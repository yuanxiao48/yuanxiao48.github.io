import assert from "node:assert/strict";
import {
	createStudioShutdownPreparation,
	createTranscodeQueue,
	isStudioApiWriteRequest,
	resolveTranscodeAttemptFinalization,
} from "../shared/transcode-runtime.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
	let resolve;
	const promise = new Promise((next) => { resolve = next; });
	return { promise, resolve };
};

const started = [];
const activeGate = deferred();
const queue = createTranscodeQueue({
	runJob: async (jobId) => {
		started.push(jobId);
		if (jobId === "active") await activeGate.promise;
	},
});

queue.enqueue("active");
queue.enqueue("first");
queue.enqueue("second");
await tick();
assert.deepEqual(started, ["active"]);
assert.equal(queue.isActive("active"), true);

const closeResult = queue.close();
assert.deepEqual(closeResult, { closed: true, alreadyClosed: false, pendingJobIds: ["first", "second"] });
assert.equal(queue.isClosed(), true);
assert.equal(queue.pendingCount(), 0);
assert.equal(queue.isActive("active"), true);
assert.throws(() => queue.enqueue("late"), (error) => error?.code === "TRANSCODE_QUEUE_CLOSED");
assert.deepEqual(queue.close(), { closed: true, alreadyClosed: true, pendingJobIds: [] });
activeGate.resolve();
await queue.idle();
assert.deepEqual(started, ["active"]);

const pendingRecovery = [];
const shutdownQueue = createTranscodeQueue({ runJob: async () => {} });
shutdownQueue.enqueue("queued-a");
shutdownQueue.enqueue("queued-b");
const shutdown = createStudioShutdownPreparation({
	queue: shutdownQueue,
	recoverPending: async (ids) => {
		pendingRecovery.push([...ids]);
		return { ok: true, recovered: ids.length };
	},
});
const firstPreparation = shutdown.begin();
const duplicatePreparation = shutdown.begin();
assert.equal(firstPreparation, duplicatePreparation);
assert.equal(shutdown.isStarted(), true);
assert.equal(shutdown.isAcceptingWrites(), false);
assert.equal(shutdown.isQueueClosed(), true);
assert.deepEqual(pendingRecovery, []);
assert.deepEqual(await firstPreparation, {
	ok: true,
	queue: { closed: true, alreadyClosed: false, pendingJobIds: ["queued-a", "queued-b"] },
	active: {},
	recovery: { ok: true, recovered: 2 },
});
assert.deepEqual(pendingRecovery, [["queued-a", "queued-b"]]);

const failedRecoveryQueue = createTranscodeQueue({ runJob: async () => {} });
failedRecoveryQueue.enqueue("queued-failure");
const failedRecovery = createStudioShutdownPreparation({
	queue: failedRecoveryQueue,
	recoverPending: async () => { throw new Error("expected test recovery failure"); },
});
const failedResult = await failedRecovery.begin();
assert.deepEqual(failedResult.recovery, { ok: false, code: "TRANSCODE_SHUTDOWN_PENDING_RECOVERY_FAILED" });
assert.equal(failedRecovery.isAcceptingWrites(), false);

assert.equal(isStudioApiWriteRequest({ method: "POST", pathname: "/api/transcode/jobs/upload" }), true);
assert.equal(isStudioApiWriteRequest({ method: "POST", pathname: "/api/transcode/jobs/job-id/cancel" }), true);
assert.equal(isStudioApiWriteRequest({ method: "PUT", pathname: "/api/posts" }), true);
assert.equal(isStudioApiWriteRequest({ method: "DELETE", pathname: "/api/posts" }), true);
assert.equal(isStudioApiWriteRequest({ method: "PATCH", pathname: "/api/settings" }), true);
assert.equal(isStudioApiWriteRequest({ method: "GET", pathname: "/api/transcode/jobs" }), false);
assert.equal(isStudioApiWriteRequest({ method: "HEAD", pathname: "/api/transcode/jobs" }), false);
assert.equal(isStudioApiWriteRequest({ method: "OPTIONS", pathname: "/api/transcode/jobs" }), false);
assert.equal(isStudioApiWriteRequest({ method: "POST", pathname: "/studio-editor.js" }), false);

assert.equal(resolveTranscodeAttemptFinalization({ terminal: true, shutdownRequested: true, cancelRequested: true }), "terminal");
assert.equal(resolveTranscodeAttemptFinalization({ shutdownRequested: true, cancelRequested: true }), "interrupted");
assert.equal(resolveTranscodeAttemptFinalization({ cancelRequested: true }), "cancelled");
assert.equal(resolveTranscodeAttemptFinalization({}), "ordinary");

const raceQueue = createTranscodeQueue({ runJob: async () => {} });
const raceShutdown = createStudioShutdownPreparation({ queue: raceQueue, recoverPending: async () => ({ ok: true }) });
await raceShutdown.begin();
assert.throws(() => raceQueue.enqueue("start-after-shutdown"), (error) => error?.code === "TRANSCODE_QUEUE_CLOSED");
assert.equal(raceQueue.hasPending("start-after-shutdown"), false);
assert.equal(raceQueue.isActive("start-after-shutdown"), false);

const shutdownWinsQueue = createTranscodeQueue({ runJob: async () => {} });
shutdownWinsQueue.enqueue("queued-cancel-race");
const shutdownWins = createStudioShutdownPreparation({
	queue: shutdownWinsQueue,
	recoverPending: async (ids) => ({ ok: true, finalState: ids.includes("queued-cancel-race") ? "ready" : "missing" }),
});
const shutdownWinsResult = await shutdownWins.begin();
assert.equal(shutdownWinsQueue.removePending("queued-cancel-race").reason, "not-found");
assert.equal(shutdownWinsResult.recovery.finalState, "ready");

const cancelWinsQueue = createTranscodeQueue({ runJob: async () => {} });
cancelWinsQueue.enqueue("cancel-before-shutdown");
assert.deepEqual(cancelWinsQueue.removePending("cancel-before-shutdown"), { removed: true, position: 1 });
const cancelWins = createStudioShutdownPreparation({ queue: cancelWinsQueue, recoverPending: async (ids) => ({ ok: true, recovered: ids.length }) });
const cancelWinsResult = await cancelWins.begin();
assert.deepEqual(cancelWinsResult.queue.pendingJobIds, []);
assert.equal(cancelWinsResult.recovery.recovered, 0);

console.log("studio shutdown preparation fake tests passed");
