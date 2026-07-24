import { createHostExecutionContainmentComparisonAuthority, HOST_EXECUTION_CONTAINMENT_RESULTS } from "./host-execution-containment-comparison.mjs";
import {
	serializeHostBootSessionWitness,
	WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID,
	WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION,
} from "./host-boot-session-witness.mjs";
import { createWindowsLogonSessionLivenessProvider } from "./windows-logon-session-liveness-provider.mjs";
import { createWindowsLogonSessionSnapshotProtocolAuthority } from "./windows-logon-session-snapshot-protocol.mjs";
import { createWindowsLogonSessionSnapshotRunner } from "./windows-logon-session-snapshot-runner.mjs";

const EXPECTED_BASENAME = "windows-logon-session-snapshot-helper.exe";
const EXPECTED_WORKING_DIRECTORY_BASENAME = "system32";
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const RUNNER_POLICY = Object.freeze({ softTimeoutMs: 1500, forceGraceMs: 250, hardDeadlineMs: 3000 });
const ABSOLUTE_IDLE_DEADLINE_MS = 4000;
const controls = new WeakSet();

export const WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES = Object.freeze({
	alreadyUsed: "WINDOWS_LOGON_REAL_VALIDATION_ALREADY_USED",
	platformInvalid: "WINDOWS_LOGON_REAL_VALIDATION_PLATFORM_INVALID",
	helperPathInvalid: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_PATH_INVALID",
	expectedHashInvalid: "WINDOWS_LOGON_REAL_VALIDATION_EXPECTED_HASH_INVALID",
	helperFileInvalid: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_FILE_INVALID",
	helperDirectoryInvalid: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_DIRECTORY_INVALID",
	helperTooLarge: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_TOO_LARGE",
	trustedWorkingDirectoryInvalid: "WINDOWS_LOGON_REAL_VALIDATION_TRUSTED_WORKING_DIRECTORY_INVALID",
	helperHashFailed: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_HASH_FAILED",
	helperHashMismatch: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_HASH_MISMATCH",
	helperChanged: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_CHANGED",
	helperDirectoryChanged: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_DIRECTORY_CHANGED",
	runnerFailed: "WINDOWS_LOGON_REAL_VALIDATION_RUNNER_FAILED",
	idleContainmentRequired: "WINDOWS_LOGON_REAL_VALIDATION_IDLE_CONTAINMENT_REQUIRED",
	runnerStateInvalid: "WINDOWS_LOGON_REAL_VALIDATION_RUNNER_STATE_INVALID",
	runnerDisposeFailed: "WINDOWS_LOGON_REAL_VALIDATION_RUNNER_DISPOSE_FAILED",
	snapshotInvalid: "WINDOWS_LOGON_REAL_VALIDATION_SNAPSHOT_INVALID",
	providerUnavailable: "WINDOWS_LOGON_REAL_VALIDATION_PROVIDER_UNAVAILABLE",
	containmentInvalid: "WINDOWS_LOGON_REAL_VALIDATION_CONTAINMENT_INVALID",
	unexpected: "WINDOWS_LOGON_REAL_VALIDATION_UNEXPECTED",
});

export const WINDOWS_LOGON_SESSION_REAL_VALIDATION_POLICY = Object.freeze({
	helperBasename: EXPECTED_BASENAME,
	maxHelperBytes: MAX_HELPER_BYTES,
	runner: RUNNER_POLICY,
	absoluteIdleDeadlineMs: ABSOLUTE_IDLE_DEADLINE_MS,
});

export function getWindowsLogonSessionRealValidationExitCode(code) {
	if ([WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid,
		WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid,
		WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperTooLarge,
		WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid].includes(code)) return 2;
	if ([WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch,
		WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged].includes(code)) return 3;
	if ([WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerStateInvalid,
		WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed].includes(code)) return 4;
	if ([WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.snapshotInvalid, WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable,
		WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.containmentInvalid].includes(code)) return 5;
	if (code === WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired) return 6;
	return 7;
}

function freeze(value) { return Object.freeze(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(code) { return freeze({ ok: false, code, summary: null }); }
function identity(value) { return value; }
function normalizedWindowsPath(value) { return value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(); }
function localDrivePath(value) {
	return typeof value === "string" && value.length > 0 && !value.includes("\0")
		&& !value.startsWith("\\\\") && !value.startsWith("\\\\?\\") && !value.startsWith("\\\\.\\")
		&& /^[A-Za-z]:\\/.test(value);
}
function helperDirectory(value) { return value.slice(0, value.lastIndexOf("\\")); }

function validWindowsHelperPath(value) {
	if (!localDrivePath(value)) return false;
	const parts = value.split("\\");
	return parts.at(-1)?.toLowerCase() === EXPECTED_BASENAME;
}
function validInspection(value) {
	return record(value) && value.exists === true && value.isFile === true && value.isSymbolicLink === false
		&& value.canonicalPathMatches === true && Number.isSafeInteger(value.size) && value.size > 0;
}
function validDirectory(value) {
	return record(value) && value.exists === true && value.isDirectory === true
		&& value.isSymbolicLink === false && value.canonicalPathMatches === true;
}
function validHelperDirectory(value) {
	if (!validDirectory(value) || !Array.isArray(value.entries) || value.entries.length !== 1) return false;
	const [entry] = value.entries;
	return record(entry) && typeof entry.name === "string" && entry.name.toLowerCase() === EXPECTED_BASENAME
		&& entry.isFile === true && entry.isDirectory === false && entry.isSymbolicLink === false;
}
function validWorkingDirectory(value, expectedDirectory) {
	return validDirectory(value) && typeof value.path === "string" && localDrivePath(value.path)
		&& value.path.split("\\").at(-1)?.toLowerCase() === EXPECTED_WORKING_DIRECTORY_BASENAME
		&& normalizedWindowsPath(value.path) !== normalizedWindowsPath(expectedDirectory)
		&& !normalizedWindowsPath(value.path).startsWith(`${normalizedWindowsPath(expectedDirectory)}\\`);
}
function validRunner(value) {
	return record(value) && typeof value.runOnce === "function" && typeof value.requestShutdown === "function"
		&& typeof value.waitForIdle === "function" && typeof value.dispose === "function" && typeof value.getSafeState === "function";
}
function validSnapshotConsumer(value) { return record(value) && typeof value.consume === "function"; }
function validDependencies(value) {
	return record(value) && typeof value.inspectHelperFile === "function" && typeof value.inspectHelperDirectory === "function"
		&& typeof value.resolveTrustedWorkingDirectory === "function" && typeof value.hashHelperFile === "function"
		&& typeof value.spawnHelper === "function" && typeof value.scheduleTimer === "function" && typeof value.cancelTimer === "function"
		&& typeof value.monotonicNow === "function" && typeof value.hashBytes === "function"
		&& (value.createLivenessProvider === undefined || typeof value.createLivenessProvider === "function")
		&& (value.wrapSnapshotRunner === undefined || typeof value.wrapSnapshotRunner === "function")
		&& (value.wrapSnapshotConsumer === undefined || typeof value.wrapSnapshotConsumer === "function");
}

export function isWindowsLogonSessionKnownChildControl(value) { return controls.has(value); }

export function createWindowsLogonSessionKnownChildControl(child) {
	if (!record(child) || typeof child.kill !== "function" || typeof child.unref !== "function" || typeof child.once !== "function") {
		throw new TypeError("Windows logon-session known child is invalid");
	}
	const state = {
		closeObserved: false,
		softStopRequested: false, softStopAttempted: false, softStopSucceeded: false,
		forceStopRequested: false, forceStopAttempted: false, forceStopSucceeded: false,
		stdoutReleaseAttempted: false, stdoutReleased: false,
		stderrReleaseAttempted: false, stderrReleased: false,
		stdinReleaseAttempted: false, stdinReleased: false,
		childUnrefAttempted: false, childUnrefed: false,
		containedAfterDeadline: false,
	};
	child.once("close", () => { state.closeObserved = true; });
	function request(signal, requestedKey, attemptedKey, succeededKey) {
		if (state[requestedKey]) return freeze({ requested: false, alreadyRequested: true, succeeded: state[succeededKey] });
		state[requestedKey] = true;
		state[attemptedKey] = true;
		try { state[succeededKey] = child.kill(signal) !== false; } catch {}
		return freeze({ requested: true, alreadyRequested: false, succeeded: state[succeededKey] });
	}
	function release(streamName, attemptedKey, succeededKey) {
		if (state[attemptedKey]) return;
		if (!child[streamName]) return;
		state[attemptedKey] = true;
		try { child[streamName].destroy(); state[succeededKey] = true; } catch {}
	}
	function requestSoftStop() { return request("SIGTERM", "softStopRequested", "softStopAttempted", "softStopSucceeded"); }
	function requestForceStop() { return request("SIGKILL", "forceStopRequested", "forceStopAttempted", "forceStopSucceeded"); }
	function containAfterDeadline() {
		if (state.containedAfterDeadline) return getSafeState();
		state.containedAfterDeadline = true;
		requestForceStop();
		release("stdout", "stdoutReleaseAttempted", "stdoutReleased");
		release("stderr", "stderrReleaseAttempted", "stderrReleased");
		release("stdin", "stdinReleaseAttempted", "stdinReleased");
		if (!state.childUnrefAttempted) { state.childUnrefAttempted = true; try { child.unref(); state.childUnrefed = true; } catch {} }
		return getSafeState();
	}
	function getSafeState() { return freeze({ ...state }); }
	const control = freeze({ requestSoftStop, requestForceStop, containAfterDeadline, getSafeState });
	controls.add(control);
	return control;
}

async function confirmIdleBeforeDeadline({ runner, control, deadline, monotonicNow, scheduleTimer, cancelTimer }) {
	if (runner.getSafeState().activeChildCount === 0) return true;
	const remaining = deadline - monotonicNow();
	if (!Number.isFinite(remaining) || remaining <= 0) { control?.containAfterDeadline?.(); return false; }
	let timer = null;
	let settled = false;
	try {
		return await new Promise((resolve) => {
			const finish = (value) => {
				if (settled) return;
				settled = true;
				if (timer !== null) cancelTimer(timer);
				resolve(value);
			};
			timer = scheduleTimer(() => { control?.containAfterDeadline?.(); finish(false); }, remaining);
			Promise.resolve().then(() => runner.waitForIdle()).then(() => finish(true), () => finish(false));
		});
	} catch {
		return false;
	} finally {
		if (timer !== null) cancelTimer(timer);
	}
}

function safeSummary(snapshotConsumer, snapshot) {
	let consumed;
	try {
		consumed = snapshotConsumer.consume(snapshot, ({ currentLogonType, liveLuidBytes }) => freeze({ currentLogonType, sessionCount: liveLuidBytes.length }));
	} catch {
		return null;
	}
	if (!consumed?.ok || !record(consumed.value) || !Number.isSafeInteger(consumed.value.currentLogonType) || !Number.isSafeInteger(consumed.value.sessionCount)) return null;
	return consumed.value;
}

export function createWindowsLogonSessionRealValidator(dependencies = {}) {
	if (!validDependencies(dependencies)) throw new TypeError("Windows logon-session real validator dependencies are invalid");
	const createLivenessProvider = dependencies.createLivenessProvider || createWindowsLogonSessionLivenessProvider;
	const wrapSnapshotRunner = dependencies.wrapSnapshotRunner || identity;
	const wrapSnapshotConsumer = dependencies.wrapSnapshotConsumer || identity;
	let used = false;
	async function validate({ helperPath, expectedSha256 } = {}) {
		if (used) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed);
		used = true;
		if (dependencies.platform !== "win32") return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid);
		if (!validWindowsHelperPath(helperPath)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid);
		if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid);
		const directory = helperDirectory(helperPath);
		let directoryInspection;
		try { directoryInspection = await dependencies.inspectHelperDirectory(directory); } catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid); }
		if (!validHelperDirectory(directoryInspection)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryInvalid);
		let inspection;
		try { inspection = await dependencies.inspectHelperFile(helperPath); } catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid); }
		if (!validInspection(inspection)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid);
		if (inspection.size > MAX_HELPER_BYTES) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperTooLarge);
		let trustedWorkingDirectory;
		try { trustedWorkingDirectory = await dependencies.resolveTrustedWorkingDirectory(); } catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid); }
		if (!validWorkingDirectory(trustedWorkingDirectory, directory)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.trustedWorkingDirectoryInvalid);
		let initialHash;
		try { initialHash = await dependencies.hashHelperFile(helperPath); } catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed); }
		if (typeof initialHash !== "string" || !SHA256.test(initialHash)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed);
		if (initialHash !== expectedSha256) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch);

		const protocol = createWindowsLogonSessionSnapshotProtocolAuthority();
		let snapshotConsumer;
		try {
			snapshotConsumer = wrapSnapshotConsumer(protocol.snapshotConsumer);
			if (!validSnapshotConsumer(snapshotConsumer)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.unexpected);
		} catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.unexpected); }
		const containmentAuthority = createHostExecutionContainmentComparisonAuthority();
		let control = null;
		let runner;
		try {
			const realRunner = createWindowsLogonSessionSnapshotRunner({
				spawnHelper: () => {
					const spawned = dependencies.spawnHelper(trustedWorkingDirectory.path);
					if (!record(spawned) || !isWindowsLogonSessionKnownChildControl(spawned.knownChildControl)) throw new TypeError("known child control is invalid");
					control = spawned.knownChildControl;
					return spawned;
				},
				decoder: protocol.decoder,
				scheduleTimer: dependencies.scheduleTimer,
				cancelTimer: dependencies.cancelTimer,
				requestSoftStopKnownChild: (knownChildControl) => knownChildControl.requestSoftStop(),
				forceStopKnownChild: (knownChildControl) => knownChildControl.requestForceStop(),
				policy: RUNNER_POLICY,
			});
			runner = wrapSnapshotRunner(realRunner);
			if (!validRunner(runner)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.unexpected);
		} catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.unexpected); }
		const attemptStart = dependencies.monotonicNow();
		const absoluteIdleDeadline = attemptStart + ABSOLUTE_IDLE_DEADLINE_MS;
		let run;
		try {
			run = await runner.runOnce();
		} catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed); }
		const idleConfirmed = await confirmIdleBeforeDeadline({ runner, control, deadline: absoluteIdleDeadline, monotonicNow: dependencies.monotonicNow, scheduleTimer: dependencies.scheduleTimer, cancelTimer: dependencies.cancelTimer });
		if (idleConfirmed !== true) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleContainmentRequired);
		if (runner.getSafeState().activeChildCount !== 0) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerStateInvalid);
		function disposeAfterIdle(code) {
			try {
				const disposed = runner.dispose();
				return disposed?.disposed === true ? failure(code) : failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed);
			} catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed); }
		}
		if (!run?.ok || !run.snapshot) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);

		let postDirectoryInspection;
		try { postDirectoryInspection = await dependencies.inspectHelperDirectory(directory); } catch { return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged); }
		if (!validHelperDirectory(postDirectoryInspection)) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperDirectoryChanged);
		let postInspection;
		try { postInspection = await dependencies.inspectHelperFile(helperPath); } catch { return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged); }
		if (!validInspection(postInspection) || postInspection.size !== inspection.size) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
		let postHash;
		try { postHash = await dependencies.hashHelperFile(helperPath); } catch { return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed); }
		if (postHash !== expectedSha256 || postHash !== initialHash) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
		const snapshot = safeSummary(snapshotConsumer, run.snapshot);
		if (!snapshot) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.snapshotInvalid);
		let provider;
		let providerResult;
		try {
			provider = createLivenessProvider({ snapshotRunner: runner, snapshotConsumer: protocol.snapshotConsumer, containmentAuthority, hash: dependencies.hashBytes });
			providerResult = await provider.getStartupState();
		} catch { return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable); }
		if (!providerResult?.ok || providerResult.unavailable === true || !providerResult.startupState) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable);
		const witness = containmentAuthority.startupStateConsumer.getCurrentWitness(providerResult.startupState);
		const serializedWitness = serializeHostBootSessionWitness(witness);
		const compared = containmentAuthority.startupStateConsumer.comparePersistedWitness(providerResult.startupState, witness);
		if (!serializedWitness || serializedWitness.providerId !== WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID
			|| serializedWitness.providerVersion !== WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION
			|| compared?.classification !== HOST_EXECUTION_CONTAINMENT_RESULTS.retained) return disposeAfterIdle(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.containmentInvalid);
		try {
			const disposed = runner.dispose();
			if (disposed?.disposed !== true) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed);
		} catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed); }
		return freeze({ ok: true, code: null, summary: freeze({ schemaVersion: 1, providerId: WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID, providerVersion: WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION, currentLogonType: snapshot.currentLogonType, sessionCount: snapshot.sessionCount, helperSha256: expectedSha256, runnerIdleConfirmed: true }) });
	}
	return freeze({ validate });
}
