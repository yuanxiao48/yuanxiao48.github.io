/**
 * Pure recovery policy for an unconfirmed source reader. This module never
 * probes, inspects files, reads host state, or starts a child process.
 */
import {
	compareHostBootSessionWitness,
	isHostBootSessionWitness,
	sameHostBootSessionWitnessIdentity,
} from "./host-boot-session-witness.mjs";
import {
	compareHostExecutionContainment,
	getHostExecutionContainmentCurrentWitness,
	isHostExecutionContainmentStartupState,
	HOST_EXECUTION_CONTAINMENT_RESULTS,
} from "./host-execution-containment-comparison.mjs";
import {
	createPreExecutionRecovery,
	normalizePreExecutionRecovery,
	normalizeSourceProbeEvidence,
} from "./transcode-recovery.mjs";

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ACCESS_CODE = "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED";
const TERMINAL_STATES = new Set(["completed", "cancelled", "failed", "discarded"]);

export const TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES = Object.freeze({
	witnessUnavailable: "BOOT_SESSION_WITNESS_UNAVAILABLE",
	witnessIncomparable: "BOOT_SESSION_WITNESS_INCOMPARABLE",
	witnessMalformed: "SOURCE_ACCESS_WITNESS_MALFORMED",
	witnessRecordFailed: "SOURCE_ACCESS_WITNESS_RECORD_FAILED",
	clearFailed: "SOURCE_ACCESS_CLEAR_FAILED",
	sourceInvalid: "SOURCE_ACCESS_SOURCE_INVALID",
	evidenceStale: "SOURCE_ACCESS_EVIDENCE_STALE",
	evidenceInvalid: "SOURCE_PROBE_EVIDENCE_INVALID",
	evidencePersistRequired: "SOURCE_PROBE_EVIDENCE_PERSIST_REQUIRED",
	phaseFailed: "RECOVERY_PREFINAL_PHASE_FAILED",
});

function freeze(value) {
	return Object.freeze(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeJobId(value) {
	return typeof value === "string" && SAFE_JOB_ID.test(value);
}

function validGeneration(value) {
	return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validSnapshot(snapshot) {
	return record(snapshot) && record(snapshot.job) && isSafeJobId(snapshot.job.id)
		&& snapshot.identity !== null && snapshot.identity !== undefined && validGeneration(snapshot.generation);
}

function stableResult({ status, manifestChanged = false, holdActive = false, mustBlockListen = false, finalRereadRequired = false, code = null } = {}) {
	return freeze({ status, manifestChanged, holdActive, mustBlockListen, finalRereadRequired, code });
}

function hasRaw(value) {
	return value !== null && value !== undefined;
}

function sourceAccessFields(job) {
	const preExecution = normalizePreExecutionRecovery(job?.preExecutionRecovery);
	const evidence = normalizeSourceProbeEvidence(job?.sourceProbeEvidence);
	return freeze({
		preExecution,
		evidence,
		hasSourceAccess: preExecution.recovery?.code === SOURCE_ACCESS_CODE,
		hasRawPreExecution: hasRaw(job?.preExecutionRecovery),
		hasRawEvidence: hasRaw(job?.sourceProbeEvidence),
	});
}

function containmentState(context, supplied) {
	if (context?.getExecutionContainmentStartupState) return context.getExecutionContainmentStartupState();
	return supplied;
}

function containmentComparison({ state, persisted, currentWitness }) {
	if (state !== null && state !== undefined) return compareHostExecutionContainment(state, persisted);
	if (!isHostBootSessionWitness(currentWitness)) return freeze({ classification: HOST_EXECUTION_CONTAINMENT_RESULTS.unavailable, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable });
	const relation = compareHostBootSessionWitness(persisted, currentWitness);
	if (relation.relation === "same-session") return freeze({ classification: HOST_EXECUTION_CONTAINMENT_RESULTS.retained, code: null });
	if (relation.relation === "different-session") return freeze({ classification: HOST_EXECUTION_CONTAINMENT_RESULTS.terminated, code: null });
	if (relation.relation === "incomparable") return freeze({ classification: HOST_EXECUTION_CONTAINMENT_RESULTS.incomparable, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessIncomparable });
	return freeze({ classification: relation.relation === "malformed" ? HOST_EXECUTION_CONTAINMENT_RESULTS.malformed : HOST_EXECUTION_CONTAINMENT_RESULTS.unavailable, code: relation.code || TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable });
}

function nextWithSourceAccess(job, witness, origin, nowIso) {
	const next = {
		...job,
		state: "interrupted",
		preExecutionRecovery: createPreExecutionRecovery({
			code: SOURCE_ACCESS_CODE,
			detectedAt: job.preExecutionRecovery?.detectedAt || nowIso,
			sourceAccessWitness: witness,
			evidenceOrigin: origin,
		}),
		updatedAt: nowIso,
	};
	delete next.sourceProbeEvidence;
	return next;
}

function nextWithoutSourceAccess(job, nowIso, { interrupt = false } = {}) {
	const next = { ...job, ...(interrupt ? { state: "interrupted" } : {}), updatedAt: nowIso };
	delete next.preExecutionRecovery;
	delete next.sourceProbeEvidence;
	return next;
}

async function persistSnapshot(persistManifestCas, snapshot, nextManifest) {
	try {
		const written = await persistManifestCas({
			jobId: snapshot.job.id,
			expectedIdentity: snapshot.identity,
			expectedGeneration: snapshot.generation,
			nextManifest,
		});
		return written?.ok === true ? "written" : written?.terminalProtected === true ? "terminal" : "failed";
	} catch {
		return "failed";
	}
}

/**
 * Defines the pre-spawn persistence rule for future managed job probes.
 */
export function evaluateSourceProbeEvidencePersistence({ evidence, persisted = false } = {}) {
	const normalized = normalizeSourceProbeEvidence(evidence);
	if (!normalized.evidence) return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.evidenceInvalid });
	return persisted === true
		? stableResult({ status: "spawnPermitted" })
		: stableResult({ status: "spawnBlocked", holdActive: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.evidencePersistRequired });
}

/**
 * A capability-driven resolver. A resolver instance remembers witnesses it
 * recorded during this startup, preventing record-and-clear in one run.
 */
export function createSourceAccessRecoveryResolver({ persistManifestCas, validateSourceAccessSource, nowIso } = {}) {
	if (typeof persistManifestCas !== "function" || typeof validateSourceAccessSource !== "function" || typeof nowIso !== "function") {
		throw new TypeError("Source-access recovery dependencies are invalid");
	}
	const recordedThisStartup = new WeakMap();

	function wasRecorded(context, jobId) {
		return record(context) && recordedThisStartup.get(context)?.has(jobId) === true;
	}

	function markRecorded(context, jobId) {
		if (!record(context)) return;
		const jobs = recordedThisStartup.get(context) || new Set();
		jobs.add(jobId);
		recordedThisStartup.set(context, jobs);
	}

	async function resolve({ snapshot, currentBootWitness = null, executionContainmentStartupState = null, context = null } = {}) {
		if (!validSnapshot(snapshot)) return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.sourceInvalid });
		const job = snapshot.job;
		if (TERMINAL_STATES.has(job.state)) return stableResult({ status: "terminalProtected" });
		const fields = sourceAccessFields(job);
		if (fields.hasRawEvidence && fields.evidence.malformed) {
			return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.evidenceInvalid });
		}
		if (fields.preExecution.malformed && fields.hasRawPreExecution
			&& (job?.preExecutionRecovery?.code === SOURCE_ACCESS_CODE || fields.hasRawEvidence)) {
			return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessMalformed });
		}
		if (!fields.hasSourceAccess && !fields.evidence.evidence) return stableResult({ status: "noAction" });
		let source;
		try { source = validateSourceAccessSource(job); } catch { source = null; }
		if (!source?.ok || !["library", "upload"].includes(source.sourceType)) {
			return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.sourceInvalid });
		}
		let state;
		try { state = containmentState(context, executionContainmentStartupState); } catch { state = {}; }
		if (state !== null && state !== undefined && !isHostExecutionContainmentStartupState(state)) {
			return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessMalformed });
		}
		const stateWitness = state === null || state === undefined ? null : getHostExecutionContainmentCurrentWitness(state);
		const effectiveCurrentWitness = stateWitness || currentBootWitness;
		if (currentBootWitness !== null && !isHostBootSessionWitness(currentBootWitness)) {
			return stableResult({ status: "holdRetained", holdActive: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable });
		}
		if (stateWitness && currentBootWitness && !sameHostBootSessionWitnessIdentity(stateWitness, currentBootWitness).equal) {
			return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessMalformed });
		}
		const evidenceWitness = fields.evidence.evidence?.bootWitness || null;
		const recoveryWitness = fields.preExecution.recovery?.sourceAccessWitness || null;
		if (evidenceWitness && recoveryWitness && !sameHostBootSessionWitnessIdentity(evidenceWitness, recoveryWitness).equal) {
			return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.evidenceStale });
		}
		const previousWitness = evidenceWitness || recoveryWitness;
		if (!fields.hasSourceAccess && evidenceWitness) {
			if (!isHostBootSessionWitness(effectiveCurrentWitness)) {
				const written = await persistSnapshot(persistManifestCas, snapshot, nextWithSourceAccess(job, evidenceWitness, "managed-job-probe", nowIso()));
				return written === "written"
					? stableResult({ status: "holdRetained", manifestChanged: true, holdActive: true, finalRereadRequired: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable })
					: stableResult({ status: written === "terminal" ? "terminalProtected" : "critical", holdActive: written !== "terminal", mustBlockListen: written !== "terminal", code: written === "terminal" ? null : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessRecordFailed });
			}
			const compared = containmentComparison({ state, persisted: evidenceWitness, currentWitness: effectiveCurrentWitness });
			if (compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.malformed) {
				return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessMalformed });
			}
			if (compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.terminated) {
				const written = await persistSnapshot(persistManifestCas, snapshot, nextWithoutSourceAccess(job, nowIso(), { interrupt: true }));
				return written === "written"
					? stableResult({ status: "holdCleared", manifestChanged: true, finalRereadRequired: true })
					: stableResult({ status: written === "terminal" ? "terminalProtected" : "critical", holdActive: written !== "terminal", mustBlockListen: written !== "terminal", code: written === "terminal" ? null : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.clearFailed });
			}
			const written = await persistSnapshot(persistManifestCas, snapshot, nextWithSourceAccess(job, evidenceWitness, "managed-job-probe", nowIso()));
			return written === "written"
				? stableResult({ status: "holdRetained", manifestChanged: true, holdActive: true, finalRereadRequired: true, code: compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.retained ? null : compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.incomparable ? TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessIncomparable : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable })
				: stableResult({ status: written === "terminal" ? "terminalProtected" : "critical", holdActive: written !== "terminal", mustBlockListen: written !== "terminal", code: written === "terminal" ? null : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessRecordFailed });
		}
		if (!previousWitness) {
			if (!isHostBootSessionWitness(effectiveCurrentWitness)) return stableResult({ status: "holdRetained", holdActive: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable });
			const written = await persistSnapshot(persistManifestCas, snapshot, nextWithSourceAccess(job, effectiveCurrentWitness, "legacy-observed", nowIso()));
			if (written === "written") {
				markRecorded(context, job.id);
				return stableResult({ status: "witnessRecorded", manifestChanged: true, holdActive: true, finalRereadRequired: true });
			}
			return stableResult({ status: written === "terminal" ? "terminalProtected" : "critical", holdActive: written !== "terminal", mustBlockListen: written !== "terminal", code: written === "terminal" ? null : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessRecordFailed });
		}
		if (!isHostBootSessionWitness(effectiveCurrentWitness)) return stableResult({ status: "holdRetained", holdActive: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable });
		const compared = containmentComparison({ state, persisted: previousWitness, currentWitness: effectiveCurrentWitness });
		if (compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.malformed) return stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessMalformed });
		if (compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.retained) return stableResult({ status: "holdRetained", holdActive: true });
		if (compared.classification !== HOST_EXECUTION_CONTAINMENT_RESULTS.terminated || wasRecorded(context, job.id)) {
			return stableResult({ status: "holdRetained", holdActive: true, code: compared.classification === HOST_EXECUTION_CONTAINMENT_RESULTS.incomparable ? TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessIncomparable : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.witnessUnavailable });
		}
		const written = await persistSnapshot(persistManifestCas, snapshot, nextWithoutSourceAccess(job, nowIso()));
		if (written === "written") return stableResult({ status: "holdCleared", manifestChanged: true, finalRereadRequired: true });
		return stableResult({ status: written === "terminal" ? "terminalProtected" : "critical", holdActive: written !== "terminal", mustBlockListen: written !== "terminal", code: written === "terminal" ? null : TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.clearFailed });
	}

	return freeze({ resolve });
}

/**
 * Serial pre-final orchestration hook. It intentionally reports counts only.
 */
export function createSourceAccessRecoveryPreFinalPhase({ readJob, resolver } = {}) {
	if (typeof readJob !== "function" || !resolver || typeof resolver.resolve !== "function") {
		throw new TypeError("Source-access pre-final phase dependencies are invalid");
	}
	return freeze({
		async run({ jobIds, context } = {}) {
			if (!Array.isArray(jobIds) || !jobIds.every(isSafeJobId)) {
				return freeze({ ok: false, mustBlockListen: true, criticalCount: 1, sourceAccessLegacyCount: 0, sourceAccessWitnessRecordedCount: 0, sourceAccessSameSessionCount: 0, sourceAccessClearedCount: 0, sourceAccessRetainedCount: 0, sourceAccessCriticalCount: 1, sourceProbeEvidenceCount: 0 });
			}
			const counts = { legacy: 0, recorded: 0, same: 0, cleared: 0, retained: 0, critical: 0, evidence: 0 };
			for (const jobId of jobIds) {
				let snapshot;
				try { snapshot = await readJob(jobId); } catch { counts.critical += 1; continue; }
				const fields = sourceAccessFields(snapshot?.job);
				if (fields.hasSourceAccess && !fields.preExecution.recovery?.sourceAccessWitness) counts.legacy += 1;
				if (fields.evidence.evidence) counts.evidence += 1;
				let outcome;
				try { outcome = await resolver.resolve({ snapshot, currentBootWitness: context?.getSourceAccessWitness?.() || null, executionContainmentStartupState: context?.getExecutionContainmentStartupState?.() || null, context }); }
				catch { outcome = stableResult({ status: "critical", holdActive: true, mustBlockListen: true, code: TRANSCODE_SOURCE_ACCESS_RECOVERY_CODES.phaseFailed }); }
				if (outcome.status === "witnessRecorded") counts.recorded += 1;
				if (outcome.status === "holdCleared") counts.cleared += 1;
				if (outcome.status === "holdRetained") {
					counts.retained += 1;
					if (!outcome.code) counts.same += 1;
				}
				if (outcome.status === "critical" || outcome.mustBlockListen) counts.critical += 1;
			}
			return freeze({
				ok: counts.critical === 0,
				mustBlockListen: counts.critical > 0,
				criticalCount: counts.critical,
				sourceAccessLegacyCount: counts.legacy,
				sourceAccessWitnessRecordedCount: counts.recorded,
				sourceAccessSameSessionCount: counts.same,
				sourceAccessClearedCount: counts.cleared,
				sourceAccessRetainedCount: counts.retained,
				sourceAccessCriticalCount: counts.critical,
				sourceProbeEvidenceCount: counts.evidence,
			});
		},
	});
}
