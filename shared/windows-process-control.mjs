import { spawn as nodeSpawn } from "node:child_process";
import { lstat as nodeLstat } from "node:fs/promises";
import nodePath from "node:path";

export const TASKKILL_OUTPUT_MAX_BYTES = 8 * 1024;
export const TASKKILL_TIMEOUT_MS = 5000;

function internalResult({
	attempted = false,
	launched = false,
	timedOut = false,
	exitCode = null,
	signal = null,
	safeErrorCode = null,
} = {}) {
	return { attempted, launched, timedOut, exitCode, signal, safeErrorCode };
}

function isSafePositivePid(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function safeTimeout(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : TASKKILL_TIMEOUT_MS;
}

function consumeBounded(stream, limit) {
	if (!stream || typeof stream.on !== "function") return () => {};
	let retained = 0;
	const onData = (chunk) => {
		if (retained >= limit) return;
		const size = Buffer.isBuffer(chunk) ? chunk.length : (typeof chunk === "string" ? Buffer.byteLength(chunk) : 0);
		retained = Math.min(limit, retained + size);
	};
	stream.on("data", onData);
	return () => {
		stream.removeListener?.("data", onData);
		stream.resume?.();
	};
}

export async function resolveTrustedTaskkillPath({
	platform = process.platform,
	systemRoot = process.env.SystemRoot,
	pathApi = nodePath,
	lstat = nodeLstat,
} = {}) {
	if (platform !== "win32") return { ok: false, safeErrorCode: "TRANSCODE_FORCE_KILL_UNSUPPORTED" };
	if (typeof systemRoot !== "string" || !systemRoot.trim() || systemRoot.includes("\0")) {
		return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_PATH_INVALID" };
	}

	const rawRoot = systemRoot.trim();
	if (!pathApi.isAbsolute(rawRoot)) return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_PATH_INVALID" };
	const resolvedRoot = pathApi.resolve(rawRoot);
	const system32 = pathApi.resolve(resolvedRoot, "System32");
	const executable = pathApi.resolve(system32, "taskkill.exe");
	const relative = pathApi.relative(system32, executable);
	if (!relative || relative.startsWith("..") || pathApi.isAbsolute(relative) || pathApi.basename(executable).toLowerCase() !== "taskkill.exe") {
		return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_PATH_INVALID" };
	}

	try {
		const info = await lstat(executable);
		if (!info?.isFile?.()) return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_NOT_FOUND" };
		if (info.isSymbolicLink?.()) return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_NOT_TRUSTED" };
		return { ok: true, executable, safeErrorCode: null };
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_NOT_FOUND" };
		return { ok: false, safeErrorCode: "TRANSCODE_TASKKILL_NOT_TRUSTED" };
	}
}

export async function forceKillWindowsProcessTree({
	pid,
	timeoutMs = TASKKILL_TIMEOUT_MS,
	platform = process.platform,
	systemRoot = process.env.SystemRoot,
	pathApi = nodePath,
	lstat = nodeLstat,
	spawnImpl = nodeSpawn,
	setTimeoutImpl = setTimeout,
	clearTimeoutImpl = clearTimeout,
} = {}) {
	if (!isSafePositivePid(pid)) return internalResult({ safeErrorCode: "TRANSCODE_FORCE_KILL_INVALID_PID" });
	const trusted = await resolveTrustedTaskkillPath({ platform, systemRoot, pathApi, lstat });
	if (!trusted.ok) return internalResult({ safeErrorCode: trusted.safeErrorCode });

	const args = ["/pid", String(pid), "/t", "/f"];
	let child;
	try {
		child = spawnImpl(trusted.executable, args, {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return internalResult({ attempted: true, safeErrorCode: "TRANSCODE_TASKKILL_LAUNCH_FAILED" });
	}
	if (!child || typeof child.once !== "function") {
		return internalResult({ attempted: true, safeErrorCode: "TRANSCODE_TASKKILL_LAUNCH_FAILED" });
	}

	return new Promise((resolve) => {
		let settled = false;
		let timer = null;
		const stopStdout = consumeBounded(child.stdout, TASKKILL_OUTPUT_MAX_BYTES);
		const stopStderr = consumeBounded(child.stderr, TASKKILL_OUTPUT_MAX_BYTES);
		const cleanup = () => {
			if (timer) clearTimeoutImpl(timer);
			timer = null;
			child.removeListener?.("error", onError);
			child.removeListener?.("close", onClose);
			stopStdout();
			stopStderr();
		};
		const finalizeOnce = (result) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const onError = () => finalizeOnce(internalResult({ attempted: true, launched: true, safeErrorCode: "TRANSCODE_TASKKILL_LAUNCH_FAILED" }));
		const onClose = (exitCode, signal) => finalizeOnce(internalResult({
			attempted: true,
			launched: true,
			exitCode: Number.isInteger(exitCode) ? exitCode : null,
			signal: typeof signal === "string" ? signal : null,
			safeErrorCode: exitCode === 0 ? null : "TRANSCODE_TASKKILL_FAILED",
		}));

		child.once("error", onError);
		child.once("close", onClose);
		timer = setTimeoutImpl(() => {
			try {
				child.kill?.();
			} catch {
				// The timeout result remains safe even if the helper process has already exited.
			}
			finalizeOnce(internalResult({ attempted: true, launched: true, timedOut: true, safeErrorCode: "TRANSCODE_TASKKILL_TIMEOUT" }));
		}, safeTimeout(timeoutMs));
	});
}
