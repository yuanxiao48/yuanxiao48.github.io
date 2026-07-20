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
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const RUNNER_POLICY = Object.freeze({ softTimeoutMs: 1500, forceGraceMs: 250, hardDeadlineMs: 3000 });
const IDLE_CONFIRMATION_TIMEOUT_MS = 4000;

export const WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES = Object.freeze({
	alreadyUsed: "WINDOWS_LOGON_REAL_VALIDATION_ALREADY_USED",
	platformInvalid: "WINDOWS_LOGON_REAL_VALIDATION_PLATFORM_INVALID",
	helperPathInvalid: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_PATH_INVALID",
	expectedHashInvalid: "WINDOWS_LOGON_REAL_VALIDATION_EXPECTED_HASH_INVALID",
	helperFileInvalid: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_FILE_INVALID",
	helperTooLarge: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_TOO_LARGE",
	helperHashFailed: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_HASH_FAILED",
	helperHashMismatch: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_HASH_MISMATCH",
	helperChanged: "WINDOWS_LOGON_REAL_VALIDATION_HELPER_CHANGED",
	runnerFailed: "WINDOWS_LOGON_REAL_VALIDATION_RUNNER_FAILED",
	idleUnconfirmed: "WINDOWS_LOGON_REAL_VALIDATION_IDLE_UNCONFIRMED",
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
	idleConfirmationTimeoutMs: IDLE_CONFIRMATION_TIMEOUT_MS,
});

function freeze(value) { return Object.freeze(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(code) { return freeze({ ok: false, code, summary: null }); }

function validWindowsHelperPath(value) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
	if (value.startsWith("\\\\") || value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) return false;
	if (!/^[A-Za-z]:\\/.test(value)) return false;
	const parts = value.split("\\");
	return parts.at(-1)?.toLowerCase() === EXPECTED_BASENAME;
}

function validInspection(value) {
	return record(value)
		&& value.exists === true
		&& value.isFile === true
		&& value.isSymbolicLink === false
		&& value.canonicalPathMatches === true
		&& Number.isSafeInteger(value.size)
		&& value.size > 0;
}

function validDependencies(value) {
	return record(value)
		&& typeof value.inspectHelperFile === "function"
		&& typeof value.hashHelperFile === "function"
		&& typeof value.spawnHelper === "function"
		&& typeof value.scheduleTimer === "function"
		&& typeof value.cancelTimer === "function"
		&& typeof value.requestSoftStopKnownChild === "function"
		&& typeof value.forceStopKnownChild === "function"
		&& typeof value.hashBytes === "function"
		&& typeof value.waitForIdleWithDeadline === "function";
}

function safeSummary(snapshotConsumer, snapshot) {
	const consumed = snapshotConsumer.consume(snapshot, ({ currentLogonType, liveLuidBytes }) => freeze({
		currentLogonType,
		sessionCount: liveLuidBytes.length,
	}));
	if (!consumed?.ok || !record(consumed.value)
		|| !Number.isSafeInteger(consumed.value.currentLogonType)
		|| !Number.isSafeInteger(consumed.value.sessionCount)) return null;
	return consumed.value;
}

export function createWindowsLogonSessionRealValidator(dependencies = {}) {
	if (!validDependencies(dependencies)) throw new TypeError("Windows logon-session real validator dependencies are invalid");
	let used = false;

	async function validate({ helperPath, expectedSha256 } = {}) {
		if (used) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.alreadyUsed);
		used = true;
		if (dependencies.platform !== "win32") return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.platformInvalid);
		if (!validWindowsHelperPath(helperPath)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid);
		if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.expectedHashInvalid);

		let inspection;
		try { inspection = await dependencies.inspectHelperFile(helperPath); }
		catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid); }
		if (!validInspection(inspection)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperFileInvalid);
		if (inspection.size > MAX_HELPER_BYTES) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperTooLarge);

		let initialHash;
		try { initialHash = await dependencies.hashHelperFile(helperPath); }
		catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed); }
		if (typeof initialHash !== "string" || !SHA256.test(initialHash)) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed);
		if (initialHash !== expectedSha256) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashMismatch);

		const protocol = createWindowsLogonSessionSnapshotProtocolAuthority();
		const containmentAuthority = createHostExecutionContainmentComparisonAuthority();
		let runner;
		try {
			runner = createWindowsLogonSessionSnapshotRunner({
				spawnHelper: dependencies.spawnHelper,
				decoder: protocol.decoder,
				scheduleTimer: dependencies.scheduleTimer,
				cancelTimer: dependencies.cancelTimer,
				requestSoftStopKnownChild: dependencies.requestSoftStopKnownChild,
				forceStopKnownChild: dependencies.forceStopKnownChild,
				policy: RUNNER_POLICY,
			});
		} catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.unexpected); }
		const provider = createWindowsLogonSessionLivenessProvider({
			snapshotRunner: runner,
			snapshotConsumer: protocol.snapshotConsumer,
			containmentAuthority,
			hash: dependencies.hashBytes,
		});

		let run;
		let providerResult;
		try {
			const runPromise = runner.runOnce();
			const providerPromise = provider.getStartupState();
			[run, providerResult] = await Promise.all([runPromise, providerPromise]);
		} catch {
			return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);
		}

		let idleConfirmed = false;
		try {
			idleConfirmed = await dependencies.waitForIdleWithDeadline({
				waitForIdle: () => runner.waitForIdle(),
				requestShutdown: () => runner.requestShutdown(),
				timeoutMs: IDLE_CONFIRMATION_TIMEOUT_MS,
			});
		} catch { idleConfirmed = false; }
		if (idleConfirmed !== true) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.idleUnconfirmed);
		if (runner.getSafeState().activeChildCount !== 0) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerStateInvalid);
		const disposed = runner.dispose();
		if (disposed?.disposed !== true) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerDisposeFailed);

		let postHash;
		try { postHash = await dependencies.hashHelperFile(helperPath); }
		catch { return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperHashFailed); }
		if (postHash !== expectedSha256 || postHash !== initialHash) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperChanged);
		if (!run?.ok || !run.snapshot) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.runnerFailed);
		const snapshot = safeSummary(protocol.snapshotConsumer, run.snapshot);
		if (!snapshot) return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.snapshotInvalid);
		if (!providerResult?.ok || providerResult.unavailable === true || !providerResult.startupState) {
			return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.providerUnavailable);
		}
		const witness = containmentAuthority.startupStateConsumer.getCurrentWitness(providerResult.startupState);
		const serializedWitness = serializeHostBootSessionWitness(witness);
		const compared = containmentAuthority.startupStateConsumer.comparePersistedWitness(providerResult.startupState, witness);
		if (!serializedWitness
			|| serializedWitness.providerId !== WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID
			|| serializedWitness.providerVersion !== WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION
			|| compared?.classification !== HOST_EXECUTION_CONTAINMENT_RESULTS.retained) {
			return failure(WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.containmentInvalid);
		}
		return freeze({
			ok: true,
			code: null,
			summary: freeze({
				schemaVersion: 1,
				providerId: WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID,
				providerVersion: WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION,
				currentLogonType: snapshot.currentLogonType,
				sessionCount: snapshot.sessionCount,
				helperSha256: expectedSha256,
				runnerIdleConfirmed: true,
			}),
		});
	}

	return freeze({ validate });
}
