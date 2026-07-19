/**
 * Pure lifecycle manager for already-prepared local source probes. Production
 * adapters own source validation, persistence, argv construction, and child
 * process control. This module only owns the known-child safety boundary.
 */

const permits = new WeakMap();
const consumers = new WeakSet();
const attemptHandles = new WeakMap();

export const MANAGED_SOURCE_PROBE_KINDS = Object.freeze([
	"job-library-source",
	"job-upload-source",
	"direct-library-source",
	"output-validation",
]);

export const MANAGED_SOURCE_PROBE_CODES = Object.freeze({
	permitInvalid: "SOURCE_PROBE_PERMIT_INVALID",
	permitAlreadyUsed: "SOURCE_PROBE_PERMIT_ALREADY_USED",
	kindInvalid: "SOURCE_PROBE_KIND_INVALID",
	directProtectionUnavailable: "SOURCE_PROBE_DIRECT_PROTECTION_UNAVAILABLE",
	shuttingDown: "SOURCE_PROBE_SHUTTING_DOWN",
	spawnFailed: "SOURCE_PROBE_SPAWN_FAILED",
	childError: "SOURCE_PROBE_CHILD_ERROR",
	childExitFailed: "SOURCE_PROBE_CHILD_EXIT_FAILED",
	streamError: "SOURCE_PROBE_STREAM_ERROR",
	outputLimit: "SOURCE_PROBE_OUTPUT_LIMIT",
	timeout: "SOURCE_PROBE_TIMEOUT",
	softStopFailed: "SOURCE_PROBE_SOFT_STOP_FAILED",
	forceStopFailed: "SOURCE_PROBE_FORCE_STOP_FAILED",
	resultInvalid: "SOURCE_PROBE_RESULT_INVALID",
	finalizeFailed: "SOURCE_PROBE_FINALIZE_FAILED",
	disposeBusy: "SOURCE_PROBE_DISPOSE_BUSY",
	disposed: "SOURCE_PROBE_DISPOSED",
	stopped: "SOURCE_PROBE_STOPPED",
});

const JOB_KINDS = new Set(["job-library-source", "job-upload-source"]);
const STOP_PRIORITIES = Object.freeze({
	normal: 0,
	"child-error": 1,
	"stream-error": 1,
	"request-abort": 2,
	"output-limit": 3,
	timeout: 4,
	shutdown: 5,
});

function freeze(value) {
	return Object.freeze(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCode(value, fallback) {
	return typeof value === "string" && /^[A-Z0-9_]{3,96}$/.test(value) ? value : fallback;
}

function validPolicy(policy) {
	return record(policy)
		&& Number.isSafeInteger(policy.executionTimeoutMs) && policy.executionTimeoutMs > 0
		&& Number.isSafeInteger(policy.softStopGraceMs) && policy.softStopGraceMs > 0
		&& Number.isSafeInteger(policy.stdoutMaxBytes) && policy.stdoutMaxBytes > 0
		&& Number.isSafeInteger(policy.stderrMaxBytes) && policy.stderrMaxBytes > 0;
}

function validChild(value) {
	return record(value) && typeof value.once === "function" && typeof value.on === "function";
}

function validControl(value) {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function validCallbacks(value) {
	return record(value)
		&& typeof value.spawnPreparedProbe === "function"
		&& typeof value.evaluateClosedProbe === "function"
		&& typeof value.finalizeBusinessProtection === "function";
}

function safeCompletion({
	status = "failed",
	code = null,
	childCloseConfirmed = false,
	businessProtectionFinalized = false,
	protectionRetained = false,
	stopped = false,
	timedOut = false,
	outputLimited = false,
} = {}) {
	return freeze({ status, code, childCloseConfirmed, businessProtectionFinalized, protectionRetained, stopped, timedOut, outputLimited });
}

function rejectedHandle(code) {
	return freeze({
		completion: Promise.resolve(safeCompletion({ status: "rejected", code })),
		requestStop: () => Promise.resolve(freeze({ requested: false, alreadyRequested: false, code })),
	});
}

function createPermit(authority, details) {
	const permit = {};
	Object.defineProperties(permit, {
		kind: { value: "managed-source-probe-permit", enumerable: false },
		toJSON: { value: () => ({ kind: "managed-source-probe-permit" }), enumerable: false },
	});
	permits.set(permit, { authority, ...details, used: false });
	return freeze(permit);
}

/**
 * Issuers are intentionally separate from consumers. A future trusted CAS or
 * journal transaction keeps the issuer private and gives only the consumer to
 * the lifecycle manager.
 */
export function createManagedSourceProbePermitAuthority() {
	const authority = {};
	const consume = (permit) => {
		const details = permits.get(permit);
		if (!details || details.authority !== authority) return freeze({ ok: false, code: MANAGED_SOURCE_PROBE_CODES.permitInvalid });
		if (details.used) return freeze({ ok: false, code: MANAGED_SOURCE_PROBE_CODES.permitAlreadyUsed });
		details.used = true;
		return freeze({ ok: true, details });
	};
	const consumer = freeze({ consume });
	consumers.add(consumer);
	const mint = (kind, protectionMode, callbacks) => {
		if (!validCallbacks(callbacks)) throw new TypeError("Managed source probe permit callbacks are invalid");
		return freeze({ ok: true, permit: createPermit(authority, {
			probeKind: kind,
			protectionMode,
			spawnPreparedProbe: callbacks.spawnPreparedProbe,
			evaluateClosedProbe: callbacks.evaluateClosedProbe,
			finalizeBusinessProtection: callbacks.finalizeBusinessProtection,
		}) });
	};
	return freeze({
		issuer: freeze({
			mintJobSourceProbePermit({ kind, ...callbacks } = {}) {
				if (!JOB_KINDS.has(kind)) return freeze({ ok: false, code: MANAGED_SOURCE_PROBE_CODES.kindInvalid, permit: null });
				return mint(kind, "persistent-job-evidence", callbacks);
			},
			mintOutputValidationPermit(callbacks = {}) {
				return mint("output-validation", "ephemeral-output-validation", callbacks);
			},
			mintDirectLibrarySourcePermit() {
				return freeze({ ok: false, code: MANAGED_SOURCE_PROBE_CODES.directProtectionUnavailable, permit: null });
			},
		}),
		consumer,
	});
}

function removeListener(emitter, event, listener) {
	if (typeof emitter?.removeListener === "function") emitter.removeListener(event, listener);
}

function outputBuffer(value) {
	if (Buffer.isBuffer(value)) return Buffer.from(value);
	if (typeof value === "string") return Buffer.from(value, "utf8");
	return null;
}

/**
 * Creates a manager with no process, filesystem, or platform capability of
 * its own. All child controls are opaque adapter capabilities.
 */
export function createManagedSourceProbeManager({
	permitConsumer,
	requestSoftStopKnownChild,
	forceKillKnownChildTree,
	scheduleTimer,
	cancelTimer,
	createAttemptId,
	policy,
} = {}) {
	if (!consumers.has(permitConsumer) || typeof permitConsumer.consume !== "function") throw new TypeError("Managed source probe permit consumer is invalid");
	if (typeof requestSoftStopKnownChild !== "function" || typeof forceKillKnownChildTree !== "function"
		|| typeof scheduleTimer !== "function" || typeof cancelTimer !== "function" || typeof createAttemptId !== "function" || !validPolicy(policy)) {
		throw new TypeError("Managed source probe manager dependencies are invalid");
	}

	const attempts = new Set();
	const safetyWaiters = new Set();
	const idleWaiters = new Set();
	let shutdownRequested = false;
	let disposed = false;
	let retainedProtectionCount = 0;

	function notifyWaiters() {
		if ([...attempts].every((attempt) => attempt.safetyConfirmed)) {
			for (const resolve of safetyWaiters) resolve();
			safetyWaiters.clear();
		}
		if (attempts.size === 0) {
			for (const resolve of idleWaiters) resolve();
			idleWaiters.clear();
		}
	}

	function waitForSafety() {
		if ([...attempts].every((attempt) => attempt.safetyConfirmed)) return Promise.resolve();
		return new Promise((resolve) => safetyWaiters.add(resolve));
	}

	function waitForIdle() {
		if (attempts.size === 0) return Promise.resolve();
		return new Promise((resolve) => idleWaiters.add(resolve));
	}

	function clearAttemptTimers(attempt) {
		if (attempt.executionTimer !== null) cancelTimer(attempt.executionTimer);
		if (attempt.graceTimer !== null) cancelTimer(attempt.graceTimer);
		attempt.executionTimer = null;
		attempt.graceTimer = null;
	}

	function removeAttemptListeners(attempt) {
		if (!attempt.child) return;
		removeListener(attempt.child, "error", attempt.listeners.childError);
		removeListener(attempt.child, "exit", attempt.listeners.childExit);
		removeListener(attempt.child, "close", attempt.listeners.childClose);
		removeListener(attempt.child.stdout, "data", attempt.listeners.stdoutData);
		removeListener(attempt.child.stderr, "data", attempt.listeners.stderrData);
		removeListener(attempt.child.stdout, "error", attempt.listeners.stdoutError);
		removeListener(attempt.child.stderr, "error", attempt.listeners.stderrError);
	}

	function chooseStopReason(attempt, reason) {
		const priority = STOP_PRIORITIES[reason];
		if (priority === undefined) return false;
		if (priority > attempt.stopPriority) {
			attempt.stopPriority = priority;
			attempt.stopReason = reason;
		}
		return true;
	}

	function scheduleGrace(attempt) {
		if (attempt.graceTimer !== null || attempt.safetyConfirmed) return;
		try {
			attempt.graceTimer = scheduleTimer(() => {
				attempt.graceTimer = null;
				if (attempt.safetyConfirmed || attempt.forceStopStarted) return;
				attempt.forceStopStarted = true;
				attempt.state = "force-stop-requested";
				Promise.resolve()
					.then(() => forceKillKnownChildTree(attempt.knownChildControl))
					.catch(() => { attempt.forceStopFailed = true; });
			}, policy.softStopGraceMs);
		} catch {
			attempt.forceStopFailed = true;
		}
	}

	function requestStopInternal(attempt, reason) {
		if (!chooseStopReason(attempt, reason)) return Promise.resolve(freeze({ requested: false, alreadyRequested: false, code: MANAGED_SOURCE_PROBE_CODES.kindInvalid }));
		if (attempt.safetyConfirmed || !attempt.child || !attempt.knownChildControl) {
			return Promise.resolve(freeze({ requested: false, alreadyRequested: attempt.softStopStarted, code: null }));
		}
		if (attempt.softStopStarted) return Promise.resolve(freeze({ requested: false, alreadyRequested: true, code: null }));
		attempt.softStopStarted = true;
		attempt.state = "soft-stop-requested";
		scheduleGrace(attempt);
		return Promise.resolve()
			.then(() => requestSoftStopKnownChild(attempt.knownChildControl))
			.then(() => freeze({ requested: true, alreadyRequested: false, code: null }))
			.catch(() => {
				attempt.softStopFailed = true;
				return freeze({ requested: true, alreadyRequested: false, code: MANAGED_SOURCE_PROBE_CODES.softStopFailed });
			});
	}

	function addOutput(attempt, stream, value) {
		if (attempt.safetyConfirmed) return;
		const chunk = outputBuffer(value);
		if (!chunk) {
			attempt.streamError = true;
			void requestStopInternal(attempt, "stream-error");
			return;
		}
		const key = stream === "stdout" ? "stdout" : "stderr";
		const limit = key === "stdout" ? policy.stdoutMaxBytes : policy.stderrMaxBytes;
		if (attempt[`${key}Limited`]) return;
		if (attempt[`${key}Bytes`] + chunk.length > limit) {
			attempt[`${key}Limited`] = true;
			attempt.outputLimited = true;
			void requestStopInternal(attempt, "output-limit");
			return;
		}
		attempt[`${key}Bytes`] += chunk.length;
		attempt[`${key}Chunks`].push(chunk);
	}

	function childFailureCode(attempt) {
		if (attempt.adapterInvalid) return MANAGED_SOURCE_PROBE_CODES.spawnFailed;
		if (attempt.stopReason === "shutdown") return MANAGED_SOURCE_PROBE_CODES.shuttingDown;
		if (attempt.stopReason === "timeout") return MANAGED_SOURCE_PROBE_CODES.timeout;
		if (attempt.outputLimited) return MANAGED_SOURCE_PROBE_CODES.outputLimit;
		if (attempt.streamError) return MANAGED_SOURCE_PROBE_CODES.streamError;
		if (attempt.childError) return MANAGED_SOURCE_PROBE_CODES.childError;
		if (attempt.exitCode !== null && attempt.exitCode !== 0) return MANAGED_SOURCE_PROBE_CODES.childExitFailed;
		if (attempt.stopReason !== "normal") return MANAGED_SOURCE_PROBE_CODES.stopped;
		return null;
	}

	function privateChildOutcome(attempt, code) {
		return freeze({
			probeKind: attempt.details.probeKind,
			protectionMode: attempt.details.protectionMode,
			spawned: attempt.spawned,
			closeConfirmed: attempt.closeConfirmed,
			code,
			stopped: attempt.stopReason !== "normal",
			timedOut: attempt.stopReason === "timeout",
			outputLimited: attempt.outputLimited,
		});
	}

	async function finalizeAttempt(attempt, initialCode) {
		if (attempt.finalizing) return;
		attempt.finalizing = true;
		attempt.state = "finalizing";
		let code = initialCode;
		let evaluated = null;
		if (!code && attempt.closeConfirmed) {
			try {
				const result = await attempt.details.evaluateClosedProbe(freeze({
					childOutcome: privateChildOutcome(attempt, null),
					stdout: Buffer.concat(attempt.stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(attempt.stderrChunks).toString("utf8"),
				}));
				if (!record(result) || result.ok !== true) code = safeCode(result?.code, MANAGED_SOURCE_PROBE_CODES.resultInvalid);
				else evaluated = result.value;
			} catch {
				code = MANAGED_SOURCE_PROBE_CODES.resultInvalid;
			}
		}
		let finalized = false;
		let protectionRetained = false;
		try {
			const result = await attempt.details.finalizeBusinessProtection(freeze({
				childOutcome: privateChildOutcome(attempt, code),
				evaluated,
			}));
			if (!record(result) || result.ok !== true) {
				protectionRetained = true;
				code = MANAGED_SOURCE_PROBE_CODES.finalizeFailed;
			} else {
				finalized = true;
				protectionRetained = result.protectionRetained === true;
			}
		} catch {
			protectionRetained = true;
			code = MANAGED_SOURCE_PROBE_CODES.finalizeFailed;
		}
		if (protectionRetained) retainedProtectionCount += 1;
		attempt.stdoutChunks = [];
		attempt.stderrChunks = [];
		attempt.finalizing = false;
		attempt.state = "finalized";
		attempts.delete(attempt);
		attempt.resolveCompletion(safeCompletion({
			status: !code && finalized && !protectionRetained ? "completed" : "failed",
			code,
			childCloseConfirmed: attempt.closeConfirmed,
			businessProtectionFinalized: finalized,
			protectionRetained,
			stopped: attempt.stopReason !== "normal",
			timedOut: attempt.stopReason === "timeout",
			outputLimited: attempt.outputLimited,
		}));
		notifyWaiters();
	}

	function confirmNoChild(attempt, code) {
		if (attempt.safetyConfirmed) return;
		attempt.safetyConfirmed = true;
		attempt.state = "spawn-failed-before-child";
		notifyWaiters();
		void finalizeAttempt(attempt, code);
	}

	function confirmClose(attempt, code, signal) {
		if (attempt.closeConfirmed) return;
		attempt.closeConfirmed = true;
		attempt.safetyConfirmed = true;
		attempt.exitCode = Number.isSafeInteger(code) ? code : null;
		attempt.exitSignal = typeof signal === "string" ? signal : null;
		attempt.state = "close-confirmed";
		clearAttemptTimers(attempt);
		removeAttemptListeners(attempt);
		notifyWaiters();
		void finalizeAttempt(attempt, childFailureCode(attempt));
	}

	function attachChild(attempt, spawned) {
		if (!record(spawned) || !validChild(spawned.child)) {
			confirmNoChild(attempt, MANAGED_SOURCE_PROBE_CODES.spawnFailed);
			return;
		}
		attempt.child = spawned.child;
		attempt.knownChildControl = validControl(spawned.knownChildControl) ? spawned.knownChildControl : null;
		attempt.adapterInvalid = attempt.knownChildControl === null;
		attempt.spawned = true;
		attempt.state = "running";
		attempt.listeners = {
			childError: () => {
				attempt.childError = true;
				void requestStopInternal(attempt, "child-error");
			},
			childExit: (code, signal) => {
				attempt.exitCode = Number.isSafeInteger(code) ? code : null;
				attempt.exitSignal = typeof signal === "string" ? signal : null;
			},
			childClose: (code, signal) => confirmClose(attempt, code, signal),
			stdoutData: (value) => addOutput(attempt, "stdout", value),
			stderrData: (value) => addOutput(attempt, "stderr", value),
			stdoutError: () => {
				attempt.streamError = true;
				void requestStopInternal(attempt, "stream-error");
			},
			stderrError: () => {
				attempt.streamError = true;
				void requestStopInternal(attempt, "stream-error");
			},
		};
		attempt.child.once("error", attempt.listeners.childError);
		attempt.child.once("exit", attempt.listeners.childExit);
		attempt.child.once("close", attempt.listeners.childClose);
		if (attempt.child.stdout && typeof attempt.child.stdout.on === "function") {
			attempt.child.stdout.on("data", attempt.listeners.stdoutData);
			attempt.child.stdout.once?.("error", attempt.listeners.stdoutError);
		} else {
			attempt.streamError = true;
			void requestStopInternal(attempt, "stream-error");
		}
		if (attempt.child.stderr && typeof attempt.child.stderr.on === "function") {
			attempt.child.stderr.on("data", attempt.listeners.stderrData);
			attempt.child.stderr.once?.("error", attempt.listeners.stderrError);
		} else {
			attempt.streamError = true;
			void requestStopInternal(attempt, "stream-error");
		}
		try {
			attempt.executionTimer = scheduleTimer(() => {
				attempt.executionTimer = null;
				void requestStopInternal(attempt, "timeout");
			}, policy.executionTimeoutMs);
		} catch {
			void requestStopInternal(attempt, "timeout");
		}
		if (shutdownRequested) void requestStopInternal(attempt, "shutdown");
	}

	function makeAttempt(details) {
		let resolveCompletion;
		const attempt = {
			details,
			attemptId: (() => {
				try { return createAttemptId(); }
				catch { return {}; }
			})(),
			state: "prepared",
			child: null,
			knownChildControl: null,
			spawned: false,
			closeConfirmed: false,
			safetyConfirmed: false,
			finalizing: false,
			stopReason: "normal",
			stopPriority: 0,
			softStopStarted: false,
			forceStopStarted: false,
			softStopFailed: false,
			forceStopFailed: false,
			adapterInvalid: false,
			executionTimer: null,
			graceTimer: null,
			childError: false,
			streamError: false,
			outputLimited: false,
			stdoutLimited: false,
			stderrLimited: false,
			stdoutBytes: 0,
			stderrBytes: 0,
			stdoutChunks: [],
			stderrChunks: [],
			exitCode: null,
			exitSignal: null,
			listeners: {},
			completion: new Promise((resolve) => { resolveCompletion = resolve; }),
			resolveCompletion,
		};
		const handle = freeze({
			completion: attempt.completion,
			requestStop: (reason = "request-abort") => requestStopInternal(attempt, reason),
		});
		attemptHandles.set(handle, attempt);
		return { attempt, handle };
	}

	function start(permit) {
		if (disposed) return rejectedHandle(MANAGED_SOURCE_PROBE_CODES.disposed);
		if (shutdownRequested) return rejectedHandle(MANAGED_SOURCE_PROBE_CODES.shuttingDown);
		const consumed = permitConsumer.consume(permit);
		if (!consumed?.ok) return rejectedHandle(consumed?.code || MANAGED_SOURCE_PROBE_CODES.permitInvalid);
		const { attempt, handle } = makeAttempt(consumed.details);
		attempts.add(attempt);
		attempt.state = "spawning";
		try {
			attachChild(attempt, attempt.details.spawnPreparedProbe());
		} catch {
			confirmNoChild(attempt, MANAGED_SOURCE_PROBE_CODES.spawnFailed);
		}
		return handle;
	}

	function requestStop(handle, reason = "request-abort") {
		const attempt = attemptHandles.get(handle);
		if (!attempt) return Promise.resolve(freeze({ requested: false, alreadyRequested: false, code: MANAGED_SOURCE_PROBE_CODES.permitInvalid }));
		return requestStopInternal(attempt, reason);
	}

	function requestShutdownAll() {
		const alreadyRequested = shutdownRequested;
		shutdownRequested = true;
		for (const attempt of attempts) void requestStopInternal(attempt, "shutdown");
		return freeze({ requested: !alreadyRequested, alreadyRequested });
	}

	function getSafeSummary() {
		let runningChildCount = 0;
		let finalizingCount = 0;
		for (const attempt of attempts) {
			if (attempt.child && !attempt.safetyConfirmed) runningChildCount += 1;
			if (attempt.finalizing) finalizingCount += 1;
		}
		return freeze({ runningChildCount, finalizingCount, retainedProtectionCount, shutdownRequested });
	}

	function dispose() {
		if (attempts.size > 0) return freeze({ disposed: false, code: MANAGED_SOURCE_PROBE_CODES.disposeBusy });
		disposed = true;
		return freeze({ disposed: true, code: null });
	}

	return freeze({ start, requestStop, requestShutdownAll, waitForSafety, waitForIdle, getSafeSummary, dispose });
}
