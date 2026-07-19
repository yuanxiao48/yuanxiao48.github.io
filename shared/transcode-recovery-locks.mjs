/**
 * Pure lock planning and conflict policy for transcode recovery.
 * This module owns no production registry and never performs I/O.
 */
import {
	isTerminalTranscodeState,
	isTranscodeTaskState,
	shouldLockTranscodeLibrarySource,
} from "./transcode-policy.mjs";
import {
	normalizePreExecutionRecovery,
	normalizeRecoveryHold,
	TRANSCODE_PREEXECUTION_RECOVERY_CODES,
} from "./transcode-recovery.mjs";

export const TRANSCODE_LOCK_REASONS = Object.freeze(["active", "recovery"]);
export const TRANSCODE_RECOVERY_CONFLICT_CODE = "TRANSCODE_RECOVERY_HOLD_ACTIVE";

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_KIND = "transcode-recovery-lock-plan";
const PLAN_FAILURE_CODE = "TRANSCODE_RECOVERY_LOCK_PLAN_INVALID";
const REGISTRY_FAILURE_CODE = "TRANSCODE_RECOVERY_LOCK_REGISTRY_INVALID";
const SOURCE_FAILURE_CODE = "TRANSCODE_RECOVERY_LOCK_SOURCE_INVALID";
const OPERATION_FAILURE_CODE = "TRANSCODE_RECOVERY_OPERATION_INVALID";
const plans = new WeakMap();
const lockViews = new WeakSet();

const TERMINAL_PROTECTED_STATES = new Set(["completed", "cancelled", "failed", "discarded"]);
const JOB_READ_OPERATIONS = new Set(["read", "summary", "source-probe-readonly"]);
const JOB_MUTATION_OPERATIONS = new Set(["start", "retry", "cancel", "discard", "delete", "cleanup", "incomplete-upload-safe-discard"]);
const SOURCE_READ_OPERATIONS = new Set(["read", "listing"]);
const SOURCE_MUTATION_OPERATIONS = new Set([
	"from-library",
	"trash",
	"restore-target",
	"delete",
	"permanent-delete",
	"rename-source",
	"rename-target",
	"move-source",
	"move-target",
	"replace-source",
	"replace-target",
]);

function freeze(value) {
	return Object.freeze(value);
}

function safeJobId(value) {
	return typeof value === "string" && SAFE_JOB_ID.test(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCount(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptySummary() {
	return freeze({ sourceCount: 0, activeSourceCount: 0, recoverySourceCount: 0, activeOwnerCount: 0, recoveryOwnerCount: 0 });
}

function safeMessage(code) {
	return code === TRANSCODE_RECOVERY_CONFLICT_CODE
		? "Transcode recovery is still protecting this task."
		: "The requested recovery operation is not available.";
}

function emptyView(ok = true, code = null) {
	const view = freeze({ ok, code, hasActive: false, hasRecovery: false, activeOwnerCount: 0, recoveryOwnerCount: 0 });
	lockViews.add(view);
	return view;
}

function entryIsValid(entry, validateJobId = safeJobId) {
	if (!record(entry) || !(entry.activeJobIds instanceof Set) || !(entry.recoveryJobIds instanceof Set)) return false;
	for (const owner of entry.activeJobIds) if (!validateJobId(owner)) return false;
	for (const owner of entry.recoveryJobIds) if (!validateJobId(owner)) return false;
	return true;
}

function copyEntry(entry) {
	return {
		activeJobIds: new Set(entry.activeJobIds),
		recoveryJobIds: new Set(entry.recoveryJobIds),
	};
}

function cloneEntries(entries) {
	const copied = new Map();
	for (const [sourceKey, entry] of entries) copied.set(sourceKey, copyEntry(entry));
	return copied;
}

function summaryForEntries(entries) {
	let activeSourceCount = 0;
	let recoverySourceCount = 0;
	let activeOwnerCount = 0;
	let recoveryOwnerCount = 0;
	for (const entry of entries.values()) {
		const active = entry.activeJobIds.size;
		const recovery = entry.recoveryJobIds.size;
		if (active) activeSourceCount += 1;
		if (recovery) recoverySourceCount += 1;
		activeOwnerCount += active;
		recoveryOwnerCount += recovery;
	}
	return freeze({ sourceCount: entries.size, activeSourceCount, recoverySourceCount, activeOwnerCount, recoveryOwnerCount });
}

function registryEntries(targetMap, validateJobId) {
	if (!targetMap || typeof targetMap.entries !== "function") return null;
	const copied = new Map();
	try {
		for (const [sourceKey, entry] of targetMap.entries()) {
			if (typeof sourceKey !== "string" || !sourceKey || !entryIsValid(entry, validateJobId)) return null;
			copied.set(sourceKey, copyEntry(entry));
		}
	} catch {
		return null;
	}
	return copied;
}

function applyEntries(targetMap, entries) {
	targetMap.clear();
	for (const [sourceKey, entry] of entries) targetMap.set(sourceKey, copyEntry(entry));
}

function sameEntries(targetMap, expected, validateJobId) {
	const actual = registryEntries(targetMap, validateJobId);
	if (!actual || actual.size !== expected.size) return false;
	for (const [sourceKey, expectedEntry] of expected) {
		const actualEntry = actual.get(sourceKey);
		if (!actualEntry || actualEntry.activeJobIds.size !== expectedEntry.activeJobIds.size || actualEntry.recoveryJobIds.size !== expectedEntry.recoveryJobIds.size) return false;
		for (const owner of expectedEntry.activeJobIds) if (!actualEntry.activeJobIds.has(owner)) return false;
		for (const owner of expectedEntry.recoveryJobIds) if (!actualEntry.recoveryJobIds.has(owner)) return false;
	}
	return true;
}

function normalizeSourceKey(normalizeLibrarySourceKey, sourcePublicPath) {
	try {
		const key = normalizeLibrarySourceKey(sourcePublicPath);
		return typeof key === "string" && key.length > 0 && !key.includes("\0") ? key : null;
	} catch {
		return null;
	}
}

function sourceView(entry) {
	const activeOwnerCount = entry?.activeJobIds?.size || 0;
	const recoveryOwnerCount = entry?.recoveryJobIds?.size || 0;
	const view = freeze({
		ok: true,
		code: null,
		hasActive: activeOwnerCount > 0,
		hasRecovery: recoveryOwnerCount > 0,
		activeOwnerCount,
		recoveryOwnerCount,
	});
	lockViews.add(view);
	return view;
}

function recoveryFieldState(job) {
	const normalizedHold = normalizeRecoveryHold(job?.recoveryHold);
	const normalizedPreExecution = normalizePreExecutionRecovery(job?.preExecutionRecovery);
	const rawHold = job?.recoveryHold !== null && job?.recoveryHold !== undefined;
	const rawPreExecution = job?.preExecutionRecovery !== null && job?.preExecutionRecovery !== undefined;
	return freeze({
		hasRecoveryHold: Boolean(normalizedHold.hold),
		malformedRecoveryHold: rawHold && normalizedHold.malformed,
		preExecutionCode: normalizedPreExecution.recovery?.code || null,
		malformedPreExecution: rawPreExecution && normalizedPreExecution.malformed,
	});
}

function isTerminalProtected(job) {
	return TERMINAL_PROTECTED_STATES.has(job?.state);
}

function reasonRequirements(job) {
	if (!record(job) || !safeJobId(job.id)) return freeze({ ok: false, code: PLAN_FAILURE_CODE });
	if (isTerminalProtected(job)) return freeze({ ok: true, active: false, recovery: false, terminal: true });
	if (!isTranscodeTaskState(job.state)) return freeze({ ok: false, code: PLAN_FAILURE_CODE });
	const fields = recoveryFieldState(job);
	const active = shouldLockTranscodeLibrarySource(job.state);
	const recovery = fields.hasRecoveryHold || fields.malformedRecoveryHold || Boolean(fields.preExecutionCode) || fields.malformedPreExecution;
	return freeze({ ok: true, active, recovery, terminal: false, fields });
}

function sourceReasonRequirements(job, requirements) {
	if (!requirements.active && !requirements.recovery) return freeze({ ok: true, active: false, recovery: false });
	if (job.sourceType !== "library" && job.sourceType !== "upload") return freeze({ ok: false, code: PLAN_FAILURE_CODE });
	const preExecutionCode = requirements.fields?.preExecutionCode;
	if (preExecutionCode === "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD" && job.sourceType !== "upload") {
		return freeze({ ok: false, code: PLAN_FAILURE_CODE });
	}
	if (job.sourceType === "upload") return freeze({ ok: true, active: false, recovery: false });
	return freeze({ ok: true, active: requirements.active, recovery: requirements.recovery });
}

function planFailure() {
	return freeze({ ok: false, code: PLAN_FAILURE_CODE, summary: emptySummary() });
}

function conflict(disposition, code = null) {
	return freeze({ disposition, code, message: code ? safeMessage(code) : null });
}

/**
 * A capability-based manager. Every public source operation normalizes the
 * raw public path itself, so callers cannot claim a key was pre-normalized.
 */
export function createReasonAwareSourceLockRegistry({ targetMap = new Map(), normalizeLibrarySourceKey, validateJobId = safeJobId } = {}) {
	if (!targetMap || typeof targetMap.get !== "function" || typeof targetMap.set !== "function" || typeof targetMap.delete !== "function"
		|| typeof targetMap.entries !== "function" || typeof normalizeLibrarySourceKey !== "function" || typeof validateJobId !== "function") {
		throw new TypeError("Recovery source lock registry dependencies are invalid");
	}

	function resolve(sourcePublicPath) {
		const sourceKey = normalizeSourceKey(normalizeLibrarySourceKey, sourcePublicPath);
		return sourceKey || null;
	}

	function acquire({ sourcePublicPath, jobId, reason } = {}) {
		if (!validateJobId(jobId) || !safeJobId(jobId) || !TRANSCODE_LOCK_REASONS.includes(reason)) {
			return freeze({ ok: false, code: REGISTRY_FAILURE_CODE, acquired: false, view: emptyView(false, REGISTRY_FAILURE_CODE) });
		}
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return freeze({ ok: false, code: SOURCE_FAILURE_CODE, acquired: false, view: emptyView(false, SOURCE_FAILURE_CODE) });
		const current = targetMap.get(sourceKey);
		if (current !== undefined && !entryIsValid(current, validateJobId)) {
			return freeze({ ok: false, code: REGISTRY_FAILURE_CODE, acquired: false, view: emptyView(false, REGISTRY_FAILURE_CODE) });
		}
		const entry = current || { activeJobIds: new Set(), recoveryJobIds: new Set() };
		const owners = reason === "active" ? entry.activeJobIds : entry.recoveryJobIds;
		const acquired = !owners.has(jobId);
		owners.add(jobId);
		if (!current) targetMap.set(sourceKey, entry);
		return freeze({ ok: true, code: null, acquired, view: sourceView(entry) });
	}

	function release({ sourcePublicPath, jobId, reason } = {}) {
		if (!validateJobId(jobId) || !safeJobId(jobId) || !TRANSCODE_LOCK_REASONS.includes(reason)) {
			return freeze({ ok: false, code: REGISTRY_FAILURE_CODE, released: false, view: emptyView(false, REGISTRY_FAILURE_CODE) });
		}
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return freeze({ ok: false, code: SOURCE_FAILURE_CODE, released: false, view: emptyView(false, SOURCE_FAILURE_CODE) });
		const entry = targetMap.get(sourceKey);
		if (entry === undefined) return freeze({ ok: true, code: null, released: false, view: emptyView() });
		if (!entryIsValid(entry, validateJobId)) return freeze({ ok: false, code: REGISTRY_FAILURE_CODE, released: false, view: emptyView(false, REGISTRY_FAILURE_CODE) });
		const owners = reason === "active" ? entry.activeJobIds : entry.recoveryJobIds;
		const released = owners.delete(jobId);
		if (entry.activeJobIds.size === 0 && entry.recoveryJobIds.size === 0) targetMap.delete(sourceKey);
		return freeze({ ok: true, code: null, released, view: sourceView(entry) });
	}

	function getLockView(sourcePublicPath) {
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return emptyView(false, SOURCE_FAILURE_CODE);
		const entry = targetMap.get(sourceKey);
		if (entry === undefined) return emptyView();
		return entryIsValid(entry, validateJobId) ? sourceView(entry) : emptyView(false, REGISTRY_FAILURE_CODE);
	}

	function getSafeSummary() {
		const entries = registryEntries(targetMap, validateJobId);
		return entries ? summaryForEntries(entries) : emptySummary();
	}

	return freeze({
		acquire,
		release,
		getLockView,
		hasAnyLock(sourcePublicPath) { const view = getLockView(sourcePublicPath); return freeze({ ok: view.ok, locked: view.hasActive || view.hasRecovery, code: view.code }); },
		hasRecoveryLock(sourcePublicPath) { const view = getLockView(sourcePublicPath); return freeze({ ok: view.ok, locked: view.hasRecovery, code: view.code }); },
		getSafeSummary,
		validateInternalState() { return registryEntries(targetMap, validateJobId) !== null; },
	});
}

/**
 * Creates an opaque, immutable plan from final recovery snapshots.
 */
export function createRecoveryLockPlan({ snapshots, normalizeLibrarySourceKey, validateJobId = safeJobId } = {}) {
	if (!Array.isArray(snapshots) || typeof normalizeLibrarySourceKey !== "function" || typeof validateJobId !== "function") return planFailure();
	const entries = new Map();
	const seenJobs = new Set();
	for (const snapshot of snapshots) {
		const job = snapshot?.job;
		if (!record(job) || !validateJobId(job.id) || !safeJobId(job.id) || seenJobs.has(job.id.toLowerCase())) return planFailure();
		seenJobs.add(job.id.toLowerCase());
		const requirements = reasonRequirements(job);
		if (!requirements.ok) return planFailure();
		if (requirements.terminal) continue;
		const sourceRequirements = sourceReasonRequirements(job, requirements);
		if (!sourceRequirements.ok) return planFailure();
		if (!sourceRequirements.active && !sourceRequirements.recovery) continue;
		if (typeof job.sourcePublicPath !== "string" || !job.sourcePublicPath) return planFailure();
		const sourceKey = normalizeSourceKey(normalizeLibrarySourceKey, job.sourcePublicPath);
		if (!sourceKey) return planFailure();
		const entry = entries.get(sourceKey) || { activeJobIds: new Set(), recoveryJobIds: new Set() };
		if (sourceRequirements.active) entry.activeJobIds.add(job.id);
		if (sourceRequirements.recovery) entry.recoveryJobIds.add(job.id);
		entries.set(sourceKey, entry);
	}
	const sortedEntries = new Map([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
	const summary = summaryForEntries(sortedEntries);
	const plan = freeze({ kind: PLAN_KIND, summary });
	plans.set(plan, cloneEntries(sortedEntries));
	return freeze({ ok: true, plan, summary });
}

/**
 * Replaces a reason-aware target registry in-place, with rollback on failure.
 */
export function installRecoveryLockPlan({ targetMap, plan, validateJobId = safeJobId } = {}) {
	if (!targetMap || typeof targetMap.clear !== "function" || typeof targetMap.set !== "function" || typeof targetMap.entries !== "function"
		|| !plans.has(plan) || plan?.kind !== PLAN_KIND || typeof validateJobId !== "function") {
		return freeze({ ok: false, installed: false, registryStateUnknown: false, code: REGISTRY_FAILURE_CODE, summary: emptySummary() });
	}
	const expected = plans.get(plan);
	const previous = registryEntries(targetMap, validateJobId);
	if (!previous || !sameEntries(new Map([...expected.entries()].map(([key, entry]) => [key, copyEntry(entry)])), expected, validateJobId)) {
		return freeze({ ok: false, installed: false, registryStateUnknown: false, code: REGISTRY_FAILURE_CODE, summary: emptySummary() });
	}
	try {
		applyEntries(targetMap, expected);
		if (!sameEntries(targetMap, expected, validateJobId)) throw new Error("recovery lock installation mismatch");
		return freeze({ ok: true, installed: true, registryStateUnknown: false, code: null, summary: summaryForEntries(expected) });
	} catch {
		try {
			applyEntries(targetMap, previous);
			if (!sameEntries(targetMap, previous, validateJobId)) throw new Error("recovery lock rollback mismatch");
			return freeze({ ok: false, installed: false, registryStateUnknown: false, code: REGISTRY_FAILURE_CODE, summary: emptySummary() });
		} catch {
			return freeze({ ok: false, installed: false, registryStateUnknown: true, code: REGISTRY_FAILURE_CODE, summary: emptySummary() });
		}
	}
}

/**
 * Pure recovery-only gate. Ordinary job state validation remains in the server.
 */
export function getTranscodeRecoveryOperationConflict(job, operation) {
	const known = JOB_READ_OPERATIONS.has(operation) || JOB_MUTATION_OPERATIONS.has(operation) || operation === "retention-cleanup";
	if (!known) return conflict("reject", OPERATION_FAILURE_CODE);
	if (isTerminalProtected(job) || JOB_READ_OPERATIONS.has(operation)) return conflict("allow");
	const fields = recoveryFieldState(job);
	if (operation === "incomplete-upload-safe-discard") {
		const allowed = job?.sourceType === "upload"
			&& fields.preExecutionCode === "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD"
			&& !fields.hasRecoveryHold && !fields.malformedRecoveryHold && !fields.malformedPreExecution;
		return allowed ? conflict("allow") : conflict("reject", TRANSCODE_RECOVERY_CONFLICT_CODE);
	}
	const protectedByRecovery = fields.hasRecoveryHold || fields.malformedRecoveryHold || Boolean(fields.preExecutionCode) || fields.malformedPreExecution;
	if (!protectedByRecovery) return conflict("allow");
	if (operation === "retention-cleanup") return conflict("skip", TRANSCODE_RECOVERY_CONFLICT_CODE);
	return conflict("reject", TRANSCODE_RECOVERY_CONFLICT_CODE);
}

/**
 * Pure source gate. Callers must hold their media-operation lock before using it.
 */
export function getTranscodeSourceMutationConflict(lockView, operation) {
	const known = SOURCE_READ_OPERATIONS.has(operation) || SOURCE_MUTATION_OPERATIONS.has(operation);
	if (!known) return conflict("reject", OPERATION_FAILURE_CODE);
	if (!lockViews.has(lockView) || !record(lockView) || lockView.ok !== true || !Number.isSafeInteger(lockView.activeOwnerCount)
		|| !Number.isSafeInteger(lockView.recoveryOwnerCount) || lockView.activeOwnerCount < 0 || lockView.recoveryOwnerCount < 0) {
		return conflict("reject", REGISTRY_FAILURE_CODE);
	}
	if (SOURCE_READ_OPERATIONS.has(operation)) return conflict("allow");
	if (lockView.recoveryOwnerCount > 0 || lockView.hasRecovery === true) return conflict("reject", TRANSCODE_RECOVERY_CONFLICT_CODE);
	if (lockView.activeOwnerCount > 0 || lockView.hasActive === true) return conflict("reject", "TRANSCODE_SOURCE_LOCKED");
	return conflict("allow");
}

export function isOpaqueRecoveryLockPlan(value) {
	return Boolean(value && value.kind === PLAN_KIND && plans.has(value));
}

export const TRANSCODE_RECOVERY_LOCK_INTERNAL_CODES = Object.freeze({
	plan: PLAN_FAILURE_CODE,
	registry: REGISTRY_FAILURE_CODE,
	source: SOURCE_FAILURE_CODE,
	operation: OPERATION_FAILURE_CODE,
});
