import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWindowsLogonSessionLivenessProvider } from "../shared/windows-logon-session-liveness-provider.mjs";
import { WINDOWS_LOGON_SESSION_HELPER_CODES } from "../shared/windows-logon-session-snapshot-runner.mjs";
import { createWindowsLogonSessionSnapshotProtocolAuthority, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES } from "../shared/windows-logon-session-snapshot-protocol.mjs";
import {
	createWindowsLogonSessionKnownChildControl,
	createWindowsLogonSessionRealValidator,
	getWindowsLogonSessionRealValidationExitCode,
	WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES,
} from "../shared/windows-logon-session-real-validator.mjs";

const HASH = "a".repeat(64);
const EXPECTED_BASENAME = "windows-logon-session-snapshot-helper.exe";
const PATH = "C:\\safe\\bin\\windows-logon-session-snapshot-helper.exe";
const DIRECTORY = "C:\\safe\\bin";
const SYSTEM32 = "C:\\Windows\\System32";
const HELPER_ENTRY = Object.freeze({ name: "windows-logon-session-snapshot-helper.exe", isFile: true, isDirectory: false, isSymbolicLink: false });
const FILE = Object.freeze({ exists: true, isFile: true, isSymbolicLink: false, canonicalPathMatches: true, size: 1024 });
const DIRECTORY_OK = Object.freeze({ exists: true, isDirectory: true, isSymbolicLink: false, canonicalPathMatches: true, entries: [HELPER_ENTRY] });
const CWD_OK = Object.freeze({ path: SYSTEM32, exists: true, isDirectory: true, isSymbolicLink: false, canonicalPathMatches: true });

class FakeStream extends EventEmitter {
	constructor(name, events, faults) { super(); this.name = name; this.events = events; this.faults = faults; this.destroyCalls = 0; this.destroyed = false; }
	destroy() { this.destroyCalls += 1; this.events.push(`${this.name}.destroy`); if (this.faults.has(`${this.name}.destroy`)) throw new Error(`${this.name} sentinel`); this.destroyed = true; }
}

class FakeChild extends EventEmitter {
	constructor(events, faults = new Set()) {
		super(); this.events = events; this.faults = faults;
		this.stdout = new FakeStream("stdout", events, faults); this.stderr = new FakeStream("stderr", events, faults); this.stdin = new FakeStream("stdin", events, faults);
		this.killSignals = []; this.unrefCalls = 0;
	}
	kill(signal) { this.killSignals.push(signal); this.events.push(`kill:${signal}`); if (this.faults.has(`kill:${signal}`)) throw new Error("kill sentinel"); return true; }
	unref() { this.unrefCalls += 1; this.events.push("child.unref"); if (this.faults.has("child.unref")) throw new Error("unref sentinel"); }
	close(code = 0, signal = null) { this.events.push("child-close"); this.emit("close", code, signal); }
	parentRefHandleCount() { return (this.unrefCalls === 0 || this.faults.has("child.unref") ? 1 : 0) + (this.stdout.destroyed ? 0 : 1) + (this.stderr.destroyed ? 0 : 1) + (this.stdin.destroyed ? 0 : 1); }
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function snapshot({ type = 2, current = 2, live = [1, 2] } = {}) {
	const value = Buffer.alloc(20 + (live.length * 8));
	value.write("SLS1", 0, "ascii"); value.writeUInt16LE(1, 4); value.writeUInt16LE(type, 6); value.writeUInt32LE(live.length, 8);
	value.writeUInt32BE(current, 16);
	live.forEach((item, index) => value.writeUInt32BE(item, 20 + (index * 8) + 4));
	return value;
}
function directory(entries) { return { ...DIRECTORY_OK, entries }; }
function clock() {
	let now = 0; let next = 1; const timers = new Map();
	function drain() { let fired = true; while (fired) { fired = false; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); fired = true; } } }
	return Object.freeze({ set(callback, ms) { const id = next++; timers.set(id, { at: now + ms, callback }); return id; }, clear(id) { timers.delete(id); }, advance(ms) { now += ms; drain(); }, get now() { return now; }, get size() { return timers.size; }, pendingDelays() { return [...timers.values()].map((timer) => timer.at - now); } });
}
async function tick(count = 16) { for (let index = 0; index < count; index += 1) await Promise.resolve(); }

function createRunnerWrapper(realRunner, observation, options) {
	let safeStateReads = 0;
	return Object.freeze({
		runOnce() {
			observation.runnerRunOnceCalls += 1;
			return realRunner.runOnce().then((result) => { observation.runnerResultCodes.push(result.code); observation.events.push(result.ok ? "runner-result-ok" : "runner-result-failed"); return result; });
		},
		requestShutdown() { return realRunner.requestShutdown(); },
		waitForIdle() { return realRunner.waitForIdle(); },
		dispose() {
			observation.disposeCount += 1; observation.events.push("runner-dispose");
			if (options.disposeFault) throw new Error("dispose sentinel");
			return realRunner.dispose();
		},
		getSafeState() {
			safeStateReads += 1;
			const state = realRunner.getSafeState();
			if (state.activeChildCount === 0) observation.events.push(safeStateReads === 1 ? "idle-confirmed" : "active-child-zero-read");
			if (options.activeChildGate && safeStateReads === 2 && state.activeChildCount === 0) {
				observation.events.push("active-child-nonzero-read");
				return Object.freeze({ ...state, activeChildCount: 1 });
			}
			return state;
		},
	});
}

function harness(options = {}) {
	const timers = clock(); const events = []; const faults = options.faults || new Set(); const child = new FakeChild(events, faults);
	const observation = { events, spawnCount: 0, providerFactoryCount: 0, providerGetStartupStateCount: 0, disposeCount: 0, validateResolveCount: 0, successResolveCount: 0, runnerRunOnceCalls: 0, runnerResultCodes: [], containmentCount: 0 };
	let inspectCalls = 0; let directoryCalls = 0; let hashCalls = 0; let control = null; let finalRunner = null; let finalConsumer = null; let realConsumer = null;
	const inspectHelperFile = options.inspectHelperFile || (async () => { inspectCalls += 1; events.push(inspectCalls === 1 ? "pre-metadata" : "post-metadata"); return FILE; });
	const inspectHelperDirectory = options.inspectHelperDirectory || (async () => { directoryCalls += 1; events.push(directoryCalls === 1 ? "pre-directory" : "post-directory"); return DIRECTORY_OK; });
	const hashHelperFile = options.hashHelperFile || (async () => { hashCalls += 1; events.push(hashCalls === 1 ? "pre-hash" : "post-hash"); return HASH; });
	const wrapSnapshotRunner = options.wrapSnapshotRunnerValue !== undefined ? options.wrapSnapshotRunnerValue : (realRunner) => {
		if (options.invalidRunnerWrapper) return null;
		finalRunner = createRunnerWrapper(realRunner, observation, options);
		return finalRunner;
	};
	const wrapSnapshotConsumer = options.wrapSnapshotConsumerValue !== undefined ? options.wrapSnapshotConsumerValue : (consumer) => {
		if (options.invalidConsumerWrapper) return null;
		realConsumer = consumer;
		finalConsumer = Object.freeze({
			consume(value, callback) {
				events.push("real-safe-consumer-called");
				const result = consumer.consume(value, callback);
				if (options.safeSummaryFault) throw new Error("safe summary sentinel");
				return result;
			},
		});
		return finalConsumer;
	};
	const createLivenessProvider = options.createLivenessProvider || ((args) => {
		observation.providerFactoryCount += 1; events.push("provider-created");
		assert.equal(args.snapshotRunner, finalRunner); assert.equal(args.snapshotConsumer, realConsumer);
		const realProvider = createWindowsLogonSessionLivenessProvider(args);
		return Object.freeze({ getStartupState: async () => {
			observation.providerGetStartupStateCount += 1; events.push("provider-get-startup-state");
			const result = await realProvider.getStartupState(); events.push("provider-startup-state-ready"); return result;
		} });
	});
	const validator = createWindowsLogonSessionRealValidator({
		platform: options.platform ?? "win32", inspectHelperFile, inspectHelperDirectory,
		resolveTrustedWorkingDirectory: options.resolveTrustedWorkingDirectory || (async () => CWD_OK), hashHelperFile,
		spawnHelper: options.spawnHelper || ((cwd) => {
			observation.spawnCount += 1; events.push("spawn"); assert.equal(cwd, SYSTEM32);
			control = createWindowsLogonSessionKnownChildControl(child);
			return { child, knownChildControl: control };
		}),
		scheduleTimer: timers.set, cancelTimer: timers.clear, monotonicNow: () => timers.now, hashBytes,
		createLivenessProvider, wrapSnapshotRunner, wrapSnapshotConsumer,
	});
	return { validator, child, timers, events, observation, control: () => control, counts: () => ({ inspectCalls, directoryCalls, hashCalls, ...observation }) };
}

async function resolve(h, pending) {
	const result = await pending; h.observation.validateResolveCount += 1;
	if (result.ok) { h.observation.successResolveCount += 1; h.events.push("validate-resolved-success"); }
	return result;
}
async function start(h) {
	const pending = h.validator.validate({ helperPath: PATH, expectedSha256: HASH });
	for (let index = 0; index < 64; index += 1) {
		if (h.observation.spawnCount === 1) {
			await tick();
			assert.ok(h.child.listenerCount("close") >= 2);
			return Object.freeze({ pending });
		}
		await Promise.resolve();
	}
	throw new Error("fake spawn did not occur");
}
async function succeed(h, document = snapshot()) {
	const { pending } = await start(h); h.child.stdout.emit("data", document); h.child.emit("exit", 0, null); h.child.close(); return resolve(h, pending);
}
async function failAtHardDeadline(h, lateClose = false) {
	const { pending } = await start(h);
	h.timers.advance(1500); await tick(); h.timers.advance(250); await tick(); h.timers.advance(1250); await tick();
	if (lateClose) { h.timers.advance(999); h.child.close(1); await tick(); } else { assert.deepEqual(h.timers.pendingDelays(), [1000]); h.timers.advance(1000); await tick(); }
	return resolve(h, pending);
}
async function failAtSoftTimeoutBeforeHardDeadline(h) {
	const { pending } = await start(h);
	h.timers.advance(1500); await tick();
	assert.equal(h.timers.now, 1500); assert.deepEqual(h.child.killSignals, ["SIGTERM"]);
	assert.equal(h.events.includes("kill:SIGKILL"), false); assert.deepEqual(h.timers.pendingDelays().sort((left, right) => left - right), [250, 1500]);
	h.child.close(0); return resolve(h, pending);
}
function completeMalformedMagicDocument() {
	const document = snapshot(); document.write("BAD!", 0, "ascii"); return document;
}
function assertSafeFailure(result) {
	assert.equal(result.ok, false); assert.equal(result.summary, null); assert.equal(Object.isFrozen(result), true);
	const text = JSON.stringify(result);
	for (const secret of [PATH, DIRECTORY, SYSTEM32, "sentinel", "AuthenticationId", "bootSessionDigest", "0000000000000002"]) assert.equal(text.includes(secret), false, secret);
}
async function assertProviderZeroFailure(h, result, { code, exitCode, spawnCount, disposeCount }) {
	assertSafeFailure(result); assert.equal(result.code, code); assert.equal(getWindowsLogonSessionRealValidationExitCode(result.code), exitCode);
	assert.equal(h.observation.providerFactoryCount, 0); assert.equal(h.observation.providerGetStartupStateCount, 0);
	assert.equal(h.events.includes("provider-created"), false); assert.equal(h.events.includes("provider-get-startup-state"), false);
	assert.equal(h.observation.spawnCount, spawnCount); assert.equal(h.observation.disposeCount, disposeCount); assert.equal(h.timers.size, 0);
	const before = { ...h.observation }; const second = await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH }));
	assert.equal(second.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed);
	assert.equal(h.observation.spawnCount, before.spawnCount); assert.equal(h.observation.providerFactoryCount, before.providerFactoryCount); assert.equal(h.observation.providerGetStartupStateCount, before.providerGetStartupStateCount);
}

for (const [input, code] of [
	[{ helperPath: PATH, expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid],
	[{ helperPath: "relative\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid],
	[{ helperPath: "\\\\server\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid],
	[{ helperPath: "\\\\?\\C:\\safe\\windows-logon-session-snapshot-helper.exe", expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid],
	[{ helperPath: `C:\\safe\\bad\0${EXPECTED_BASENAME}`, expectedSha256: HASH }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid],
	[{ helperPath: PATH, expectedSha256: "A".repeat(64) }, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid],
]) {
	const h = harness({ platform: code === WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid ? "linux" : "win32" });
	await assertProviderZeroFailure(h, await resolve(h, h.validator.validate(input)), { code, exitCode: 2, spawnCount: 0, disposeCount: 0 });
}
for (const inspection of [{ exists: false, isFile: false, isSymbolicLink: false, canonicalPathMatches: false, size: 0 }, { ...FILE, isSymbolicLink: true }, { ...FILE, canonicalPathMatches: false }, { ...FILE, size: 0 }, { ...FILE, size: (16 * 1024 * 1024) + 1 }]) {
	const h = harness({ inspectHelperFile: async () => inspection }); const code = inspection.size > FILE.size ? WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperTooLarge : WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid;
	await assertProviderZeroFailure(h, await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH })), { code, exitCode: 2, spawnCount: 0, disposeCount: 0 });
}
for (const inspectedDirectory of [{ ...DIRECTORY_OK, isSymbolicLink: true }, { ...DIRECTORY_OK, canonicalPathMatches: false }, directory([HELPER_ENTRY, { name: "extra.dll", isFile: true, isDirectory: false, isSymbolicLink: false }])]) {
	const h = harness({ inspectHelperDirectory: async () => inspectedDirectory }); await assertProviderZeroFailure(h, await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH })), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid, exitCode: 2, spawnCount: 0, disposeCount: 0 });
}
for (const workingDirectory of [{ ...CWD_OK, path: "" }, { ...CWD_OK, path: "\\\\server\\System32" }, { ...CWD_OK, isDirectory: false }, { ...CWD_OK, isSymbolicLink: true }, { ...CWD_OK, path: DIRECTORY }]) {
	const h = harness({ resolveTrustedWorkingDirectory: async () => workingDirectory }); await assertProviderZeroFailure(h, await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH })), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid, exitCode: 2, spawnCount: 0, disposeCount: 0 });
}
{
	const h = harness({ hashHelperFile: async () => "b".repeat(64) }); await assertProviderZeroFailure(h, await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH })), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch, exitCode: 3, spawnCount: 0, disposeCount: 0 });
}
{
	const h = harness({ spawnHelper: () => { h.observation.spawnCount += 1; h.events.push("spawn"); throw new Error("spawn sentinel"); } });
	await assertProviderZeroFailure(h, await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH })), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
}
{
	const h = harness(); const { pending } = await start(h); assert.equal(h.child.listenerCount("error"), 1); h.child.emit("error", new Error("child sentinel")); h.child.close(1);
	assert.equal(h.timers.size, 0);
	await assertProviderZeroFailure(h, await resolve(h, pending), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
}
for (const document of [snapshot({ live: [2, 1] }), snapshot({ live: [1, 1], current: 1 }), snapshot({ current: 3, live: [1, 2] }), snapshot({ type: 7 }), Buffer.from("SLS1")]) {
	const h = harness(); await assertProviderZeroFailure(h, await succeed(h, document), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
}
{
	const h = harness(); const { pending } = await start(h); h.child.stderr.emit("data", Buffer.from([1])); h.child.close(); await assertProviderZeroFailure(h, await resolve(h, pending), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
}
{
	const h = harness(); const { pending } = await start(h); h.child.close(1); await assertProviderZeroFailure(h, await resolve(h, pending), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
}
{
	const h = harness(); const result = await failAtSoftTimeoutBeforeHardDeadline(h);
	await assertProviderZeroFailure(h, result, { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
	assert.deepEqual(h.observation.runnerResultCodes, [WINDOWS_LOGON_SESSION_HELPER_CODES.timeout]); assert.equal(h.events.includes("child.unref"), false);
	assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.stderr.destroyCalls, 0); assert.equal(h.child.stdin.destroyCalls, 0);
}
{
	const document = completeMalformedMagicDocument(); const decoded = createWindowsLogonSessionSnapshotProtocolAuthority().decoder.decode(document);
	assert.equal(document.length, snapshot().length); assert.equal(decoded.code, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.magicInvalid);
	for (const code of [WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.lengthInvalid, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.duplicate, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.unsorted, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.currentMissing, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.logonTypeUnsupported]) assert.notEqual(decoded.code, code);
	const h = harness(); await assertProviderZeroFailure(h, await succeed(h, document), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
	assert.deepEqual(h.observation.runnerResultCodes, [WINDOWS_LOGON_SESSION_HELPER_CODES.protocolInvalid]);
}
{
	const h = harness(); await assertProviderZeroFailure(h, await failAtHardDeadline(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired, exitCode: 6, spawnCount: 1, disposeCount: 0 });
	assert.deepEqual(h.events.slice(-4), ["stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]); assert.equal(h.control().getSafeState().containedAfterDeadline, true);
	assert.equal(h.child.parentRefHandleCount(), 0); h.control().containAfterDeadline(); assert.equal(h.child.stdout.destroyCalls, 1); assert.equal(h.child.unrefCalls, 1);
}
{
	const h = harness(); await assertProviderZeroFailure(h, await failAtHardDeadline(h, true), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, exitCode: 4, spawnCount: 1, disposeCount: 1 });
	assert.equal(h.control().getSafeState().containedAfterDeadline, false); assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.unrefCalls, 0);
}
for (const fault of ["kill:SIGKILL", "stdout.destroy", "stderr.destroy", "stdin.destroy", "child.unref"]) {
	const h = harness({ faults: new Set([fault]) }); await assertProviderZeroFailure(h, await failAtHardDeadline(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired, exitCode: 6, spawnCount: 1, disposeCount: 0 });
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
{
	const h = harness({ activeChildGate: true }); await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerStateInvalid, exitCode: 4, spawnCount: 1, disposeCount: 0 });
	assert.equal(h.events.includes("active-child-nonzero-read"), true);
}
{
	const h = harness({ safeSummaryFault: true }); await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.snapshotInvalid, exitCode: 5, spawnCount: 1, disposeCount: 1 });
	assert.equal(h.events.includes("real-safe-consumer-called"), true);
}
{
	let calls = 0; const h = harness({ inspectHelperDirectory: async () => { calls += 1; if (calls === 1) return DIRECTORY_OK; throw new Error("directory sentinel"); } });
	await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged, exitCode: 3, spawnCount: 1, disposeCount: 1 });
}
{
	let calls = 0; const h = harness({ inspectHelperFile: async () => { calls += 1; if (calls === 1) return FILE; throw new Error("metadata sentinel"); } });
	await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged, exitCode: 3, spawnCount: 1, disposeCount: 1 });
}
{
	let calls = 0; const h = harness({ hashHelperFile: async () => { calls += 1; if (calls === 1) return HASH; throw new Error("hash sentinel"); } });
	await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed, exitCode: 3, spawnCount: 1, disposeCount: 1 });
}
{
	let calls = 0; const h = harness({ inspectHelperDirectory: async () => { calls += 1; return calls === 1 ? DIRECTORY_OK : directory([HELPER_ENTRY, { name: "extra.dll", isFile: true, isDirectory: false, isSymbolicLink: false }]); } });
	await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged, exitCode: 3, spawnCount: 1, disposeCount: 1 });
}
{
	let calls = 0; const h = harness({ inspectHelperFile: async () => { calls += 1; return { ...FILE, size: calls === 1 ? FILE.size : FILE.size + 1 }; } });
	await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged, exitCode: 3, spawnCount: 1, disposeCount: 1 });
}
{
	let calls = 0; const h = harness({ hashHelperFile: async () => { calls += 1; return calls === 1 ? HASH : "b".repeat(64); } });
	await assertProviderZeroFailure(h, await succeed(h), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged, exitCode: 3, spawnCount: 1, disposeCount: 1 });
}
for (const option of ["invalidRunnerWrapper", "invalidConsumerWrapper"]) {
	const h = harness({ [option]: true }); await assertProviderZeroFailure(h, await resolve(h, h.validator.validate({ helperPath: PATH, expectedSha256: HASH })), { code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.unexpected, exitCode: 7, spawnCount: 0, disposeCount: 0 });
}
assert.throws(() => harness({ wrapSnapshotRunnerValue: null }), TypeError);
assert.throws(() => harness({ wrapSnapshotConsumerValue: null }), TypeError);
{
	const h = harness({ disposeFault: true }); const result = await succeed(h);
	assertSafeFailure(result); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed); assert.equal(h.observation.spawnCount, 1); assert.equal(h.observation.providerFactoryCount, 1); assert.equal(h.observation.providerGetStartupStateCount, 1); assert.equal(h.observation.disposeCount, 1); assert.equal(h.observation.successResolveCount, 0);
}
{
	let h; h = harness({ createLivenessProvider: () => { h.observation.providerFactoryCount += 1; h.events.push("provider-created"); throw new Error("provider factory sentinel"); } });
	const result = await succeed(h); assertSafeFailure(result); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); assert.equal(h.observation.spawnCount, 1); assert.equal(h.observation.providerFactoryCount, 1); assert.equal(h.observation.providerGetStartupStateCount, 0); assert.equal(h.observation.disposeCount, 1);
}
{
	let h; h = harness({ createLivenessProvider: (args) => {
		h.observation.providerFactoryCount += 1; h.events.push("provider-created"); const real = createWindowsLogonSessionLivenessProvider(args);
		return Object.freeze({ getStartupState: async () => { h.observation.providerGetStartupStateCount += 1; h.events.push("provider-get-startup-state"); await real.getStartupState(); throw new Error("provider get sentinel"); } });
	} });
	const result = await succeed(h); assertSafeFailure(result); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); assert.equal(h.observation.spawnCount, 1); assert.equal(h.observation.providerFactoryCount, 1); assert.equal(h.observation.providerGetStartupStateCount, 1); assert.equal(h.observation.disposeCount, 1);
}
{
	let h; h = harness({ createLivenessProvider: (args) => {
		h.observation.providerFactoryCount += 1; h.events.push("provider-created"); const real = createWindowsLogonSessionLivenessProvider(args);
		return Object.freeze({ getStartupState: async () => { h.observation.providerGetStartupStateCount += 1; h.events.push("provider-get-startup-state"); await real.getStartupState(); return Object.freeze({ ok: false, code: "safe", unavailable: true, startupState: null }); } });
	} });
	const result = await succeed(h); assertSafeFailure(result); assert.equal(result.code, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); assert.equal(h.observation.spawnCount, 1); assert.equal(h.observation.providerFactoryCount, 1); assert.equal(h.observation.providerGetStartupStateCount, 1); assert.equal(h.observation.disposeCount, 1);
}
{
	const h = harness(); const result = await succeed(h); const events = h.events;
	assert.equal(result.ok, true); assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.summary), true);
	assert.equal(h.observation.spawnCount, 1); assert.equal(h.observation.providerFactoryCount, 1); assert.equal(h.observation.providerGetStartupStateCount, 1); assert.equal(h.observation.disposeCount, 1); assert.equal(h.observation.successResolveCount, 1);
	for (const event of ["pre-directory", "pre-metadata", "pre-hash", "spawn", "child-close", "runner-result-ok", "idle-confirmed", "active-child-zero-read", "post-directory", "post-metadata", "post-hash", "real-safe-consumer-called", "provider-created", "provider-get-startup-state", "provider-startup-state-ready", "runner-dispose", "validate-resolved-success"]) assert.notEqual(events.indexOf(event), -1, event);
	function before(left, right) { assert.ok(events.indexOf(left) < events.indexOf(right), `${left} before ${right}`); }
	before("post-hash", "real-safe-consumer-called"); before("real-safe-consumer-called", "provider-created"); before("provider-startup-state-ready", "runner-dispose"); before("runner-dispose", "validate-resolved-success");
	assert.equal(h.control().getSafeState().containedAfterDeadline, false); assert.equal(h.child.stdout.destroyCalls, 0); assert.equal(h.child.unrefCalls, 0);
}

console.log("windows logon-session real validator tests passed");
