/**
 * Pure source-lock planning and conflict policy. Registry state is supplied by
 * callers; this module has no filesystem, process, or production startup I/O.
 */
import {
	isTranscodeTaskState,
	shouldLockTranscodeLibrarySource,
} from "./transcode-policy.mjs";
import {
	normalizePreExecutionRecovery,
	normalizeRecoveryHold,
} from "./transcode-recovery.mjs";

export const TRANSCODE_LOCK_REASONS = Object.freeze(["active", "recovery"]);
export const TRANSCODE_RECOVERY_CONFLICT_CODE = "TRANSCODE_RECOVERY_HOLD_ACTIVE";
export const TRANSCODE_SOURCE_READER_CONFLICT_CODE = "TRANSCODE_SOURCE_READER_ACTIVE";

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_KIND = "transcode-recovery-lock-plan";
const ENTRY_VERSION = 2;
const PLAN_FAILURE_CODE = "TRANSCODE_RECOVERY_LOCK_PLAN_INVALID";
const REGISTRY_FAILURE_CODE = "TRANSCODE_SOURCE_READER_REGISTRY_INVALID";
const SOURCE_FAILURE_CODE = "TRANSCODE_RECOVERY_LOCK_SOURCE_INVALID";
const OPERATION_FAILURE_CODE = "TRANSCODE_RECOVERY_OPERATION_INVALID";
const LEASE_INVALID_CODE = "TRANSCODE_SOURCE_READER_LEASE_INVALID";
const LEASE_KIND_CODE = "TRANSCODE_SOURCE_READER_LEASE_KIND_INVALID";
const LEASE_SOURCE_MISMATCH_CODE = "TRANSCODE_SOURCE_READER_LEASE_SOURCE_MISMATCH";
const ACQUISITION_PROOF_INVALID_CODE = "TRANSCODE_SOURCE_READER_ACQUISITION_PROOF_INVALID";
const ACQUISITION_PROOF_USED_CODE = "TRANSCODE_SOURCE_READER_ACQUISITION_PROOF_ALREADY_USED";
const RELEASE_HANDLE_INVALID_CODE = "TRANSCODE_SOURCE_READER_RELEASE_HANDLE_INVALID";
const RELEASE_GENERATION_MISMATCH_CODE = "TRANSCODE_SOURCE_READER_RELEASE_GENERATION_MISMATCH";
const RECOVERY_READER_ACTIVE_CODE = "TRANSCODE_SOURCE_RECOVERY_READER_ACTIVE";
const CONTRIBUTION_FAILURE_CODE = "TRANSCODE_RECOVERY_READER_CONTRIBUTION_INVALID";
const TARGET_NOT_EMPTY_CODE = "TRANSCODE_RECOVERY_LOCK_INSTALL_TARGET_NOT_EMPTY";

const entries = new WeakSet();
const plans = new WeakMap();
const lockViews = new WeakSet();
const leaseTokens = new WeakMap();
const leaseConsumers = new WeakSet();
const readerAcquisitionProofs = new WeakMap();
const readerReleaseHandles = new WeakMap();
const contributionConsumers = new WeakSet();
const contributions = new WeakMap();

const TERMINAL_PROTECTED_STATES = new Set(["completed", "cancelled", "failed", "discarded"]);
const JOB_READ_OPERATIONS = new Set(["read", "summary", "source-probe-readonly"]);
const JOB_MUTATION_OPERATIONS = new Set(["start", "retry", "cancel", "discard", "delete", "cleanup", "incomplete-upload-safe-discard"]);
const SOURCE_READ_OPERATIONS = new Set(["read", "list", "listing", "playback", "download"]);
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
	"overwrite",
]);

function freeze(value) {
	return Object.freeze(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeJobId(value) {
	return typeof value === "string" && SAFE_JOB_ID.test(value);
}

function exactEntryKeys(value) {
	const keys = Object.keys(value).sort();
	return keys.length === 5
		&& keys[0] === "activeJobIds"
		&& keys[1] === "recoveryJobIds"
		&& keys[2] === "recoveryReaderLeaseIds"
		&& keys[3] === "runtimeReaderLeaseIds"
		&& keys[4] === "version";
}

function createEntry() {
	const entry = {
		version: ENTRY_VERSION,
		activeJobIds: new Set(),
		recoveryJobIds: new Set(),
		runtimeReaderLeaseIds: new Set(),
		recoveryReaderLeaseIds: new Set(),
	};
	entries.add(entry);
	return entry;
}

function copyEntry(entry) {
	const copy = createEntry();
	copy.activeJobIds = new Set(entry.activeJobIds);
	copy.recoveryJobIds = new Set(entry.recoveryJobIds);
	copy.runtimeReaderLeaseIds = new Set(entry.runtimeReaderLeaseIds);
	copy.recoveryReaderLeaseIds = new Set(entry.recoveryReaderLeaseIds);
	return copy;
}

function cloneEntries(input) {
	const copied = new Map();
	for (const [sourceKey, entry] of input) copied.set(sourceKey, copyEntry(entry));
	return copied;
}

function safeSummary() {
	return freeze({
		sourceCount: 0,
		activeSourceCount: 0,
		recoverySourceCount: 0,
		activeOwnerCount: 0,
		recoveryOwnerCount: 0,
		runtimeReaderSourceCount: 0,
		recoveryReaderSourceCount: 0,
		runtimeReaderOwnerCount: 0,
		recoveryReaderOwnerCount: 0,
	});
}

function summaryForEntries(input) {
	let activeSourceCount = 0;
	let recoverySourceCount = 0;
	let activeOwnerCount = 0;
	let recoveryOwnerCount = 0;
	let runtimeReaderSourceCount = 0;
	let recoveryReaderSourceCount = 0;
	let runtimeReaderOwnerCount = 0;
	let recoveryReaderOwnerCount = 0;
	for (const entry of input.values()) {
		const active = entry.activeJobIds.size;
		const recovery = entry.recoveryJobIds.size;
		const runtimeReaders = entry.runtimeReaderLeaseIds.size;
		const recoveryReaders = entry.recoveryReaderLeaseIds.size;
		if (active) activeSourceCount += 1;
		if (recovery) recoverySourceCount += 1;
		if (runtimeReaders) runtimeReaderSourceCount += 1;
		if (recoveryReaders) recoveryReaderSourceCount += 1;
		activeOwnerCount += active;
		recoveryOwnerCount += recovery;
		runtimeReaderOwnerCount += runtimeReaders;
		recoveryReaderOwnerCount += recoveryReaders;
	}
	return freeze({
		sourceCount: input.size,
		activeSourceCount,
		recoverySourceCount,
		activeOwnerCount,
		recoveryOwnerCount,
		runtimeReaderSourceCount,
		recoveryReaderSourceCount,
		runtimeReaderOwnerCount,
		recoveryReaderOwnerCount,
	});
}

function entryIsValid(entry, validateJobId = safeJobId, validateLease = null) {
	if (!entries.has(entry) || !record(entry) || entry.version !== ENTRY_VERSION || !exactEntryKeys(entry)
		|| !(entry.activeJobIds instanceof Set) || !(entry.recoveryJobIds instanceof Set)
		|| !(entry.runtimeReaderLeaseIds instanceof Set) || !(entry.recoveryReaderLeaseIds instanceof Set)) return false;
	for (const owner of entry.activeJobIds) if (!validateJobId(owner) || !safeJobId(owner)) return false;
	for (const owner of entry.recoveryJobIds) if (!validateJobId(owner) || !safeJobId(owner)) return false;
	if (entry.runtimeReaderLeaseIds.size > 0 || entry.recoveryReaderLeaseIds.size > 0) {
		if (typeof validateLease !== "function") return false;
		for (const token of entry.runtimeReaderLeaseIds) if (!validateLease(token, "runtime")) return false;
		for (const token of entry.recoveryReaderLeaseIds) if (!validateLease(token, "recovery")) return false;
	}
	return true;
}

function registryEntries(targetMap, validateJobId, validateLease) {
	if (!targetMap || typeof targetMap.entries !== "function") return null;
	const copied = new Map();
	try {
		for (const [sourceKey, entry] of targetMap.entries()) {
			if (typeof sourceKey !== "string" || !sourceKey || !entryIsValid(entry, validateJobId, validateLease)) return null;
			copied.set(sourceKey, copyEntry(entry));
		}
	} catch {
		return null;
	}
	return copied;
}

function applyEntries(targetMap, input) {
	targetMap.clear();
	for (const [sourceKey, entry] of input) targetMap.set(sourceKey, copyEntry(entry));
}

function sameEntries(targetMap, expected, validateJobId, validateLease) {
	const actual = registryEntries(targetMap, validateJobId, validateLease);
	if (!actual || actual.size !== expected.size) return false;
	for (const [sourceKey, expectedEntry] of expected) {
		const actualEntry = actual.get(sourceKey);
		if (!actualEntry) return false;
		for (const field of ["activeJobIds", "recoveryJobIds", "runtimeReaderLeaseIds", "recoveryReaderLeaseIds"]) {
			if (actualEntry[field].size !== expectedEntry[field].size) return false;
			for (const owner of expectedEntry[field]) if (!actualEntry[field].has(owner)) return false;
		}
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

function emptyView(ok = true, code = null) {
	const view = freeze({
		ok,
		code,
		hasActive: false,
		hasRecovery: false,
		hasRuntimeReader: false,
		hasRecoveryReader: false,
		activeOwnerCount: 0,
		recoveryOwnerCount: 0,
		runtimeReaderOwnerCount: 0,
		recoveryReaderOwnerCount: 0,
	});
	lockViews.add(view);
	return view;
}

function sourceView(entry) {
	const activeOwnerCount = entry.activeJobIds.size;
	const recoveryOwnerCount = entry.recoveryJobIds.size;
	const runtimeReaderOwnerCount = entry.runtimeReaderLeaseIds.size;
	const recoveryReaderOwnerCount = entry.recoveryReaderLeaseIds.size;
	const view = freeze({
		ok: true,
		code: null,
		hasActive: activeOwnerCount > 0,
		hasRecovery: recoveryOwnerCount > 0,
		hasRuntimeReader: runtimeReaderOwnerCount > 0,
		hasRecoveryReader: recoveryReaderOwnerCount > 0,
		activeOwnerCount,
		recoveryOwnerCount,
		runtimeReaderOwnerCount,
		recoveryReaderOwnerCount,
	});
	lockViews.add(view);
	return view;
}

function safeMessage(code) {
	if (code === TRANSCODE_RECOVERY_CONFLICT_CODE) return "Transcode recovery is still protecting this task.";
	if (code === TRANSCODE_SOURCE_READER_CONFLICT_CODE) return "A source reader is still active.";
	return "The requested recovery operation is not available.";
}

function conflict(disposition, code = null, kind = null) {
	return freeze({ disposition, code, kind, message: code ? safeMessage(code) : null });
}

function planFailure(code = PLAN_FAILURE_CODE) {
	return freeze({ ok: false, code, summary: safeSummary() });
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
	if (!record(job) || !safeJobId(job.id)) return freeze({ ok: false });
	if (isTerminalProtected(job)) return freeze({ ok: true, active: false, recovery: false, terminal: true });
	if (!isTranscodeTaskState(job.state)) return freeze({ ok: false });
	const fields = recoveryFieldState(job);
	return freeze({
		ok: true,
		active: shouldLockTranscodeLibrarySource(job.state),
		recovery: fields.hasRecoveryHold || fields.malformedRecoveryHold || Boolean(fields.preExecutionCode) || fields.malformedPreExecution,
		terminal: false,
		fields,
	});
}

function sourceReasonRequirements(job, requirements) {
	if (!requirements.active && !requirements.recovery) return freeze({ ok: true, active: false, recovery: false });
	if (job.sourceType !== "library" && job.sourceType !== "upload") return freeze({ ok: false });
	if (requirements.fields?.preExecutionCode === "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD" && job.sourceType !== "upload") return freeze({ ok: false });
	if (job.sourceType === "upload") return freeze({ ok: true, active: false, recovery: false });
	return freeze({ ok: true, active: requirements.active, recovery: requirements.recovery });
}

function hasAnyOwner(entry) {
	return entry.activeJobIds.size > 0 || entry.recoveryJobIds.size > 0
		|| entry.runtimeReaderLeaseIds.size > 0 || entry.recoveryReaderLeaseIds.size > 0;
}

function tokenDetails(consumer, token, expectedKind, sourceKey, { bind = false } = {}) {
	if (!leaseConsumers.has(consumer)) return freeze({ ok: false, code: LEASE_INVALID_CODE });
	const details = leaseTokens.get(token);
	if (!details || details.authority !== consumer.authority) return freeze({ ok: false, code: LEASE_INVALID_CODE });
	if (details.kind !== expectedKind) return freeze({ ok: false, code: LEASE_KIND_CODE });
	if (details.sourceKey !== null && details.sourceKey !== sourceKey) return freeze({ ok: false, code: LEASE_SOURCE_MISMATCH_CODE });
	if (bind && details.sourceKey === null) details.sourceKey = sourceKey;
	return freeze({ ok: true, code: null, token });
}

function validReaderLease(consumer, token, expectedKind) {
	if (!leaseConsumers.has(consumer)) return false;
	const details = leaseTokens.get(token);
	return Boolean(details && details.authority === consumer.authority && details.kind === expectedKind && details.sourceKey !== null);
}

/**
 * Opaque reader tokens have a distinct authority from job IDs. An issued token
 * permanently binds to the first canonical source it acquires.
 */
export function createTranscodeSourceReaderLeaseAuthority() {
	const authority = {};
	const registryConsumer = freeze({ authority });
	leaseConsumers.add(registryConsumer);
	const runtimeAcquisitionConsumer = freeze({
		inspect(proof, releaseHandle, callback) {
			const acquisition = readerAcquisitionProofs.get(proof);
			const release = readerReleaseHandles.get(releaseHandle);
			if (!acquisition || acquisition.authority !== authority || acquisition.used || !release || release.authority !== authority
				|| release.released || release.acquisition !== acquisition || typeof callback !== "function") {
				return freeze({ ok: false, code: !acquisition || acquisition.authority !== authority
					? ACQUISITION_PROOF_INVALID_CODE
					: acquisition.used ? ACQUISITION_PROOF_USED_CODE : RELEASE_HANDLE_INVALID_CODE });
			}
			try { return callback(freeze({ sourceKey: acquisition.sourceKey })); }
			catch { return freeze({ ok: false, code: ACQUISITION_PROOF_INVALID_CODE }); }
		},
		consume(proof) {
			const acquisition = readerAcquisitionProofs.get(proof);
			if (!acquisition || acquisition.authority !== authority) return freeze({ ok: false, code: ACQUISITION_PROOF_INVALID_CODE });
			if (acquisition.used || !acquisition.active()) return freeze({ ok: false, code: ACQUISITION_PROOF_USED_CODE });
			acquisition.used = true;
			return freeze({ ok: true, code: null });
		},
	});
	const runtimeReleaseConsumer = freeze({
		release(releaseHandle) {
			const release = readerReleaseHandles.get(releaseHandle);
			if (!release || release.authority !== authority || typeof release.release !== "function") {
				return freeze({ ok: false, code: RELEASE_HANDLE_INVALID_CODE, released: false });
			}
			if (release.released) return freeze({ ok: true, code: null, released: true, alreadyReleased: true });
			let result;
			try { result = release.release(); }
			catch { return freeze({ ok: false, code: RELEASE_HANDLE_INVALID_CODE, released: false }); }
			if (!result?.ok || result.released !== true) return freeze({ ok: false, code: result?.code || RELEASE_HANDLE_INVALID_CODE, released: false });
			release.released = true;
			return freeze({ ok: true, code: null, released: true, alreadyReleased: false });
		},
	});
	function mint(kind) {
		const token = {};
		Object.defineProperties(token, {
			kind: { value: "transcode-source-reader-lease", enumerable: false },
			toJSON: { value: () => ({ kind: "transcode-source-reader-lease" }), enumerable: false },
		});
		leaseTokens.set(token, { authority, kind, sourceKey: null, runtimeRegistry: null, runtimeGeneration: 0, runtimeActiveGeneration: null });
		return freeze(token);
	}
	return freeze({
		issuer: freeze({
			mintRuntimeReaderLease() { return freeze({ ok: true, leaseToken: mint("runtime") }); },
			mintRecoveryReaderLease() { return freeze({ ok: true, leaseToken: mint("recovery") }); },
		}),
		registryConsumer,
		runtimeAcquisitionConsumer,
		runtimeReleaseConsumer,
	});
}

/**
 * A source registry always normalizes raw public references itself. Job owners
 * remain validated UUID strings; reader owners require opaque lease tokens.
 */
export function createReasonAwareSourceLockRegistry({
	targetMap = new Map(),
	normalizeLibrarySourceKey,
	validateJobId = safeJobId,
	readerLeaseConsumer = null,
} = {}) {
	if (!targetMap || typeof targetMap.get !== "function" || typeof targetMap.set !== "function" || typeof targetMap.delete !== "function"
		|| typeof targetMap.entries !== "function" || typeof normalizeLibrarySourceKey !== "function" || typeof validateJobId !== "function"
		|| (readerLeaseConsumer !== null && !leaseConsumers.has(readerLeaseConsumer))) {
		throw new TypeError("Recovery source lock registry dependencies are invalid");
	}
	const validateLease = (token, kind) => validReaderLease(readerLeaseConsumer, token, kind);
	const registryIdentity = {};
	function resolve(sourcePublicPath) {
		return normalizeSourceKey(normalizeLibrarySourceKey, sourcePublicPath);
	}
	function currentEntry(sourceKey) {
		if (registryEntries(targetMap, validateJobId, validateLease) === null) return { entry: null, code: REGISTRY_FAILURE_CODE };
		const entry = targetMap.get(sourceKey);
		if (entry === undefined) return { entry: null, code: null };
		return entryIsValid(entry, validateJobId, validateLease) ? { entry, code: null } : { entry: null, code: REGISTRY_FAILURE_CODE };
	}
	function acquire({ sourcePublicPath, jobId, reason } = {}) {
		if (!validateJobId(jobId) || !safeJobId(jobId) || !TRANSCODE_LOCK_REASONS.includes(reason)) {
			return freeze({ ok: false, code: REGISTRY_FAILURE_CODE, acquired: false, view: emptyView(false, REGISTRY_FAILURE_CODE) });
		}
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return freeze({ ok: false, code: SOURCE_FAILURE_CODE, acquired: false, view: emptyView(false, SOURCE_FAILURE_CODE) });
		const current = currentEntry(sourceKey);
		if (current.code) return freeze({ ok: false, code: current.code, acquired: false, view: emptyView(false, current.code) });
		const entry = current.entry || createEntry();
		const owners = reason === "active" ? entry.activeJobIds : entry.recoveryJobIds;
		const acquired = !owners.has(jobId);
		owners.add(jobId);
		if (!current.entry) targetMap.set(sourceKey, entry);
		return freeze({ ok: true, code: null, acquired, view: sourceView(entry) });
	}
	function release({ sourcePublicPath, jobId, reason } = {}) {
		if (!validateJobId(jobId) || !safeJobId(jobId) || !TRANSCODE_LOCK_REASONS.includes(reason)) {
			return freeze({ ok: false, code: REGISTRY_FAILURE_CODE, released: false, view: emptyView(false, REGISTRY_FAILURE_CODE) });
		}
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return freeze({ ok: false, code: SOURCE_FAILURE_CODE, released: false, view: emptyView(false, SOURCE_FAILURE_CODE) });
		const current = currentEntry(sourceKey);
		if (current.code) return freeze({ ok: false, code: current.code, released: false, view: emptyView(false, current.code) });
		if (!current.entry) return freeze({ ok: true, code: null, released: false, view: emptyView() });
		const owners = reason === "active" ? current.entry.activeJobIds : current.entry.recoveryJobIds;
		const released = owners.delete(jobId);
		if (!hasAnyOwner(current.entry)) targetMap.delete(sourceKey);
		return freeze({ ok: true, code: null, released, view: sourceView(current.entry) });
	}
	function acquireReader(sourcePublicPath, leaseToken, kind) {
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return freeze({ ok: false, code: SOURCE_FAILURE_CODE, acquired: false, view: emptyView(false, SOURCE_FAILURE_CODE) });
		const current = currentEntry(sourceKey);
		if (current.code) return freeze({ ok: false, code: current.code, acquired: false, view: emptyView(false, current.code) });
		const token = tokenDetails(readerLeaseConsumer, leaseToken, kind, sourceKey, { bind: true });
		if (!token.ok) return freeze({ ok: false, code: token.code, acquired: false, view: emptyView(false, token.code) });
		const entry = current.entry || createEntry();
		const owners = kind === "runtime" ? entry.runtimeReaderLeaseIds : entry.recoveryReaderLeaseIds;
		const acquired = !owners.has(leaseToken);
		owners.add(leaseToken);
		if (!current.entry) targetMap.set(sourceKey, entry);
		if (kind !== "runtime" || !acquired) return freeze({ ok: true, code: null, acquired, view: sourceView(entry), acquisitionProof: null, releaseHandle: null });
		const details = leaseTokens.get(leaseToken);
		if (details.runtimeRegistry !== null && details.runtimeRegistry !== registryIdentity) {
			owners.delete(leaseToken);
			if (!current.entry && !hasAnyOwner(entry)) targetMap.delete(sourceKey);
			return freeze({ ok: false, code: ACQUISITION_PROOF_INVALID_CODE, acquired: false, view: emptyView(false, ACQUISITION_PROOF_INVALID_CODE), acquisitionProof: null, releaseHandle: null });
		}
		details.runtimeRegistry = registryIdentity;
		details.runtimeGeneration += 1;
		details.runtimeActiveGeneration = details.runtimeGeneration;
		const generation = details.runtimeGeneration;
		const acquisition = { authority: readerLeaseConsumer.authority, registryIdentity, sourceKey, leaseToken, generation, used: false,
			active: () => details.runtimeRegistry === registryIdentity && details.runtimeActiveGeneration === generation };
		const acquisitionProof = freeze({ kind: "transcode-source-reader-acquisition-proof" });
		const releaseHandle = freeze({ kind: "transcode-source-reader-release-handle" });
		readerAcquisitionProofs.set(acquisitionProof, acquisition);
		readerReleaseHandles.set(releaseHandle, {
			authority: readerLeaseConsumer.authority,
			acquisition,
			released: false,
			release: () => releaseRuntimeAcquisition(sourceKey, leaseToken, acquisition.generation),
		});
		return freeze({ ok: true, code: null, acquired, view: sourceView(entry), acquisitionProof, releaseHandle });
	}
	function releaseRuntimeAcquisition(sourceKey, leaseToken, generation) {
		const details = leaseTokens.get(leaseToken);
		if (!details || details.runtimeRegistry !== registryIdentity || details.runtimeActiveGeneration !== generation) {
			return freeze({ ok: false, code: RELEASE_GENERATION_MISMATCH_CODE, released: false });
		}
		const current = currentEntry(sourceKey);
		if (current.code || !current.entry || !current.entry.runtimeReaderLeaseIds.has(leaseToken)) {
			return freeze({ ok: false, code: current.code || RELEASE_GENERATION_MISMATCH_CODE, released: false });
		}
		current.entry.runtimeReaderLeaseIds.delete(leaseToken);
		details.runtimeActiveGeneration = null;
		if (!hasAnyOwner(current.entry)) targetMap.delete(sourceKey);
		return freeze({ ok: true, code: null, released: true });
	}
	function releaseReader(sourcePublicPath, leaseToken, kind) {
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return freeze({ ok: false, code: SOURCE_FAILURE_CODE, released: false, view: emptyView(false, SOURCE_FAILURE_CODE) });
		const token = tokenDetails(readerLeaseConsumer, leaseToken, kind, sourceKey, { bind: false });
		if (!token.ok) return freeze({ ok: false, code: token.code, released: false, view: emptyView(false, token.code) });
		const current = currentEntry(sourceKey);
		if (current.code) return freeze({ ok: false, code: current.code, released: false, view: emptyView(false, current.code) });
		if (!current.entry) return freeze({ ok: true, code: null, released: false, view: emptyView() });
		const owners = kind === "runtime" ? current.entry.runtimeReaderLeaseIds : current.entry.recoveryReaderLeaseIds;
		const released = owners.delete(leaseToken);
		if (kind === "runtime" && released) {
			const details = leaseTokens.get(leaseToken);
			if (details?.runtimeRegistry === registryIdentity) details.runtimeActiveGeneration = null;
		}
		if (!hasAnyOwner(current.entry)) targetMap.delete(sourceKey);
		return freeze({ ok: true, code: null, released, view: sourceView(current.entry) });
	}
	function getLockView(sourcePublicPath) {
		const sourceKey = resolve(sourcePublicPath);
		if (!sourceKey) return emptyView(false, SOURCE_FAILURE_CODE);
		const current = currentEntry(sourceKey);
		if (current.code) return emptyView(false, current.code);
		return current.entry ? sourceView(current.entry) : emptyView();
	}
	function getSafeSummary() {
		const copied = registryEntries(targetMap, validateJobId, validateLease);
		return copied ? summaryForEntries(copied) : safeSummary();
	}
	return freeze({
		acquire,
		release,
		acquireRuntimeReader(sourcePublicPath, leaseToken) { return acquireReader(sourcePublicPath, leaseToken, "runtime"); },
		releaseRuntimeReader(sourcePublicPath, leaseToken) { return releaseReader(sourcePublicPath, leaseToken, "runtime"); },
		acquireRecoveryReader(sourcePublicPath, leaseToken) { return acquireReader(sourcePublicPath, leaseToken, "recovery"); },
		releaseRecoveryReader(sourcePublicPath, leaseToken) { return releaseReader(sourcePublicPath, leaseToken, "recovery"); },
		getLockView,
		hasAnyLock(sourcePublicPath) {
			const view = getLockView(sourcePublicPath);
			return freeze({ ok: view.ok, locked: view.hasActive || view.hasRecovery || view.hasRuntimeReader || view.hasRecoveryReader, code: view.code });
		},
		hasRecoveryLock(sourcePublicPath) {
			const view = getLockView(sourcePublicPath);
			return freeze({ ok: view.ok, locked: view.hasRecovery || view.hasRecoveryReader, code: view.code });
		},
		getSafeSummary,
		validateInternalState() { return registryEntries(targetMap, validateJobId, validateLease) !== null; },
	});
}

function makePlan(input, validateLease = null) {
	const stored = cloneEntries(input);
	const plan = freeze({ kind: PLAN_KIND, summary: summaryForEntries(stored) });
	plans.set(plan, { entries: stored, validateLease });
	return freeze({ ok: true, plan, summary: plan.summary });
}

/**
 * Builds a manifest-only startup plan. Reader owner sets are always empty.
 */
export function createRecoveryLockPlan({ snapshots, normalizeLibrarySourceKey, validateJobId = safeJobId } = {}) {
	if (!Array.isArray(snapshots) || typeof normalizeLibrarySourceKey !== "function" || typeof validateJobId !== "function") return planFailure();
	const planned = new Map();
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
		const entry = planned.get(sourceKey) || createEntry();
		if (sourceRequirements.active) entry.activeJobIds.add(job.id);
		if (sourceRequirements.recovery) entry.recoveryJobIds.add(job.id);
		planned.set(sourceKey, entry);
	}
	return makePlan(new Map([...planned.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

/**
 * Future journal recovery owns this issuer. It accepts one trusted,
 * normalized-at-the-boundary source contribution at a time.
 */
export function createRecoveryReaderLockContributionAuthority({ normalizeLibrarySourceKey, readerLeaseConsumer } = {}) {
	if (typeof normalizeLibrarySourceKey !== "function" || !leaseConsumers.has(readerLeaseConsumer)) {
		throw new TypeError("Recovery reader contribution dependencies are invalid");
	}
	const authority = {};
	const contributionConsumer = freeze({ authority });
	contributionConsumers.add(contributionConsumer);
	const validateLease = (token, kind) => validReaderLease(readerLeaseConsumer, token, kind);
	return freeze({
		issuer: freeze({
			mintRecoveryReaderContribution({ sourcePublicPath, leaseToken } = {}) {
				const sourceKey = normalizeSourceKey(normalizeLibrarySourceKey, sourcePublicPath);
				if (!sourceKey) return freeze({ ok: false, code: CONTRIBUTION_FAILURE_CODE, contribution: null });
				const token = tokenDetails(readerLeaseConsumer, leaseToken, "recovery", sourceKey, { bind: true });
				if (!token.ok) return freeze({ ok: false, code: token.code, contribution: null });
				const contribution = {};
				Object.defineProperties(contribution, {
					kind: { value: "transcode-recovery-reader-contribution", enumerable: false },
					toJSON: { value: () => ({ kind: "transcode-recovery-reader-contribution" }), enumerable: false },
				});
				contributions.set(contribution, { authority, sourceKey, leaseToken, validateLease });
				return freeze({ ok: true, code: null, contribution: freeze(contribution) });
			},
		}),
		contributionConsumer,
	});
}

/**
 * Combines a manifest plan with opaque journal-derived recovery-reader owners.
 * Contributions are immutable and can be safely combined more than once.
 */
export function combineTranscodeRecoveryLockPlans({ plan, contributionConsumer, contributions: input = [] } = {}) {
	const base = plans.get(plan);
	if (!base || !contributionConsumers.has(contributionConsumer) || !Array.isArray(input)) return planFailure(CONTRIBUTION_FAILURE_CODE);
	for (const entry of base.entries.values()) {
		if (entry.runtimeReaderLeaseIds.size !== 0 || entry.recoveryReaderLeaseIds.size !== 0) return planFailure(CONTRIBUTION_FAILURE_CODE);
	}
	const combined = cloneEntries(base.entries);
	let validateLease = base.validateLease;
	for (const contribution of input) {
		const details = contributions.get(contribution);
		if (!details || details.authority !== contributionConsumer.authority) return planFailure(CONTRIBUTION_FAILURE_CODE);
		if (validateLease && validateLease !== details.validateLease) return planFailure(CONTRIBUTION_FAILURE_CODE);
		validateLease = details.validateLease;
		const entry = combined.get(details.sourceKey) || createEntry();
		entry.recoveryReaderLeaseIds.add(details.leaseToken);
		combined.set(details.sourceKey, entry);
	}
	if (!validateLease && [...combined.values()].some((entry) => entry.runtimeReaderLeaseIds.size || entry.recoveryReaderLeaseIds.size)) {
		return planFailure(CONTRIBUTION_FAILURE_CODE);
	}
	return makePlan(new Map([...combined.entries()].sort(([left], [right]) => left.localeCompare(right))), validateLease);
}

/**
 * Replaces an empty startup registry in-place. A live non-empty registry is
 * rejected so startup installation can never overwrite runtime reader leases.
 */
export function installRecoveryLockPlan({ targetMap, plan, validateJobId = safeJobId } = {}) {
	const stored = plans.get(plan);
	if (!targetMap || typeof targetMap.clear !== "function" || typeof targetMap.set !== "function" || typeof targetMap.entries !== "function"
		|| !stored || plan?.kind !== PLAN_KIND || typeof validateJobId !== "function") {
		return freeze({ ok: false, installed: false, registryStateUnknown: false, code: REGISTRY_FAILURE_CODE, summary: safeSummary() });
	}
	const previous = registryEntries(targetMap, validateJobId, stored.validateLease);
	if (!previous) return freeze({ ok: false, installed: false, registryStateUnknown: false, code: REGISTRY_FAILURE_CODE, summary: safeSummary() });
	if (previous.size !== 0) return freeze({ ok: false, installed: false, registryStateUnknown: false, code: TARGET_NOT_EMPTY_CODE, summary: safeSummary() });
	if (!sameEntries(new Map([...stored.entries.entries()].map(([key, entry]) => [key, copyEntry(entry)])), stored.entries, validateJobId, stored.validateLease)) {
		return freeze({ ok: false, installed: false, registryStateUnknown: false, code: PLAN_FAILURE_CODE, summary: safeSummary() });
	}
	try {
		applyEntries(targetMap, stored.entries);
		if (!sameEntries(targetMap, stored.entries, validateJobId, stored.validateLease)) throw new Error("recovery lock installation mismatch");
		return freeze({ ok: true, installed: true, registryStateUnknown: false, code: null, summary: summaryForEntries(stored.entries) });
	} catch {
		try {
			applyEntries(targetMap, previous);
			if (!sameEntries(targetMap, previous, validateJobId, stored.validateLease)) throw new Error("recovery lock rollback mismatch");
			return freeze({ ok: false, installed: false, registryStateUnknown: false, code: REGISTRY_FAILURE_CODE, summary: safeSummary() });
		} catch {
			return freeze({ ok: false, installed: false, registryStateUnknown: true, code: REGISTRY_FAILURE_CODE, summary: safeSummary() });
		}
	}
}

/** Pure recovery-only gate. Ordinary job state validation remains elsewhere. */
export function getTranscodeRecoveryOperationConflict(job, operation) {
	const known = JOB_READ_OPERATIONS.has(operation) || JOB_MUTATION_OPERATIONS.has(operation) || operation === "retention-cleanup";
	if (!known) return conflict("reject", OPERATION_FAILURE_CODE);
	if (isTerminalProtected(job) || JOB_READ_OPERATIONS.has(operation)) return conflict("allow");
	const fields = recoveryFieldState(job);
	if (operation === "incomplete-upload-safe-discard") {
		const allowed = job?.sourceType === "upload"
			&& fields.preExecutionCode === "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD"
			&& !fields.hasRecoveryHold && !fields.malformedRecoveryHold && !fields.malformedPreExecution;
		return allowed ? conflict("allow") : conflict("reject", TRANSCODE_RECOVERY_CONFLICT_CODE, "recovery");
	}
	const protectedByRecovery = fields.hasRecoveryHold || fields.malformedRecoveryHold || Boolean(fields.preExecutionCode) || fields.malformedPreExecution;
	if (!protectedByRecovery) return conflict("allow");
	if (operation === "retention-cleanup") return conflict("skip", TRANSCODE_RECOVERY_CONFLICT_CODE, "recovery");
	return conflict("reject", TRANSCODE_RECOVERY_CONFLICT_CODE, "recovery");
}

/**
 * Pure per-source gate. A future global migration barrier belongs outside this
 * module and must be checked before this helper receives an opaque lock view.
 */
export function getTranscodeSourceMutationConflict(lockView, operation) {
	const known = SOURCE_READ_OPERATIONS.has(operation) || SOURCE_MUTATION_OPERATIONS.has(operation);
	if (!known) return conflict("reject", OPERATION_FAILURE_CODE);
	if (!lockViews.has(lockView) || !record(lockView) || lockView.ok !== true
		|| !Number.isSafeInteger(lockView.activeOwnerCount) || !Number.isSafeInteger(lockView.recoveryOwnerCount)
		|| !Number.isSafeInteger(lockView.runtimeReaderOwnerCount) || !Number.isSafeInteger(lockView.recoveryReaderOwnerCount)
		|| lockView.activeOwnerCount < 0 || lockView.recoveryOwnerCount < 0
		|| lockView.runtimeReaderOwnerCount < 0 || lockView.recoveryReaderOwnerCount < 0) {
		return conflict("reject", REGISTRY_FAILURE_CODE);
	}
	if (SOURCE_READ_OPERATIONS.has(operation)) return conflict("allow");
	if (lockView.recoveryOwnerCount > 0 || lockView.recoveryReaderOwnerCount > 0 || lockView.hasRecovery || lockView.hasRecoveryReader) {
		return conflict("reject", TRANSCODE_RECOVERY_CONFLICT_CODE, "recovery");
	}
	if (lockView.runtimeReaderOwnerCount > 0 || lockView.hasRuntimeReader) {
		return conflict("reject", TRANSCODE_SOURCE_READER_CONFLICT_CODE, "runtime-reader");
	}
	if (lockView.activeOwnerCount > 0 || lockView.hasActive) return conflict("reject", "TRANSCODE_SOURCE_LOCKED", "active");
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
	leaseInvalid: LEASE_INVALID_CODE,
	leaseKind: LEASE_KIND_CODE,
	leaseSourceMismatch: LEASE_SOURCE_MISMATCH_CODE,
	recoveryReaderActive: RECOVERY_READER_ACTIVE_CODE,
	contribution: CONTRIBUTION_FAILURE_CODE,
	targetNotEmpty: TARGET_NOT_EMPTY_CODE,
});
