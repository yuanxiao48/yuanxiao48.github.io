import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	createWindowsLogonSessionKnownChildControl,
	createWindowsLogonSessionRealValidator,
	getWindowsLogonSessionRealValidationExitCode,
	WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES,
} from "../shared/windows-logon-session-real-validator.mjs";

const HASH = "a".repeat(64);
const PATH = "C:\\safe\\bin\\windows-logon-session-snapshot-helper.exe";
const DIRECTORY = "C:\\safe\\bin";
const SYSTEM32 = "C:\\Windows\\System32";
const HELPER_ENTRY = Object.freeze({ name: "windows-logon-session-snapshot-helper.exe", isFile: true, isDirectory: false, isSymbolicLink: false });
const FILE = Object.freeze({ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: 1024 });
const DIRECTORY_OK = Object.freeze({ exists: true, isDirectory: true, isSymbolicLink: false, canonicalPathMatches: true, entries: [HELPER_ENTRY] });
const CWD_OK = Object.freeze({ path: SYSTEM32, exists: true, isDirectory: true, isSymbolicLink: false, canonicalPathMatches: true });

class FakeStream extends EventEmitter {
	constructor() { super(); this.destroyCalls = 0; this.destroyed = false; }
	destroy() { this.destroyCalls += 1; this.destroyed = true; }
}
class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = new FakeStream(); this.stderr = new FakeStream(); this.stdin = new FakeStream();
		this.killSignals = []; this.unrefCalls = 0;
	}
	kill(signal) { this.killSignals.push(signal); return true; }
	unref() { this.unrefCalls += 1; }
	close(code = 0, signal = null) { this.emit("close", code, signal); }
	parentRefHandleCount() { return (this.unrefCalls > 0 ? 0 : 1) + (this.stdout.destroyed ? 0 : 1) + (this.stderr.destroyed ? 0 : 1) + (this.stdin.destroyed ? 0 : 1); }
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
	function drain() {
		let fired = true;
		while (fired) {
			fired = false;
			for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); fired = true; }
		}
	}
	return {
		set(callback, ms) { const id = next++; timers.set(id, { at: now + ms, callback }); return id; },
		clear(id) { timers.delete(id); },
		advance(ms) { now += ms; drain(); },
		get now() { return now; },
		get size() { return timers.size; },
		pendingDelays() { return [...timers.values()].map((timer) => timer.at - now); },
	};
}
async function tick(count = 12) { for (let index = 0; index < count; index += 1) await Promise.resolve(); }
function harness(overrides = {}) {
	const timers = clock(); const child = new FakeChild(); let spawns = 0; let hashes = 0; let inspections = 0; let directoryInspections = 0; let receivedCwd = null; let control = null;
	const validator = createWindowsLogonSessionRealValidator({
		platform: overrides.platform ?? "win32",
		inspectHelperFile: overrides.inspectHelperFile || (async () => { inspections += 1; return FILE; }),
		inspectHelperDirectory: overrides.inspectHelperDirectory || (async () => { directoryInspections += 1; return DIRECTORY_OK; }),
		resolveTrustedWorkingDirectory: overrides.resolveTrustedWorkingDirectory || (async () => CWD_OK),
		hashHelperFile: overrides.hashHelperFile || (async () => { hashes += 1; return HASH; }),
		spawnHelper: overrides.spawnHelper || ((cwd) => { spawns += 1; receivedCwd = cwd; control = createWindowsLogonSessionKnownChildControl(child); return { child, knownChildControl: control }; }),
		scheduleTimer: timers.set,
		cancelTimer: timers.clear,
		monotonicNow: () => timers.now,
		hashBytes,
	});
	return { validator, child, timers, control: () => control, counts: () => ({ spawns, hashes, inspections, directoryInspections, receivedCwd }) };
}
async function waitForSpawn() { await tick(); }
async function succeed(h, options = { helperPath: PATH, expectedSha256: HASH }) {
	const pending = h.validator.validate(options); await waitForSpawn();
	h.child.stdout.emit("data", snapshot()); h.child.emit("exit", 0, null); h.child.close();
	return pending;
}
function directory(entries) { return { ...DIRECTORY_OK, entries }; }

for (const [input, code, overrides] of [
	[{ helperPath: PATH, expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid, { platform: "linux" }],
	[{ helperPath: "relative\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "\\\\server\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "\\\\?\\C:\\safe\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "C:\\safe\\other.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: PATH, expectedSha256: "A".repeat(64) }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid, {}],
]) {
	const h = harness(overrides); const result = await h.validator.validate(input);
	assert.equal(result.code, code); assert.equal(h.counts().inspections, 0); assert.equal(h.counts().spawns, 0); assert.equal(Object.isFrozen(result), true);
}
for (const inspection of [
	{ exists: false, isFile: false, isSymbolicLink: false, canonicalPathMatches: false, size: 0 },
	{ exists: true, isFile: false, isSymbolicLink: false, canonicalPathMatches: true, size: 1 },
	{ exists: true, isFile: true, isSymbolicLink: true, canonicalPathMatches: true, size: 1 },
	{ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: false, size: 1 },
	{ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: 0 },
]) {
	const h = harness({ inspectHelperFile: async () => inspection });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness({ inspectHelperFile: async () => ({ ...FILE, size: (16 * 1024 * 1024) + 1 }) });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperTooLarge); assert.equal(h.counts().spawns, 0);
}
for (const entries of [
	[HELPER_ENTRY, { name: "extra.dll", isFile: true, isDirectory: false, isSymbolicLink: false }],
	[HELPER_ENTRY, { name: "note.txt", isFile: true, isDirectory: false, isSymbolicLink: false }],
	[HELPER_ENTRY, { name: "nested", isFile: false, isDirectory: true, isSymbolicLink: false }],
]) {
	const h = harness({ inspectHelperDirectory: async () => directory(entries) });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid); assert.equal(h.counts().spawns, 0);
}
for (const inspectedDirectory of [
	{ ...DIRECTORY_OK, isSymbolicLink: true },
	{ ...DIRECTORY_OK, canonicalPathMatches: false },
]) {
	const h = harness({ inspectHelperDirectory: async () => inspectedDirectory });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness({ inspectHelperDirectory: async () => { throw new Error("directory read failed"); } });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid); assert.equal(h.counts().spawns, 0);
}
for (const workingDirectory of [
	{ ...CWD_OK, path: "" }, { ...CWD_OK, path: "relative\\System32" }, { ...CWD_OK, path: "\\\\server\\System32" }, { ...CWD_OK, path: "\\\\?\\C:\\Windows\\System32" },
	{ ...CWD_OK, exists: false }, { ...CWD_OK, isDirectory: false }, { ...CWD_OK, isSymbolicLink: true }, { ...CWD_OK, canonicalPathMatches: false }, { ...CWD_OK, path: DIRECTORY }, { ...CWD_OK, path: `${DIRECTORY}\\System32` },
]) {
	const h = harness({ resolveTrustedWorkingDirectory: async () => workingDirectory });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness({ hashHelperFile: async () => "b".repeat(64) });
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch); assert.equal(h.counts().spawns, 0);
}
{
	const h = harness(); const result = await succeed(h);
	assert.equal(result.ok, true); assert.equal(h.counts().spawns, 1); assert.equal(h.counts().hashes, 2); assert.equal(h.counts().inspections, 2); assert.equal(h.counts().directoryInspections, 2);
	assert.equal(h.counts().receivedCwd, SYSTEM32); assert.notEqual(h.counts().receivedCwd, DIRECTORY);
	assert.equal(result.summary.providerId, "windows-logon-session-liveness"); assert.equal(result.summary.providerVersion, 1); assert.equal(result.summary.currentLogonType, 2); assert.equal(result.summary.sessionCount, 2); assert.equal(result.summary.runnerIdleConfirmed, true);
	assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.stderr.destroyCalls, 0); assert.equal(h.child.unrefCalls, 0); assert.equal(h.control().getSafeState().containedAfterDeadline, false);
	assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.summary), true);
	const text = JSON.stringify(result); assert.equal(text.includes(PATH), false); assert.equal(text.includes("0000000000000002"), false); assert.equal(text.includes("bootSessionDigest"), false);
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed); assert.equal(h.counts().spawns, 1);
}
{
	const h = harness(); const first = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); const second = h.validator.validate({ helperPath: PATH, expectedSha256: HASH });
	assert.equal((await second).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed); await waitForSpawn(); h.child.stdout.emit("data", snapshot()); h.child.close(); assert.equal((await first).ok, true); assert.equal(h.counts().spawns, 1);
}
{
	let calls = 0; const h = harness({ hashHelperFile: async () => { calls += 1; return calls === 1 ? HASH : "b".repeat(64); } });
	assert.equal((await succeed(h)).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
}
{
	let calls = 0; const h = harness({ inspectHelperFile: async () => { calls += 1; return { ...FILE, size: calls === 1 ? 1024 : 1025 }; } });
	assert.equal((await succeed(h)).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
}
{
	let calls = 0; const h = harness({ inspectHelperDirectory: async () => { calls += 1; return calls === 1 ? DIRECTORY_OK : directory([HELPER_ENTRY, { name: "extra.dll", isFile: true, isDirectory: false, isSymbolicLink: false }]); } });
	assert.equal((await succeed(h)).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.stderr.emit("data", Buffer.from([1])); h.child.close(); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.stdout.emit("data", snapshot({ live: [2, 1] })); h.child.close(); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn();
	h.timers.advance(1500); await tick(); h.timers.advance(250); await tick(); h.timers.advance(1250); await tick();
	assert.equal(h.timers.now, 3000); assert.deepEqual(h.timers.pendingDelays(), [1000]);
	h.timers.advance(1000); await tick(); const result = await pending;
	assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired); assert.equal(result.summary, null);
	assert.deepEqual(h.child.killSignals, ["SIGTERM", "SIGKILL"]); assert.equal(h.child.stdout.destroyCalls, 1); assert.equal(h.child.stderr.destroyCalls, 1); assert.equal(h.child.stdin.destroyCalls, 1); assert.equal(h.child.unrefCalls, 1); assert.equal(h.child.parentRefHandleCount(), 0); assert.equal(h.timers.size, 0);
	const state = h.control().getSafeState(); assert.equal(state.containedAfterDeadline, true); assert.equal(state.closeObserved, false); assert.equal(Object.isFrozen(state), true);
	h.control().containAfterDeadline(); assert.equal(h.child.stdout.destroyCalls, 1); assert.equal(h.child.unrefCalls, 1);
	assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed); assert.equal(h.counts().spawns, 1);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn();
	h.timers.advance(3000); await tick(); h.timers.advance(999); h.child.close(1); await tick();
	const result = await pending; assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); assert.equal(h.control().getSafeState().containedAfterDeadline, false); assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.unrefCalls, 0); assert.equal(h.timers.size, 0);
}
{
	const h = harness({ resolveTrustedWorkingDirectory: async () => ({ ...CWD_OK, path: `${DIRECTORY}\\System32` }) });
	const result = await h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); const text = JSON.stringify(result);
	assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid); assert.equal(Object.isFrozen(result), true); assert.equal(text.includes(DIRECTORY), false); assert.equal(text.includes("extra.dll"), false);
}
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid), 2);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch), 3);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed), 4);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable), 5);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired), 6);
console.log("windows logon-session real validator tests passed");
