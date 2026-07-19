/**
 * Pure safety policy for recovering transcode outputs after an unclean stop.
 * This module never reads, writes, removes, or discovers files by itself.
 */
import path from "node:path";
import {
	isHostBootSessionWitness,
	normalizeHostBootSessionWitness,
	serializeHostBootSessionWitness,
} from "./host-boot-session-witness.mjs";

export const TRANSCODE_RECOVERY_OUTPUT_FILENAMES = Object.freeze([
	"output.partial.m4a",
	"output.partial.mp3",
	"output.m4a",
	"output.mp3",
]);

export const TRANSCODE_RECOVERY_POLICY = Object.freeze({
	holdVersion: 1,
	sampleOffsetsMs: Object.freeze([0, 2_000, 8_000, 20_000]),
	minimumSilentAgeMs: 120_000,
});

export const TRANSCODE_RECOVERY_HOLD_CODE = "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED";
export const TRANSCODE_PREEXECUTION_RECOVERY_CODES = Object.freeze([
	"TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD",
	"TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED",
]);
export const TRANSCODE_SOURCE_ACCESS_EVIDENCE_ORIGINS = Object.freeze([
	"legacy-observed",
	"managed-job-probe",
]);
export const TRANSCODE_RECOVERY_WARNING_CODES = Object.freeze([
	"TRANSCODE_RECOVERY_OUTPUT_UNSAFE",
	"TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED",
	"TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE",
]);

const HOLD_CODES = Object.freeze([TRANSCODE_RECOVERY_HOLD_CODE]);
const cleanupPlans = new WeakSet();
const stableSnapshots = new WeakSet();

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIsoTime(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function toWallMs(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function freeze(value) {
	return Object.freeze(value);
}

function freezeArray(value) {
	return Object.freeze([...value]);
}

function safeCode(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

function sameValue(left, right) {
	return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function sameIdentity(left, right) {
	if (!left || !right || left.kind !== right.kind) return false;
	for (const key of Object.keys(left)) {
		if (!sameValue(left[key], right[key])) return false;
	}
	for (const key of Object.keys(right)) {
		if (!(key in left)) return false;
	}
	return true;
}

function identityValue(value) {
	if (typeof value === "bigint") return value >= 0n ? `b:${value}` : null;
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return `n:${value}`;
	return null;
}

function millisecondValue(value) {
	if (typeof value === "bigint") {
		return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
	}
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function statMilliseconds(stats, name) {
	return millisecondValue(stats?.[`${name}Ms`] ?? stats?.[name]?.getTime?.());
}

function statIdentity(stats, kind, { includeSize = false } = {}) {
	const dev = identityValue(stats?.dev);
	const ino = identityValue(stats?.ino);
	const mtimeMs = statMilliseconds(stats, "mtime");
	const ctimeMs = statMilliseconds(stats, "ctime");
	const birthtimeMs = statMilliseconds(stats, "birthtime");
	if (!dev || !ino || dev === "n:0" || dev === "b:0" || ino === "n:0" || ino === "b:0" || mtimeMs === null || ctimeMs === null) return null;
	const identity = { kind, dev, ino, mtimeMs, ctimeMs, birthtimeMs };
	if (includeSize) {
		const size = identityValue(stats?.size);
		if (!size) return null;
		identity.size = size;
		identity.mtimeMs = mtimeMs;
	}
	return freeze(identity);
}

function isNotFound(error) {
	return error?.code === "ENOENT";
}

function errorCode(error) {
	if (error?.code === "ELOOP") return "TRANSCODE_RECOVERY_OUTPUT_UNSAFE";
	if (["EACCES", "EPERM"].includes(error?.code)) return "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED";
	return "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED";
}

function normalizedPath(value, pathApi) {
	const resolved = pathApi.resolve(value);
	return pathApi === path.win32 || pathApi.sep === "\\" ? resolved.toLowerCase() : resolved;
}

function isWithinPath(base, candidate, pathApi) {
	const normalizedBase = normalizedPath(base, pathApi);
	const normalizedCandidate = normalizedPath(candidate, pathApi);
	const relative = pathApi.relative(normalizedBase, normalizedCandidate);
	return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

function safeBasename(name, pathApi) {
	return typeof name === "string" && name === pathApi.basename(name) && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

function compareSnapshotShape(left, right) {
	if (!left || !right || left.ok !== true || right.ok !== true) return false;
	if (!sameIdentity(left.jobDirectory.identity, right.jobDirectory.identity)) return false;
	if (left.outputDirectory.present !== right.outputDirectory.present) return false;
	if (left.outputDirectory.present && !sameIdentity(left.outputDirectory.identity, right.outputDirectory.identity)) return false;
	for (const name of TRANSCODE_RECOVERY_OUTPUT_FILENAMES) {
		const before = left.files[name];
		const after = right.files[name];
		if (!before || !after || before.present !== after.present) return false;
		if (before.present && !sameIdentity(before.identity, after.identity)) return false;
	}
	return true;
}

function makeHold(detectedAt, lastCheckedAt = detectedAt, retryAfterIso = lastCheckedAt) {
	return freeze({
		version: TRANSCODE_RECOVERY_POLICY.holdVersion,
		active: true,
		code: TRANSCODE_RECOVERY_HOLD_CODE,
		detectedAt,
		lastCheckedAt,
		retryAfter: retryAfterIso,
	});
}

export function createRecoveryHold({ nowIso, retryAfterIso = nowIso } = {}) {
	if (!isSafeIsoTime(nowIso) || !isSafeIsoTime(retryAfterIso)) {
		throw new Error("Recovery hold timestamps are invalid");
	}
	return makeHold(nowIso, nowIso, retryAfterIso);
}

export function normalizeRecoveryHold(value, { fallbackNowIso } = {}) {
	if (value === null || value === undefined || value.active === false) return freeze({ hold: null, malformed: false });
	if (isRecord(value)
		&& value.version === TRANSCODE_RECOVERY_POLICY.holdVersion
		&& value.active === true
		&& HOLD_CODES.includes(value.code)
		&& isSafeIsoTime(value.detectedAt)
		&& isSafeIsoTime(value.lastCheckedAt)
		&& isSafeIsoTime(value.retryAfter)) {
		return freeze({
			hold: makeHold(value.detectedAt, value.lastCheckedAt, value.retryAfter),
			malformed: false,
		});
	}
	if (!isSafeIsoTime(fallbackNowIso)) {
		return freeze({ hold: null, malformed: true });
	}
	return freeze({ hold: makeHold(fallbackNowIso), malformed: true });
}

export function updateRecoveryHold(hold, { lastCheckedAt, retryAfter } = {}) {
	const normalized = normalizeRecoveryHold(hold);
	if (!normalized.hold || !isSafeIsoTime(lastCheckedAt) || !isSafeIsoTime(retryAfter)) {
		throw new Error("Recovery hold update is invalid");
	}
	return freeze({
		version: TRANSCODE_RECOVERY_POLICY.holdVersion,
		active: true,
		code: TRANSCODE_RECOVERY_HOLD_CODE,
		detectedAt: normalized.hold.detectedAt,
		lastCheckedAt,
		retryAfter,
	});
}

function safeProbeGeneration(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function normalizedWitness(value) {
	return isHostBootSessionWitness(value) ? value : normalizeHostBootSessionWitness(value).witness || null;
}

export function createPreExecutionRecovery({ code, detectedAt, sourceAccessWitness = null, evidenceOrigin = null } = {}) {
	if (!TRANSCODE_PREEXECUTION_RECOVERY_CODES.includes(code) || !isSafeIsoTime(detectedAt)) {
		throw new Error("Pre-execution recovery is invalid");
	}
	if (code !== "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED") {
		if (sourceAccessWitness !== null || evidenceOrigin !== null) throw new Error("Pre-execution recovery witness is invalid");
		return freeze({ version: 1, active: true, code, detectedAt });
	}
	if (sourceAccessWitness === null && evidenceOrigin === null) return freeze({ version: 1, active: true, code, detectedAt });
	const witness = normalizedWitness(sourceAccessWitness);
	if (!witness || !TRANSCODE_SOURCE_ACCESS_EVIDENCE_ORIGINS.includes(evidenceOrigin)) {
		throw new Error("Pre-execution recovery witness is invalid");
	}
	return freeze({
		version: 2,
		active: true,
		code,
		detectedAt,
		sourceAccessWitness: serializeHostBootSessionWitness(witness),
		evidenceOrigin,
	});
}

export function normalizePreExecutionRecovery(value) {
	if (value === null || value === undefined || value.active === false) return freeze({ recovery: null, malformed: false });
	if (isRecord(value) && value.version === 1 && value.active === true
		&& TRANSCODE_PREEXECUTION_RECOVERY_CODES.includes(value.code) && isSafeIsoTime(value.detectedAt)) {
		if (value.sourceAccessWitness !== undefined || value.evidenceOrigin !== undefined) return freeze({ recovery: null, malformed: true });
		return freeze({ recovery: freeze({ version: 1, active: true, code: value.code, detectedAt: value.detectedAt, sourceAccessWitness: null, evidenceOrigin: null }), malformed: false });
	}
	if (isRecord(value) && value.version === 2 && value.active === true
		&& value.code === "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED" && isSafeIsoTime(value.detectedAt)
		&& TRANSCODE_SOURCE_ACCESS_EVIDENCE_ORIGINS.includes(value.evidenceOrigin)) {
		const witness = normalizedWitness(value.sourceAccessWitness);
		if (witness) {
			return freeze({
				recovery: freeze({ version: 2, active: true, code: value.code, detectedAt: value.detectedAt, sourceAccessWitness: witness, evidenceOrigin: value.evidenceOrigin }),
				malformed: false,
			});
		}
	}
	return freeze({ recovery: null, malformed: true });
}

export function createSourceProbeEvidence({ generation, bootWitness } = {}) {
	const witness = normalizedWitness(bootWitness);
	if (!safeProbeGeneration(generation) || !witness) throw new Error("Source probe evidence is invalid");
	return freeze({
		version: 1,
		active: true,
		generation,
		bootWitness: serializeHostBootSessionWitness(witness),
	});
}

export function normalizeSourceProbeEvidence(value) {
	if (value === null || value === undefined || value.active === false) return freeze({ evidence: null, malformed: false });
	if (!isRecord(value) || value.version !== 1 || value.active !== true || !safeProbeGeneration(value.generation)) {
		return freeze({ evidence: null, malformed: true });
	}
	const witness = normalizedWitness(value.bootWitness);
	if (!witness) return freeze({ evidence: null, malformed: true });
	return freeze({ evidence: freeze({ version: 1, active: true, generation: value.generation, bootWitness: witness }), malformed: false });
}

/**
 * Future managed probes may clear evidence only from the original close path
 * and only when its generation still matches the persisted evidence.
 */
export function evaluateSourceProbeEvidenceClear({ evidence, generation, closeConfirmed = false } = {}) {
	const normalized = normalizeSourceProbeEvidence(evidence);
	if (!normalized.evidence) return freeze({ permitted: false, code: "SOURCE_PROBE_EVIDENCE_INVALID" });
	if (!safeProbeGeneration(generation) || generation !== normalized.evidence.generation) {
		return freeze({ permitted: false, code: "SOURCE_ACCESS_EVIDENCE_STALE" });
	}
	return closeConfirmed === true
		? freeze({ permitted: true, code: null })
		: freeze({ permitted: false, code: "SOURCE_PROBE_EVIDENCE_PERSIST_REQUIRED" });
}

export function normalizeRecoveryWarning(value) {
	if (!isRecord(value) || !TRANSCODE_RECOVERY_WARNING_CODES.includes(value.code)) return null;
	return freeze({ code: value.code, message: recoveryWarningMessage(value.code) });
}

export function recoveryWarningMessage(code) {
	return safeCode(code, TRANSCODE_RECOVERY_WARNING_CODES, "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED") === "TRANSCODE_RECOVERY_OUTPUT_UNSAFE"
		? "Recovery output could not be verified safely."
		: safeCode(code, TRANSCODE_RECOVERY_WARNING_CODES, "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED") === "TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE"
			? "Recovery output cleanup did not complete."
			: "Recovery output could not be checked.";
}

export function evaluateRecoveryRecheckEligibility({ hold, holdExistedBeforeStartup, startupIdentity, wallNowMs } = {}) {
	const normalized = normalizeRecoveryHold(hold);
	const now = toWallMs(wallNowMs);
	if (!normalized.hold || normalized.malformed) return freeze({ eligible: false, reasonCode: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
	if (holdExistedBeforeStartup !== true || typeof startupIdentity !== "string" || !startupIdentity) {
		return freeze({ eligible: false, reasonCode: "TRANSCODE_RECOVERY_NOT_COLD_START" });
	}
	if (now === null) return freeze({ eligible: false, reasonCode: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	const detectedAt = Date.parse(normalized.hold.detectedAt);
	const lastCheckedAt = Date.parse(normalized.hold.lastCheckedAt);
	const retryAfter = Date.parse(normalized.hold.retryAfter);
	if (!Number.isFinite(detectedAt) || !Number.isFinite(lastCheckedAt) || !Number.isFinite(retryAfter)
		|| detectedAt > now || lastCheckedAt > now || retryAfter > now) {
		return freeze({ eligible: false, reasonCode: "TRANSCODE_RECOVERY_HOLD_TOO_RECENT" });
	}
	if (now - detectedAt < TRANSCODE_RECOVERY_POLICY.minimumSilentAgeMs) {
		return freeze({ eligible: false, reasonCode: "TRANSCODE_RECOVERY_HOLD_TOO_RECENT" });
	}
	return freeze({ eligible: true, reasonCode: null });
}

export function classifyStartupRecoveryRequirements(manifest, { hasFixedOutput = false } = {}) {
	if (!isRecord(manifest) || typeof manifest.state !== "string") return "malformedUnsafe";
	if (manifest.state === "completed") return "terminalProtected";
	if (["cancelled", "failed", "discarded"].includes(manifest.state)) return "terminalProtected";
	const preExecution = normalizePreExecutionRecovery(manifest.preExecutionRecovery);
	if (manifest.state !== "completed" && preExecution.malformed && manifest.preExecutionRecovery !== null && manifest.preExecutionRecovery !== undefined) {
		return "preExecutionRecoveryRequired";
	}
	if (preExecution.recovery) return "preExecutionRecoveryRequired";
	if (manifest.state === "creating") return hasFixedOutput ? "needsInitialOutputHold" : "needsPreExecutionInterruption";
	if (manifest.state === "uploading") return "needsIncompleteUploadRecovery";
	if (manifest.state === "probing") return "needsSourceAccessRecovery";
	if (["transcoding", "cancelling", "validating-output"].includes(manifest.state)
		|| (manifest.completionCommitStarted === true && manifest.state !== "completed")) return "needsInitialHold";
	if (manifest.state === "interrupted" && normalizeRecoveryHold(manifest.recoveryHold).hold) return "needsExistingHoldRecheck";
	if (manifest.state === "interrupted") return "ordinaryInterrupted";
	if (manifest.state === "queued") return hasFixedOutput ? "needsInitialHold" : "queuedRecovery";
	if (manifest.state === "ready") return hasFixedOutput ? "needsInitialHold" : "noRecoveryAction";
	return "noRecoveryAction";
}

export function classifyStartupRecoveryRisk(manifest, options = {}) {
	return classifyStartupRecoveryRequirements(manifest, options);
}

export async function inspectRecoveryOutputSnapshot({ jobDirectory, fsApi, pathApi = path, monotonicNowMs } = {}) {
	if (!fsApi?.lstat || !fsApi?.realpath || typeof jobDirectory !== "string" || typeof monotonicNowMs !== "function") {
		return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	}
	try {
		const jobPath = pathApi.resolve(jobDirectory);
		const jobStats = await fsApi.lstat(jobPath);
		if (!jobStats?.isDirectory?.() || jobStats.isSymbolicLink?.()) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
		const jobIdentity = statIdentity(jobStats, "directory");
		if (!jobIdentity) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
		const resolvedJob = await fsApi.realpath(jobPath);
		if (!isWithinPath(jobPath, resolvedJob, pathApi)) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
		const outputPath = pathApi.join(jobPath, "output");
		let outputDirectory = { present: false, identity: null };
		let resolvedOutput = null;
		try {
			const outputStats = await fsApi.lstat(outputPath);
			if (!outputStats?.isDirectory?.() || outputStats.isSymbolicLink?.()) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
			const identity = statIdentity(outputStats, "directory");
			if (!identity) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
			resolvedOutput = await fsApi.realpath(outputPath);
			if (!isWithinPath(resolvedJob, resolvedOutput, pathApi)) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
			outputDirectory = { present: true, identity };
		} catch (error) {
			if (!isNotFound(error)) return freeze({ ok: false, code: errorCode(error) });
		}
		const files = {};
		for (const name of TRANSCODE_RECOVERY_OUTPUT_FILENAMES) {
			if (!safeBasename(name, pathApi)) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
			if (!outputDirectory.present) {
				files[name] = freeze({ present: false, identity: null });
				continue;
			}
			const candidate = pathApi.join(outputPath, name);
			if (!isWithinPath(outputPath, candidate, pathApi)) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
			try {
				const stats = await fsApi.lstat(candidate);
				if (!stats?.isFile?.() || stats.isSymbolicLink?.()) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
				const identity = statIdentity(stats, "file", { includeSize: true });
				if (!identity) return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
				const resolvedCandidate = await fsApi.realpath(candidate);
				if (!isWithinPath(resolvedOutput, resolvedCandidate, pathApi) || !isWithinPath(resolvedJob, resolvedCandidate, pathApi)) {
					return freeze({ ok: false, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
				}
				files[name] = freeze({ present: true, identity });
			} catch (error) {
				if (isNotFound(error)) files[name] = freeze({ present: false, identity: null });
				else return freeze({ ok: false, code: errorCode(error) });
			}
		}
		return freeze({
			ok: true,
			offsetMs: null,
			capturedAtMonotonicMs: toWallMs(monotonicNowMs()),
			jobDirectory: freeze({ identity: jobIdentity }),
			outputDirectory: freeze(outputDirectory),
			files: freeze(files),
		});
	} catch (error) {
		return freeze({ ok: false, code: errorCode(error) });
	}
}

export async function collectRecoverySnapshots({ inspect, scheduler, monotonicNowMs } = {}) {
	if (typeof inspect !== "function" || typeof scheduler?.sleepUntilOffset !== "function" || typeof monotonicNowMs !== "function") {
		throw new Error("Recovery sampler dependencies are invalid");
	}
	const snapshots = [];
	for (const offsetMs of TRANSCODE_RECOVERY_POLICY.sampleOffsetsMs) {
		await scheduler.sleepUntilOffset(offsetMs);
		const snapshot = await inspect();
		snapshots.push(freeze({ ...snapshot, offsetMs, capturedAtMonotonicMs: toWallMs(monotonicNowMs()) }));
	}
	return freezeArray(snapshots);
}

export function evaluateRecoverySnapshots({ snapshots, hold, holdExistedBeforeStartup, startupIdentity, wallNowMs } = {}) {
	const eligibility = evaluateRecoveryRecheckEligibility({ hold, holdExistedBeforeStartup, startupIdentity, wallNowMs });
	if (!eligibility.eligible) return freeze({ safeToAttemptCleanup: false, stable: false, silentAgeSatisfied: false, identityConfidence: "none", code: eligibility.reasonCode });
	if (!Array.isArray(snapshots) || snapshots.length !== TRANSCODE_RECOVERY_POLICY.sampleOffsetsMs.length) {
		return freeze({ safeToAttemptCleanup: false, stable: false, silentAgeSatisfied: false, identityConfidence: "none", code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	}
	for (let index = 0; index < snapshots.length; index += 1) {
		if (!snapshots[index]?.ok || snapshots[index].offsetMs !== TRANSCODE_RECOVERY_POLICY.sampleOffsetsMs[index]) {
			return freeze({ safeToAttemptCleanup: false, stable: false, silentAgeSatisfied: false, identityConfidence: "none", code: snapshots[index]?.code || "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
		}
	}
	const initial = snapshots[0];
	if (!snapshots.slice(1).every((snapshot) => compareSnapshotShape(initial, snapshot))) {
		return freeze({ safeToAttemptCleanup: false, stable: false, silentAgeSatisfied: false, identityConfidence: "strong", code: "TRANSCODE_RECOVERY_OUTPUT_CHANGED" });
	}
	const now = toWallMs(wallNowMs);
	const present = TRANSCODE_RECOVERY_OUTPUT_FILENAMES.filter((name) => initial.files[name].present);
	if (present.some((name) => initial.files[name].identity.mtimeMs > now
		|| now - initial.files[name].identity.mtimeMs < TRANSCODE_RECOVERY_POLICY.minimumSilentAgeMs)) {
		return freeze({ safeToAttemptCleanup: false, stable: true, silentAgeSatisfied: false, identityConfidence: "strong", code: "TRANSCODE_RECOVERY_OUTPUT_RECENT" });
	}
	stableSnapshots.add(snapshots.at(-1));
	return freeze({ safeToAttemptCleanup: true, stable: true, silentAgeSatisfied: true, identityConfidence: "strong", code: null });
}

export function createRecoveryCleanupPlan(stableSnapshot) {
	if (!stableSnapshots.has(stableSnapshot)) return null;
	const plan = {
		outputDirectory: stableSnapshot.outputDirectory,
		jobDirectory: stableSnapshot.jobDirectory,
		files: freezeArray(TRANSCODE_RECOVERY_OUTPUT_FILENAMES.map((name) => freeze({ name, ...stableSnapshot.files[name] }))),
	};
	Object.defineProperty(plan, "toJSON", { value: () => { throw new Error("Recovery cleanup plans are in-memory only"); } });
	cleanupPlans.add(plan);
	return freeze(plan);
}

export function validateRecoveryCleanupCandidate(plan, currentSnapshot) {
	if (!cleanupPlans.has(plan) || !currentSnapshot?.ok
		|| !sameIdentity(plan.jobDirectory.identity, currentSnapshot.jobDirectory.identity)
		|| plan.outputDirectory.present !== currentSnapshot.outputDirectory.present
		|| (plan.outputDirectory.present && !sameIdentity(plan.outputDirectory.identity, currentSnapshot.outputDirectory.identity))) {
		return freeze({ valid: false, removableCount: 0, missingCount: 0, code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
	}
	let removableCount = 0;
	let missingCount = 0;
	for (const expected of plan.files) {
		const current = currentSnapshot.files[expected.name];
		if (!current || expected.present !== current.present) {
			if (expected.present && current && !current.present) {
				missingCount += 1;
				continue;
			}
			return freeze({ valid: false, removableCount: 0, missingCount: 0, code: "TRANSCODE_RECOVERY_OUTPUT_CHANGED" });
		}
		if (expected.present) {
			if (!sameIdentity(expected.identity, current.identity)) {
				return freeze({ valid: false, removableCount: 0, missingCount: 0, code: "TRANSCODE_RECOVERY_OUTPUT_CHANGED" });
			}
			removableCount += 1;
		}
	}
	return freeze({ valid: true, removableCount, missingCount, code: null });
}

export function createRecoveryCleanupOutcome({ attemptedCount = 0, removedCount = 0, missingCount = 0, stoppedEarly = false } = {}) {
	const complete = !stoppedEarly && attemptedCount === removedCount + missingCount;
	return freeze({
		completed: complete,
		partial: !complete && removedCount + missingCount > 0,
		retainHold: !complete,
		warningCode: complete ? null : "TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE",
	});
}
