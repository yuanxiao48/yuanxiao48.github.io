/**
 * Dependency-injected startup recovery execution.
 * Importing this module has no filesystem, timer, signal, or server side effects.
 */
import {
	TRANSCODE_RECOVERY_OUTPUT_FILENAMES,
	TRANSCODE_RECOVERY_POLICY,
	classifyStartupRecoveryRisk,
	collectRecoverySnapshots,
	createRecoveryCleanupOutcome,
	createRecoveryCleanupPlan,
	createRecoveryHold,
	evaluateRecoveryRecheckEligibility,
	evaluateRecoverySnapshots,
	normalizeRecoveryHold,
	normalizeRecoveryWarning,
	updateRecoveryHold,
	validateRecoveryCleanupCandidate,
} from "./transcode-recovery.mjs";

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOVERY_INTERRUPTED_ERROR = Object.freeze({
	code: "STUDIO_RESTARTED",
	message: "Studio restarted before transcode recovery completed.",
});
const RECOVERY_QUEUED_ERROR = Object.freeze({
	code: "STUDIO_RESTARTED_QUEUE_RESET",
	message: "Studio restarted; this queued task was not resumed automatically.",
});

function isSafeJobId(value) {
	return typeof value === "string" && SAFE_JOB_ID.test(value);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIso(value) {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function freeze(value) {
	return Object.freeze(value);
}

function stableCode(value, fallback = "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED") {
	return typeof value === "string" && /^TRANSCODE_RECOVERY_[A-Z_]+$/.test(value) ? value : fallback;
}

function warningFor(code) {
	if (code === "TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE") {
		return normalizeRecoveryWarning({ code: "TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE" });
	}
	if (code === "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED") {
		return normalizeRecoveryWarning({ code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	}
	return normalizeRecoveryWarning({ code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE" });
}

function result({ status, jobId, manifestChanged = false, holdActive = false, cleanupAttempted = false, cleanupCompleted = false, lockRequired = false, lockReleaseAllowed = false, mustBlockListen = false, code = null } = {}) {
	return freeze({
		status,
		...(isSafeJobId(jobId) ? { jobId } : {}),
		manifestChanged,
		holdActive,
		cleanupAttempted,
		cleanupCompleted,
		lockRequired,
		lockReleaseAllowed,
		mustBlockListen,
		code: code === null ? null : stableCode(code),
	});
}

function recordVersion(record) {
	if (!isRecord(record) || !isRecord(record.job) || typeof record.identity !== "string" || !record.identity
		|| !Number.isSafeInteger(record.generation) || record.generation < 0) return null;
	return freeze({ identity: record.identity, generation: record.generation });
}

function sameRecordVersion(left, right) {
	return Boolean(left && right && left.identity === right.identity && left.generation === right.generation);
}

function cloneRuntimeForInterrupted(runtime, nowIso) {
	return {
		queuedAt: null,
		startedAt: null,
		finishedAt: nowIso,
		attempt: Number.isSafeInteger(runtime?.attempt) && runtime.attempt >= 0 ? runtime.attempt : 0,
	};
}

function cloneRuntimeForReady(runtime) {
	return {
		queuedAt: null,
		startedAt: null,
		finishedAt: null,
		attempt: Number.isSafeInteger(runtime?.attempt) && runtime.attempt >= 0 ? runtime.attempt : 0,
	};
}

function retryAfterIso(wallNowMs) {
	if (!Number.isFinite(wallNowMs) || wallNowMs < 0) return null;
	return new Date(wallNowMs + TRANSCODE_RECOVERY_POLICY.minimumSilentAgeMs).toISOString();
}

function fixedOutputPresence(snapshot) {
	return Boolean(snapshot?.ok && TRANSCODE_RECOVERY_OUTPUT_FILENAMES.some((name) => snapshot.files?.[name]?.present));
}

function recoveryRisk(job, snapshot) {
	const normalizedHold = normalizeRecoveryHold(job.recoveryHold);
	if (job.state !== "completed" && normalizedHold.malformed && job.recoveryHold !== null && job.recoveryHold !== undefined) {
		return "needsInitialHold";
	}
	return classifyStartupRecoveryRisk(job, { hasFixedOutput: fixedOutputPresence(snapshot) });
}

function removeRecoveryHold(job) {
	const next = { ...job };
	delete next.recoveryHold;
	delete next.recoveryWarning;
	return next;
}

function createInitialHoldManifest(job, nowIso, wallNowMs) {
	const retryAfter = retryAfterIso(wallNowMs);
	if (!isSafeIso(nowIso) || !retryAfter) return null;
	return {
		...job,
		state: "interrupted",
		runtime: cloneRuntimeForInterrupted(job.runtime, nowIso),
		error: { ...RECOVERY_INTERRUPTED_ERROR },
		recoveryHold: createRecoveryHold({ nowIso, retryAfterIso: retryAfter }),
		recoveryWarning: null,
		updatedAt: nowIso,
	};
}

function createQueuedReadyManifest(job, nowIso) {
	if (!isSafeIso(nowIso)) return null;
	return {
		...job,
		state: "ready",
		runtime: cloneRuntimeForReady(job.runtime),
		error: { ...RECOVERY_QUEUED_ERROR },
		updatedAt: nowIso,
	};
}

function createRetainedHoldManifest(job, nowIso, wallNowMs, warningCode) {
	const normalized = normalizeRecoveryHold(job.recoveryHold, { fallbackNowIso: nowIso });
	const retryAfter = retryAfterIso(wallNowMs);
	if (!normalized.hold || !retryAfter || !isSafeIso(nowIso)) return null;
	return {
		...job,
		state: "interrupted",
		recoveryHold: updateRecoveryHold(normalized.hold, { lastCheckedAt: nowIso, retryAfter }),
		recoveryWarning: warningFor(warningCode),
		updatedAt: nowIso,
	};
}

function requiredDependencies(dependencies) {
	const names = ["readJob", "persistJobAtomic", "inspectFixedOutputs", "removeFixedOutput", "nowIso", "wallNowMs", "monotonicNowMs", "scheduler", "acquireRecoveryGuard"];
	return names.every((name) => typeof dependencies?.[name] === "function" || (name === "scheduler" && typeof dependencies?.scheduler?.sleepUntilOffset === "function"));
}

async function resolveGuard(acquireRecoveryGuard, jobId) {
	const guard = await acquireRecoveryGuard(jobId);
	if (typeof guard === "function") return guard;
	if (guard && typeof guard.release === "function") return guard.release.bind(guard);
	throw new Error("Recovery guard is invalid");
}

async function persist(dependencies, jobId, expected, nextManifest) {
	try {
		const written = await dependencies.persistJobAtomic({
			jobId,
			expectedIdentity: expected.identity,
			expectedGeneration: expected.generation,
			nextManifest,
		});
		return written?.ok === true ? { ok: true, record: written.record || null } : { ok: false };
	} catch {
		return { ok: false };
	}
}

async function readCurrent(dependencies, jobId) {
	try {
		const record = await dependencies.readJob(jobId);
		const version = recordVersion(record);
		return version ? { record, version } : null;
	} catch {
		return null;
	}
}

function isHeldInterrupted(job) {
	return job?.state === "interrupted" && Boolean(normalizeRecoveryHold(job.recoveryHold).hold);
}

export function createStartupRecoveryContext({ startupIdentity, startupWallTimeMs, startupMonotonicTimeMs = 0, preexistingHoldJobIds = [] } = {}) {
	if (typeof startupIdentity !== "string" || !startupIdentity || !Number.isFinite(startupWallTimeMs) || startupWallTimeMs < 0
		|| !Number.isFinite(startupMonotonicTimeMs) || startupMonotonicTimeMs < 0) {
		throw new Error("Startup recovery context is invalid");
	}
	const preexisting = new Set([...preexistingHoldJobIds].filter(isSafeJobId));
	return freeze({
		startupIdentity,
		startupWallTimeMs,
		startupMonotonicTimeMs,
		hasPreexistingHold: (jobId) => preexisting.has(jobId),
	});
}

export function createTranscodeRecoveryExecutor(dependencies) {
	if (!requiredDependencies(dependencies)) throw new Error("Recovery executor dependencies are invalid");

	async function retainHold(jobId, expected, job, code) {
		const nowIso = dependencies.nowIso();
		const next = createRetainedHoldManifest(job, nowIso, dependencies.wallNowMs(), code);
		if (!next) return result({ status: "criticalFailure", jobId, holdActive: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
		const written = await persist(dependencies, jobId, expected, next);
		return written.ok
			? result({ status: "holdRetained", jobId, manifestChanged: true, holdActive: true, lockRequired: true, code })
			: result({ status: "criticalFailure", jobId, holdActive: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	}

	async function cleanupExistingHold(jobId, initial, context) {
		const { record, version } = initial;
		const job = record.job;
		const hold = normalizeRecoveryHold(job.recoveryHold);
		const eligibility = evaluateRecoveryRecheckEligibility({
			hold: hold.hold,
			holdExistedBeforeStartup: context.hasPreexistingHold(jobId),
			startupIdentity: context.startupIdentity,
			wallNowMs: dependencies.wallNowMs(),
		});
		if (!eligibility.eligible) {
			return result({ status: "holdRetained", jobId, holdActive: true, lockRequired: true, code: eligibility.reasonCode });
		}
		const snapshots = await collectRecoverySnapshots({
			inspect: async () => dependencies.inspectFixedOutputs({ jobId, job, context }),
			scheduler: dependencies.scheduler,
			monotonicNowMs: dependencies.monotonicNowMs,
		});
		const evaluated = evaluateRecoverySnapshots({
			snapshots,
			hold: hold.hold,
			holdExistedBeforeStartup: context.hasPreexistingHold(jobId),
			startupIdentity: context.startupIdentity,
			wallNowMs: dependencies.wallNowMs(),
		});
		if (!evaluated.safeToAttemptCleanup) return retainHold(jobId, version, job, evaluated.code);

		const afterSampling = await readCurrent(dependencies, jobId);
		if (!afterSampling) return result({ status: "criticalFailure", jobId, holdActive: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
		if (afterSampling.record.job.state === "completed") return result({ status: "terminalProtected", jobId });
		if (!sameRecordVersion(version, afterSampling.version) || !isHeldInterrupted(afterSampling.record.job)
			|| normalizeRecoveryHold(afterSampling.record.job.recoveryHold).hold.detectedAt !== hold.hold.detectedAt) {
			return result({ status: "criticalFailure", jobId, holdActive: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
		}
		const plan = createRecoveryCleanupPlan(snapshots.at(-1));
		const preflight = await dependencies.inspectFixedOutputs({ jobId, job: afterSampling.record.job, context });
		const preflightResult = plan ? validateRecoveryCleanupCandidate(plan, preflight) : { valid: false, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" };
		if (!preflightResult.valid) return retainHold(jobId, afterSampling.version, afterSampling.record.job, preflightResult.code);

		let removedCount = 0;
		let missingCount = 0;
		let stoppedEarly = false;
		for (const expected of plan.files) {
			const current = await dependencies.inspectFixedOutputs({ jobId, job: afterSampling.record.job, context });
			const check = validateRecoveryCleanupCandidate(plan, current);
			if (!check.valid) {
				stoppedEarly = true;
				break;
			}
			const candidate = current.files?.[expected.name];
			if (!candidate?.present) {
				missingCount += 1;
				continue;
			}
			try {
				const removal = await dependencies.removeFixedOutput({ jobId, basename: expected.name, expectedIdentity: expected.identity });
				if (removal?.status === "alreadyAbsent") missingCount += 1;
				else if (removal?.status === "removed") removedCount += 1;
				else stoppedEarly = true;
			} catch {
				stoppedEarly = true;
			}
			if (stoppedEarly) break;
		}
		const outcome = createRecoveryCleanupOutcome({ attemptedCount: plan.files.length, removedCount, missingCount, stoppedEarly });
		if (!outcome.completed) {
			const latest = await readCurrent(dependencies, jobId);
			if (!latest || !sameRecordVersion(afterSampling.version, latest.version) || !isHeldInterrupted(latest.record.job)) {
				return result({ status: "criticalFailure", jobId, holdActive: true, cleanupAttempted: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
			}
			const retained = await retainHold(jobId, latest.version, latest.record.job, outcome.warningCode);
			if (retained.mustBlockListen) return retained;
			return result({ ...retained, status: "cleanupIncomplete", cleanupAttempted: true, cleanupCompleted: false, holdActive: true, lockRequired: true, lockReleaseAllowed: false, code: retained.code || outcome.warningCode });
		}

		const latest = await readCurrent(dependencies, jobId);
		if (!latest || !sameRecordVersion(afterSampling.version, latest.version) || !isHeldInterrupted(latest.record.job)) {
			return result({ status: "criticalFailure", jobId, holdActive: true, cleanupAttempted: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
		}
		const next = removeRecoveryHold({ ...latest.record.job, updatedAt: dependencies.nowIso() });
		const written = await persist(dependencies, jobId, latest.version, next);
		return written.ok
			? result({ status: "cleanupCompleted", jobId, manifestChanged: true, cleanupAttempted: true, cleanupCompleted: true, lockReleaseAllowed: true })
			: result({ status: "criticalFailure", jobId, holdActive: true, cleanupAttempted: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	}

	async function recoverJob({ jobId, context }) {
		if (!isSafeJobId(jobId) || !context?.hasPreexistingHold) {
			return result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
		}
		let release = null;
		let output;
		try {
			release = await resolveGuard(dependencies.acquireRecoveryGuard, jobId);
			const current = await readCurrent(dependencies, jobId);
			if (!current) output = result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
			else {
			const terminal = classifyStartupRecoveryRisk(current.record.job) === "terminalProtected";
			if (terminal) output = result({ status: "terminalProtected", jobId });
			else {
			const snapshot = await dependencies.inspectFixedOutputs({ jobId, job: current.record.job, context });
			const risk = recoveryRisk(current.record.job, snapshot);
			if (risk === "needsInitialHold") {
				const nowIso = dependencies.nowIso();
				const next = createInitialHoldManifest(current.record.job, nowIso, dependencies.wallNowMs());
				if (!next) output = result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
				else {
				const written = await persist(dependencies, jobId, current.version, next);
				output = written.ok
					? result({ status: "initialHoldPersisted", jobId, manifestChanged: true, holdActive: true, lockRequired: true, code: "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED" })
					: result({ status: "criticalFailure", jobId, holdActive: true, lockRequired: true, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
				}
			}
			else if (risk === "queuedRecovery") {
				const next = createQueuedReadyManifest(current.record.job, dependencies.nowIso());
				if (!next) output = result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
				else {
				const written = await persist(dependencies, jobId, current.version, next);
				output = written.ok
					? result({ status: "queuedRecoveryRequired", jobId, manifestChanged: true })
					: result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
				}
			}
			else if (risk === "needsExistingHoldRecheck") output = await cleanupExistingHold(jobId, current, context);
			else if (risk === "ordinaryInterrupted" || risk === "noRecoveryAction") output = result({ status: "noAction", jobId });
			else output = result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
			}
			}
		} catch {
			output = result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
			return output;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					output = result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
				}
			}
		}
		return output || result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" });
	}

	async function recoverBatch({ jobIds, context }) {
		const uniqueIds = [];
		const invalidItems = [];
		const seen = new Set();
		for (const jobId of Array.isArray(jobIds) ? jobIds : []) {
			if (!isSafeJobId(jobId)) {
				invalidItems.push(result({ status: "criticalFailure", mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" }));
				continue;
			}
			if (seen.has(jobId)) continue;
			seen.add(jobId);
			uniqueIds.push(jobId);
		}
		const items = [...invalidItems];
		for (const jobId of uniqueIds) {
			try { items.push(await recoverJob({ jobId, context })); }
			catch { items.push(result({ status: "criticalFailure", jobId, mustBlockListen: true, code: "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED" })); }
		}
		const count = (status) => items.filter((item) => item.status === status).length;
		const lockJobIds = items.filter((item) => item.lockRequired && item.jobId).map((item) => item.jobId);
		return freeze({
			total: items.length,
			protected: count("terminalProtected"),
			initialHolds: count("initialHoldPersisted"),
			retainedHolds: count("holdRetained"),
			cleaned: count("cleanupCompleted"),
			partial: count("cleanupIncomplete"),
			critical: count("criticalFailure"),
			mustBlockListen: items.some((item) => item.mustBlockListen),
			lockRequiredJobIds: freeze([...lockJobIds]),
			items: freeze([...items]),
		});
	}

	return freeze({ recoverJob, recoverBatch });
}
