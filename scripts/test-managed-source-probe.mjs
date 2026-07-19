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
	constructor() {
		super();
		this.stdout = new FakeStream();
		this.stderr = new FakeStream();
	}

	exit(code = 0, signal = null) { this.emit("exit", code, signal); }
	close(code = 0, signal = null) { this.emit("close", code, signal); }
}

function createClock() {
	let next = 0;
	const timers = new Map();
	return {
		set(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
		clear(id) { timers.delete(id); },
		fireDelay(delay) {
			const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
			assert.ok(entry, `expected timer with delay ${delay}`);
			timers.delete(entry[0]);
			entry[1].callback();
		},
		count() { return timers.size; },
	};
}

function createHarness({ softStop = async () => {}, forceStop = async () => {} } = {}) {
	const clock = createClock();
	const authority = createManagedSourceProbePermitAuthority();
	let nextAttempt = 0;
	const manager = createManagedSourceProbeManager({
		permitConsumer: authority.consumer,
		requestSoftStopKnownChild: softStop,
		forceKillKnownChildTree: forceStop,
		scheduleTimer: clock.set,
		cancelTimer: clock.clear,
		createAttemptId: () => ({ sequence: ++nextAttempt }),
		policy: { executionTimeoutMs: 100, softStopGraceMs: 25, stdoutMaxBytes: 8, stderrMaxBytes: 4 },
	});
	return { authority, manager, clock };
}

function issueJob(authority, child, hooks = {}, kind = "job-library-source") {
	return authority.issuer.mintJobSourceProbePermit({
		kind,
		spawnPreparedProbe: hooks.spawnPreparedProbe || (() => ({ child, knownChildControl: {} })),
		evaluateClosedProbe: hooks.evaluateClosedProbe || (() => ({ ok: true, value: { private: true } })),
		finalizeBusinessProtection: hooks.finalizeBusinessProtection || (() => ({ ok: true })),
	});
}

function issueOutput(authority, child, hooks = {}) {
	return authority.issuer.mintOutputValidationPermit({
		spawnPreparedProbe: hooks.spawnPreparedProbe || (() => ({ child, knownChildControl: {} })),
		evaluateClosedProbe: hooks.evaluateClosedProbe || (() => ({ ok: true, value: { private: true } })),
		finalizeBusinessProtection: hooks.finalizeBusinessProtection || (() => ({ ok: true })),
	});
}

{
	const { authority, manager, clock } = createHarness();
	assert.equal(clock.count(), 0);
	assert.equal(manager.getSafeSummary().runningChildCount, 0);
	assert.equal(JSON.stringify(authority), "{\"issuer\":{},\"consumer\":{}}");
	assert.throws(() => createManagedSourceProbeManager({}), TypeError);
	assert.throws(() => authority.issuer.mintOutputValidationPermit({}), TypeError);
}

{
	const first = createHarness();
	const second = createHarness();
	const child = new FakeChild();
	const issued = issueJob(first.authority, child);
	assert.equal(JSON.stringify(issued.permit), "{\"kind\":\"managed-source-probe-permit\"}");
	assert.equal(Object.keys(issued.permit).length, 0);
	const rejected = second.manager.start(issued.permit);
	assert.equal((await rejected.completion).code, MANAGED_SOURCE_PROBE_CODES.permitInvalid);
	assert.equal(first.clock.count(), 0);
	const handle = first.manager.start(issued.permit);
	const duplicate = first.manager.start(issued.permit);
	assert.equal((await duplicate.completion).code, MANAGED_SOURCE_PROBE_CODES.permitAlreadyUsed);
	child.close();
	assert.equal((await handle.completion).status, "completed");
}

{
	const { authority, manager, clock } = createHarness();
	let spawned = 0;
	const direct = authority.issuer.mintDirectLibrarySourcePermit();
	assert.deepEqual(direct, { ok: false, code: MANAGED_SOURCE_PROBE_CODES.directProtectionUnavailable, permit: null });
	assert.equal(spawned, 0);
	assert.equal(clock.count(), 0);
	const invalid = manager.start({ spawn: () => { spawned += 1; } });
	assert.equal((await invalid.completion).code, MANAGED_SOURCE_PROBE_CODES.permitInvalid);
	assert.equal(spawned, 0);
}

{
	const { authority, manager, clock } = createHarness();
	let finalized = 0;
	const issued = issueJob(authority, null, {
		spawnPreparedProbe: () => { throw new Error("fake synchronous failure"); },
		finalizeBusinessProtection: () => { finalized += 1; return { ok: true }; },
	});
	const result = await manager.start(issued.permit).completion;
	assert.equal(result.code, MANAGED_SOURCE_PROBE_CODES.spawnFailed);
	assert.equal(result.childCloseConfirmed, false);
	assert.equal(result.businessProtectionFinalized, true);
	assert.equal(finalized, 1);
	assert.equal(clock.count(), 0);
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	assert.deepEqual(authority.issuer.mintJobSourceProbePermit({ kind: "direct-library-source" }), {
		ok: false,
		code: MANAGED_SOURCE_PROBE_CODES.kindInvalid,
		permit: null,
	});
	const upload = manager.start(issueJob(authority, child, {}, "job-upload-source").permit);
	child.close();
	assert.equal((await upload.completion).status, "completed");
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	let evaluated = 0;
	let finalized = 0;
	const handle = manager.start(issueJob(authority, child, {
		evaluateClosedProbe: () => { evaluated += 1; return { ok: true, value: { parsed: "private" } }; },
		finalizeBusinessProtection: () => { finalized += 1; return { ok: true }; },
	}).permit);
	child.emit("error", new Error("fake child error"));
	child.exit(0);
	await tick();
	assert.equal(evaluated, 0);
	assert.equal(finalized, 0);
	child.close(0);
	const result = await handle.completion;
	assert.equal(result.code, MANAGED_SOURCE_PROBE_CODES.childError);
	assert.equal(evaluated, 0);
	assert.equal(finalized, 1);
	child.close(0);
	assert.equal(finalized, 1);
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	let finalized = 0;
	const handle = manager.start(issueJob(authority, child, {
		spawnPreparedProbe: () => ({ child, knownChildControl: null }),
		finalizeBusinessProtection: () => { finalized += 1; return { ok: true }; },
	}).permit);
	child.emit("error", new Error("known child control is invalid"));
	await tick();
	assert.equal(finalized, 0);
	child.close(0);
	assert.equal((await handle.completion).code, MANAGED_SOURCE_PROBE_CODES.spawnFailed);
	assert.equal(finalized, 1);
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	let evaluated = 0;
	const handle = manager.start(issueJob(authority, child, {
		evaluateClosedProbe: () => { evaluated += 1; return { ok: true }; },
	}).permit);
	child.stdout.emit("data", Buffer.from("ok"));
	child.stderr.emit("data", "e");
	child.exit(1);
	child.close(1);
	const result = await handle.completion;
	assert.equal(result.code, MANAGED_SOURCE_PROBE_CODES.childExitFailed);
	assert.equal(evaluated, 0);
	assert.equal("stdout" in result, false);
	assert.equal("stderr" in result, false);
	assert.equal(Object.isFrozen(result), true);
}

{
	const softStops = [];
	const { authority, manager, clock } = createHarness({ softStop: async (control) => softStops.push(control) });
	const child = new FakeChild();
	const handle = manager.start(issueOutput(authority, child).permit);
	child.stdout.emit("data", Buffer.from("123456789"));
	child.stdout.emit("data", Buffer.from("more"));
	await tick();
	assert.equal(softStops.length, 1);
	assert.equal(clock.count(), 2);
	child.close(0);
	const result = await handle.completion;
	assert.equal(result.code, MANAGED_SOURCE_PROBE_CODES.outputLimit);
	assert.equal(result.outputLimited, true);
	assert.equal(clock.count(), 0);
	assert.equal(child.stdout.listenerCount("data"), 0);
}

{
	const softStops = [];
	const { authority, manager } = createHarness({ softStop: async () => { throw new Error("fake soft stop failure"); } });
	const child = new FakeChild();
	const handle = manager.start(issueJob(authority, child).permit);
	child.stdout.emit("error", new Error("fake stream failure"));
	await tick();
	assert.equal(softStops.length, 0);
	child.close(0);
	assert.equal((await handle.completion).code, MANAGED_SOURCE_PROBE_CODES.streamError);
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	let finalized = 0;
	const handle = manager.start(issueJob(authority, child, {
		evaluateClosedProbe: () => { throw new Error("fake parser failure"); },
		finalizeBusinessProtection: () => { finalized += 1; return { ok: true }; },
	}).permit);
	child.close(0);
	const result = await handle.completion;
	assert.equal(result.code, MANAGED_SOURCE_PROBE_CODES.resultInvalid);
	assert.equal(finalized, 1);
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	const handle = manager.start(issueJob(authority, child, {
		finalizeBusinessProtection: () => ({ ok: false }),
	}).permit);
	child.close(0);
	const result = await handle.completion;
	assert.equal(result.code, MANAGED_SOURCE_PROBE_CODES.finalizeFailed);
	assert.equal(result.protectionRetained, true);
	assert.equal(result.businessProtectionFinalized, false);
	assert.equal(manager.getSafeSummary().retainedProtectionCount, 1);
}

{
	const { authority, manager } = createHarness();
	const child = new FakeChild();
	const output = authority.issuer.mintOutputValidationPermit({
		spawnPreparedProbe: () => ({ child, knownChildControl: {} }),
		evaluateClosedProbe: () => ({ ok: true }),
		finalizeBusinessProtection: () => ({ ok: true }),
	});
	const handle = manager.start(output.permit);
	assert.equal(typeof handle.requestStop, "function");
	assert.equal("attemptId" in handle, false);
	assert.equal("permit" in handle, false);
	child.close(0);
	assert.equal((await handle.completion).status, "completed");
}

console.log("managed source probe fake tests passed");
