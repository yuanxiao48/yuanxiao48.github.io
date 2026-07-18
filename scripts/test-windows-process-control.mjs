import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
	forceKillWindowsProcessTree,
	resolveTrustedTaskkillPath,
	TASKKILL_OUTPUT_MAX_BYTES,
} from "../shared/windows-process-control.mjs";

class FakeStream extends EventEmitter {
	resume() { this.resumed = true; }
}

class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = new FakeStream();
		this.stderr = new FakeStream();
		this.killed = false;
	}
	kill() { this.killed = true; return true; }
}

const systemRoot = "C:\\Windows";
const trustedExecutable = path.resolve(systemRoot, "System32", "taskkill.exe");
const trustedFile = async () => ({ isFile: () => true, isSymbolicLink: () => false });
const missingFile = async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; };
const afterSpawn = () => new Promise((resolve) => setImmediate(resolve));

const unsupported = await resolveTrustedTaskkillPath({ platform: "linux", systemRoot, lstat: trustedFile });
assert.equal(unsupported.safeErrorCode, "TRANSCODE_FORCE_KILL_UNSUPPORTED");
assert.equal((await resolveTrustedTaskkillPath({ platform: "win32", systemRoot: "", lstat: trustedFile })).safeErrorCode, "TRANSCODE_TASKKILL_PATH_INVALID");
assert.equal((await resolveTrustedTaskkillPath({ platform: "win32", systemRoot: "relative", lstat: trustedFile })).safeErrorCode, "TRANSCODE_TASKKILL_PATH_INVALID");
assert.equal((await resolveTrustedTaskkillPath({ platform: "win32", systemRoot, lstat: missingFile })).safeErrorCode, "TRANSCODE_TASKKILL_NOT_FOUND");
assert.equal((await resolveTrustedTaskkillPath({ platform: "win32", systemRoot, lstat: async () => ({ isFile: () => false, isSymbolicLink: () => false }) })).safeErrorCode, "TRANSCODE_TASKKILL_NOT_FOUND");
assert.equal((await resolveTrustedTaskkillPath({ platform: "win32", systemRoot, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }) })).safeErrorCode, "TRANSCODE_TASKKILL_NOT_TRUSTED");

for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "123"]) {
	let spawned = false;
	const result = await forceKillWindowsProcessTree({ pid: value, platform: "win32", systemRoot, lstat: trustedFile, spawnImpl: () => { spawned = true; } });
	assert.equal(spawned, false);
	assert.equal(result.safeErrorCode, "TRANSCODE_FORCE_KILL_INVALID_PID");
}

const launchFailure = await forceKillWindowsProcessTree({
	pid: 41,
	platform: "win32",
	systemRoot,
	lstat: trustedFile,
	spawnImpl: () => { throw new Error("spawn failed"); },
});
assert.equal(launchFailure.safeErrorCode, "TRANSCODE_TASKKILL_LAUNCH_FAILED");

let received = null;
const closeChild = new FakeChild();
const closeResultPromise = forceKillWindowsProcessTree({
	pid: 42,
	platform: "win32",
	systemRoot,
	lstat: trustedFile,
	spawnImpl: (executable, args, options) => { received = { executable, args, options }; return closeChild; },
});
await afterSpawn();
closeChild.stdout.emit("data", Buffer.alloc(TASKKILL_OUTPUT_MAX_BYTES + 1024));
closeChild.stderr.emit("data", Buffer.alloc(TASKKILL_OUTPUT_MAX_BYTES + 1024));
closeChild.emit("close", 0, null);
const closeResult = await closeResultPromise;
assert.equal(received.executable, trustedExecutable);
assert.deepEqual(received.args, ["/pid", "42", "/t", "/f"]);
assert.equal(received.options.shell, false);
assert.equal(closeResult.exitCode, 0);
assert.equal(closeResult.safeErrorCode, null);

const nonzeroChild = new FakeChild();
const nonzeroPromise = forceKillWindowsProcessTree({ pid: 43, platform: "win32", systemRoot, lstat: trustedFile, spawnImpl: () => nonzeroChild });
await afterSpawn();
nonzeroChild.emit("close", 128, null);
assert.equal((await nonzeroPromise).safeErrorCode, "TRANSCODE_TASKKILL_FAILED");

const errorChild = new FakeChild();
const errorPromise = forceKillWindowsProcessTree({ pid: 44, platform: "win32", systemRoot, lstat: trustedFile, spawnImpl: () => errorChild });
await afterSpawn();
errorChild.emit("error", new Error("spawn failure"));
errorChild.emit("close", 1, null);
assert.equal((await errorPromise).safeErrorCode, "TRANSCODE_TASKKILL_LAUNCH_FAILED");

const timers = [];
const timeoutChild = new FakeChild();
const timeoutPromise = forceKillWindowsProcessTree({
	pid: 45,
	platform: "win32",
	systemRoot,
	lstat: trustedFile,
	spawnImpl: () => timeoutChild,
	setTimeoutImpl: (handler) => { const timer = { handler, cleared: false }; timers.push(timer); return timer; },
	clearTimeoutImpl: (timer) => { timer.cleared = true; },
});
await afterSpawn();
timers[0].handler();
const timeoutResult = await timeoutPromise;
timeoutChild.emit("close", 0, null);
assert.equal(timeoutChild.killed, true);
assert.equal(timeoutResult.timedOut, true);
assert.equal(timeoutResult.safeErrorCode, "TRANSCODE_TASKKILL_TIMEOUT");

for (const result of [closeResult, timeoutResult]) {
	for (const forbidden of ["pid", "path", "command", "args", "stdout", "stderr", "stack"]) assert.equal(Object.hasOwn(result, forbidden), false);
}

console.log("windows-process-control fake tests passed");
