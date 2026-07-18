import assert from "node:assert/strict";
import { TRANSCODE_RECOVERY_OUTPUT_FILENAMES, createRecoveryHold } from "../shared/transcode-recovery.mjs";
import { createStartupRecoveryContext, createTranscodeRecoveryExecutor } from "../shared/transcode-recovery-executor.mjs";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const nowIso = "2026-07-18T00:10:00.000Z";
const nowMs = Date.parse(nowIso);
const oldIso = "2026-07-18T00:00:00.000Z";

function makeSnapshot(present, { changed = false } = {}) {
	const files = {};
	for (const [index, name] of TRANSCODE_RECOVERY_OUTPUT_FILENAMES.entries()) {
		files[name] = present.has(name)
			? { present: true, identity: { kind: "file", dev: "n:1", ino: `n:${changed ? index + 90 : index + 30}`, size: "n:4", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } }
			: { present: false, identity: null };
	}
	return {
		ok: true,
		jobDirectory: { identity: { kind: "directory", dev: "n:1", ino: "n:10", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } },
		outputDirectory: { present: true, identity: { kind: "directory", dev: "n:1", ino: "n:11", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } },
		files,
	};
}

function build({ preflightChanged = false, failAt = null, clearPersistFails = false, generationChangesAfterSampling = false, completedAfterSampling = false } = {}) {
	const present = new Set(TRANSCODE_RECOVERY_OUTPUT_FILENAMES);
	let job = { id: JOB_ID, state: "interrupted", runtime: { attempt: 2 }, recoveryHold: createRecoveryHold({ nowIso: oldIso }), sourceType: "upload" };
	let persistCount = 0;
	let removeCount = 0;
	let inspectCount = 0;
	let readCount = 0;
	const removed = [];
	const executor = createTranscodeRecoveryExecutor({
		readJob: async () => {
			readCount += 1;
			const latest = completedAfterSampling && readCount >= 2 ? { ...job, state: "completed" } : job;
			return { job: structuredClone(latest), identity: "record-b", generation: generationChangesAfterSampling && readCount >= 2 ? 3 : 2 };
		},
		persistJobAtomic: async ({ nextManifest }) => {
			persistCount += 1;
			if (clearPersistFails && !Object.hasOwn(nextManifest, "recoveryHold")) return { ok: false };
			job = structuredClone(nextManifest);
			return { ok: true };
		},
		inspectFixedOutputs: async () => {
			inspectCount += 1;
			return makeSnapshot(present, { changed: preflightChanged && inspectCount === 5 });
		},
		removeFixedOutput: async ({ basename }) => {
			removeCount += 1;
			assert.equal(TRANSCODE_RECOVERY_OUTPUT_FILENAMES.includes(basename), true);
			if (failAt === removeCount) throw new Error("fake remove failure");
			present.delete(basename);
			removed.push(basename);
			return { status: "removed" };
		},
		nowIso: () => nowIso,
		wallNowMs: () => nowMs,
		monotonicNowMs: () => 0,
		scheduler: { sleepUntilOffset: async () => {} },
		acquireRecoveryGuard: async () => async () => {},
	});
	return { executor, stored: () => job, removed, removeCount: () => removeCount, persistCount: () => persistCount };
}

const context = createStartupRecoveryContext({ startupIdentity: "cleanup-boot", startupWallTimeMs: nowMs, preexistingHoldJobIds: [JOB_ID] });
{
	const harness = build();
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context });
	assert.equal(outcome.status, "cleanupCompleted");
	assert.equal(outcome.lockReleaseAllowed, true);
	assert.deepEqual(harness.removed, TRANSCODE_RECOVERY_OUTPUT_FILENAMES);
	assert.equal(harness.stored().recoveryHold, undefined);
}

{
	const harness = build({ preflightChanged: true });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context });
	assert.equal(outcome.status, "holdRetained");
	assert.equal(outcome.cleanupAttempted, false);
	assert.equal(harness.removeCount(), 0);
	assert.equal(harness.stored().recoveryHold.active, true);
}

{
	const harness = build({ failAt: 2 });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context });
	assert.equal(outcome.status, "cleanupIncomplete");
	assert.equal(outcome.cleanupCompleted, false);
	assert.equal(outcome.lockReleaseAllowed, false);
	assert.deepEqual(harness.removed, ["output.partial.m4a"]);
	assert.equal(harness.stored().recoveryWarning.code, "TRANSCODE_RECOVERY_OUTPUT_CLEANUP_INCOMPLETE");
}

{
	const harness = build({ clearPersistFails: true });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context });
	assert.equal(outcome.status, "criticalFailure");
	assert.equal(outcome.mustBlockListen, true);
	assert.equal(outcome.lockReleaseAllowed, false);
	assert.equal(harness.stored().recoveryHold.active, true);
}

{
	const harness = build({ generationChangesAfterSampling: true });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context });
	assert.equal(outcome.status, "criticalFailure");
	assert.equal(outcome.mustBlockListen, true);
	assert.equal(harness.removeCount(), 0);
}

{
	const harness = build({ completedAfterSampling: true });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context });
	assert.equal(outcome.status, "terminalProtected");
	assert.equal(harness.removeCount(), 0);
}

console.log("transcode recovery cleanup tests passed");
