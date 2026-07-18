import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	createManagedTranscodeProcesses,
	createManagedTranscodeStopCoordinator,
	resolveManagedStopIntent,
} from "../shared/transcode-runtime.mjs";

class FakeStdin extends EventEmitter {
	constructor({ writeError = null } = {}) {
		super();
		this.writable = true;
		this.writeError = writeError;
		this.writes = [];
	}

	write(value, callback) {
		this.writes.push(value);
		if (callback) callback(this.writeError);
		return true;
	}
}

class FakeChild extends EventEmitter {
	constructor(pid, options = {}) {
		super();
		this.pid = pid;
		this.exitCode = null;
		this.stdin = new FakeStdin(options);
	}
}

function createTimers() {
	const timers = [];
	return {
		timers,
		setTimeoutImpl(handler) {
			const timer = { handler, cleared: false };
			timers.push(timer);
			return timer;
		},
	};
}

const timers = createTimers();
const processes = createManagedTranscodeProcesses();
const issues = [];
const grace = [];
const coordinator = createManagedTranscodeStopCoordinator({
	processes,
	setTimeoutImpl: timers.setTimeoutImpl,
	onStopIssue: async ({ jobId, intent }) => issues.push(`${jobId}:${intent}`),
	onGraceExpired: async ({ jobId, intent }) => grace.push(`${jobId}:${intent}`),
});

const cancelChild = new FakeChild(801);
const cancelRecord = processes.attach("cancel", cancelChild, { attempt: 1 });
assert.equal(processes.requestCancel("cancel", 1).requested, true);
assert.deepEqual(await coordinator.request("cancel", 1, { intent: "cancel" }), { requested: true, intent: "cancel" });
assert.deepEqual(cancelChild.stdin.writes, ["q\n"]);
assert.equal(timers.timers.length, 1);
assert.equal((await coordinator.request("cancel", 1, { intent: "cancel" })).alreadyRequested, true);
assert.deepEqual(cancelChild.stdin.writes, ["q\n"]);
assert.equal(timers.timers.length, 1);
timers.timers[0].handler();
await Promise.resolve();
assert.deepEqual(grace, ["cancel:cancel"]);
cancelChild.emit("close", 0, null);
assert.equal(cancelRecord.processExitConfirmed, true);
timers.timers[0].handler();
await Promise.resolve();
assert.deepEqual(grace, ["cancel:cancel"]);
processes.finish("cancel", 1);

const shutdownChild = new FakeChild(802);
const shutdownRecord = processes.attach("shutdown", shutdownChild, { attempt: 2 });
assert.equal(processes.requestShutdown("shutdown", 2).requested, true);
assert.equal(resolveManagedStopIntent(shutdownRecord), "shutdown");
assert.deepEqual(await coordinator.request("shutdown", 2, { intent: "shutdown" }), { requested: true, intent: "shutdown" });
assert.deepEqual(shutdownChild.stdin.writes, ["q\n"]);
assert.equal(timers.timers.length, 2);
timers.timers[1].handler();
await Promise.resolve();
assert.deepEqual(grace, ["cancel:cancel", "shutdown:shutdown"]);
shutdownChild.emit("close", 1, null);
processes.finish("shutdown", 2);

const upgradedChild = new FakeChild(803);
const upgradedRecord = processes.attach("upgraded", upgradedChild, { attempt: 3 });
assert.equal(processes.requestCancel("upgraded", 3).requested, true);
await coordinator.request("upgraded", 3, { intent: "cancel" });
assert.equal(processes.requestShutdown("upgraded", 3).requested, true);
assert.equal(resolveManagedStopIntent(upgradedRecord), "shutdown");
assert.equal((await coordinator.request("upgraded", 3, { intent: "shutdown" })).alreadyRequested, true);
assert.deepEqual(upgradedChild.stdin.writes, ["q\n"]);
assert.equal(timers.timers.length, 3);
timers.timers[2].handler();
await Promise.resolve();
assert.deepEqual(grace, ["cancel:cancel", "shutdown:shutdown", "upgraded:shutdown"]);
upgradedChild.emit("close", 0, null);
processes.finish("upgraded", 3);

const qFailureChild = new FakeChild(804, { writeError: new Error("expected fake stdin failure") });
processes.attach("q-failure", qFailureChild, { attempt: 4 });
processes.requestShutdown("q-failure", 4);
await coordinator.request("q-failure", 4, { intent: "shutdown" });
await Promise.resolve();
assert.deepEqual(issues, ["q-failure:shutdown"]);
assert.equal(timers.timers.length, 4);
qFailureChild.emit("close", 1, null);
processes.finish("q-failure", 4);

const preStart = processes.requestShutdown("pre-start", 5);
assert.equal(preStart.pending, true);
const preStartRecord = processes.reserve("pre-start", { attempt: 5 });
assert.equal(preStartRecord.qSent, false);
assert.equal(preStartRecord.graceTimer, null);
assert.equal(preStartRecord.forceKillPromise, null);
processes.finish("pre-start", 5);

assert.equal(processes.get("cancel"), null);
assert.equal(processes.get("shutdown"), null);
assert.equal(processes.get("upgraded"), null);
assert.equal(processes.get("q-failure"), null);
assert.equal(processes.get("pre-start"), null);

console.log("transcode stop coordination fake tests passed");
