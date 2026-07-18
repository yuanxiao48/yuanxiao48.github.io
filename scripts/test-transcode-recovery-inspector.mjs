import assert from "node:assert/strict";
import path from "node:path";
import {
	TRANSCODE_RECOVERY_OUTPUT_FILENAMES,
	collectRecoverySnapshots,
	createRecoveryCleanupOutcome,
	createRecoveryCleanupPlan,
	createRecoveryHold,
	evaluateRecoverySnapshots,
	inspectRecoveryOutputSnapshot,
	validateRecoveryCleanupCandidate,
} from "../shared/transcode-recovery.mjs";

const oldIso = "2026-07-18T00:00:00.000Z";
const nowMs = Date.parse("2026-07-18T00:10:00.000Z");

function failure(code) {
	const error = new Error(code);
	error.code = code;
	return error;
}

function stats(kind, { dev = 1, ino = 1, size = 1, mtimeMs = nowMs - 180_000, ctimeMs = nowMs - 180_000, birthtimeMs = nowMs - 300_000, bigint = false } = {}) {
	const convert = (value) => bigint ? BigInt(value) : value;
	return {
		dev: convert(dev), ino: convert(ino), size: convert(size), mtimeMs: convert(mtimeMs), ctimeMs: convert(ctimeMs), birthtimeMs: convert(birthtimeMs),
		isFile: () => kind === "file", isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "symlink",
	};
}

function fakeFs(entries) {
	return {
		lstat: async (target) => {
			const value = entries.get(target) ?? entries.get([...entries.keys()].find((key) => key.toLowerCase() === target.toLowerCase()));
			if (value instanceof Error) throw value;
			if (!value) throw failure("ENOENT");
			return value;
		},
		realpath: async (target) => {
			const value = entries.get(`${target}:realpath`);
			if (value instanceof Error) throw value;
			return typeof value === "string" ? value : target;
		},
	};
}

function baseEntries({ file = true } = {}) {
	const entries = new Map();
	entries.set("/job", stats("directory", { ino: 10 }));
	entries.set("/job/output", stats("directory", { ino: 11 }));
	if (file) entries.set("/job/output/output.m4a", stats("file", { ino: 12, size: 44 }));
	return entries;
}

let monotonic = 0;
const snapshot = async (entries) => inspectRecoveryOutputSnapshot({ jobDirectory: "/job", fsApi: fakeFs(entries), pathApi: path.posix, monotonicNowMs: () => monotonic });

assert.deepEqual(TRANSCODE_RECOVERY_OUTPUT_FILENAMES, ["output.partial.m4a", "output.partial.mp3", "output.m4a", "output.mp3"]);
assert.equal(Object.isFrozen(TRANSCODE_RECOVERY_OUTPUT_FILENAMES), true);
assert.throws(() => TRANSCODE_RECOVERY_OUTPUT_FILENAMES.push("other"));

const entries = baseEntries();
const stable = await snapshot(entries);
assert.equal(stable.ok, true);
assert.equal(stable.files["output.m4a"].present, true);
assert.equal(stable.files["output.mp3"].present, false);
assert.equal("path" in stable, false);

entries.set("/job", stats("symlink", { ino: 10 }));
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.set("/job", stats("directory", { ino: 10 }));
entries.set("/job/output/output.m4a", stats("symlink", { ino: 12 }));
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.set("/job/output/output.m4a", stats("directory", { ino: 12 }));
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.set("/job/output/output.m4a", failure("EACCES"));
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED");
entries.set("/job/output/output.m4a", failure("ELOOP"));
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.set("/job/output/output.m4a", stats("file", { ino: 12, size: 44 }));
entries.set("/job/output/output.m4a:realpath", "/outside/output.m4a");
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.delete("/job/output/output.m4a:realpath");
entries.set("/job/output/output.m4a:realpath", "/job2/output/output.m4a");
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.delete("/job/output/output.m4a:realpath");
entries.set("/job/output/output.m4a", stats("file", { ino: 0 }));
assert.equal((await snapshot(entries)).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");
entries.set("/job/output/output.m4a", stats("file", { ino: 12, bigint: true }));
assert.equal((await snapshot(entries)).ok, true);
entries.set("/job/output/output.m4a", stats("file", { ino: 12, size: 44 }));

const windowsEntries = new Map([
	["C:\\job", stats("directory", { ino: 20 })],
	["C:\\job\\output", stats("directory", { ino: 21 })],
	["C:\\job\\output\\output.mp3", stats("file", { ino: 22 })],
]);
const windowsSnapshot = await inspectRecoveryOutputSnapshot({ jobDirectory: "c:\\JOB", fsApi: fakeFs(windowsEntries), pathApi: path.win32, monotonicNowMs: () => 0 });
assert.equal(windowsSnapshot.ok, true);
windowsEntries.set("C:\\job\\output\\output.mp3:realpath", "C:\\job2\\output\\output.mp3");
assert.equal((await inspectRecoveryOutputSnapshot({ jobDirectory: "C:\\job", fsApi: fakeFs(windowsEntries), pathApi: path.win32, monotonicNowMs: () => 0 })).code, "TRANSCODE_RECOVERY_OUTPUT_UNSAFE");

const hold = createRecoveryHold({ nowIso: oldIso });
const snapshots = await collectRecoverySnapshots({
	inspect: async () => stable,
	scheduler: { sleepUntilOffset: async (offset) => { monotonic = offset; } },
	monotonicNowMs: () => monotonic,
});
assert.deepEqual(snapshots.map((item) => item.offsetMs), [0, 2_000, 8_000, 20_000]);
const evaluation = evaluateRecoverySnapshots({ snapshots, hold, holdExistedBeforeStartup: true, startupIdentity: "boot-2", wallNowMs: nowMs });
assert.equal(evaluation.safeToAttemptCleanup, true);

const changed = [...snapshots];
changed[2] = { ...changed[2], files: { ...changed[2].files, "output.m4a": { present: true, identity: { ...changed[2].files["output.m4a"].identity, size: "n:45" } } } };
assert.equal(evaluateRecoverySnapshots({ snapshots: changed, hold, holdExistedBeforeStartup: true, startupIdentity: "boot-2", wallNowMs: nowMs }).code, "TRANSCODE_RECOVERY_OUTPUT_CHANGED");
const directoryChanged = [...snapshots];
directoryChanged[3] = { ...directoryChanged[3], outputDirectory: { present: true, identity: { ...directoryChanged[3].outputDirectory.identity, birthtimeMs: nowMs - 200_000 } } };
assert.equal(evaluateRecoverySnapshots({ snapshots: directoryChanged, hold, holdExistedBeforeStartup: true, startupIdentity: "boot-2", wallNowMs: nowMs }).code, "TRANSCODE_RECOVERY_OUTPUT_CHANGED");
assert.equal(evaluateRecoverySnapshots({ snapshots: snapshots.slice(0, 3), hold, holdExistedBeforeStartup: true, startupIdentity: "boot-2", wallNowMs: nowMs }).code, "TRANSCODE_RECOVERY_OUTPUT_CHECK_FAILED");
const recentEntries = baseEntries();
recentEntries.set("/job/output/output.m4a", stats("file", { ino: 12, mtimeMs: nowMs - 10_000 }));
const recentSnapshot = await snapshot(recentEntries);
assert.equal(evaluateRecoverySnapshots({ snapshots: [recentSnapshot, recentSnapshot, recentSnapshot, recentSnapshot].map((item, index) => ({ ...item, offsetMs: [0, 2000, 8000, 20000][index] })), hold, holdExistedBeforeStartup: true, startupIdentity: "boot-2", wallNowMs: nowMs }).code, "TRANSCODE_RECOVERY_OUTPUT_RECENT");
const futureEntries = baseEntries();
futureEntries.set("/job/output/output.m4a", stats("file", { ino: 12, mtimeMs: nowMs + 1 }));
const futureSnapshot = await snapshot(futureEntries);
assert.equal(evaluateRecoverySnapshots({ snapshots: [futureSnapshot, futureSnapshot, futureSnapshot, futureSnapshot].map((item, index) => ({ ...item, offsetMs: [0, 2000, 8000, 20000][index] })), hold, holdExistedBeforeStartup: true, startupIdentity: "boot-2", wallNowMs: nowMs }).code, "TRANSCODE_RECOVERY_OUTPUT_RECENT");

const absentEntries = baseEntries({ file: false });
const absentSnapshot = await snapshot(absentEntries);
const absentSamples = [0, 2000, 8000, 20000].map((offsetMs) => ({ ...absentSnapshot, offsetMs }));
assert.equal(evaluateRecoverySnapshots({ snapshots: absentSamples, hold, holdExistedBeforeStartup: true, startupIdentity: "boot-3", wallNowMs: nowMs }).safeToAttemptCleanup, true);
assert.equal(evaluateRecoverySnapshots({ snapshots: absentSamples, hold, holdExistedBeforeStartup: false, startupIdentity: "boot-3", wallNowMs: nowMs }).safeToAttemptCleanup, false);

const plan = createRecoveryCleanupPlan(snapshots.at(-1));
assert.throws(() => JSON.stringify(plan));
assert.deepEqual(plan.files.map((item) => item.name), TRANSCODE_RECOVERY_OUTPUT_FILENAMES);
assert.equal(validateRecoveryCleanupCandidate(plan, snapshots.at(-1)).valid, true);
const missingCurrent = { ...snapshots.at(-1), files: { ...snapshots.at(-1).files, "output.m4a": { present: false, identity: null } } };
assert.equal(validateRecoveryCleanupCandidate(plan, missingCurrent).valid, true);
const replacedCurrent = { ...snapshots.at(-1), files: { ...snapshots.at(-1).files, "output.m4a": { present: true, identity: { ...snapshots.at(-1).files["output.m4a"].identity, ino: "n:99" } } } };
assert.equal(validateRecoveryCleanupCandidate(plan, replacedCurrent).valid, false);
assert.equal(validateRecoveryCleanupCandidate(plan, { ...snapshots.at(-1), jobDirectory: { identity: { ...snapshots.at(-1).jobDirectory.identity, ino: "n:999" } } }).valid, false);

assert.deepEqual(createRecoveryCleanupOutcome({ attemptedCount: 4, removedCount: 4 }), { completed: true, partial: false, retainHold: false, warningCode: null });
assert.deepEqual(createRecoveryCleanupOutcome({ attemptedCount: 4, removedCount: 1, stoppedEarly: true }), { completed: false, partial: true, retainHold: true, warningCode: "TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE" });

console.log("transcode recovery inspector tests passed");
