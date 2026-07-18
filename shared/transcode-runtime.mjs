const DEFAULT_PROGRESS_PERSIST_MS = 2000;
const DEFAULT_STDERR_LIMIT = 16 * 1024;

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
		getPosition(jobId) {
			if (activeId === jobId) return 0;
			const index = pending.indexOf(jobId);
			return index === -1 ? null : index + 1;
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

export function createManagedTranscodeProcesses({ stderrLimit = DEFAULT_STDERR_LIMIT } = {}) {
	const records = new Map();
	return Object.freeze({
		attach(jobId, child) {
			if (records.has(jobId)) throw queueError("TRANSCODE_PROCESS_DUPLICATE", "This task already has a managed process");
			const record = { child, startedAt: new Date().toISOString(), lastProgressAt: null, cancelRequested: false, progressParser: {}, stderr: "", exitPromise: null, cleanupTimer: null };
			if (child && typeof child.once === "function") {
				record.exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
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
		requestCancel(jobId) { const record = records.get(jobId); if (record) record.cancelRequested = true; },
		get(jobId) { return records.get(jobId) || null; },
		finish(jobId) { const record = records.get(jobId) || null; records.delete(jobId); return record; },
		clear() { for (const record of records.values()) if (record.cleanupTimer) clearTimeout(record.cleanupTimer); records.clear(); },
	});
}
