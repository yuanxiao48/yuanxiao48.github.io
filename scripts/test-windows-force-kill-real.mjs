import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { forceKillWindowsProcessTree } from "../shared/windows-process-control.mjs";

if (process.platform !== "win32") {
	console.log("SKIP: Windows-only force-kill verification.");
	process.exit(0);
}

const keepAlive = "setInterval(() => {}, 1000); process.stdin?.resume();";
const parentSource = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(keepAlive)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  child.once("spawn", () => process.send?.({ type: "descendant-ready", pid: child.pid }));
  setInterval(() => {}, 1000);
`;

function waitForMessage(child, type, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for the controlled test process")), timeoutMs);
		const onMessage = (message) => {
			if (message?.type !== type) return;
			clearTimeout(timer);
			child.removeListener("message", onMessage);
			resolve(message);
		};
		child.on("message", onMessage);
	});
}

async function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

console.log("Test start");
let parent = null;
let descendantPid = null;
try {
	parent = spawn(process.execPath, ["-e", parentSource], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	const parentClosed = once(parent, "close");
	const ready = await waitForMessage(parent, "descendant-ready");
	descendantPid = ready.pid;
	assert(Number.isSafeInteger(parent.pid) && parent.pid > 0);
	assert(Number.isSafeInteger(descendantPid) && descendantPid > 0);
	console.log("Controlled parent and child tree established");

	const result = await forceKillWindowsProcessTree({ pid: parent.pid, timeoutMs: 5000 });
	assert.equal(result.attempted, true);
	assert.equal("pid" in result, false);
	assert.equal("path" in result, false);
	assert.equal("stdout" in result, false);
	assert.equal("stderr" in result, false);
	console.log("Force stop requested");

	await Promise.race([
		parentClosed,
		new Promise((_, reject) => setTimeout(() => reject(new Error("Controlled parent did not close")), 8000)),
	]);
	console.log("Parent process closed");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(await isAlive(descendantPid), false);
	console.log("Descendant process closed");
	console.log("PASS");
} catch (error) {
	console.error(`FAIL: ${error?.message || "controlled force-kill verification failed"}`);
	process.exitCode = 1;
} finally {
	if (parent?.pid && await isAlive(parent.pid)) await forceKillWindowsProcessTree({ pid: parent.pid, timeoutMs: 5000 }).catch(() => {});
	if (descendantPid && await isAlive(descendantPid)) {
		try { process.kill(descendantPid); } catch { /* Controlled descendant is already gone. */ }
	}
}
