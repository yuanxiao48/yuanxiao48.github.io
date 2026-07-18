import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	createManagedForceKillCoordinator,
	createManagedTranscodeProcesses,
	createManagedTranscodeStopCoordinator,
	createTranscodeOperationGuard,
	createTranscodeQueue,
	resolveManagedStopIntent,
	resolveTranscodeAttemptFinalization,
	shouldAwaitManagedChildClose,
} from "../shared/transcode-runtime.mjs";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class FakeStdin extends EventEmitter {
	constructor({ syncError = null, callbackError = null } = {}) {
		super();
		this.writable = true;
		this.syncError = syncError;
		this.callbackError = callbackError;
		this.writes = [];
	}

	write(value, callback) {
		this.writes.push(value);
		if (this.syncError) throw this.syncError;
		if (callback) callback(this.callbackError);
		return true;
	}
}

class FakeChild extends EventEmitter {
	constructor(pid = 9101, stdinOptions = {}) {
		super();
		this.pid = pid;
		this.exitCode = null;
		this.stdin = new FakeStdin(stdinOptions);
		this.closeSent = false;
	}

	close(code = 0, signal = null) {
		if (this.closeSent) return;
		this.closeSent = true;
		this.exitCode = code;
		this.emit("close", code, signal);
	}
}

function createFakeTimers() {
	const timers = [];
	return {
		timers,
		setTimeoutImpl(handler) {
			const timer = { handler, cleared: false };
			timers.push(timer);
			return timer;
		},
		fire(index) {
			const timer = timers[index];
			if (!timer || timer.cleared) return;
			timer.handler();
		},
		clear() {
			for (const timer of timers) timer.cleared = true;
		},
	};
}

let harnessSequence = 0;

class ShutdownRaceHarness {
	constructor({ forceKillResult = null, interruptedPersistError = null } = {}) {
		harnessSequence += 1;
		this.id = `race-${harnessSequence}`;
		this.attempt = 1;
		this.processes = createManagedTranscodeProcesses();
		this.timers = createFakeTimers();
		this.events = [];
		this.forceKillCalls = 0;
		this.cleanupCalls = 0;
		this.lockHeld = true;
		this.active = true;
		this.interruptedPersistError = interruptedPersistError;
		this.job = {
			state: "transcoding",
			runtime: { attempt: this.attempt },
			interruption: null,
			cancellation: null,
			error: null,
			cleanupWarning: null,
		};
		this.forceKillResult = forceKillResult;
		this.forceKill = createManagedForceKillCoordinator({
			processes: this.processes,
			forceKill: async () => {
				this.forceKillCalls += 1;
				return this.forceKillResult || { attempted: false, launched: false, timedOut: false, exitCode: null, signal: null, safeErrorCode: "TRANSCODE_FORCE_KILL_FAILED" };
			},
			onForceKillResult: async () => this.events.push("force-result"),
			onProcessStuck: async () => this.events.push("process-stuck"),
			confirmationDelayMs: 2,
			setTimeoutImpl: this.timers.setTimeoutImpl,
		});
		this.stop = createManagedTranscodeStopCoordinator({
			processes: this.processes,
			gracePeriodMs: 5,
			setTimeoutImpl: this.timers.setTimeoutImpl,
			onStopIssue: async () => this.events.push("stop-issue"),
			onGraceExpired: async ({ jobId, attempt }) => {
				this.events.push("grace-expired");
				this.forceKill.start(jobId, attempt);
			},
		});
	}

	reserve() {
		return this.processes.reserve(this.id, { attempt: this.attempt });
	}

	attach(child = new FakeChild()) {
		this.child = child;
		const record = this.processes.attach(this.id, child, { attempt: this.attempt });
		child.once("close", (code, signal) => {
			this.processes.setExitInfo(this.id, this.attempt, { code, signal });
			this.events.push("child-close");
		});
		return record;
	}

	requestCancel() {
		const request = this.processes.requestCancel(this.id, this.attempt);
		this.job.state = "cancelling";
		this.job.cancellation = { requested: true };
		return request;
	}

	requestShutdown() {
		const request = this.processes.requestShutdown(this.id, this.attempt);
		if (request?.record && !request.completionCommitted && !request.completionCommitInProgress) {
			this.job.state = this.job.state === "transcoding" ? "cancelling" : this.job.state;
			this.job.interruption = { requested: true, reason: "studio-shutdown" };
			this.job.cancellation = null;
		}
		return request;
	}

	async startStop(intent) {
		return this.stop.request(this.id, this.attempt, { intent });
	}

	async close(code = 0) {
		this.child.close(code);
		await Promise.resolve();
		return this.finalize({ kind: "close", code });
	}

	async cleanup() {
		const record = this.processes.get(this.id);
		assert.equal(record?.processExitConfirmed, true, "cleanup must wait for the original child close");
		this.cleanupCalls += 1;
		this.events.push("cleanup");
	}

	async finalize(outcome) {
		const record = this.processes.get(this.id);
		if (!record) return { ignored: true };
		return this.processes.beginFinalize(this.id, this.attempt, async () => {
			this.events.push("finalize");
			const finalization = resolveTranscodeAttemptFinalization({
				terminal: ["completed", "failed", "cancelled", "interrupted", "discarded"].includes(this.job.state),
				shutdownRequested: record.shutdownRequested || this.job.interruption?.requested === true,
				cancelRequested: record.cancelRequested || this.job.state === "cancelling",
			});
			if (finalization === "terminal") return { state: this.job.state };
			if (finalization === "interrupted") {
				if (!record.processExitConfirmed) return { waitingForClose: true };
				await this.cleanup();
				if (this.interruptedPersistError) {
					record.finalizationPersistenceFailed = true;
					this.events.push("interrupted-persist-failed");
					return { persistenceFailed: true };
				}
				this.job.state = "interrupted";
				this.job.error = { code: "TRANSCODE_INTERRUPTED_BY_SHUTDOWN" };
				this.events.push("interrupted-persisted");
				this.lockHeld = false;
				this.events.push("lock-released");
				this.active = false;
				this.processes.finish(this.id, this.attempt);
				return { state: "interrupted" };
			}
			if (finalization === "cancelled") {
				if (!record.processExitConfirmed) return { waitingForClose: true };
				await this.cleanup();
				this.job.state = "cancelled";
				this.lockHeld = false;
				this.active = false;
				this.processes.finish(this.id, this.attempt);
				return { state: "cancelled" };
			}
			this.job.state = outcome.code === 0 ? "completed" : "failed";
			this.lockHeld = false;
			this.active = false;
			this.processes.finish(this.id, this.attempt);
			return { state: this.job.state };
		});
	}

	async beginCompletedCommit(persist) {
		const record = this.processes.get(this.id);
		this.job.state = "validating-output";
		assert.equal(this.processes.beginCompletionCommit(this.id, this.attempt), true);
		this.events.push("completion-commit-started");
		try {
			await persist();
			this.job.state = "completed";
			this.processes.markCompletionCommitted(this.id, this.attempt);
			this.events.push("completed-persisted");
			this.lockHeld = false;
			this.active = false;
			this.processes.finish(this.id, this.attempt);
			return { state: "completed" };
		} catch (error) {
			this.processes.abortCompletionCommit(this.id, this.attempt);
			if (resolveManagedStopIntent(record) === "shutdown") return this.finalize({ kind: "error" });
			throw error;
		}
	}

	finishForTest() {
		this.timers.clear();
		this.processes.finish(this.id, this.attempt);
		this.active = false;
	}
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
}

// The same per-job guard used by /start lets only one concurrent request own
// the ready-to-queued transition; a rejected contender cannot mark it failed.
{
	const guard = createTranscodeOperationGuard();
	assert.equal(guard.tryAcquire("start-race"), true);
	assert.equal(guard.tryAcquire("start-race"), false);
	assert.equal(guard.has("start-race"), true);
	guard.release("start-race");
	assert.equal(guard.tryAcquire("start-race"), true);
	guard.release("start-race");
}

// Pre-start work remains ready and has no managed attempt or stop side effects.
{
	const processes = createManagedTranscodeProcesses();
	const request = processes.requestShutdown("pre-start", 1);
	assert.equal(request.pending, true);
	assert.equal(processes.get("pre-start"), null);
	assert.equal(resolveManagedStopIntent({}), null);
	processes.clear();
}

// A stop-related child error cannot replace the original close confirmation,
// including the small interval before a spawn has assigned a usable PID.
{
	assert.equal(shouldAwaitManagedChildClose({ shutdownRequested: true, processExitConfirmed: false }), true);
	assert.equal(shouldAwaitManagedChildClose({ cancelRequested: true, processExitConfirmed: false }), true);
	assert.equal(shouldAwaitManagedChildClose({ shutdownRequested: true, processExitConfirmed: true }), false);
	assert.equal(shouldAwaitManagedChildClose({ processExitConfirmed: false }), false);
}

// A queued job is removed by queue close before any runner gets it.
{
	const started = [];
	const queue = createTranscodeQueue({ runJob: async (id) => started.push(id) });
	queue.enqueue("first");
	queue.enqueue("second");
	assert.deepEqual(queue.close().pendingJobIds, ["first", "second"]);
	await settle();
	assert.deepEqual(started, []);
	assert.equal(queue.isClosed(), true);
}

// Shutdown before child attach is retained and produces one graceful stop after attach.
{
	const harness = new ShutdownRaceHarness();
	const record = harness.reserve();
	assert.equal(record.spawnStarted, false);
	assert.equal(harness.requestShutdown().requested, true);
	assert.equal(record.shutdownRequested, true);
	assert.equal(record.qSent, false);
	const child = new FakeChild();
	harness.attach(child);
	await harness.startStop("shutdown");
	assert.deepEqual(child.stdin.writes, ["q\n"]);
	assert.equal(harness.timers.timers.length, 1);
	await harness.close(0);
	assert.equal(harness.job.state, "interrupted");
	assert.equal(harness.cleanupCalls, 1);
	assert.equal(harness.lockHeld, false);
	assert.equal(harness.active, false);
}

// User cancellation upgrades to shutdown without a second q, timer, or force kill.
{
	const harness = new ShutdownRaceHarness({ forceKillResult: { attempted: true, launched: true, timedOut: false, exitCode: 0, signal: null, safeErrorCode: null } });
	harness.attach();
	harness.requestCancel();
	await harness.startStop("cancel");
	assert.equal(harness.child.stdin.writes.length, 1);
	assert.equal(harness.timers.timers.length, 1);
	harness.requestShutdown();
	assert.equal(resolveManagedStopIntent(harness.processes.get(harness.id)), "shutdown");
	await harness.startStop("shutdown");
	assert.equal(harness.child.stdin.writes.length, 1);
	assert.equal(harness.timers.timers.length, 1);
	harness.timers.fire(0);
	await settle();
	assert.equal(harness.forceKillCalls, 1);
	await harness.close(1);
	assert.equal(harness.job.state, "interrupted");
	assert.equal(harness.forceKillCalls, 1);
}

// A q write error still waits for child close; it cannot prematurely clean output or release the lock.
{
	const harness = new ShutdownRaceHarness({ forceKillResult: { attempted: false, launched: false, timedOut: true, exitCode: null, signal: null, safeErrorCode: "TRANSCODE_FORCE_KILL_FAILED" } });
	harness.attach(new FakeChild(9102, { syncError: new Error("fake stdin failure") }));
	harness.requestShutdown();
	await harness.startStop("shutdown");
	await settle();
	assert.ok(harness.events.includes("stop-issue"));
	assert.equal(harness.cleanupCalls, 0);
	assert.equal(harness.lockHeld, true);
	harness.timers.fire(0);
	await settle();
	assert.equal(harness.forceKillCalls, 1);
	assert.equal(harness.cleanupCalls, 0);
	await harness.close(0);
	assert.equal(harness.job.state, "interrupted");
}

// A forced stop result is only an attempt: without the original close the slot and source lock remain held.
{
	const harness = new ShutdownRaceHarness({ forceKillResult: { attempted: true, launched: true, timedOut: false, exitCode: 0, signal: null, safeErrorCode: null } });
	harness.attach();
	harness.requestShutdown();
	await harness.startStop("shutdown");
	harness.timers.fire(0);
	await settle();
	assert.equal(harness.forceKillCalls, 1);
	assert.equal(harness.processes.get(harness.id).processExitConfirmed, false);
	assert.equal(harness.job.state, "cancelling");
	assert.equal(harness.cleanupCalls, 0);
	assert.equal(harness.lockHeld, true);
	harness.finishForTest();
}

// The validating-output checkpoints V1-V5 all yield interruption before a completed commit begins.
for (const checkpoint of ["V1", "V2", "V3", "V4", "V5"]) {
	const harness = new ShutdownRaceHarness();
	harness.attach(new FakeChild(9200 + Number(checkpoint.slice(1))));
	harness.child.close(0);
	await settle();
	harness.job.state = checkpoint === "V1" ? "transcoding" : "validating-output";
	harness.requestShutdown();
	const result = await harness.finalize({ kind: "close", code: 0 });
	assert.equal(result.state, "interrupted", `${checkpoint} should settle as interrupted`);
	assert.equal(harness.job.state, "interrupted");
	assert.equal(harness.cleanupCalls, 1);
	assert.equal(harness.lockHeld, false);
}

// V6: the atomic completed write is the irreversible boundary. Success wins; failure returns to shutdown interruption.
{
	const success = new ShutdownRaceHarness();
	success.attach();
	success.child.close(0);
	const commit = deferred();
	const committing = success.beginCompletedCommit(() => commit.promise);
	await settle();
	assert.equal(success.processes.get(success.id).completionCommitStarted, true);
	assert.equal(success.processes.get(success.id).completionCommitted, false);
	success.requestShutdown();
	commit.resolve();
	assert.equal((await committing).state, "completed");
	assert.equal(success.job.state, "completed");
	assert.equal(success.cleanupCalls, 0);

	const failure = new ShutdownRaceHarness();
	failure.attach();
	failure.child.close(0);
	const failedCommit = deferred();
	const failing = failure.beginCompletedCommit(() => failedCommit.promise);
	await settle();
	failure.requestShutdown();
	failedCommit.reject(new Error("fake atomic persist failure"));
	assert.equal((await failing).state, "interrupted");
	assert.equal(failure.job.state, "interrupted");
	assert.equal(failure.cleanupCalls, 1);
}

// V7: while the registry still owns a successfully committed completion, shutdown is a no-op.
{
	const processes = createManagedTranscodeProcesses();
	processes.attach("committed", new FakeChild(9257), { attempt: 1 });
	assert.equal(processes.beginCompletionCommit("committed", 1), true);
	assert.equal(processes.markCompletionCommitted("committed", 1), true);
	assert.equal(processes.requestShutdown("committed", 1).completionCommitted, true);
	assert.equal(resolveTranscodeAttemptFinalization({ terminal: true, shutdownRequested: true }), "terminal");
	processes.finish("committed", 1);
}

// V8: after normal completion has cleared the registry, a later shutdown has no task to rewind or clean.
{
	const harness = new ShutdownRaceHarness();
	harness.attach();
	harness.child.close(0);
	await harness.beginCompletedCommit(async () => {});
	assert.equal(harness.job.state, "completed");
	assert.equal(harness.processes.get(harness.id), null);
	assert.equal(harness.cleanupCalls, 0);
}

// Interrupted persistence failure retains the managed record and lock, rather than falsely reporting a clean terminal result.
{
	const harness = new ShutdownRaceHarness({ interruptedPersistError: new Error("fake interrupted persist failure") });
	harness.attach();
	harness.requestShutdown();
	await harness.startStop("shutdown");
	await harness.close(0);
	assert.equal(harness.job.state, "cancelling");
	assert.equal(harness.processes.get(harness.id).finalizationPersistenceFailed, true);
	assert.equal(harness.lockHeld, true);
	assert.equal(harness.active, true);
	assert.equal(harness.cleanupCalls, 1);
	harness.finishForTest();
}

// An old generation cannot attach or steer the newer attempt.
{
	const processes = createManagedTranscodeProcesses();
	processes.attach("generation", new FakeChild(9301), { attempt: 1 });
	processes.finish("generation", 1);
	const current = processes.attach("generation", new FakeChild(9302), { attempt: 2 });
	assert.equal(processes.markSpawnStarted("generation", 1), false);
	assert.equal(processes.requestShutdown("generation", 1).pending, true);
	assert.equal(current.shutdownRequested, false);
	processes.finish("generation", 2);
	processes.clear();
}

console.log("transcode shutdown race fake tests passed");
