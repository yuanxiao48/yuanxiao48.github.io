import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWindowsLogonSessionSnapshotProtocolAuthority } from "../shared/windows-logon-session-snapshot-protocol.mjs";
import { createWindowsLogonSessionSnapshotRunner, WINDOWS_LOGON_SESSION_HELPER_CODES } from "../shared/windows-logon-session-snapshot-runner.mjs";

class FakeChild extends EventEmitter {
	constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); }
	close(code = 0, signal = null) { this.emit("close", code, signal); }
}
function snapshot() {
	const result = Buffer.alloc(36);
	result.write("SLS1", 0, "ascii"); result.writeUInt16LE(1, 4); result.writeUInt16LE(2, 6); result.writeUInt32LE(2, 8);
	result.writeUInt32LE(2, 12); result.writeUInt32LE(1, 20); result.writeUInt32LE(2, 28);
	return result;
}
function clock() {
	let now = 0; let next = 1; const timers = new Map();
	return {
		set(callback, ms) { const id = next++; timers.set(id, { at: now + ms, callback }); return id; },
		clear(id) { timers.delete(id); },
		advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
		get size() { return timers.size; },
	};
}
function harness({ spawn = null } = {}) {
	const protocol = createWindowsLogonSessionSnapshotProtocolAuthority();
	const timers = clock(); const child = new FakeChild(); let spawns = 0; let soft = 0; let force = 0;
	const runner = createWindowsLogonSessionSnapshotRunner({
		spawnHelper: spawn || (() => { spawns += 1; return { child, knownChildControl: {} }; }), decoder: protocol.decoder,
		scheduleTimer: timers.set, cancelTimer: timers.clear,
		requestSoftStopKnownChild: async () => { soft += 1; }, forceStopKnownChild: async () => { force += 1; },
		policy: { softTimeoutMs: 10, forceGraceMs: 5, hardDeadlineMs: 30 },
	});
	return { runner, child, timers, counts: () => ({ spawns, soft, force }) };
}

{
	const h = harness(); const first = h.runner.runOnce(); const second = h.runner.runOnce();
	assert.strictEqual(first, second); assert.equal(h.counts().spawns, 1);
	h.child.stdout.emit("data", snapshot()); h.child.emit("exit", 0, null); let settled = false; void first.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
	h.child.close(); assert.equal((await first).ok, true); assert.equal(h.timers.size, 0); await h.runner.waitForIdle(); assert.equal(h.runner.dispose().disposed, true);
}
{
	const h = harness(); const result = h.runner.runOnce(); h.child.stderr.emit("data", Buffer.from([1])); h.child.close(); assert.equal((await result).code, WINDOWS_LOGON_SESSION_HELPER_CODES.stderrNotEmpty);
}
{
	const h = harness(); const result = h.runner.runOnce(); h.child.stdout.emit("data", Buffer.alloc(32789)); h.child.close(); assert.equal((await result).code, WINDOWS_LOGON_SESSION_HELPER_CODES.stdoutTooLarge);
}
{
	const h = harness(); const result = h.runner.runOnce(); h.timers.advance(10); await Promise.resolve(); assert.equal(h.counts().soft, 1); h.timers.advance(5); await Promise.resolve(); assert.equal(h.counts().force, 1); h.timers.advance(15);
	assert.equal((await result).code, WINDOWS_LOGON_SESSION_HELPER_CODES.closeUnconfirmed); let idle = false; void h.runner.waitForIdle().then(() => { idle = true; }); await Promise.resolve(); assert.equal(idle, false); h.child.close(1); await Promise.resolve(); assert.equal(idle, true); assert.equal(h.runner.getSafeState().activeChildCount, 0);
}
{
	const h = harness(); h.runner.requestShutdown(); assert.equal((await h.runner.runOnce()).code, WINDOWS_LOGON_SESSION_HELPER_CODES.shutdown);
}
{
	const h = harness({ spawn: () => { throw new Error("fake"); } }); assert.equal((await h.runner.runOnce()).code, WINDOWS_LOGON_SESSION_HELPER_CODES.spawnFailed);
}
console.log("windows logon-session snapshot runner tests passed");
