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
	let closed = false;

	const schedule = () => {
		if (closed || scheduling || activeId || !pending.length) return;
		scheduling = true;
		queueMicrotask(async () => {
			scheduling = false;
			if (closed || activeId || !pending.length) return;
			const jobId = pending.shift();
			activeId = jobId;
			try {
				await runJob(jobId);
			} catch (error) {
				await onJobError(jobId, error);
			} finally {
				known.delete(jobId);
				activeId = null;
				if (!closed) schedule();
			}
		});
	};

	return Object.freeze({
		enqueue(jobId) {
			if (closed) throw queueError("TRANSCODE_QUEUE_CLOSED", "The transcode queue is closed");
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
		isClosed() { return closed; },
		pendingCount() { return pending.length; },
		close() {
			if (closed) return { closed: true, alreadyClosed: true, pendingJobIds: [] };
			closed = true;
			const pendingJobIds = pending.splice(0);
			for (const jobId of pendingJobIds) known.delete(jobId);
			return { closed: true, alreadyClosed: false, pendingJobIds };
		},
		snapshot() {
			return { closed, activeId, pending: [...pending] };
		},
		async idle() {
			while (activeId || pending.length || scheduling) await new Promise((resolve) => setTimeout(resolve, 0));
		},
	});
}

export function isStudioApiWriteRequest({ method, pathname }) {
	return typeof pathname === "string"
		&& pathname.startsWith("/api/")
		&& ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase());
}

export function resolveTranscodeAttemptFinalization({ terminal = false, shutdownRequested = false, cancelRequested = false } = {}) {
	if (terminal) return "terminal";
	const stopIntent = resolveManagedStopIntent({ shutdownRequested, cancelRequested });
	if (stopIntent === "shutdown") return "interrupted";
	if (stopIntent === "cancel") return "cancelled";
	return "ordinary";
}

/**
 * Resolves the one stop intent that may control an active attempt. Shutdown
 * deliberately wins over a user cancellation, but does not itself perform I/O.
 */
export function resolveManagedStopIntent({ shutdownRequested = false, cancelRequested = false } = {}) {
	if (shutdownRequested === true) return "shutdown";
	if (cancelRequested === true) return "cancel";
	return null;
}

/**
 * A child error does not prove that its stdio and descendants have closed.
 * During either supported stop intent, retain the managed attempt until close
 * remains the process-exit confirmation.
 */
export function shouldAwaitManagedChildClose(record) {
	return Boolean(resolveManagedStopIntent(record || {}) && record?.processExitConfirmed !== true);
}

export function createStudioShutdownPreparation({ queue, recoverPending = async () => ({}), requestActiveShutdown = async () => ({}) }) {
	if (!queue || typeof queue.close !== "function") throw new TypeError("queue.close must be a function");
	if (typeof recoverPending !== "function") throw new TypeError("recoverPending must be a function");
	if (typeof requestActiveShutdown !== "function") throw new TypeError("requestActiveShutdown must be a function");
	const state = {
		started: false,
		acceptingWrites: true,
		queueClosed: false,
		startedAt: null,
		activeStopRequested: false,
		pendingRecoveryStarted: false,
		pendingRecoveryCompleted: false,
		httpCloseStarted: false,
		httpClosed: false,
		degraded: false,
		degradedCodes: [],
		completed: false,
		preparationPromise: null,
	};

	const markDegraded = (code) => {
		if (typeof code !== "string" || !/^[A-Z0-9_]+$/.test(code)) return false;
		state.degraded = true;
		if (!state.degradedCodes.includes(code)) state.degradedCodes.push(code);
		return true;
	};

	const snapshot = () => Object.freeze({
		started: state.started,
		acceptingWrites: state.acceptingWrites,
		queueClosed: state.queueClosed,
		startedAt: state.startedAt,
		activeStopRequested: state.activeStopRequested,
		pendingRecoveryStarted: state.pendingRecoveryStarted,
		pendingRecoveryCompleted: state.pendingRecoveryCompleted,
		httpCloseStarted: state.httpCloseStarted,
		httpClosed: state.httpClosed,
		degraded: state.degraded,
		degradedCodes: Object.freeze([...state.degradedCodes]),
		completed: state.completed,
		preparationCompleted: state.preparationPromise !== null && state.pendingRecoveryCompleted,
	});

	const begin = () => {
		if (state.preparationPromise) return state.preparationPromise;
		state.started = true;
		state.acceptingWrites = false;
		state.startedAt = new Date().toISOString();
		const queueResult = queue.close();
		state.queueClosed = true;
		let activeShutdown;
		try { activeShutdown = requestActiveShutdown(); }
		catch { activeShutdown = Promise.reject(new Error("Active transcode shutdown preparation failed")); }
		const active = Promise.resolve(activeShutdown)
			.catch(() => ({ ok: false, code: "TRANSCODE_SHUTDOWN_ACTIVE_PREPARATION_FAILED" }));
		state.pendingRecoveryStarted = true;
		const recovery = Promise.resolve()
			.then(() => recoverPending(queueResult.pendingJobIds))
			.catch(() => ({ ok: false, code: "TRANSCODE_SHUTDOWN_PENDING_RECOVERY_FAILED" }));
		state.preparationPromise = Promise.all([active, recovery]).then(([activeResult, recoveryResult]) => {
			state.pendingRecoveryCompleted = true;
			if (activeResult?.ok === false) markDegraded(activeResult.code || "TRANSCODE_SHUTDOWN_ACTIVE_PREPARATION_FAILED");
			if (recoveryResult?.ok === false) markDegraded(recoveryResult.code || "TRANSCODE_SHUTDOWN_PENDING_RECOVERY_FAILED");
			return {
				ok: activeResult?.ok !== false && recoveryResult?.ok !== false,
				queue: queueResult,
				active: activeResult,
				recovery: recoveryResult,
			};
		});
		return state.preparationPromise;
	};

	return Object.freeze({
		begin,
		isAcceptingWrites() { return state.acceptingWrites; },
		isStarted() { return state.started; },
		isQueueClosed() { return state.queueClosed; },
		markActiveStopRequested() {
			if (state.activeStopRequested) return false;
			state.activeStopRequested = true;
			return true;
		},
		markHttpCloseStarted() {
			if (state.httpCloseStarted) return false;
			state.httpCloseStarted = true;
			return true;
		},
		markHttpClosed() {
			if (state.httpClosed) return false;
			state.httpClosed = true;
			return true;
		},
		markDegraded,
		isHttpClosed() { return state.httpClosed; },
		isCompleted() { return state.completed; },
		snapshot,
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
	const pendingShutdownIntents = new Map();
	const createRecord = (jobId, attempt, { executionStarted = false } = {}) => ({
		jobId,
		attempt,
		child: null,
		startedAt: new Date().toISOString(),
		lastProgressAt: null,
		settled: false,
		finalizePromise: null,
		cancelRequested: false,
		cancelRequestedAt: null,
		shutdownRequested: false,
		shutdownRequestedAt: null,
		shutdownReason: null,
		executionStarted,
		spawnStarted: false,
		completionCommitStarted: false,
		completionCommitted: false,
		finalizationPersistenceFailed: false,
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
		closePromise: null,
	});
	const applyPendingShutdownIntent = (record) => {
		const pending = pendingShutdownIntents.get(record.jobId);
		if (!pending || pending.attempt !== record.attempt) return;
		pendingShutdownIntents.delete(record.jobId);
		record.shutdownRequested = true;
		record.shutdownRequestedAt = pending.requestedAt;
		record.shutdownReason = pending.reason;
	};
	const attachChild = (record, child) => {
		record.child = child;
		record.executionStarted = true;
		record.spawnStarted = true;
		if (child && typeof child.once === "function") {
			record.exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
			record.closePromise = new Promise((resolve) => child.once("close", (code, signal) => {
				record.processExitConfirmed = true;
				resolve({ code, signal });
			}));
		}
	};
	return Object.freeze({
		reserve(jobId, { attempt = null } = {}) {
			if (records.has(jobId)) throw queueError("TRANSCODE_PROCESS_DUPLICATE", "This task already has a managed process");
			const record = createRecord(jobId, attempt, { executionStarted: true });
			applyPendingShutdownIntent(record);
			records.set(jobId, record);
			return record;
		},
		attach(jobId, child, { attempt = null } = {}) {
			let record = records.get(jobId);
			if (record && (record.attempt !== attempt || record.child)) throw queueError("TRANSCODE_PROCESS_DUPLICATE", "This task already has a managed process");
			if (!record) {
				record = createRecord(jobId, attempt, { executionStarted: true });
				applyPendingShutdownIntent(record);
				records.set(jobId, record);
			}
			attachChild(record, child);
			return record;
		},
		markSpawnStarted(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			record.executionStarted = true;
			record.spawnStarted = true;
			return true;
		},
		markCompletionCommitted(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt) return false;
			record.completionCommitted = true;
			record.completionCommitStarted = false;
			return true;
		},
		abortCompletionCommit(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt || record.completionCommitted) return false;
			record.completionCommitStarted = false;
			return true;
		},
		beginCompletionCommit(jobId, attempt) {
			const record = records.get(jobId);
			if (!record || record.attempt !== attempt || record.completionCommitted || record.completionCommitStarted) return false;
			record.completionCommitStarted = true;
			return true;
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
		requestShutdown(jobId, attempt) {
			const record = records.get(jobId);
			if (record && record.attempt === attempt) {
				if (record.completionCommitted) return { record, requested: false, pending: false, completionCommitted: true };
				if (record.shutdownRequested) return { record, requested: false, pending: false, completionCommitInProgress: record.completionCommitStarted };
				record.shutdownRequested = true;
				record.shutdownRequestedAt = new Date().toISOString();
				record.shutdownReason = "studio-shutdown";
				return { record, requested: true, pending: false, completionCommitInProgress: record.completionCommitStarted };
			}
			if (!jobId || !Number.isSafeInteger(attempt) || attempt < 1) return null;
			const pending = pendingShutdownIntents.get(jobId);
			if (pending?.attempt === attempt) return { record: null, requested: false, pending: true };
			pendingShutdownIntents.set(jobId, {
				attempt,
				requestedAt: new Date().toISOString(),
				reason: "studio-shutdown",
			});
			return { record: null, requested: true, pending: true };
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
			pendingShutdownIntents.delete(jobId);
			return record;
		},
		clear() {
			for (const record of records.values()) {
				if (record.graceTimer) clearTimeout(record.graceTimer);
				if (record.forceKillConfirmationTimer) clearTimeout(record.forceKillConfirmationTimer);
			}
			records.clear();
			pendingShutdownIntents.clear();
		},
	});
}

/**
 * Coordinates the shared graceful-stop mechanics for one managed attempt.
 * Callers persist intent-specific status and decide what happens after grace.
 */
export function createManagedTranscodeStopCoordinator({
	processes,
	onStopIssue = async () => {},
	onGraceExpired = async () => {},
	gracePeriodMs = 5000,
	setTimeoutImpl = setTimeout,
} = {}) {
	if (!processes || typeof processes.get !== "function" || typeof processes.setGraceTimer !== "function") {
		throw new TypeError("processes must be a managed process registry");
	}
	if (typeof onStopIssue !== "function" || typeof onGraceExpired !== "function") {
		throw new TypeError("stop callbacks must be functions");
	}

	function isCurrent(jobId, attempt, record) {
		return processes.get(jobId) === record && record.attempt === attempt;
	}

	async function request(jobId, attempt, { intent } = {}) {
		if (!['cancel', 'shutdown'].includes(intent)) return { requested: false, reason: "intent-invalid" };
		const record = processes.get(jobId);
		if (!isCurrent(jobId, attempt, record) || record.finalizePromise || record.processExitConfirmed) {
			return { requested: false, reason: "not-runnable" };
		}
		if (resolveManagedStopIntent(record) !== intent) return { requested: false, reason: "intent-changed" };
		if (record.qSent) return { requested: false, alreadyRequested: true, intent: resolveManagedStopIntent(record) };

		record.qSent = true;
		const stopError = "FFmpeg did not accept the graceful stop request";
		const reportIssue = () => Promise.resolve(onStopIssue({ jobId, attempt, record, intent: resolveManagedStopIntent(record), message: stopError })).catch(() => {});
		try {
			if (!record.child || record.child.exitCode !== null || !record.child.stdin || !record.child.stdin.writable) {
				await reportIssue();
			} else {
				record.child.stdin.write("q\n", (error) => {
					if (error) reportIssue();
				});
			}
		} catch {
			await reportIssue();
		}

		const timer = setTimeoutImpl(() => {
			const current = processes.get(jobId);
			const currentIntent = resolveManagedStopIntent(current || {});
			if (!isCurrent(jobId, attempt, current) || current.finalizePromise || current.processExitConfirmed || !currentIntent) return;
			Promise.resolve(onGraceExpired({ jobId, attempt, record: current, intent: currentIntent })).catch(() => {});
		}, gracePeriodMs);
		processes.setGraceTimer(jobId, attempt, timer);
		return { requested: true, intent };
	}

	return Object.freeze({ request });
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
