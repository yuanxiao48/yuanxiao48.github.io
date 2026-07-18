import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createManagedForceKillCoordinator, createManagedTranscodeProcesses } from "../shared/transcode-runtime.mjs";

class FakeChild extends EventEmitter {
	constructor(pid) {
		super();
		this.pid = pid;
		this.exitCode = null;
	}
}

function createTimers() {
	const timers = [];
	return {
		timers,
		setTimeoutImpl(handler) { const timer = { handler, cleared: false }; timers.push(timer); return timer; },
		clear(timer) { timer.cleared = true; },
	};
}

const timers = createTimers();
const processes = createManagedTranscodeProcesses();
const forceCalls = [];
const resultCalls = [];
const stuckCalls = [];
const pendingResults = new Map();
const coordinator = createManagedForceKillCoordinator({
	processes,
	forceKill: ({ pid }) => {
		forceCalls.push(pid);
		return new Promise((resolve) => pendingResults.set(pid, resolve));
	},
	onForceKillResult: async ({ result }) => resultCalls.push(result.safeErrorCode || "ok"),
	onProcessStuck: async ({ jobId }) => stuckCalls.push(jobId),
	confirmationDelayMs: 2000,
	setTimeoutImpl: timers.setTimeoutImpl,
});

const childA = new FakeChild(101);
const recordA = processes.attach("job-a", childA, { attempt: 1 });
const first = coordinator.start("job-a", 1);
const duplicate = coordinator.start("job-a", 1);
assert.strictEqual(first, duplicate);
assert.deepEqual(forceCalls, []);
await Promise.resolve();
assert.deepEqual(forceCalls, [101]);
pendingResults.get(101)({ attempted: true, launched: true, timedOut: false, exitCode: 0, signal: null, safeErrorCode: null });
await first;
assert.equal(recordA.forceKillStarted, true);
assert.equal(recordA.forceKillFinished, true);
assert.equal(timers.timers.length, 1);
childA.emit("close", 0, null);
assert.equal(recordA.processExitConfirmed, true);
processes.clearForceKillConfirmationTimer("job-a", 1);
assert.equal(stuckCalls.length, 0);
processes.finish("job-a", 1);

const childB = new FakeChild(102);
const recordB = processes.attach("job-b", childB, { attempt: 2 });
const failed = coordinator.start("job-b", 2);
await Promise.resolve();
pendingResults.get(102)({ attempted: true, launched: true, timedOut: false, exitCode: 1, signal: null, safeErrorCode: "TRANSCODE_TASKKILL_FAILED" });
await failed;
assert.deepEqual(resultCalls, ["ok", "TRANSCODE_TASKKILL_FAILED"]);
const confirmation = timers.timers.at(-1);
confirmation.handler();
await Promise.resolve();
assert.deepEqual(stuckCalls, ["job-b"]);
assert.equal(recordB.processExitConfirmed, false);
childB.emit("close", 1, null);
assert.equal(recordB.processExitConfirmed, true);
processes.finish("job-b", 2);

const childC = new FakeChild(103);
const recordC = processes.attach("job-c", childC, { attempt: 3 });
const late = coordinator.start("job-c", 3);
await Promise.resolve();
processes.finish("job-c", 3);
pendingResults.get(103)({ attempted: true, launched: true, timedOut: true, exitCode: null, signal: null, safeErrorCode: "TRANSCODE_TASKKILL_TIMEOUT" });
await late;
assert.equal(resultCalls.length, 2);
assert.equal(recordC.forceKillFinished, false);

const childD = new FakeChild(104);
processes.attach("job-d", childD, { attempt: 4 });
childD.emit("close", 0, null);
assert.equal(coordinator.start("job-d", 4), null);
processes.finish("job-d", 4);

console.log("transcode force-kill coordination fake tests passed");
