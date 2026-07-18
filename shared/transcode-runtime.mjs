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
	const idleWaiters = new Set();

	const notifyIdle = () => {
		if (activeId || pending.length || scheduling) return;
		for (const resolve of idleWaiters) resolve();
		idleWaiters.clear();
	};

	const schedule = () => {
		if (closed || scheduling || activeId || !pending.length) return;
		scheduling = true;
		queueMicrotask(async () => {
			scheduling = false;
			if (closed || activeId || !pending.length) {
				notifyIdle();
				return;
			}
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
				notifyIdle();
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
			notifyIdle();
			return { closed: true, alreadyClosed: false, pendingJobIds };
		},
		snapshot() {
			return { closed, activeId, pending: [...pending] };
		},
		idle() {
			if (!activeId && !pending.length && !scheduling) return Promise.resolve();
			return new Promise((resolve) => idleWaiters.add(resolve));
		},
	});
}

export function isStudioApiWriteRequest({ method, pathname }) {
	return typeof pathname === "string"
		&& pathname.startsWith("/api/")
		&& ["POST", "PUT", "PATCH", "DELETE"].includes(String(method || "").toUpperCase());
}

export function withStudioShutdownConnectionClose(headers = {}) {
	return Object.freeze({ ...headers, connection: "close" });
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

export function createStudioHttpRequestTracker() {
	let activeRequestCount = 0;
	const zeroWaiters = new Set();

	const notifyZero = () => {
		if (activeRequestCount !== 0) return;
		for (const resolve of zeroWaiters) resolve();
		zeroWaiters.clear();
	};

	return Object.freeze({
		beginRequest() {
			activeRequestCount += 1;
			let settled = false;
			return Object.freeze({
				settle() {
					if (settled) return false;
					settled = true;
					activeRequestCount = Math.max(0, activeRequestCount - 1);
					notifyZero();
					return true;
				},
			});
		},
		getActiveRequestCount() { return activeRequestCount; },
		waitForZero() {
			if (activeRequestCount === 0) return Promise.resolve();
			return new Promise((resolve) => zeroWaiters.add(resolve));
		},
	});
}

export function createStudioShutdownPreparation({
	queue,
	recoverPending = async () => ({}),
	requestActiveShutdown = async () => ({}),
	closeHttp = async () => ({ ok: true, closed: true }),
	closeIdleConnections = () => ({ ok: true }),
	forceCloseHttp = () => ({ ok: true }),
	waitForHttpRequests = async () => {},
	waitForActiveSafety = async () => {},
	processAdapter = { setExitCode() {}, forceExit() {} },
	logger = () => {},
	httpForceCloseDelayMs = 12_000,
	globalDeadlineMs = 14_000,
	setTimeoutImpl = setTimeout,
	clearTimeoutImpl = clearTimeout,
}) {
	if (!queue || typeof queue.close !== "function") throw new TypeError("queue.close must be a function");
	if (typeof recoverPending !== "function") throw new TypeError("recoverPending must be a function");
	if (typeof requestActiveShutdown !== "function") throw new TypeError("requestActiveShutdown must be a function");
	if (typeof closeHttp !== "function" || typeof closeIdleConnections !== "function" || typeof forceCloseHttp !== "function") throw new TypeError("HTTP shutdown callbacks must be functions");
	if (typeof waitForHttpRequests !== "function" || typeof waitForActiveSafety !== "function") throw new TypeError("shutdown wait callbacks must be functions");
	if (!processAdapter || typeof processAdapter.setExitCode !== "function" || typeof processAdapter.forceExit !== "function") throw new TypeError("processAdapter must provide setExitCode and forceExit");
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
		lifecycleStarted: false,
		signalHandlersRegistered: false,
		signalCount: 0,
		httpIdleCloseRequested: false,
		httpForceCloseRequested: false,
		activeRequestCount: 0,
		gracefulDeadlineReached: false,
		forcedShutdownRequested: false,
		awaitingChild: false,
		awaitingHttp: false,
		lifecycleResultSettled: false,
		safeCompletionReached: false,
		exitCode: null,
		activeSafetySettled: false,
		httpSafetySettled: false,
		httpRequestsSettled: false,
		lifecycleResultPromise: null,
		safeCompletionPromise: null,
		resolveLifecycleResult: null,
		resolveSafeCompletion: null,
		httpForceCloseTimer: null,
		globalDeadlineTimer: null,
		signalSource: null,
		signalHandlers: null,
		forceExitCalled: false,
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
		lifecycleStarted: state.lifecycleStarted,
		signalHandlersRegistered: state.signalHandlersRegistered,
		signalCount: state.signalCount,
		httpIdleCloseRequested: state.httpIdleCloseRequested,
		httpForceCloseRequested: state.httpForceCloseRequested,
		activeRequestCount: state.activeRequestCount,
		gracefulDeadlineReached: state.gracefulDeadlineReached,
		forcedShutdownRequested: state.forcedShutdownRequested,
		awaitingChild: state.awaitingChild,
		awaitingHttp: state.awaitingHttp,
		lifecycleResultSettled: state.lifecycleResultSettled,
		safeCompletionReached: state.safeCompletionReached,
		exitCode: state.exitCode,
		httpRequestsSettled: state.httpRequestsSettled,
	});

	const setExitCode = (code) => {
		if (![0, 1].includes(code)) return false;
		if (state.exitCode === 1 || state.exitCode === code) return false;
		state.exitCode = code;
		try { processAdapter.setExitCode(code); } catch { markDegraded("STUDIO_SHUTDOWN_INTERNAL_ERROR"); }
		return true;
	};

	const clearLifecycleTimers = () => {
		if (state.httpForceCloseTimer) clearTimeoutImpl(state.httpForceCloseTimer);
		if (state.globalDeadlineTimer) clearTimeoutImpl(state.globalDeadlineTimer);
		state.httpForceCloseTimer = null;
		state.globalDeadlineTimer = null;
	};

	const removeTerminationHandlers = () => {
		if (!state.signalHandlersRegistered || !state.signalSource || !state.signalHandlers) return false;
		try {
			state.signalSource.removeListener("SIGINT", state.signalHandlers.interrupt);
			state.signalSource.removeListener("SIGTERM", state.signalHandlers.terminate);
		} catch {
			markDegraded("STUDIO_SHUTDOWN_INTERNAL_ERROR");
			return false;
		}
		state.signalHandlersRegistered = false;
		state.signalSource = null;
		state.signalHandlers = null;
		return true;
	};

	const settleLifecycleResult = (result) => {
		if (state.lifecycleResultSettled) return false;
		state.lifecycleResultSettled = true;
		state.resolveLifecycleResult?.(Object.freeze(result));
		return true;
	};

	const checkSafeCompletion = () => {
		if (!state.lifecycleStarted || state.safeCompletionReached || !state.pendingRecoveryCompleted || !state.activeSafetySettled || !state.httpSafetySettled || !state.httpClosed) return false;
		state.awaitingChild = false;
		state.awaitingHttp = false;
		state.safeCompletionReached = true;
		state.completed = true;
		clearLifecycleTimers();
		removeTerminationHandlers();
		state.resolveSafeCompletion?.(Object.freeze({ status: "completed", degraded: state.degraded, degradedCodes: [...state.degradedCodes] }));
		settleLifecycleResult({ status: "completed", degraded: state.degraded, degradedCodes: [...state.degradedCodes] });
		try { logger("Studio has shut down safely."); } catch { /* lifecycle logging is best effort */ }
		return true;
	};

	const requestHttpForceClose = () => {
		if (state.httpForceCloseRequested) return false;
		state.httpForceCloseRequested = true;
		markDegraded("STUDIO_HTTP_FORCE_CLOSE_REQUIRED");
		setExitCode(1);
		try {
			const result = forceCloseHttp();
			Promise.resolve(result).then((value) => {
				if (value?.ok === false) markDegraded(value.code || "STUDIO_HTTP_CLOSE_TIMEOUT");
			}).catch(() => markDegraded("STUDIO_HTTP_CLOSE_TIMEOUT"));
		} catch {
			markDegraded("STUDIO_HTTP_CLOSE_TIMEOUT");
		}
		return true;
	};

	const onGlobalDeadline = () => {
		if (state.safeCompletionReached || state.gracefulDeadlineReached) return;
		state.gracefulDeadlineReached = true;
		state.globalDeadlineTimer = null;
		state.awaitingChild = !state.activeSafetySettled;
		state.awaitingHttp = !state.httpSafetySettled || !state.httpClosed;
		if (state.awaitingChild) markDegraded("STUDIO_ACTIVE_SHUTDOWN_TIMEOUT");
		if (state.awaitingHttp) {
			markDegraded("STUDIO_HTTP_CLOSE_TIMEOUT");
			requestHttpForceClose();
		}
		if (state.awaitingChild || state.awaitingHttp || state.degraded) setExitCode(1);
		settleLifecycleResult({
			status: "degraded",
			awaitingChild: state.awaitingChild,
			awaitingHttp: state.awaitingHttp,
			degradedCodes: [...state.degradedCodes],
		});
	};

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
			if (activeResult?.ok === false) {
				markDegraded(activeResult.code || "TRANSCODE_SHUTDOWN_ACTIVE_PREPARATION_FAILED");
				if (state.lifecycleStarted) setExitCode(1);
			}
			if (recoveryResult?.ok === false) {
				markDegraded(recoveryResult.code || "TRANSCODE_SHUTDOWN_PENDING_RECOVERY_FAILED");
				if (state.lifecycleStarted) setExitCode(1);
			}
			checkSafeCompletion();
			return {
				ok: activeResult?.ok !== false && recoveryResult?.ok !== false,
				queue: queueResult,
				active: activeResult,
				recovery: recoveryResult,
			};
		});
		return state.preparationPromise;
	};

	const beginLifecycle = () => {
		if (state.lifecycleResultPromise) return state.lifecycleResultPromise;
		state.lifecycleStarted = true;
		const preparation = begin();
		state.lifecycleResultPromise = new Promise((resolve) => { state.resolveLifecycleResult = resolve; });
		state.safeCompletionPromise = new Promise((resolve) => { state.resolveSafeCompletion = resolve; });
		state.httpCloseStarted = true;
		let closeResult;
		try { closeResult = closeHttp(); }
		catch { closeResult = { ok: false, code: "STUDIO_HTTP_CLOSE_TIMEOUT" }; }
		let idleResult;
		state.httpIdleCloseRequested = true;
		try { idleResult = closeIdleConnections(); }
		catch { idleResult = { ok: false, code: "STUDIO_HTTP_CLOSE_TIMEOUT" }; }
		Promise.resolve(idleResult).then((value) => {
			if (value?.ok === false) {
				markDegraded(value.code || "STUDIO_HTTP_CLOSE_TIMEOUT");
				setExitCode(1);
			}
		}).catch(() => { markDegraded("STUDIO_HTTP_CLOSE_TIMEOUT"); setExitCode(1); });
		const closePromise = Promise.resolve(closeResult).then((value) => {
			if (value?.ok === false) {
				markDegraded(value.code || "STUDIO_HTTP_CLOSE_TIMEOUT");
				setExitCode(1);
			} else if (value?.closed === true) {
				state.httpClosed = true;
			}
			return value;
		}).catch(() => {
			markDegraded("STUDIO_HTTP_CLOSE_TIMEOUT");
			setExitCode(1);
			return { ok: false };
		});
		Promise.all([closePromise, Promise.resolve().then(waitForHttpRequests).catch(() => ({ ok: false }))])
			.then(([, requestResult]) => {
				if (requestResult?.ok === false) {
					markDegraded("STUDIO_HTTP_CLOSE_TIMEOUT");
					setExitCode(1);
				}
				state.activeRequestCount = 0;
				state.httpRequestsSettled = true;
				state.httpSafetySettled = state.httpClosed;
				checkSafeCompletion();
			});
		Promise.resolve().then(waitForActiveSafety)
			.then((value) => {
				if (value?.ok === false) {
					markDegraded(value.code || "STUDIO_ACTIVE_SHUTDOWN_TIMEOUT");
					setExitCode(1);
				}
				state.activeSafetySettled = value?.ok !== false;
				checkSafeCompletion();
			}).catch(() => {
				markDegraded("STUDIO_ACTIVE_SHUTDOWN_TIMEOUT");
				setExitCode(1);
			});
		state.httpForceCloseTimer = setTimeoutImpl(() => {
			state.httpForceCloseTimer = null;
			if (!state.httpSafetySettled || !state.httpClosed) requestHttpForceClose();
		}, httpForceCloseDelayMs);
		state.globalDeadlineTimer = setTimeoutImpl(onGlobalDeadline, globalDeadlineMs);
		preparation.catch(() => {});
		return state.lifecycleResultPromise;
	};

	const handleTerminationRequest = () => {
		state.signalCount += 1;
		if (state.signalCount === 1) {
			try { logger("Studio is shutting down."); } catch { /* lifecycle logging is best effort */ }
			return beginLifecycle();
		}
		if (state.signalCount === 2) {
			state.forcedShutdownRequested = true;
			setExitCode(1);
			requestHttpForceClose();
			try { logger("A second shutdown request was received. Studio will exit forcefully."); } catch { /* lifecycle logging is best effort */ }
			if (!state.forceExitCalled) {
				state.forceExitCalled = true;
				try { processAdapter.forceExit(1); } catch { markDegraded("STUDIO_SHUTDOWN_INTERNAL_ERROR"); }
			}
		}
		return state.lifecycleResultPromise || Promise.resolve(Object.freeze({ status: "not-started" }));
	};

	const registerTerminationHandlers = (signalSource) => {
		if (state.signalHandlersRegistered) return false;
		if (!signalSource || typeof signalSource.on !== "function" || typeof signalSource.removeListener !== "function") throw new TypeError("signalSource must provide on and removeListener");
		const interrupt = () => { Promise.resolve(handleTerminationRequest()).catch(() => markDegraded("STUDIO_SHUTDOWN_INTERNAL_ERROR")); };
		const terminate = () => { Promise.resolve(handleTerminationRequest()).catch(() => markDegraded("STUDIO_SHUTDOWN_INTERNAL_ERROR")); };
		signalSource.on("SIGINT", interrupt);
		signalSource.on("SIGTERM", terminate);
		state.signalSource = signalSource;
		state.signalHandlers = { interrupt, terminate };
		state.signalHandlersRegistered = true;
		return true;
	};

	return Object.freeze({
		begin,
		beginLifecycle,
		handleTerminationRequest,
		registerTerminationHandlers,
		removeTerminationHandlers,
		getSafeCompletionPromise() { return state.safeCompletionPromise; },
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
			if (state.httpRequestsSettled) state.httpSafetySettled = true;
			checkSafeCompletion();
			return true;
		},
		setActiveRequestCount(count) {
			const next = Number.isSafeInteger(count) && count >= 0 ? count : state.activeRequestCount;
			if (next === state.activeRequestCount) return false;
			state.activeRequestCount = next;
			checkSafeCompletion();
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
	const idleWaiters = new Set();
	const notifyIdle = () => {
		if (records.size !== 0) return;
		for (const resolve of idleWaiters) resolve();
		idleWaiters.clear();
	};
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
			notifyIdle();
			return record;
		},
		clear() {
			for (const record of records.values()) {
				if (record.graceTimer) clearTimeout(record.graceTimer);
				if (record.forceKillConfirmationTimer) clearTimeout(record.forceKillConfirmationTimer);
			}
			records.clear();
			pendingShutdownIntents.clear();
			notifyIdle();
		},
		waitForIdle() {
			if (records.size === 0) return Promise.resolve();
			return new Promise((resolve) => idleWaiters.add(resolve));
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
