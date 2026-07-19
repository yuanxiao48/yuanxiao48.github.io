import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	createManagedSourceProbeManager,
	createManagedSourceProbePermitAuthority,
	MANAGED_SOURCE_PROBE_CODES,
} from "../shared/managed-source-probe.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter {
	constructor() { super(); this.stdout = new FakeStream(); this.stderr = new FakeStream(); }
	close(code = 0) { this.emit("close", code, null); }
}

function createClock() {
	let next = 0;
	const timers = new Map();
	return {
		set(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
		clear(id) { timers.delete(id); },
		fire(delay) {
			const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
			assert.ok(entry, `timer ${delay} missing`);
			timers.delete(entry[0]);
			entry[1].callback();
		},
		count() { return timers.size; },
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((next) => { resolve = next; });
	return { promise, resolve };
}

function createHarness({ finalizer = () => ({ ok: true }), softStop = async () => {}, forceStop = async () => {} } = {}) {
	const clock = createClock();
	const authority = createManagedSourceProbePermitAuthority();
	let id = 0;
	const manager = createManagedSourceProbeManager({
		permitConsumer: authority.consumer,
		requestSoftStopKnownChild: softStop,
		forceKillKnownChildTree: forceStop,
		scheduleTimer: clock.set,
		cancelTimer: clock.clear,
		createAttemptId: () => ({ id: ++id }),
		policy: { executionTimeoutMs: 100, softStopGraceMs: 20, stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
	});
	const issue = (child, overrides = {}) => authority.issuer.mintJobSourceProbePermit({
		kind: "job-library-source",
		spawnPreparedProbe: overrides.spawnPreparedProbe || (() => ({ child, knownChildControl: overrides.control || {} })),
		evaluateClosedProbe: overrides.evaluateClosedProbe || (() => ({ ok: true })),
		finalizeBusinessProtection: overrides.finalizeBusinessProtection || finalizer,
	});
	return { clock, authority, manager, issue };
}

{
	const { manager } = createHarness();
	await manager.waitForSafety();
	await manager.waitForIdle();
	assert.deepEqual(manager.getSafeSummary(), { runningChildCount: 0, finalizingCount: 0, retainedProtectionCount: 0, shutdownRequested: false });
}

{
	const softStops = [];
	const { manager, issue, clock } = createHarness({ softStop: async (control) => softStops.push(control) });
	const first = new FakeChild();
	const second = new FakeChild();
	const firstHandle = manager.start(issue(first).permit);
	const secondHandle = manager.start(issue(second).permit);
	const safety = manager.waitForSafety();
	assert.deepEqual(manager.requestShutdownAll(), { requested: true, alreadyRequested: false });
	assert.deepEqual(manager.requestShutdownAll(), { requested: false, alreadyRequested: true });
	await tick();
	assert.equal(softStops.length, 2);
	assert.equal(manager.getSafeSummary().shutdownRequested, true);
	const rejected = await manager.start(issue(new FakeChild()).permit).completion;
	assert.equal(rejected.code, MANAGED_SOURCE_PROBE_CODES.shuttingDown);
	first.close(0);
	await tick();
	assert.equal(manager.getSafeSummary().runningChildCount, 1);
	second.close(0);
	await safety;
	assert.equal((await firstHandle.completion).code, MANAGED_SOURCE_PROBE_CODES.shuttingDown);
	assert.equal((await secondHandle.completion).code, MANAGED_SOURCE_PROBE_CODES.shuttingDown);
	await manager.waitForIdle();
	assert.equal(clock.count(), 0);
}

{
	const softStops = [];
	const forceStops = [];
	const { manager, issue, clock } = createHarness({
		softStop: async (control) => softStops.push(control),
		forceStop: async (control) => forceStops.push(control),
	});
	const child = new FakeChild();
	const handle = manager.start(issue(child, { control: { known: true } }).permit);
	clock.fire(100);
	await tick();
	assert.equal(softStops.length, 1);
	clock.fire(20);
	await tick();
	assert.equal(forceStops.length, 1);
	let safe = false;
	void manager.waitForSafety().then(() => { safe = true; });
	await tick();
	assert.equal(safe, false);
	child.close(0);
	await handle.completion;
	assert.equal(safe, true);
	assert.equal(clock.count(), 0);
}

{
	const finalization = deferred();
	const { manager, issue } = createHarness({ finalizer: () => finalization.promise });
	const child = new FakeChild();
	const handle = manager.start(issue(child).permit);
	child.close(0);
	await manager.waitForSafety();
	let idle = false;
	void manager.waitForIdle().then(() => { idle = true; });
	await tick();
	assert.equal(idle, false);
	assert.equal(manager.getSafeSummary().finalizingCount, 1);
	finalization.resolve({ ok: true });
	assert.equal((await handle.completion).status, "completed");
	await manager.waitForIdle();
	assert.equal(idle, true);
}

{
	const { manager, issue } = createHarness({ finalizer: () => ({ ok: false }) });
	const child = new FakeChild();
	const handle = manager.start(issue(child).permit);
	child.close(0);
	await manager.waitForIdle();
	assert.equal((await handle.completion).protectionRetained, true);
	assert.equal(manager.getSafeSummary().retainedProtectionCount, 1);
	assert.deepEqual(manager.dispose(), { disposed: true, code: null });
}

{
	const { manager, issue } = createHarness();
	const child = new FakeChild();
	const handle = manager.start(issue(child).permit);
	assert.deepEqual(manager.dispose(), { disposed: false, code: MANAGED_SOURCE_PROBE_CODES.disposeBusy });
	const abort = await handle.requestStop("request-abort");
	assert.equal(abort.requested, true);
	assert.equal((await handle.requestStop("request-abort")).alreadyRequested, true);
	child.close(0);
	await handle.completion;
	assert.deepEqual(manager.dispose(), { disposed: true, code: null });
	assert.equal((await manager.start(issue(new FakeChild()).permit).completion).code, MANAGED_SOURCE_PROBE_CODES.disposed);
}

console.log("managed source probe shutdown fake tests passed");
