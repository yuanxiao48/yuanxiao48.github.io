import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import { spawn } from "node:child_process";
import {
	createWindowsLogonSessionKnownChildControl,
	createWindowsLogonSessionRealValidator,
	getWindowsLogonSessionRealValidationExitCode,
	WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES,
} from "../shared/windows-logon-session-real-validator.mjs";

const EXPECTED_BASENAME = "windows-logon-session-snapshot-helper.exe";

function parseArguments(argv) {
	if (argv.length !== 4) return null;
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index]; const value = argv[index + 1];
		if (![["--helper"], ["--sha256"]].some(([allowed]) => allowed === name) || values.has(name) || typeof value !== "string") return null;
		values.set(name, value);
	}
	return values.has("--helper") && values.has("--sha256") ? { helperPath: values.get("--helper"), expectedSha256: values.get("--sha256") } : null;
}
function normalizedWindowsPath(value) { return value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(); }
function localDrivePath(value) { return typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.startsWith("\\\\") && !value.startsWith("\\\\?\\") && !value.startsWith("\\\\.\\") && /^[A-Za-z]:\\/.test(value); }
async function inspectPath(path, type) {
	try {
		const link = await lstat(path); const canonicalPath = await realpath(path);
		return { exists: true, isFile: type === "file" && link.isFile(), isDirectory: type === "directory" && link.isDirectory(), isSymbolicLink: link.isSymbolicLink(), canonicalPathMatches: normalizedWindowsPath(canonicalPath) === normalizedWindowsPath(path), size: link.size };
	} catch { return { exists: false, isFile: false, isDirectory: false, isSymbolicLink: false, canonicalPathMatches: false, size: 0 }; }
}
async function inspectHelperFile(helperPath) { return inspectPath(helperPath, "file"); }
async function inspectHelperDirectory(directory) {
	const inspection = await inspectPath(directory, "directory");
	if (!inspection.exists) return { ...inspection, entries: [] };
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return { ...inspection, entries: entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() })) };
	} catch { return { ...inspection, entries: [] }; }
}
async function resolveTrustedWorkingDirectory() {
	const systemRoot = process.env.SystemRoot;
	if (!localDrivePath(systemRoot)) return { path: "", exists: false, isDirectory: false, isSymbolicLink: false, canonicalPathMatches: false };
	const path = join(systemRoot, "System32");
	const inspection = await inspectPath(path, "directory");
	return { path, exists: inspection.exists, isDirectory: inspection.isDirectory, isSymbolicLink: inspection.isSymbolicLink, canonicalPathMatches: inspection.canonicalPathMatches };
}
function hashHelperFile(helperPath) {
	return new Promise((resolve, reject) => { const hash = createHash("sha256"); const stream = createReadStream(helperPath); stream.once("error", reject); stream.on("data", (chunk) => hash.update(chunk)); stream.once("end", () => resolve(hash.digest("hex"))); });
}
function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function createSpawnAdapter(helperPath) {
	return {
		spawnHelper(trustedWorkingDirectory) {
			const child = spawn(helperPath, [], { shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"], cwd: trustedWorkingDirectory });
			return { child, knownChildControl: createWindowsLogonSessionKnownChildControl(child) };
		},
	};
}

const parsed = parseArguments(process.argv.slice(2));
if (!parsed || basename(parsed.helperPath).toLowerCase() !== EXPECTED_BASENAME || !win32.isAbsolute(parsed.helperPath)) {
	process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "failed", code: WINDOWS_LOGON_SESSION_REAL_VALIDATION_CODES.helperPathInvalid })}\n`);
	process.exitCode = 2;
} else {
	const adapter = createSpawnAdapter(parsed.helperPath);
	const validator = createWindowsLogonSessionRealValidator({ platform: process.platform, inspectHelperFile, inspectHelperDirectory, resolveTrustedWorkingDirectory, hashHelperFile, spawnHelper: adapter.spawnHelper, scheduleTimer: setTimeout, cancelTimer: clearTimeout, monotonicNow: performance.now.bind(performance), hashBytes });
	const result = await validator.validate(parsed);
	if (result.ok) process.stdout.write(`${JSON.stringify({ ...result.summary, status: "passed" })}\n`);
	else { process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "failed", code: result.code })}\n`); process.exitCode = getWindowsLogonSessionRealValidationExitCode(result.code); }
}
