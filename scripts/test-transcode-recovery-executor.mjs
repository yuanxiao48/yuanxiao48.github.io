import assert from "node:assert/strict";
import {
	TRANSCODE_RECOVERY_OUTPUT_FILENAMES,
	createRecoveryHold,
} from "../shared/transcode-recovery.mjs";
import {
	createStartupRecoveryContext,
	createTranscodeRecoveryExecutor,
} from "../shared/transcode-recovery-executor.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const nowIso = "2026-07-18T00:10:00.000Z";
const oldIso = "2026-07-18T00:00:00.000Z";
const nowMs = Date.parse(nowIso);

function job(state, extra = {}) {
	return {
		id: JOB_ID,
		state,
		runtime: { queuedAt: "2026-07-18T00:01:00.000Z", startedAt: "2026-07-18T00:02:00.000Z", finishedAt: null, attempt: 3 },
		updatedAt: oldIso,
		sourceType: "upload",
		...extra,
	};
}

function snapshot({ present = [] } = {}) {
	const files = {};
	for (const [index, name] of TRANSCODE_RECOVERY_OUTPUT_FILENAMES.entries()) {
		files[name] = present.includes(name)
			? { present: true, identity: { kind: "file", dev: "n:1", ino: `n:${index + 30}`, size: "n:4", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } }
			: { present: false, identity: null };
	}
	return {
		ok: true,
		jobDirectory: { identity: { kind: "directory", dev: "n:1", ino: "n:10", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } },
		outputDirectory: { present: true, identity: { kind: "directory", dev: "n:1", ino: "n:11", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } },
		files,
	};
}

function createHarness(initialJob, { initialPresent = [], persistFails = false } = {}) {
	let stored = structuredClone(initialJob);
	let persistCount = 0;
	let guardCount = 0;
	const offsets = [];
	const removed = [];
	const present = new Set(initialPresent);
	const deps = {
		readJob: async () => ({ job: structuredClone(stored), identity: "record-a", generation: 3 }),
		persistJobAtomic: async ({ expectedIdentity, expectedGeneration, nextManifest }) => {
			persistCount += 1;
			assert.equal(expectedIdentity, "record-a");
			assert.equal(expectedGeneration, 3);
			if (persistFails) return { ok: false };
			stored = structuredClone(nextManifest);
			return { ok: true };
		},
		inspectFixedOutputs: async () => snapshot({ present: [...present] }),
		removeFixedOutput: async ({ basename }) => {
			assert.equal(TRANSCODE_RECOVERY_OUTPUT_FILENAMES.includes(basename), true);
			removed.push(basename);
			present.delete(basename);
			return { status: "removed" };
		},
		nowIso: () => nowIso,
		wallNowMs: () => nowMs,
		monotonicNowMs: () => offsets.at(-1) ?? 0,
		scheduler: { sleepUntilOffset: async (offset) => { offsets.push(offset); } },
		acquireRecoveryGuard: async () => {
			guardCount += 1;
			return async () => { guardCount -= 1; };
		},
	};
	return { executor: createTranscodeRecoveryExecutor(deps), getStored: () => stored, persistCount: () => persistCount, offsets, removed, guardCount: () => guardCount };
}

const newContext = createStartupRecoveryContext({ startupIdentity: "boot-new", startupWallTimeMs: nowMs, preexistingHoldJobIds: [] });
{
	const harness = createHarness(job("transcoding"), { initialPresent: ["output.m4a"] });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "initialHoldPersisted");
	assert.equal(outcome.holdActive, true);
	assert.equal(outcome.lockRequired, true);
	assert.equal(harness.getStored().state, "interrupted");
	assert.equal(harness.getStored().recoveryHold.detectedAt, nowIso);
	assert.equal(Date.parse(harness.getStored().recoveryHold.retryAfter) - nowMs, 120_000);
	assert.equal(harness.getStored().runtime.queuedAt, null);
	assert.equal(harness.getStored().runtime.startedAt, null);
	assert.equal(harness.getStored().runtime.finishedAt, nowIso);
	assert.equal(harness.removed.length, 0);
	assert.equal(harness.guardCount(), 0);
	const sameStart = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(sameStart.status, "holdRetained");
	assert.equal(harness.offsets.length, 0);
}

{
	const harness = createHarness(job("creating", { sourceStoredFilename: "source-11111111-1111-4111-8111-111111111111.m4a" }));
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "preExecutionInterruptionRequired");
	assert.equal(harness.getStored().recoveryHold, undefined);
	assert.equal(harness.getStored().preExecutionRecovery, undefined);
	assert.equal(harness.getStored().sourceStoredFilename, "source-11111111-1111-4111-8111-111111111111.m4a");
	assert.equal(harness.removed.length, 0);
}

for (const [state, code, field] of [
	["uploading", "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", "sourcePartialRecoveryRequired"],
	["probing", "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", "sourceAccessRecoveryRequired"],
]) {
	const harness = createHarness(job(state, { sourceStoredFilename: "source-11111111-1111-4111-8111-111111111111.m4a" }));
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "preExecutionRecoveryRequired");
	assert.equal(outcome[field], true);
	assert.equal(harness.getStored().preExecutionRecovery.code, code);
	assert.equal(harness.getStored().recoveryHold, undefined);
	assert.equal(harness.getStored().sourceStoredFilename, "source-11111111-1111-4111-8111-111111111111.m4a");
	assert.equal(harness.removed.length, 0);
}

{
	const harness = createHarness(job("queued"));
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "queuedRecoveryRequired");
	assert.equal(harness.getStored().state, "ready");
	assert.equal(harness.getStored().runtime.queuedAt, null);
	assert.equal(harness.getStored().recoveryHold, undefined);
}

{
	const harness = createHarness(job("queued"), { initialPresent: ["output.partial.m4a"] });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "initialHoldPersisted");
	assert.equal(harness.getStored().state, "interrupted");
}

{
	const harness = createHarness(job("transcoding"), { persistFails: true });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "criticalFailure");
	assert.equal(outcome.mustBlockListen, true);
	assert.equal(harness.removed.length, 0);
}

{
	const harness = createHarness(job("completed", { completionCommitted: undefined, recoveryHold: { active: "bad" } }));
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "terminalProtected");
	assert.equal(harness.persistCount(), 0);
}

{
	const harness = createHarness(job("interrupted"));
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "noAction");
	assert.equal(harness.persistCount(), 0);
}

{
	const harness = createHarness(job("completed"));
	const failingExecutor = createTranscodeRecoveryExecutor({
		readJob: async () => ({ job: job("completed"), identity: "record-a", generation: 3 }),
		persistJobAtomic: async () => ({ ok: true }),
		inspectFixedOutputs: async () => snapshot(),
		removeFixedOutput: async () => ({ status: "alreadyAbsent" }),
		nowIso: () => nowIso,
		wallNowMs: () => nowMs,
		monotonicNowMs: () => 0,
		scheduler: { sleepUntilOffset: async () => {} },
		acquireRecoveryGuard: async () => async () => { throw new Error("release failed"); },
	});
	const outcome = await failingExecutor.recoverJob({ jobId: JOB_ID, context: newContext });
	assert.equal(outcome.status, "criticalFailure");
	assert.equal(outcome.mustBlockListen, true);
	assert.equal(harness.guardCount(), 0);
}

{
	const held = job("interrupted", { recoveryHold: createRecoveryHold({ nowIso: oldIso }) });
	const harness = createHarness(held);
	const oldContext = createStartupRecoveryContext({ startupIdentity: "boot-next", startupWallTimeMs: nowMs, preexistingHoldJobIds: [JOB_ID] });
	const outcome = await harness.executor.recoverJob({ jobId: JOB_ID, context: oldContext });
	assert.equal(outcome.status, "cleanupCompleted");
	assert.equal(outcome.cleanupCompleted, true);
	assert.equal(outcome.lockReleaseAllowed, true);
	assert.equal(harness.getStored().recoveryHold, undefined);
	assert.deepEqual(harness.offsets, [0, 2_000, 8_000, 20_000]);
}

console.log("transcode recovery executor tests passed");
