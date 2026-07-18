import assert from "node:assert/strict";
import { TRANSCODE_RECOVERY_OUTPUT_FILENAMES } from "../shared/transcode-recovery.mjs";
import { createStartupRecoveryContext, createTranscodeRecoveryExecutor } from "../shared/transcode-recovery-executor.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";
const nowIso = "2026-07-18T00:10:00.000Z";
const nowMs = Date.parse(nowIso);

function makeJob(state, extra = {}) {
	return {
		id: jobId,
		state,
		sourceType: "upload",
		runtime: { attempt: 0, queuedAt: null, startedAt: null, finishedAt: null },
		...extra,
	};
}

function makeSnapshot(present = []) {
	const files = {};
	for (const [index, name] of TRANSCODE_RECOVERY_OUTPUT_FILENAMES.entries()) {
		files[name] = present.includes(name)
			? { present: true, identity: { kind: "file", dev: "n:1", ino: `n:${index + 1}`, size: "n:1", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 180_000 } }
			: { present: false, identity: null };
	}
	return {
		ok: true,
		jobDirectory: { identity: { kind: "directory", dev: "n:1", ino: "n:20", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 180_000 } },
		outputDirectory: { present: true, identity: { kind: "directory", dev: "n:1", ino: "n:21", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 180_000 } },
		files,
	};
}

function harness(initial, present = []) {
	let stored = structuredClone(initial);
	const offsets = [];
	const removed = [];
	const executor = createTranscodeRecoveryExecutor({
		readJob: async () => ({ job: structuredClone(stored), identity: "record", generation: 0 }),
		persistJobAtomic: async ({ nextManifest }) => { stored = structuredClone(nextManifest); return { ok: true }; },
		inspectFixedOutputs: async () => makeSnapshot(present),
		removeFixedOutput: async ({ basename }) => { removed.push(basename); return { status: "removed" }; },
		nowIso: () => nowIso,
		wallNowMs: () => nowMs,
		monotonicNowMs: () => 0,
		scheduler: { sleepUntilOffset: async (offset) => { offsets.push(offset); } },
		acquireRecoveryGuard: async () => async () => {},
	});
	return { executor, stored: () => stored, offsets, removed };
}

const context = createStartupRecoveryContext({ startupIdentity: "startup", startupWallTimeMs: nowMs, preexistingHoldJobIds: [] });

{
	const test = harness(makeJob("uploading", { sourceStoredFilename: null }), ["output.partial.m4a"]);
	const outcome = await test.executor.recoverJob({ jobId, context });
	assert.equal(outcome.status, "preExecutionRecoveryRequired");
	assert.equal(outcome.sourcePartialRecoveryRequired, true);
	assert.equal(test.stored().recoveryHold.active, true);
	assert.equal(test.stored().preExecutionRecovery.code, "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD");
	assert.deepEqual(test.removed, []);
	const later = await test.executor.recoverJob({ jobId, context });
	assert.equal(later.status, "preExecutionRecoveryRequired");
	assert.deepEqual(test.offsets, []);
	assert.deepEqual(test.removed, []);
}

{
	const test = harness(makeJob("probing", { sourceType: "library", sourcePublicPath: "/assets/audio/source.m4a" }));
	const outcome = await test.executor.recoverJob({ jobId, context });
	assert.equal(outcome.status, "preExecutionRecoveryRequired");
	assert.equal(outcome.sourceAccessRecoveryRequired, true);
	assert.equal(test.stored().recoveryHold, undefined);
	assert.equal(test.stored().preExecutionRecovery.code, "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED");
	assert.deepEqual(test.offsets, []);
}

{
	const test = harness(makeJob("creating", { sourceType: "library", sourcePublicPath: "/assets/audio/source.m4a" }), ["output.m4a"]);
	const outcome = await test.executor.recoverJob({ jobId, context });
	assert.equal(outcome.status, "initialHoldPersisted");
	assert.equal(test.stored().state, "interrupted");
	assert.equal(test.stored().recoveryHold.active, true);
	assert.equal(test.stored().preExecutionRecovery, undefined);
	assert.deepEqual(test.removed, []);
}

console.log("transcode pre-execution recovery tests passed");
