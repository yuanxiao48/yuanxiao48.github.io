/**
 * Pure, capability-based recovery for an upload interrupted before commit.
 * This module never derives paths or removes files by itself.
 */
import {
	normalizePreExecutionRecovery,
	normalizeRecoveryHold,
} from "./transcode-recovery.mjs";
import { isManifestContentIdentity, sameManifestContentIdentity } from "./transcode-manifest-identity.mjs";

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INCOMPLETE_UPLOAD_CODE = "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD";
const TERMINAL_PROTECTED_STATES = new Set(["completed", "cancelled", "failed", "discarded"]);

export const INCOMPLETE_UPLOAD_RECOVERY_CODES = Object.freeze({
	layoutUnsafe: "INCOMPLETE_UPLOAD_LAYOUT_UNSAFE",
	sourceTypeInvalid: "INCOMPLETE_UPLOAD_SOURCE_TYPE_INVALID",
	outputHoldActive: "INCOMPLETE_UPLOAD_OUTPUT_HOLD_ACTIVE",
	discardNotAllowed: "INCOMPLETE_UPLOAD_DISCARD_NOT_ALLOWED",
	discardPrepareFailed: "INCOMPLETE_UPLOAD_DISCARD_PREPARE_FAILED",
	candidateChanged: "INCOMPLETE_UPLOAD_CANDIDATE_CHANGED",
	candidateRemoveFailed: "INCOMPLETE_UPLOAD_CANDIDATE_REMOVE_FAILED",
	discardFinalizeFailed: "INCOMPLETE_UPLOAD_DISCARD_FINALIZE_FAILED",
	unknownEntry: "INCOMPLETE_UPLOAD_UNKNOWN_ENTRY",
	multipleFinals: "INCOMPLETE_UPLOAD_MULTIPLE_FINALS",
	notApplicable: "INCOMPLETE_UPLOAD_NOT_APPLICABLE",
});

export const INCOMPLETE_UPLOAD_DISCARD_VERSION = 1;

function freeze(value) {
	return Object.freeze(value);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeJobId(value) {
	return typeof value === "string" && SAFE_JOB_ID.test(value);
}

function isSafeIso(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameIdentity(left, right) {
	return left === right || (isManifestContentIdentity(left)
		&& isManifestContentIdentity(right)
		&& sameManifestContentIdentity(left, right));
}

function validRecord(record) {
	return isRecord(record) && isRecord(record.job) && isSafeJobId(record.job.id)
		&& record.identity !== undefined && (record.generation === null || (Number.isSafeInteger(record.generation) && record.generation >= 0));
}

function safeResult({ status, code = null, critical = false, safeDiscardAvailable = false, jobGuardRequired = false, userActionRequired = false, hasPart = false, hasFinal = false } = {}) {
	return freeze({ status, code, critical, safeDiscardAvailable, jobGuardRequired, userActionRequired, hasPart, hasFinal });
}

function safeExecution({ status, code = null, manifestChanged = false, prepared = false, completed = false, partial = false, mustBlockListen = false } = {}) {
	return freeze({ status, code, manifestChanged, prepared, completed, partial, mustBlockListen });
}

function layoutCandidate(value) {
	if (!isRecord(value) || typeof value.present !== "boolean") return null;
	if (!value.present) return freeze({ present: false, trusted: true, identity: null });
	return freeze({ present: true, trusted: value.trusted === true && value.identity !== undefined && value.identity !== null, identity: value.identity ?? null });
}

function normalizeLayout(layout) {
	if (!isRecord(layout) || layout.ok !== true || layout.boundarySafe !== true) return null;
	const part = layoutCandidate(layout.part);
	if (!part || !Array.isArray(layout.finals)) return null;
	const finals = layout.finals.map(layoutCandidate);
	if (finals.some((candidate) => !candidate)) return null;
	return freeze({
		part,
		finals: freeze(finals),
		unknownSourceLikeEntry: layout.unknownSourceLikeEntry === true,
	});
}

export function createIncompleteUploadDiscardTombstone({ nowIso } = {}) {
	if (!isSafeIso(nowIso)) throw new Error("Incomplete upload discard timestamp is invalid");
	return freeze({
		version: INCOMPLETE_UPLOAD_DISCARD_VERSION,
		active: true,
		phase: "prepared",
		preparedAt: nowIso,
		code: INCOMPLETE_UPLOAD_CODE,
	});
}

export function normalizeIncompleteUploadDiscard(value) {
	if (value === null || value === undefined || value.active === false) return freeze({ tombstone: null, malformed: false });
	if (isRecord(value) && value.version === INCOMPLETE_UPLOAD_DISCARD_VERSION && value.active === true
		&& value.phase === "prepared" && value.code === INCOMPLETE_UPLOAD_CODE && isSafeIso(value.preparedAt)) {
		return freeze({ tombstone: createIncompleteUploadDiscardTombstone({ nowIso: value.preparedAt }), malformed: false });
	}
	return freeze({ tombstone: null, malformed: true });
}

/**
 * Classifies only a capability-validated upload layout. It never adopts or
 * removes a source candidate and never treats output stability as proof.
 */
export function createIncompleteUploadRecoveryPlan({ job, layout } = {}) {
	if (!isRecord(job)) return safeResult({ status: "notApplicable", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.notApplicable });
	if (TERMINAL_PROTECTED_STATES.has(job.state)) return safeResult({ status: "terminalProtected" });
	const preExecution = normalizePreExecutionRecovery(job.preExecutionRecovery);
	const rawPreExecution = job.preExecutionRecovery !== null && job.preExecutionRecovery !== undefined;
	if (preExecution.recovery?.code === "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED") {
		return safeResult({ status: "notApplicable", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.notApplicable, jobGuardRequired: true, userActionRequired: true });
	}
	if (preExecution.malformed && rawPreExecution) {
		return safeResult({ status: "unsafe", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.layoutUnsafe, critical: true, jobGuardRequired: true, userActionRequired: true });
	}
	if (preExecution.recovery?.code !== INCOMPLETE_UPLOAD_CODE) {
		return safeResult({ status: "notApplicable", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.notApplicable });
	}
	if (job.sourceType !== "upload") {
		return safeResult({ status: "unsafe", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.sourceTypeInvalid, critical: true, jobGuardRequired: true, userActionRequired: true });
	}
	const hold = normalizeRecoveryHold(job.recoveryHold);
	if (hold.hold || (hold.malformed && job.recoveryHold !== null && job.recoveryHold !== undefined)) {
		return safeResult({ status: "outputRecoveryBlocked", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.outputHoldActive, jobGuardRequired: true, userActionRequired: true });
	}
	const normalized = normalizeLayout(layout);
	if (!normalized) return safeResult({ status: "unsafe", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.layoutUnsafe, critical: true, jobGuardRequired: true, userActionRequired: true });
	const hasPart = normalized.part.present;
	const hasFinal = normalized.finals.length > 0;
	if (normalized.unknownSourceLikeEntry) return safeResult({ status: "unsafe", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.unknownEntry, critical: true, jobGuardRequired: true, userActionRequired: true, hasPart, hasFinal });
	if (normalized.finals.length > 1) return safeResult({ status: "unsafe", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.multipleFinals, critical: true, jobGuardRequired: true, userActionRequired: true, hasPart, hasFinal });
	if ((normalized.part.present && !normalized.part.trusted) || normalized.finals.some((candidate) => candidate.present && !candidate.trusted)) {
		return safeResult({ status: "unsafe", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.layoutUnsafe, critical: true, jobGuardRequired: true, userActionRequired: true, hasPart, hasFinal });
	}
	return safeResult({
		status: hasPart && hasFinal ? "partAndFinal" : hasPart ? "partOnly" : hasFinal ? "finalOnly" : "neither",
		safeDiscardAvailable: true,
		jobGuardRequired: true,
		userActionRequired: true,
		hasPart,
		hasFinal,
	});
}

function nextPreparedManifest(job, nowIso) {
	return { ...job, incompleteUploadDiscard: createIncompleteUploadDiscardTombstone({ nowIso }), updatedAt: nowIso };
}

function nextDiscardedManifest(job, nowIso) {
	const next = { ...job, state: "discarded", updatedAt: nowIso };
	delete next.preExecutionRecovery;
	delete next.incompleteUploadDiscard;
	return next;
}

async function resolveGuard(acquire, jobId) {
	const guard = await acquire(jobId);
	if (typeof guard === "function") return guard;
	if (guard && typeof guard.release === "function") return guard.release.bind(guard);
	throw new Error("Incomplete upload recovery guard is invalid");
}

async function readCurrent(dependencies, jobId) {
	try {
		const record = await dependencies.readJob(jobId);
		return validRecord(record) ? record : null;
	} catch {
		return null;
	}
}

async function persist(dependencies, record, nextManifest) {
	try {
		const written = await dependencies.persistJobAtomic({
			jobId: record.job.id,
			expectedIdentity: record.identity,
			expectedGeneration: record.generation,
			nextManifest,
		});
		return written?.ok === true;
	} catch {
		return false;
	}
}

function sameCandidate(expected, current) {
	if (!expected.present) return !current.present;
	return current.present && current.trusted && sameIdentity(expected.identity, current.identity);
}

function candidateFor(layout, kind) {
	return kind === "part" ? layout.part : layout.finals[0] || freeze({ present: false, trusted: true, identity: null });
}

function eligiblePreparedJob(job) {
	const plan = createIncompleteUploadRecoveryPlan({ job, layout: { ok: true, boundarySafe: true, part: { present: false }, finals: [] } });
	return plan.status !== "terminalProtected" && job.sourceType === "upload"
		&& normalizePreExecutionRecovery(job.preExecutionRecovery).recovery?.code === INCOMPLETE_UPLOAD_CODE
		&& !normalizeIncompleteUploadDiscard(job.incompleteUploadDiscard).malformed;
}

export function createIncompleteUploadRecoveryExecutor(dependencies = {}) {
	const required = ["readJob", "persistJobAtomic", "inspectIncompleteUploadLayout", "removeValidatedUploadCandidate", "nowIso", "acquireRecoveryGuard"];
	if (!required.every((name) => typeof dependencies[name] === "function")) {
		throw new TypeError("Incomplete upload recovery dependencies are invalid");
	}

	async function inspect(jobId, job) {
		try {
			return { layout: await dependencies.inspectIncompleteUploadLayout({ jobId, job }) };
		} catch {
			return { layout: null };
		}
	}

	async function executeIncompleteUploadSafeDiscard({ jobId } = {}) {
		if (!isSafeJobId(jobId)) return safeExecution({ status: "rejected", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.discardNotAllowed });
		let release = null;
		try {
			release = await resolveGuard(dependencies.acquireRecoveryGuard, jobId);
			let record = await readCurrent(dependencies, jobId);
			if (!record) return safeExecution({ status: "criticalFailure", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.layoutUnsafe, mustBlockListen: true });
			if (TERMINAL_PROTECTED_STATES.has(record.job.state)) return safeExecution({ status: "terminalProtected" });
			if (!eligiblePreparedJob(record.job)) return safeExecution({ status: "rejected", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.discardNotAllowed });
			let inspected = await inspect(jobId, record.job);
			let plan = createIncompleteUploadRecoveryPlan({ job: record.job, layout: inspected.layout });
			if (!plan.safeDiscardAvailable) return safeExecution({ status: plan.critical ? "criticalFailure" : "rejected", code: plan.code || INCOMPLETE_UPLOAD_RECOVERY_CODES.discardNotAllowed, mustBlockListen: plan.critical });
			let tombstone = normalizeIncompleteUploadDiscard(record.job.incompleteUploadDiscard);
			if (!tombstone.tombstone) {
				if (!await persist(dependencies, record, nextPreparedManifest(record.job, dependencies.nowIso()))) {
					return safeExecution({ status: "criticalFailure", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.discardPrepareFailed, mustBlockListen: true });
				}
			}
			record = await readCurrent(dependencies, jobId);
			if (!record || !eligiblePreparedJob(record.job) || !normalizeIncompleteUploadDiscard(record.job.incompleteUploadDiscard).tombstone) {
				return safeExecution({ status: "criticalFailure", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.discardPrepareFailed, mustBlockListen: true });
			}
			inspected = await inspect(jobId, record.job);
			plan = createIncompleteUploadRecoveryPlan({ job: record.job, layout: inspected.layout });
			if (!plan.safeDiscardAvailable) return safeExecution({ status: "discardPrepared", code: plan.code || INCOMPLETE_UPLOAD_RECOVERY_CODES.candidateChanged, prepared: true, partial: true, mustBlockListen: plan.critical });
			const expectedLayout = normalizeLayout(inspected.layout);
			if (!expectedLayout) return safeExecution({ status: "discardPrepared", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.candidateChanged, prepared: true, partial: true, mustBlockListen: true });

			for (const kind of ["part", "final"]) {
				const expected = candidateFor(expectedLayout, kind);
				const currentInspected = await inspect(jobId, record.job);
				const currentLayout = normalizeLayout(currentInspected.layout);
				if (!currentLayout || !sameCandidate(expected, candidateFor(currentLayout, kind))) {
					return safeExecution({ status: "discardIncomplete", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.candidateChanged, prepared: true, partial: true });
				}
				if (!expected.present) continue;
				try {
					const removed = await dependencies.removeValidatedUploadCandidate({ jobId, candidateKind: kind, expectedIdentity: expected.identity });
					if (removed?.status !== "removed" && removed?.status !== "alreadyAbsent") {
						return safeExecution({ status: "discardIncomplete", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.candidateRemoveFailed, prepared: true, partial: true });
					}
				} catch {
					return safeExecution({ status: "discardIncomplete", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.candidateRemoveFailed, prepared: true, partial: true });
				}
			}
			const finalInspection = await inspect(jobId, record.job);
			const finalPlan = createIncompleteUploadRecoveryPlan({ job: record.job, layout: finalInspection.layout });
			if (!finalPlan.safeDiscardAvailable || finalPlan.hasPart || finalPlan.hasFinal) {
				return safeExecution({ status: "discardIncomplete", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.candidateChanged, prepared: true, partial: true, mustBlockListen: finalPlan.critical });
			}
			const latest = await readCurrent(dependencies, jobId);
			if (!latest || !eligiblePreparedJob(latest.job) || !normalizeIncompleteUploadDiscard(latest.job.incompleteUploadDiscard).tombstone) {
				return safeExecution({ status: "criticalFailure", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.discardFinalizeFailed, prepared: true, mustBlockListen: true });
			}
			if (!await persist(dependencies, latest, nextDiscardedManifest(latest.job, dependencies.nowIso()))) {
				return safeExecution({ status: "criticalFailure", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.discardFinalizeFailed, prepared: true, mustBlockListen: true });
			}
			return safeExecution({ status: "discardCompleted", manifestChanged: true, prepared: true, completed: true });
		} catch {
			return safeExecution({ status: "criticalFailure", code: INCOMPLETE_UPLOAD_RECOVERY_CODES.layoutUnsafe, mustBlockListen: true });
		} finally {
			if (release) {
				try { await release(); } catch { /* The returned state remains conservative. */ }
			}
		}
	}

	return freeze({ executeIncompleteUploadSafeDiscard });
}
