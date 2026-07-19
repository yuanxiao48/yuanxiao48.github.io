import { isWindowsLogonSessionSnapshotDecoder } from "./windows-logon-session-snapshot-protocol.mjs";

const MAX_STDOUT_BYTES = 32788;
const MAX_STDERR_BYTES = 4096;

export const WINDOWS_LOGON_SESSION_HELPER_CODES = Object.freeze({
	spawnFailed: "WINDOWS_LOGON_HELPER_SPAWN_FAILED",
	childError: "WINDOWS_LOGON_HELPER_CHILD_ERROR",
	timeout: "WINDOWS_LOGON_HELPER_TIMEOUT",
	closeUnconfirmed: "WINDOWS_LOGON_HELPER_CLOSE_UNCONFIRMED",
	exitFailed: "WINDOWS_LOGON_HELPER_EXIT_FAILED",
	stdoutTooLarge: "WINDOWS_LOGON_HELPER_STDOUT_TOO_LARGE",
	stderrNotEmpty: "WINDOWS_LOGON_HELPER_STDERR_NOT_EMPTY",
	stderrTooLarge: "WINDOWS_LOGON_HELPER_STDERR_TOO_LARGE",
	streamFailed: "WINDOWS_LOGON_HELPER_STREAM_FAILED",
	protocolInvalid: "WINDOWS_LOGON_HELPER_PROTOCOL_INVALID",
	shutdown: "WINDOWS_LOGON_HELPER_SHUTDOWN",
	disposeBusy: "WINDOWS_LOGON_HELPER_DISPOSE_BUSY",
});

function freeze(value) { return Object.freeze(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function bytes(value) {
	if (Buffer.isBuffer(value)) return Buffer.from(value);
	if (typeof value === "string") return Buffer.from(value, "utf8");
	return null;
}
function validChild(value) { return record(value) && typeof value.once === "function" && typeof value.on === "function"; }
function validControl(value) { return value !== null && (typeof value === "object" || typeof value === "function"); }
function validPolicy(value) {
	return record(value)
		&& Number.isSafeInteger(value.softTimeoutMs) && value.softTimeoutMs > 0
		&& Number.isSafeInteger(value.forceGraceMs) && value.forceGraceMs > 0
		&& Number.isSafeInteger(value.hardDeadlineMs) && value.hardDeadlineMs > value.softTimeoutMs + value.forceGraceMs;
}
function failure(code) { return freeze({ ok: false, code, unavailable: true, snapshot: null }); }
function remove(emitter, event, listener) { if (typeof emitter?.removeListener === "function") emitter.removeListener(event, listener); }

export function createWindowsLogonSessionSnapshotRunner({
	spawnHelper,
	decoder,
	scheduleTimer,
	cancelTimer,
	requestSoftStopKnownChild,
	forceStopKnownChild,
	policy,
} = {}) {
	if (typeof spawnHelper !== "function" || !isWindowsLogonSessionSnapshotDecoder(decoder)
		|| typeof scheduleTimer !== "function" || typeof cancelTimer !== "function"
		|| typeof requestSoftStopKnownChild !== "function" || typeof forceStopKnownChild !== "function" || !validPolicy(policy)) {
		throw new TypeError("Windows logon-session snapshot runner dependencies are invalid");
	}

	let runPromise = null;
	let attempt = null;
	let shutdownRequested = false;
	let disposed = false;
	const idleWaiters = new Set();

	function notifyIdle() {
		if (attempt !== null) return;
		for (const resolve of idleWaiters) resolve();
		idleWaiters.clear();
	}
	function waitForIdle() { return attempt === null ? Promise.resolve() : new Promise((resolve) => idleWaiters.add(resolve)); }
	function clearTimers(state) {
		for (const timer of [state.softTimer, state.graceTimer, state.hardTimer]) if (timer !== null) cancelTimer(timer);
		state.softTimer = null;
		state.graceTimer = null;
		state.hardTimer = null;
	}
	function removeListeners(state) {
		if (!state.child) return;
		remove(state.child, "error", state.listeners.childError);
		remove(state.child, "exit", state.listeners.childExit);
		remove(state.child, "close", state.listeners.childClose);
		remove(state.child.stdout, "data", state.listeners.stdoutData);
		remove(state.child.stdout, "error", state.listeners.stdoutError);
		remove(state.child.stderr, "data", state.listeners.stderrData);
		remove(state.child.stderr, "error", state.listeners.stderrError);
	}
	function settle(state, result) {
		if (state.settled) return;
		state.settled = true;
		state.resolve(result);
	}
	function stopSoft(state) {
		if (state.softStopRequested || state.closeConfirmed || !state.control) return;
		state.softStopRequested = true;
		Promise.resolve().then(() => requestSoftStopKnownChild(state.control)).catch(() => {});
	}
	function stopForce(state) {
		if (state.forceStopRequested || state.closeConfirmed || !state.control) return;
		state.forceStopRequested = true;
		Promise.resolve().then(() => forceStopKnownChild(state.control)).catch(() => {});
	}
	function markFailure(state, code) { if (state.failureCode === null) state.failureCode = code; }
	function drain(state, stream, value) {
		const chunk = bytes(value);
		if (!chunk) { markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.streamFailed); stopSoft(state); return; }
		if (stream === "stdout") {
			state.stdoutBytes += chunk.length;
			if (state.stdoutBytes > MAX_STDOUT_BYTES) { markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.stdoutTooLarge); stopSoft(state); return; }
			state.stdoutChunks.push(chunk);
			return;
		}
		state.stderrBytes += chunk.length;
		if (state.stderrBytes > MAX_STDERR_BYTES) markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.stderrTooLarge);
		else markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.stderrNotEmpty);
		stopSoft(state);
	}
	function completionAfterClose(state) {
		if (state.failureCode) return failure(state.failureCode);
		if (state.exitCode !== 0 || state.exitSignal !== null) return failure(WINDOWS_LOGON_SESSION_HELPER_CODES.exitFailed);
		const decoded = decoder.decode(Buffer.concat(state.stdoutChunks));
		return decoded?.ok === true
			? freeze({ ok: true, code: null, unavailable: false, snapshot: decoded.snapshot })
			: failure(WINDOWS_LOGON_SESSION_HELPER_CODES.protocolInvalid);
	}
	function close(state, code, signal) {
		if (state.closeConfirmed) return;
		state.closeConfirmed = true;
		state.exitCode = Number.isSafeInteger(code) ? code : null;
		state.exitSignal = typeof signal === "string" ? signal : null;
		clearTimers(state);
		removeListeners(state);
		const result = state.settled ? null : completionAfterClose(state);
		state.stdoutChunks = [];
		attempt = null;
		notifyIdle();
		if (result) settle(state, result);
	}
	function startAttempt() {
		let resolve;
		const promise = new Promise((done) => { resolve = done; });
		const state = {
			child: null, control: null, resolve, settled: false, closeConfirmed: false,
			failureCode: null, exitCode: null, exitSignal: null, softStopRequested: false, forceStopRequested: false,
			stdoutBytes: 0, stderrBytes: 0, stdoutChunks: [], softTimer: null, graceTimer: null, hardTimer: null, listeners: {},
		};
		attempt = state;
		try {
			const spawned = spawnHelper();
			if (!record(spawned) || !validChild(spawned.child) || !validControl(spawned.knownChildControl)) throw new TypeError("invalid child adapter");
			state.child = spawned.child;
			state.control = spawned.knownChildControl;
			state.listeners = {
				childError: () => { markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.childError); stopSoft(state); },
				childExit: (code, signal) => { state.exitCode = Number.isSafeInteger(code) ? code : null; state.exitSignal = typeof signal === "string" ? signal : null; },
				childClose: (code, signal) => close(state, code, signal),
				stdoutData: (value) => drain(state, "stdout", value),
				stderrData: (value) => drain(state, "stderr", value),
				stdoutError: () => { markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.streamFailed); stopSoft(state); },
				stderrError: () => { markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.streamFailed); stopSoft(state); },
			};
			state.child.once("error", state.listeners.childError);
			state.child.once("exit", state.listeners.childExit);
			state.child.once("close", state.listeners.childClose);
			if (!state.child.stdout || !state.child.stderr || typeof state.child.stdout.on !== "function" || typeof state.child.stderr.on !== "function") throw new TypeError("missing streams");
			state.child.stdout.on("data", state.listeners.stdoutData);
			state.child.stderr.on("data", state.listeners.stderrData);
			state.child.stdout.once?.("error", state.listeners.stdoutError);
			state.child.stderr.once?.("error", state.listeners.stderrError);
			state.softTimer = scheduleTimer(() => {
				state.softTimer = null;
				markFailure(state, shutdownRequested ? WINDOWS_LOGON_SESSION_HELPER_CODES.shutdown : WINDOWS_LOGON_SESSION_HELPER_CODES.timeout);
				stopSoft(state);
			}, policy.softTimeoutMs);
			state.graceTimer = scheduleTimer(() => { state.graceTimer = null; stopForce(state); }, policy.softTimeoutMs + policy.forceGraceMs);
			state.hardTimer = scheduleTimer(() => {
				state.hardTimer = null;
				state.failureCode = WINDOWS_LOGON_SESSION_HELPER_CODES.closeUnconfirmed;
				settle(state, failure(state.failureCode));
			}, policy.hardDeadlineMs);
			if (shutdownRequested) { markFailure(state, WINDOWS_LOGON_SESSION_HELPER_CODES.shutdown); stopSoft(state); }
		} catch {
			attempt = null;
			notifyIdle();
			settle(state, failure(WINDOWS_LOGON_SESSION_HELPER_CODES.spawnFailed));
		}
		return promise;
	}

	function runOnce() {
		if (runPromise) return runPromise;
		if (disposed) return Promise.resolve(failure(WINDOWS_LOGON_SESSION_HELPER_CODES.disposeBusy));
		if (shutdownRequested) return Promise.resolve(failure(WINDOWS_LOGON_SESSION_HELPER_CODES.shutdown));
		runPromise = startAttempt();
		return runPromise;
	}
	function requestShutdown() {
		const alreadyRequested = shutdownRequested;
		shutdownRequested = true;
		if (attempt) { markFailure(attempt, WINDOWS_LOGON_SESSION_HELPER_CODES.shutdown); stopSoft(attempt); }
		return freeze({ requested: !alreadyRequested, alreadyRequested });
	}
	function dispose() {
		if (attempt !== null) return freeze({ disposed: false, code: WINDOWS_LOGON_SESSION_HELPER_CODES.disposeBusy });
		disposed = true;
		return freeze({ disposed: true, code: null });
	}
	function getSafeState() { return freeze({ activeChildCount: attempt === null ? 0 : 1, shutdownRequested, disposed }); }
	return freeze({ runOnce, requestShutdown, waitForIdle, dispose, getSafeState });
}
