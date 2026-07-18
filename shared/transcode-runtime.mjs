const DEFAULT_PROGRESS_PERSIST_MS = 2000;
const DEFAULT_STDERR_LIMIT = 16 * 1024;
const DEFAULT_OUTPUT_CLEANUP_DELAYS_MS = Object.freeze([0, 150, 400, 900]);

function queueError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

export function createTranscodeQueue({ runJob, onJobError = () => {} }) {
	if (typeof runJob !== "function") throw new TypeError("runJob must be a function");
	const pending = [];
	const known = new Set();
	let activeId = null;
	let scheduling = false;

	const schedule = () => {
		if (scheduling || activeId || !pending.length) return;
		scheduling = true;
		queueMicrotask(async () => {
			scheduling = false;
			if (activeId || !pending.length) return;
			const jobId = pending.shift();
			activeId = jobId;
			try {
				await runJob(jobId);
			} catch (error) {
				await onJobError(jobId, error);
			} finally {
				known.delete(jobId);
				activeId = null;
				schedule();
			}
		});
	};

	return Object.freeze({
		enqueue(jobId) {
			if (!jobId || known.has(jobId)) throw queueError("TRANSCODE_QUEUE_DUPLICATE", "This transcode task is already queued or running");
			known.add(jobId);
			pending.push(jobId);
			schedule();
			return { queuePosition: pending.length, active: false };
		},
		removePending(jobId) {
			if (activeId === jobId) return { removed: false, reason: "active" };
			const index = pending.indexOf(jobId);
			if (index === -1) return { removed: false, reason: "not-found" };
			pending.splice(index, 1);
			known.delete(jobId);
			return { removed: true, position: index + 1 };
		},
		hasPending(jobId) { return pending.includes(jobId); },
		isActive(jobId) { return activeId === jobId; },
		getQueuePosition(jobId) {
			if (activeId === jobId) return 0;
			const index = pending.indexOf(jobId);
			return index === -1 ? null : index + 1;
		},
		getPosition(jobId) {
			return this.getQueuePosition(jobId);
		},
		has(jobId) { return known.has(jobId); },
		snapshot() {
			return { activeId, pending: [...pending] };
		},
		async idle() {
			while (activeId || pending.length || scheduling) await new Promise((resolve) => setTimeout(resolve, 0));
		},
	});
}

export function createProgressPersistence({ write, delayMs = DEFAULT_PROGRESS_PERSIST_MS }) {
	if (typeof write !== "function") throw new TypeError("write must be a function");
	const timers = new Map();
	const pending = new Map();

	async function flush(jobId) {
		const entry = pending.get(jobId);
		if (!entry) return;
		pending.delete(jobId);
		const timer = timers.get(jobId);
		if (timer) clearTimeout(timer);
		timers.delete(jobId);
		await write(jobId, entry);
	}

	return Object.freeze({
		update(jobId, progress) {
			pending.set(jobId, progress);
			if (!timers.has(jobId)) timers.set(jobId, setTimeout(() => { flush(jobId).catch(() => {}); }, delayMs));
		},
		flush,
		async flushAll() { await Promise.all([...pending.keys()].map((jobId) => flush(jobId))); },
		clear(jobId) {
			pending.delete(jobId);
			const timer = timers.get(jobId);
			if (timer) clearTimeout(timer);
			timers.delete(jobId);
		},
	});
}

function cleanupErrorCode(error) {
	return typeof error?.code === "string" ? error.code : "";
}

function isRetryableCleanupError(error) {
	return ["EBUSY", "EPERM", "EACCES"].includes(cleanupErrorCode(error));
}

/**
 * Removes only the caller-provided, already-boundary-checked output files.
 * This intentionally has no directory traversal or wildcard behavior.
 */
export async function removeFilesWithRetry({
	files,
	removeFile,
	delaysMs = DEFAULT_OUTPUT_CLEANUP_DELAYS_MS,
	wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
	if (!Array.isArray(files) || typeof removeFile !== "function") throw new TypeError("files and removeFile are required");
	const delays = Array.isArray(delaysMs) && delaysMs.length ? delaysMs : DEFAULT_OUTPUT_CLEANUP_DELAYS_MS;
	let removedCount = 0;
	let missingCount = 0;
	let failedCount = 0;

	for (const file of files) {
		let finished = false;
		for (let index = 0; index < delays.length; index += 1) {
			if (index > 0) await wait(delays[index]);
			try {
				await removeFile(file);
				removedCount += 1;
				finished = true;
				break;
			} catch (error) {
				if (cleanupErrorCode(error) === "ENOENT") {
					missingCount += 1;
					finished = true;
					break;
				}
				if (!isRetryableCleanupError(error) || index === delays.length - 1) break;
			}
		}
		if (!finished) failedCount += 1;
	}

	return {
		success: failedCount === 0,
		removedCount,
		missingCount,
		failedCount,
		safeErrorCode: failedCount ? "TRANSCODE_PARTIAL_CLEANUP_FAILED" : null,
	};
}

export function createTranscodeOperationGuard() {
	const active = new Set();
	return Object.freeze({
		tryAcquire(jobId) {
			if (!jobId || active.has(jobId)) return false;
			active.add(jobId);
			return true;
		},
		release(jobId) { active.delete(jobId); },
		has(jobId) { return active.has(jobId); },
	});
}

export function createManagedTranscodeProcesses({ stderrLimit = DEFAULT_STDERR_LIMIT } = {}) {
	const records = new Map();
	return Object.freeze({
		attach(jobId, child, { attempt = null } = {}) {
			if (records.has(jobId)) throw queueError("TRANSCODE_PROCESS_DUPLICATE", "This task already has a managed process");
			const record = {
				jobId,
				attempt,
				child,
				startedAt: new Date().toISOString(),
				lastProgressAt: null,
				settled: false,
				finalizePromise: null,
				cancelRequested: false,
				cancelRequestedAt: null,
				cancelStatePromise: null,
				statusUpdatePromise: null,
				exitInfo: null,
				graceTimer: null,
				forceStopRequired: false,
				forceKillStarted: false,
				forceKillPromise: null,
				forceKillResult: null,
				forceKillFinished: false,
				forceKillConfirmationTimer: null,
				processExitConfirmed: false,
				progressFlushed: false,
				cleanupCompleted: false,
				cleanupPromise: null,
				qSent: false,
				progressParser: {},
				stderr: "",
				exitPromise: null,
			};
			if (child && typeof child.once === "function") {
				record.exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
				record.closePromise = new Promise((resolve) => child.once("close", (code, signal) => {
					record.processExitConfirmed = true;
					resolve({ code, signal });
				}));
			}
			records.set(jobId, record);
			return record;
		},
		appendStderr(jobId, chunk) {
			const record = records.get(jobId);
			if (!record) return;
			record.stderr = `${record.stderr}${String(chunk || "")}`.slice(-stderrLimit);
		},
		markProgress(jobId) { const record = records.get(jobId); if (record) record.lastProgressAt = new Date().toISOString(); },
		requestCancel(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || (attempt !== undefined && attempt !== null && record.attempt !== attempt)) return null;
			if (record.cancelRequested) return { record, requested: false };
			record.cancelRequested = true;
			record.cancelRequestedAt = new Date().toISOString();
			return { record, requested: true };
		},
		setCancelStatePromise(jobId, attempt, promise) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			record.cancelStatePromise = promise || null;
			return true;
		},
		setExitInfo(jobId, attempt, exitInfo) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			record.exitInfo = exitInfo || null;
			return true;
		},
		setGraceTimer(jobId, attempt, timer) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			if (record.graceTimer) clearTimeout(record.graceTimer);
			record.graceTimer = timer || null;
			return true;
		},
		clearGraceTimer(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || (attempt !== undefined && attempt !== null && record.attempt !== attempt)) return false;
			if (record.graceTimer) clearTimeout(record.graceTimer);
			record.graceTimer = null;
			return true;
		},
		markForceStopRequired(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			record.forceStopRequired = true;
			return true;
		},
		setForceKillConfirmationTimer(jobId, attempt, timer) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			if (record.forceKillConfirmationTimer) clearTimeout(record.forceKillConfirmationTimer);
			record.forceKillConfirmationTimer = timer || null;
			return true;
		},
		clearForceKillConfirmationTimer(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || (attempt !== undefined && attempt !== null && record.attempt !== attempt)) return false;
			if (record.forceKillConfirmationTimer) clearTimeout(record.forceKillConfirmationTimer);
			record.forceKillConfirmationTimer = null;
			return true;
		},
		markProgressFlushed(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			record.progressFlushed = true;
			return true;
		},
		beginFinalize(jobId, attempt, finalize) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return null;
			if (record.finalizePromise) return record.finalizePromise;
			record.settled = true;
			record.finalizePromise = Promise.resolve().then(finalize);
			return record.finalizePromise;
		},
		get(jobId) { return records.get(jobId) || null; },
		finish(jobId, attempt) {
			const record = records.get(jobId) || null;
			if (!record || (attempt !== undefined && attempt !== null && record.attempt !== attempt)) return null;
			if (record.graceTimer) clearTimeout(record.graceTimer);
			if (record.forceKillConfirmationTimer) clearTimeout(record.forceKillConfirmationTimer);
			records.delete(jobId);
			return record;
		},
		clear() {
			for (const record of records.values()) {
				if (record.graceTimer) clearTimeout(record.graceTimer);
				if (record.forceKillConfirmationTimer) clearTimeout(record.forceKillConfirmationTimer);
			}
			records.clear();
		},
	});
}

function normalizedForceKillResult(value) {
	if (value && typeof value === "object") return value;
	return { attempted: false, launched: false, timedOut: false, exitCode: null, signal: null, safeErrorCode: "TRANSCODE_FORCE_KILL_FAILED" };
}

export function createManagedForceKillCoordinator({
	processes,
	forceKill,
	onForceKillResult = async () => {},
	onProcessStuck = async () => {},
	confirmationDelayMs = 2000,
	setTimeoutImpl = setTimeout,
} = {}) {
	if (!processes || typeof processes.get !== "function") throw new TypeError("processes must be a managed process registry");
	if (typeof forceKill !== "function") throw new TypeError("forceKill must be a function");

	function isCurrent(jobId, attempt, record) {
		return processes.get(jobId) === record && record.attempt === attempt;
	}

	function start(jobId, attempt) {
		const record = processes.get(jobId);
		if (!record || record.attempt !== attempt || record.finalizePromise || record.processExitConfirmed) return null;
		if (record.forceKillStarted) return record.forceKillPromise;
		record.forceKillStarted = true;
		const promise = Promise.resolve()
			.then(() => forceKill({ pid: record.child?.pid }))
			.catch(() => ({ attempted: false, launched: false, timedOut: false, exitCode: null, signal: null, safeErrorCode: "TRANSCODE_FORCE_KILL_FAILED" }))
			.then(async (rawResult) => {
				const result = normalizedForceKillResult(rawResult);
				if (!isCurrent(jobId, attempt, record)) return result;
				record.forceKillResult = result;
				record.forceKillFinished = true;
				if (record.processExitConfirmed || record.finalizePromise) return result;
				try { await onForceKillResult({ jobId, attempt, record, result }); } catch { /* preserve the active slot when status persistence fails */ }
				if (!isCurrent(jobId, attempt, record) || record.processExitConfirmed || record.finalizePromise) return result;
				const timer = setTimeoutImpl(() => {
					const current = processes.get(jobId);
					if (current !== record || current.attempt !== attempt || current.processExitConfirmed || current.finalizePromise) return;
					Promise.resolve(onProcessStuck({ jobId, attempt, record, result })).catch(() => {});
				}, confirmationDelayMs);
				processes.setForceKillConfirmationTimer(jobId, attempt, timer);
				return result;
			});
		record.forceKillPromise = promise;
		return promise;
	}

	return Object.freeze({ start });
}
