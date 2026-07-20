import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, win32 } from "node:path";
import { spawn } from "node:child_process";
import {
	createWindowsLogonSessionRealValidator,
	getWindowsLogonSessionRealValidationExitCode,
	WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES,
} from "../shared/windows-logon-session-real-validator.mjs";

const EXPECTED_BASENAME = "windows-logon-session-snapshot-helper.exe";

function parseArguments(argv) {
	if (argv.length !== 4) return null;
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!["--helper", "--sha256"].includes(name) || values.has(name) || typeof value !== "string") return null;
		values.set(name, value);
	}
	return values.has("--helper") && values.has("--sha256") ? { helperPath: values.get("--helper"), expectedSha256: values.get("--sha256") } : null;
}

function normalizedWindowsPath(value) {
	return value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

async function inspectHelperFile(helperPath) {
	try {
		const link = await lstat(helperPath);
		const canonicalPath = await realpath(helperPath);
		return {
			exists: true,
			isFile: link.isFile(),
			isSymbolicLink: link.isSymbolicLink(),
			canonicalPathMatches: normalizedWindowsPath(canonicalPath) === normalizedWindowsPath(helperPath),
			size: link.size,
		};
	} catch {
		return { exists: false, isFile: false, isSymbolicLink: false, canonicalPathMatches: false, size: 0 };
	}
}

function hashHelperFile(helperPath) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(helperPath);
		stream.once("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("end", () => resolve(hash.digest("hex")));
	});
}

function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function createSpawnAdapter(helperPath) {
	const controls = new WeakMap();
	function stop(control) {
		const child = controls.get(control);
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		try { child.kill(); } catch {}
	}
	return {
		spawnHelper() {
			const child = spawn(helperPath, [], {
				shell: false,
				windowsHide: true,
				detached: false,
				stdio: ["ignore", "pipe", "pipe"],
				cwd: dirname(helperPath),
			});
			const knownChildControl = {};
			controls.set(knownChildControl, child);
			return { child, knownChildControl };
		},
		requestSoftStopKnownChild: stop,
		forceStopKnownChild: stop,
	};
}

async function waitForIdleWithDeadline({ waitForIdle, requestShutdown, timeoutMs }) {
	let timer = null;
	try {
		return await Promise.race([
			Promise.resolve().then(waitForIdle).then(() => true),
			new Promise((resolve) => { timer = setTimeout(() => { requestShutdown(); resolve(false); }, timeoutMs); }),
		]);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

const parsed = parseArguments(process.argv.slice(2));
if (!parsed || basename(parsed.helperPath).toLowerCase() !== EXPECTED_BASENAME || !win32.isAbsolute(parsed.helperPath)) {
	process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "failed", code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid })}\n`);
	process.exitCode = 2;
} else {
	const adapter = createSpawnAdapter(parsed.helperPath);
	const validator = createWindowsLogonSessionRealValidator({
		platform: process.platform,
		inspectHelperFile,
		hashHelperFile,
		spawnHelper: adapter.spawnHelper,
		scheduleTimer: setTimeout,
		cancelTimer: clearTimeout,
		requestSoftStopKnownChild: adapter.requestSoftStopKnownChild,
		forceStopKnownChild: adapter.forceStopKnownChild,
		hashBytes,
		waitForIdleWithDeadline,
	});
	const result = await validator.validate(parsed);
	if (result.ok) process.stdout.write(`${JSON.stringify({ ...result.summary, status: "passed" })}\n`);
	else {
		process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "failed", code: result.code })}\n`);
		process.exitCode = getWindowsLogonSessionRealValidationExitCode(result.code);
	}
}
