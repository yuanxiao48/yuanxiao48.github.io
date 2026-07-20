import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWindowsLogonSessionLivenessProvider } from "../shared/windows-logon-session-liveness-provider.mjs";
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
	constructor(name, events, faults) { super(); this.name = name; this.events = events; this.faults = faults; this.destroyCalls = 0; this.destroyed = false; }
	destroy() { this.destroyCalls += 1; this.events.push(`${this.name}.destroy`); if (this.faults.has(`${this.name}.destroy`)) throw new Error(`${this.name} destroy`); this.destroyed = true; }
}
class FakeChild extends EventEmitter {
	constructor(events, faults = new Set()) {
		super(); this.events = events; this.faults = faults;
		this.stdout = new FakeStream("stdout", events, faults); this.stderr = new FakeStream("stderr", events, faults); this.stdin = new FakeStream("stdin", events, faults);
		this.killSignals = []; this.unrefCalls = 0;
	}
	kill(signal) { this.killSignals.push(signal); this.events.push(`kill:${signal}`); if (this.faults.has(`kill:${signal}`)) throw new Error("kill"); return true; }
	unref() { this.unrefCalls += 1; this.events.push("child.unref"); if (this.faults.has("child.unref")) throw new Error("unref"); }
	close(code = 0, signal = null) { this.events.push("close"); this.emit("close", code, signal); }
	parentRefHandleCount() { return (this.unrefCalls === 0 || this.faults.has("child.unref") ? 1 : 0) + (this.stdout.destroyed ? 0 : 1) + (this.stderr.destroyed ? 0 : 1) + (this.stdin.destroyed ? 0 : 1); }
}
function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function snapshot({ type = 2, current = 2, live = [1, 2] } = {}) {
	const value = Buffer.alloc(20 + (live.length * 8));
	value.write("SLS1", 0, "ascii"); value.writeUInt16LE(1, 4); value.writeUInt16LE(type, 6); value.writeUInt32LE(live.length, 8);
	value.writeUInt32BE(current, 16); live.forEach((item, index) => value.writeUInt32BE(item, 20 + (index * 8) + 4));
	return value;
}
function clock() {
	let now = 0; let next = 1; const timers = new Map();
	function drain() { let fired = true; while (fired) { fired = false; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); fired = true; } } }
	return { set(callback, ms) { const id = next++; timers.set(id, { at: now + ms, callback }); return id; }, clear(id) { timers.delete(id); }, advance(ms) { now += ms; drain(); }, get now() { return now; }, get size() { return timers.size; }, pendingDelays() { return [...timers.values()].map((timer) => timer.at - now); } };
}
async function tick(count = 14) { for (let index = 0; index < count; index += 1) await Promise.resolve(); }
function directory(entries) { return { ...DIRECTORY_OK, entries }; }
function harness(overrides = {}) {
	const timers = clock(); const events = []; const faults = overrides.faults || new Set(); const child = new FakeChild(events, faults);
	let spawns = 0; let hashes = 0; let inspections = 0; let directoryInspections = 0; let control = null; let factoryCalls = 0; let providerGets = 0;
	const inspectHelperFile = overrides.inspectHelperFile || (async () => { inspections += 1; events.push(inspections === 1 ? "pre-metadata" : "post-metadata"); return FILE; });
	const inspectHelperDirectory = overrides.inspectHelperDirectory || (async () => { directoryInspections += 1; events.push(directoryInspections === 1 ? "pre-directory" : "post-directory"); return DIRECTORY_OK; });
	const hashHelperFile = overrides.hashHelperFile || (async () => { hashes += 1; events.push(hashes === 1 ? "pre-hash" : "post-hash"); return HASH; });
	const createLivenessProvider = overrides.createLivenessProvider || ((args) => {
		factoryCalls += 1; events.push("provider-created");
		assert.equal(args.snapshotRunner.getSafeState().activeChildCount, 0); assert.equal(inspections, 2); assert.equal(directoryInspections, 2); assert.equal(hashes, 2);
		const real = createWindowsLogonSessionLivenessProvider(args);
		return Object.freeze({ getStartupState: async () => { providerGets += 1; events.push("provider-get-startup-state"); return real.getStartupState(); } });
	});
	const validator = createWindowsLogonSessionRealValidator({
		platform: overrides.platform ?? "win32", inspectHelperFile, inspectHelperDirectory,
		resolveTrustedWorkingDirectory: overrides.resolveTrustedWorkingDirectory || (async () => CWD_OK), hashHelperFile,
		spawnHelper: overrides.spawnHelper || ((cwd) => { spawns += 1; events.push("spawn"); assert.equal(cwd, SYSTEM32); control = createWindowsLogonSessionKnownChildControl(child); return { child, knownChildControl: control }; }),
		scheduleTimer: timers.set, cancelTimer: timers.clear, monotonicNow: () => timers.now, hashBytes, createLivenessProvider,
	});
	return { validator, child, timers, events, control: () => control, counts: () => ({ spawns, hashes, inspections, directoryInspections, factoryCalls, providerGets }) };
}
async function waitForSpawn() { await tick(); }
async function succeed(h, document = snapshot()) { const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.stdout.emit("data", document); h.child.emit("exit", 0, null); h.child.close(); return pending; }
async function failAtHardDeadline(h, { lateClose = false } = {}) {
	const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn();
	h.timers.advance(1500); await tick(); h.timers.advance(250); await tick(); h.timers.advance(1250); await tick();
	if (lateClose) { h.timers.advance(999); h.child.close(1); await tick(); } else { assert.deepEqual(h.timers.pendingDelays(), [1000]); h.timers.advance(1000); await tick(); }
	return pending;
}

for (const [input, code, overrides] of [
	[{ helperPath: PATH, expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid, { platform: "linux" }],
	[{ helperPath: "relative\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: "\\\\server\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid, {}],
	[{ helperPath: PATH, expectedSha256: "A".repeat(64) }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid, {}],
]) { const h = harness(overrides); assert.equal((await h.validator.validate(input)).code, code); assert.equal(h.counts().spawns, 0); assert.equal(h.counts().factoryCalls, 0); }
for (const inspection of [{ exists: false, isFile: false, isSymbolicLink: false, canonicalPathMatches: false, size: 0 }, { ...FILE, isSymbolicLink: true }, { ...FILE, canonicalPathMatches: false }, { ...FILE, size: 0 }]) {
	const h = harness({ inspectHelperFile: async () => inspection }); assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid); assert.equal(h.counts().factoryCalls, 0);
}
for (const entries of [[HELPER_ENTRY, { name: "extra.dll", isFile: true, isDirectory: false, isSymbolicLink: false }], [HELPER_ENTRY, { name: "note.txt", isFile: true, isDirectory: false, isSymbolicLink: false }], [HELPER_ENTRY, { name: "nested", isFile: false, isDirectory: true, isSymbolicLink: false }]]) {
	const h = harness({ inspectHelperDirectory: async () => directory(entries) }); assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid); assert.equal(h.counts().factoryCalls, 0);
}
for (const workingDirectory of [{ ...CWD_OK, path: "" }, { ...CWD_OK, path: "\\\\server\\System32" }, { ...CWD_OK, isDirectory: false }, { ...CWD_OK, isSymbolicLink: true }, { ...CWD_OK, path: DIRECTORY }]) {
	const h = harness({ resolveTrustedWorkingDirectory: async () => workingDirectory }); assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid); assert.equal(h.counts().factoryCalls, 0);
}
{
	const h = harness({ hashHelperFile: async () => "b".repeat(64) }); assert.equal((await h.validator.validate({ helperPath: PATH, expectedSha256: HASH })).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch); assert.equal(h.counts().factoryCalls, 0);
}
{
	const h = harness(); const result = await succeed(h); const counts = h.counts();
	assert.equal(result.ok, true); assert.deepEqual(counts, { spawns: 1, hashes: 2, inspections: 2, directoryInspections: 2, factoryCalls: 1, providerGets: 1 });
	assert.deepEqual(h.events, ["pre-directory", "pre-metadata", "pre-hash", "spawn", "close", "post-directory", "post-metadata", "post-hash", "provider-created", "provider-get-startup-state"]);
	assert.equal(h.control().getSafeState().containedAfterDeadline, false); assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.unrefCalls, 0); assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.summary), true);
	const text = JSON.stringify(result); assert.equal(text.includes(PATH), false); assert.equal(text.includes("0000000000000002"), false); assert.equal(text.includes("bootSessionDigest"), false);
}
{
	const h = harness(); const first = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); const second = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); assert.equal((await second).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed); await waitForSpawn(); h.child.stdout.emit("data", snapshot()); h.child.close(); assert.equal((await first).ok, true); assert.equal(h.counts().spawns, 1);
}
for (const document of [snapshot({ live: [2, 1] }), snapshot({ current: 3, live: [1, 2] }), snapshot({ type: 7 }), Buffer.from("SLS1")]) {
	const h = harness(); const result = await succeed(h, document); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); assert.equal(h.counts().factoryCalls, 0);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.stderr.emit("data", Buffer.from([1])); h.child.close(); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); assert.equal(h.counts().factoryCalls, 0);
}
{
	const h = harness(); const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH }); await waitForSpawn(); h.child.close(1); assert.equal((await pending).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); assert.equal(h.counts().factoryCalls, 0);
}
{
	const h = harness(); const result = await failAtHardDeadline(h); const counts = h.counts();
	assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired); assert.equal(result.summary, null); assert.equal(counts.factoryCalls, 0); assert.equal(counts.providerGets, 0); assert.equal(h.timers.size, 0);
	assert.deepEqual(h.events, ["pre-directory", "pre-metadata", "pre-hash", "spawn", "kill:SIGTERM", "kill:SIGKILL", "stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]);
	assert.equal(h.child.parentRefHandleCount(), 0); h.control().containAfterDeadline(); assert.equal(h.child.stdout.destroyCalls, 1); assert.equal(h.child.unrefCalls, 1);
}
{
	const h = harness(); const result = await failAtHardDeadline(h, { lateClose: true }); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); assert.equal(h.counts().factoryCalls, 0); assert.equal(h.control().getSafeState().containedAfterDeadline, false); assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.unrefCalls, 0); assert.equal(h.timers.size, 0);
}
{
	let calls = 0; const h = harness({ inspectHelperDirectory: async () => { calls += 1; return calls === 1 ? DIRECTORY_OK : directory([HELPER_ENTRY, { name: "extra.dll", isFile: true, isDirectory: false, isSymbolicLink: false }]); } }); assert.equal((await succeed(h)).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged); assert.equal(h.counts().factoryCalls, 0);
}
{
	let calls = 0; const h = harness({ inspectHelperFile: async () => { calls += 1; return { ...FILE, size: calls === 1 ? 1024 : 1025 }; } }); assert.equal((await succeed(h)).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged); assert.equal(h.counts().factoryCalls, 0);
}
{
	let calls = 0; const h = harness({ hashHelperFile: async () => { calls += 1; return calls === 1 ? HASH : "b".repeat(64); } }); assert.equal((await succeed(h)).code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged); assert.equal(h.counts().factoryCalls, 0);
}
for (const fault of ["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]) {
	const events = []; const child = new FakeChild(events, new Set([fault])); const control = createWindowsLogonSessionKnownChildControl(child); const state = control.containAfterDeadline();
	assert.equal(Object.isFrozen(state), true); assert.deepEqual(events, ["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]);
	assert.equal(state.containedAfterDeadline, true); assert.equal(state.forceStopAttempted, true); assert.equal(state.forceStopSucceeded, fault !== "kill:SIGKILL");
	assert.equal(state.stdoutReleased, fault !== "stdout.destroy"); assert.equal(state.stderrReleased, fault !== "stderr.destroy"); assert.equal(state.stdinReleased, fault !== "stdin.destroy"); assert.equal(state.childUnrefed, fault !== "child.unref");
	control.containAfterDeadline(); assert.deepEqual(events, ["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]);
}
{
	const events = []; const child = new FakeChild(events); const control = createWindowsLogonSessionKnownChildControl(child);
	control.requestSoftStop(); control.requestSoftStop(); control.requestForceStop(); control.requestForceStop();
	assert.deepEqual(events, ["kill:SIGTERM", "kill:SIGKILL"]); assert.equal(control.getSafeState().softStopSucceeded, true); assert.equal(control.getSafeState().forceStopSucceeded, true);
}
for (const fault of ["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]) {
	const h = harness({ faults: new Set([fault]) }); const result = await failAtHardDeadline(h); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired); assert.equal(result.summary, null); assert.equal(h.counts().factoryCalls, 0); assert.equal(h.counts().spawns, 1);
}
{
	const h = harness({ createLivenessProvider: () => { throw new Error("factory"); } }); const result = await succeed(h); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); assert.equal(h.counts().spawns, 1);
}
{
	const h = harness({ createLivenessProvider: (args) => { const real = createWindowsLogonSessionLivenessProvider(args); return Object.freeze({ getStartupState: async () => { await real.getStartupState(); throw new Error("provider"); } }); } }); const result = await succeed(h); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); assert.equal(h.counts().spawns, 1);
}
{
	const h = harness({ createLivenessProvider: (args) => { const real = createWindowsLogonSessionLivenessProvider(args); return Object.freeze({ getStartupState: async () => { await real.getStartupState(); return Object.freeze({ ok: false, code: "safe", unavailable: true, startupState: null }); } }); } }); const result = await succeed(h); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); assert.equal(h.counts().spawns, 1);
}
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid), 2);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch), 3);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed), 4);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable), 5);
assert.equal(getWindowsLogonSessionRealValidationExitCode(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired), 6);
console.log("windows logon-session real validator tests passed");
