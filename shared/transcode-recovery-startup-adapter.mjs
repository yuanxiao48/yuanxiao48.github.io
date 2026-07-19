/**
 * Capability-based adapters for startup recovery. Importing this module has no
 * filesystem, timer, process, signal, or Studio startup side effects.
 */
import { randomUUID } from "node:crypto";
import {
	TRANSCODE_RECOVERY_OUTPUT_FILENAMES,
	TRANSCODE_RECOVERY_POLICY,
	normalizeRecoveryHold,
	normalizePreExecutionRecovery,
} from "./transcode-recovery.mjs";
import { createStartupRecoveryContext } from "./transcode-recovery-executor.mjs";
import {
	createManifestContentIdentity,
	isManifestContentIdentity,
	sameManifestContentIdentity,
} from "./transcode-manifest-identity.mjs";

const SAFE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOVERY_CODES = Object.freeze({
	read: "TRANSCODE_RECOVERY_MANIFEST_READ_FAILED",
	invalid: "TRANSCODE_RECOVERY_MANIFEST_INVALID",
	changed: "TRANSCODE_RECOVERY_MANIFEST_CHANGED",
	generation: "TRANSCODE_RECOVERY_GENERATION_CHANGED",
	write: "TRANSCODE_RECOVERY_MANIFEST_WRITE_FAILED",
	lock: "TRANSCODE_RECOVERY_OPERATION_LOCK_FAILED",
	terminal: "TRANSCODE_RECOVERY_TERMINAL_PROTECTED",
	finalSnapshot: "RECOVERY_FINAL_SNAPSHOT_UNAVAILABLE",
	finalSnapshotRead: "RECOVERY_FINAL_SNAPSHOT_READ_FAILED",
});
const finalSnapshotCollections = new WeakMap();

function freeze(value) {
	return Object.freeze(value);
}

function isSafeJobId(value) {
	return typeof value === "string" && SAFE_JOB_ID.test(value);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value, seen = new Set()) {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const item of Object.values(value)) deepFreeze(item, seen);
	return Object.freeze(value);
}

function copyFrozen(value) {
	return deepFreeze(structuredClone(value));
}

function copyFinalSnapshot(snapshot) {
	return freeze({
		job: copyFrozen(snapshot.job),
		identity: snapshot.identity,
		generation: snapshot.generation,
	});
}

function createFinalSnapshotCollection(snapshots) {
	const collection = freeze({ kind: "transcode-recovery-final-snapshots" });
	finalSnapshotCollections.set(collection, freeze(snapshots.map(copyFinalSnapshot)));
	return collection;
}

/**
 * Gives a trusted internal consumer an immutable copy of final recovery
 * snapshots. The opaque collection has no iterator and no serializable data.
 */
export function withFinalRecoverySnapshots(collection, callback) {
	if (!finalSnapshotCollections.has(collection) || typeof callback !== "function") {
		throw new TypeError(RECOVERY_CODES.finalSnapshot);
	}
	return callback(freeze([...finalSnapshotCollections.get(collection)]));
}

function bytesFrom(value) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError("Manifest payload is not raw bytes");
}

function safeGeneration(job) {
	if (!isRecord(job?.runtime)) return null;
	return Number.isSafeInteger(job.runtime.attempt) && job.runtime.attempt >= 0 ? job.runtime.attempt : null;
}

function validExpectedGeneration(value) {
	return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function sameIdentity(left, right) {
	return left === right || (isManifestContentIdentity(left)
		&& isManifestContentIdentity(right)
		&& sameManifestContentIdentity(left, right));
}

function isRecordIdentity(value) {
	return (typeof value === "string" && value.length > 0) || isManifestContentIdentity(value);
}

function stableFailure(code) {
	return freeze({ ok: false, code });
}

function parseAndValidate(rawBytes, validateManifest) {
	let parsed;
	try {
		parsed = JSON.parse(bytesFrom(rawBytes).toString("utf8"));
	} catch {
		return null;
	}
	try {
		const job = validateManifest(parsed);
		if (!isRecord(job) || !isSafeJobId(job.id)) return null;
		return copyFrozen(job);
	} catch {
		return null;
	}
}

function createRecord(rawBytes, validateManifest) {
	const job = parseAndValidate(rawBytes, validateManifest);
	if (!job) return null;
	return freeze({
		job,
		identity: createManifestContentIdentity(rawBytes),
		generation: safeGeneration(job),
	});
}

/**
 * Wraps trusted, job-id-bound manifest capabilities with recovery CAS rules.
 */
export function createStartupRecoveryManifestAdapter(capabilities = {}) {
	const required = ["withJobOperation", "readRawManifest", "validateManifest", "serializeManifest", "atomicWriteManifest"];
	if (!required.every((name) => typeof capabilities[name] === "function") || typeof capabilities.validateJobId !== "function") {
		throw new TypeError("Startup recovery manifest capabilities are invalid");
	}

	async function readJob(jobId) {
		if (!capabilities.validateJobId(jobId) || !isSafeJobId(jobId)) throw new Error(RECOVERY_CODES.invalid);
		let rawBytes;
		try {
			rawBytes = bytesFrom(await capabilities.readRawManifest(jobId));
		} catch {
			throw new Error(RECOVERY_CODES.read);
		}
		const record = createRecord(rawBytes, capabilities.validateManifest);
		if (!record || record.job.id !== jobId) throw new Error(RECOVERY_CODES.invalid);
		return record;
	}

	async function persistJobAtomic({ jobId, expectedIdentity, expectedGeneration, nextManifest } = {}) {
		if (!capabilities.validateJobId(jobId) || !isSafeJobId(jobId) || !isManifestContentIdentity(expectedIdentity)
			|| !validExpectedGeneration(expectedGeneration) || !isRecord(nextManifest)) {
			return stableFailure(RECOVERY_CODES.invalid);
		}
		let outcome;
		try {
			outcome = await capabilities.withJobOperation(jobId, async () => {
				let currentRaw;
				try {
					currentRaw = bytesFrom(await capabilities.readRawManifest(jobId));
				} catch {
					return stableFailure(RECOVERY_CODES.read);
				}
				const current = createRecord(currentRaw, capabilities.validateManifest);
				if (!current || current.job.id !== jobId) return stableFailure(RECOVERY_CODES.invalid);
				if (current.job.state === "completed") return freeze({ ok: false, terminalProtected: true, code: RECOVERY_CODES.terminal });
				if (!sameIdentity(expectedIdentity, current.identity)) return stableFailure(RECOVERY_CODES.changed);
				if (current.generation !== expectedGeneration) return stableFailure(RECOVERY_CODES.generation);
				let next;
				try {
					next = copyFrozen(capabilities.validateManifest(structuredClone(nextManifest)));
				} catch {
					return stableFailure(RECOVERY_CODES.invalid);
				}
				if (next.id !== jobId || safeGeneration(next) !== current.generation) return stableFailure(RECOVERY_CODES.generation);
				let nextBytes;
				try {
					nextBytes = bytesFrom(await capabilities.serializeManifest(next));
				} catch {
					return stableFailure(RECOVERY_CODES.invalid);
				}
				try {
					await capabilities.atomicWriteManifest(jobId, nextBytes);
				} catch {
					return stableFailure(RECOVERY_CODES.write);
				}
				const written = createRecord(nextBytes, capabilities.validateManifest);
				return written && written.job.id === jobId
					? freeze({ ok: true, record: written })
					: stableFailure(RECOVERY_CODES.invalid);
			});
		} catch {
			return stableFailure(RECOVERY_CODES.lock);
		}
		return outcome && typeof outcome === "object" ? outcome : stableFailure(RECOVERY_CODES.lock);
	}

	return freeze({ readJob, persistJobAtomic });
}

/**
 * Validates only entries supplied by a trusted job-root capability.
 */
export function createValidatedTranscodeJobDiscovery(capabilities = {}) {
	if (typeof capabilities.listDirectEntries !== "function" || typeof capabilities.inspectJobDirectory !== "function"
		|| typeof capabilities.validateJobId !== "function") {
		throw new TypeError("Startup recovery discovery capabilities are invalid");
	}
	return freeze({
		async discoverJobIds() {
			let entries;
			try {
				entries = await capabilities.listDirectEntries();
			} catch {
				throw new Error(RECOVERY_CODES.read);
			}
			if (!Array.isArray(entries)) throw new Error(RECOVERY_CODES.invalid);
			const seen = new Set();
			const ids = [];
			for (const entry of entries) {
				if (!entry?.isDirectory || entry?.isSymbolicLink || !isSafeJobId(entry.name) || !capabilities.validateJobId(entry.name)) continue;
				const key = entry.name.toLowerCase();
				if (seen.has(key)) throw new Error(RECOVERY_CODES.invalid);
				let trusted = false;
				try { trusted = (await capabilities.inspectJobDirectory(entry.name))?.trusted === true; }
				catch { throw new Error(RECOVERY_CODES.read); }
				if (!trusted) throw new Error(RECOVERY_CODES.invalid);
				seen.add(key);
				ids.push(entry.name);
			}
			return freeze([...ids].sort((left, right) => left.localeCompare(right)));
		},
	});
}

export function createStartupRecoveryGuard() {
	const active = new Set();
	return freeze({
		acquire(jobId) {
			if (!isSafeJobId(jobId) || active.has(jobId)) throw new Error(RECOVERY_CODES.lock);
			active.add(jobId);
			let released = false;
			return freeze({
				release() {
					if (released || !active.delete(jobId)) throw new Error(RECOVERY_CODES.lock);
					released = true;
				},
			});
		},
		getActiveCount() { return active.size; },
	});
}

export function createRecoveryOffsetScheduler({ monotonicNowMs, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
	if (typeof monotonicNowMs !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
		throw new TypeError("Recovery scheduler dependencies are invalid");
	}
	function createSession() {
		let base = null;
		let nextIndex = 0;
		let disposed = false;
		const pending = new Map();
		function cancel() {
			if (disposed) return;
			disposed = true;
			for (const [timer, reject] of pending) {
				clearTimer(timer);
				reject(new Error(RECOVERY_CODES.invalid));
			}
			pending.clear();
		}
		return freeze({
			sleepUntilOffset(offsetMs) {
				if (disposed || offsetMs !== TRANSCODE_RECOVERY_POLICY.sampleOffsetsMs[nextIndex]) {
					return Promise.reject(new Error(RECOVERY_CODES.invalid));
				}
				nextIndex += 1;
				if (base === null) base = monotonicNowMs();
				const delay = Math.max(0, base + offsetMs - monotonicNowMs());
				return new Promise((resolve, reject) => {
					const timer = setTimer(() => {
						pending.delete(timer);
						if (disposed) reject(new Error(RECOVERY_CODES.invalid));
						else resolve();
					}, delay);
					pending.set(timer, reject);
				});
			},
			cancel,
			dispose: cancel,
			getPendingCount() { return pending.size; },
		});
	}
	return freeze({ createSession });
}

function safeBatchSummary(batch) {
	return freeze({
		total: Number.isSafeInteger(batch?.total) ? batch.total : 0,
		protected: Number.isSafeInteger(batch?.protected) ? batch.protected : 0,
		initialHolds: Number.isSafeInteger(batch?.initialHolds) ? batch.initialHolds : 0,
		retainedHolds: Number.isSafeInteger(batch?.retainedHolds) ? batch.retainedHolds : 0,
		cleaned: Number.isSafeInteger(batch?.cleaned) ? batch.cleaned : 0,
		partial: Number.isSafeInteger(batch?.partial) ? batch.partial : 0,
		preExecution: Number.isSafeInteger(batch?.preExecution) ? batch.preExecution : 0,
		sourcePartial: Number.isSafeInteger(batch?.sourcePartial) ? batch.sourcePartial : 0,
		sourceAccess: Number.isSafeInteger(batch?.sourceAccess) ? batch.sourceAccess : 0,
		critical: Number.isSafeInteger(batch?.critical) ? batch.critical : 0,
		mustBlockListen: batch?.mustBlockListen === true,
	});
}

/**
 * Memoized two-pass coordinator. It reports recovery readiness only; it never
 * listens, installs locks, changes process state, or decides canListen.
 */
export function createTranscodeStartupRecoveryOrchestrator(dependencies = {}) {
	const required = ["discoverJobIds", "readJob", "wallNowMs", "monotonicNowMs"];
	if (!required.every((name) => typeof dependencies[name] === "function")
		|| typeof dependencies.createExecutor !== "function") {
		throw new TypeError("Startup recovery orchestration dependencies are invalid");
	}
	const createIdentity = typeof dependencies.createStartupIdentity === "function" ? dependencies.createStartupIdentity : randomUUID;
	let runPromise = null;
	let finalSnapshotCollection = null;

	function summary({ status, totalJobs, recoveryCompleted, requiresLockPlanning, mustBlockListen, criticalCount, batchResult, finalSnapshotReady = false } = {}) {
		return freeze({
			status,
			totalJobs,
			recoveryCompleted,
			requiresLockPlanning,
			mustBlockListen,
			criticalCount,
			batchResult,
			finalSnapshotReady,
		});
	}

	async function readFinalSnapshots(jobIds) {
		const snapshots = [];
		for (const jobId of jobIds) {
			const snapshot = await dependencies.readJob(jobId);
			if (!isRecord(snapshot) || !isRecord(snapshot.job) || snapshot.job.id !== jobId
				|| !isRecordIdentity(snapshot.identity) || !validExpectedGeneration(snapshot.generation)) {
				throw new Error(RECOVERY_CODES.finalSnapshotRead);
			}
			snapshots.push(snapshot);
		}
		return snapshots;
	}

	async function runOnce() {
		let jobIds;
		try {
			jobIds = await dependencies.discoverJobIds();
		} catch {
			return summary({ status: "blockedBeforeRecovery", totalJobs: 0, recoveryCompleted: false, requiresLockPlanning: false, mustBlockListen: true, criticalCount: 1, batchResult: null });
		}
		if (!Array.isArray(jobIds) || !jobIds.every(isSafeJobId)) {
			return summary({ status: "blockedBeforeRecovery", totalJobs: 0, recoveryCompleted: false, requiresLockPlanning: false, mustBlockListen: true, criticalCount: 1, batchResult: null });
		}
		const snapshots = [];
		try {
			for (const jobId of jobIds) {
				const snapshot = await dependencies.readJob(jobId);
				if (!isRecord(snapshot) || !isRecord(snapshot.job) || snapshot.job.id !== jobId
					|| !isRecordIdentity(snapshot.identity) || !validExpectedGeneration(snapshot.generation)) {
					throw new Error(RECOVERY_CODES.invalid);
				}
				snapshots.push(snapshot);
			}
		} catch {
			return summary({ status: "blockedBeforeRecovery", totalJobs: jobIds.length, recoveryCompleted: false, requiresLockPlanning: false, mustBlockListen: true, criticalCount: 1, batchResult: null });
		}
		const preexistingHoldJobIds = snapshots
			.filter((record) => record?.job?.state !== "completed" && (() => {
				const normalized = normalizeRecoveryHold(record?.job?.recoveryHold);
				const preExecution = normalizePreExecutionRecovery(record?.job?.preExecutionRecovery);
				return Boolean(normalized.hold || (normalized.malformed && record?.job?.recoveryHold !== null && record?.job?.recoveryHold !== undefined)
					|| preExecution.recovery || (preExecution.malformed && record?.job?.preExecutionRecovery !== null && record?.job?.preExecutionRecovery !== undefined));
			})())
			.map((record) => record.job.id);
		let context;
		try {
			context = createStartupRecoveryContext({
				startupIdentity: createIdentity(),
				startupWallTimeMs: dependencies.wallNowMs(),
				startupMonotonicTimeMs: dependencies.monotonicNowMs(),
				preexistingHoldJobIds,
			});
		} catch {
			return summary({ status: "blockedBeforeRecovery", totalJobs: jobIds.length, recoveryCompleted: false, requiresLockPlanning: false, mustBlockListen: true, criticalCount: 1, batchResult: null });
		}
		let batch;
		try {
			batch = await dependencies.createExecutor().recoverBatch({ jobIds, context });
		} catch {
			return summary({ status: "blockedAfterRecovery", totalJobs: jobIds.length, recoveryCompleted: false, requiresLockPlanning: false, mustBlockListen: true, criticalCount: 1, batchResult: null });
		}
		const batchResult = safeBatchSummary(batch);
		if (batchResult.mustBlockListen) {
			return summary({ status: "blockedAfterRecovery", totalJobs: jobIds.length, recoveryCompleted: true, requiresLockPlanning: false, mustBlockListen: true, criticalCount: batchResult.critical, batchResult });
		}
		try {
			finalSnapshotCollection = createFinalSnapshotCollection(await readFinalSnapshots(jobIds));
		} catch {
			return summary({ status: "blockedAfterRecovery", totalJobs: jobIds.length, recoveryCompleted: true, requiresLockPlanning: false, mustBlockListen: true, criticalCount: Math.max(1, batchResult.critical), batchResult });
		}
		if (jobIds.length === 0) return summary({ status: "noJobs", totalJobs: 0, recoveryCompleted: true, requiresLockPlanning: false, mustBlockListen: false, criticalCount: 0, batchResult, finalSnapshotReady: true });
		const held = batchResult.initialHolds + batchResult.retainedHolds + batchResult.partial + batchResult.preExecution;
		const terminalOnly = batchResult.protected === jobIds.length;
		return summary({
			status: terminalOnly ? "terminalOnly" : held ? "degradedHeldJobs" : "readyForLockPlanning",
			totalJobs: jobIds.length,
			recoveryCompleted: true,
			requiresLockPlanning: true,
			mustBlockListen: false,
			criticalCount: 0,
			batchResult,
			finalSnapshotReady: true,
		});
	}

	return freeze({
		run() {
			runPromise ||= runOnce();
			return runPromise;
		},
		getFinalSnapshotCollection() {
			if (!runPromise || !finalSnapshotCollection) throw new Error(RECOVERY_CODES.finalSnapshot);
			return finalSnapshotCollection;
		},
	});
}

export { RECOVERY_CODES };
