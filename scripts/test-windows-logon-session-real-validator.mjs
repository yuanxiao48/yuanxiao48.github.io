import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	createWindowsLogonSessionRealValidator,
	getWindowsLogonSessionRealValidationExitCode,
	WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES,
} from "../shared/windows-logon-session-real-validator.mjs";

const HASH = "a".repeat(64);
const PATH = "C:\\safe\\windows-logon-session-snapshot-helper.exe";

class FakeChild extends EventEmitter {
	constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); }
	close(code = 0, signal = null) { this.emit("close", code, signal); }
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function snapshot({ type = 2, current = 2, live = [1, 2] } = {}) {
	const value = Buffer.alloc(20 + (live.length * 8));
	value.write("SLS1", 0, "ascii"); value.writeUInt16LE(1, 4); value.writeUInt16LE(type, 6); value.writeUInt32LE(live.length, 8);
	value.writeUInt32BE(current, 16);
	live.forEach((item, index) => value.writeUInt32BE(item, 20 + (index * 8) + 4));
	return value;
}
function clock() {
	let now = 0; let next = 1; const timers = new Map();
	return {
		set(callback, ms) { const id = next++; timers.set(id, { at: now + ms, callback }); return id; },
		clear(id) { timers.delete(id); },
		advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
	};
}
function harness(overrides = {}) {
	const timers = clock(); const child = new FakeChild(); let spawns = 0; let hashes = 0; let inspections = 0; let soft = 0; let force = 0;
	const validator = createWindowsLogonSessionRealValidator({
		platform: overrides.platform ?? "win32",
		inspectHelperFile: overrides.inspectHelperFile || (async () => { inspections += 1; return { exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: 1024 }; }),
		hashHelperFile: overrides.hashHelperFile || (async () => { hashes += 1; return HASH; }),
		spawnHelper: overrides.spawnHelper || (() => { spawns += 1; return { child, knownChildControl: {} }; }),
		scheduleTimer: timers.set,
		cancelTimer: timers.clear,
		requestSoftStopKnownChild: async () => { soft += 1; },
		forceStopKnownChild: async () => { force += 1; },
		hashBytes,
		waitForIdleWithDeadline: overrides.waitForIdleWithDeadline || (async ({ waitForIdle }) => { await waitForIdle(); return true; }),
	});
	return { validator, child, timers, counts: () => ({ spawns, hashes, inspections, soft, force }) };
}
async function succeed(h, options = {}) {
	const pending = h.validator.validate(options);
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
	h.child.stdout.emit("data", snapshot()); h.child.emit("exit", 0, null); h.child.close();
	return pending;
}
async function waitForSpawn() {
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

for (const [input, code, overrides] of [
	[{ helperPath: PATH, expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid, { platform: "linux" }],
	[{ helperPath: "relative\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "\\\\server\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "\\\\?\\C:\\safe\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "C:\\safe\\other.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: PATH, expectedSha256: "A".repeat(64) }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid, {}],
]) {
	const h = harness(overrides);
	const result = await h.validator.validate(input);
	assert.equal(result.code, code); assert.equal(h.counts().inspections, 0); assert.equal(h.counts().spawns, 0);
}

for (const inspection of [
	{ exists: false, isFile: false, isSymbolicLink: false, canonicalPathMatches: false, size: 0 },
	{ exists: true, isFile: false, isSymbolicLink: false, canonicalPathMatches: true, size: 1 },
	{ exists: true, isFile: true, isSymbolicLink: true, canonicalPathMatches: true, size: 1 },
	{ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: false, size: 1 },
	{ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: 0 },
]) {
	const h = harness({ inspectHelperFile: async () => inspection });
	const result = await h.validator.validate({ helperPath: PATH, expectedSha256: HASH });
	assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness({ inspectHelperFile: async () => ({ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: (16 * 1024 * 1024) + 1 }) });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperTooLarge); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness({ hashHelperFile: async () => "b".repeat(64) });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness(); const result = await succeed(h, { helperPath: PATH, expectedSha256: HASH });
	assert.equal(result.ok, true); assert.equal(h.counts().spawns, 1); assert.equal(h.counts().hashes, 2);
	assert.equal(result.summary.providerId, "windows-logon-session-liveness"); assert.equal(result.summary.providerVersion, 1);
	assert.equal(result.summary.currentLogonType, 2); assert.equal(result.summary.sessionCount, 2); assert.equal(result.summary.runnerIdleConfirmed, true);
	assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.summary), true);
	const text = JSON.stringify(result); assert.equal(text.includes(PATH), false); assert.equal(text.includes("0000000000000002"), false); assert.equal(text.includes("bootSessionDigest"), false);
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed);
	assert.equal(h.counts().spawns, 1);
}
{
	const h = harness(); const first = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); const second = h.validator.validate({ helperPath: PATH, expectedSha256: HASH });
	assert.equal((await second).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed); await waitForSpawn(); h.child.stdout.emit("data", snapshot()); h.child.close(); assert.equal((await first).ok, true); assert.equal(h.counts().spawns, 1);
}
{
	let calls = 0;
	const h = harness({ hashHelperFile: async () => { calls += 1; return calls === 1 ? HASH : "b".repeat(64); } });
	const result = await succeed(h, { helperPath: PATH, expectedSha256: HASH }); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
}
{
	let inspections = 0;
	const h = harness({ inspectHelperFile: async () => {
		inspections += 1;
		return { exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: inspections === 1 ? 1024 : 1025 };
	} });
	const result = await succeed(h, { helperPath: PATH, expectedSha256: HASH }); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.stderr.emit("data", Buffer.from([1])); h.child.close(); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.stdout.emit("data", snapshot({ live: [2, 1] })); h.child.close(); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);
}
{
	const h = harness({ waitForIdleWithDeadline: async () => false }); const result = await succeed(h, { helperPath: PATH, expectedSha256: HASH }); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleUnconfirmed);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.timers.advance(1500); await Promise.resolve(); h.timers.advance(250); await Promise.resolve(); h.timers.advance(1250); await Promise.resolve(); h.child.close(1); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); assert.equal(h.counts().soft, 1); assert.equal(h.counts().force, 1);
}
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid), 2);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch), 3);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed), 4);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable), 5);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleUnconfirmed), 6);
console.log("windows logon-session real validator tests passed");
