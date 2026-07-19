import assert from "node:assert/strict";
import { createIncompleteUploadRecoveryExecutor } from "../shared/transcode-incomplete-upload-recovery.mjs";
import { getTranscodeRecoveryOperationConflict } from "../shared/transcode-recovery-locks.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const nowIso = "2026-07-18T00:10:00.000Z";

function initialJob(extra = {}) {
	return {
		id: JOB_ID,
		state: "interrupted",
		sourceType: "upload",
		runtime: { attempt: 0 },
		preExecutionRecovery: { version: 1, active: true, code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: "2026-07-18T00:00:00.000Z" },
		...extra,
	};
}

function createHarness({ part = false, final = false, unknown = false, persistFailure = null, removeFailure = null, outputHold = null } = {}) {
	let stored = initialJob(outputHold ? { recoveryHold: outputHold } : {});
	let version = 0;
	let guardCount = 0;
	const candidates = new Set([...(part ? ["part"] : []), ...(final ? ["final"] : [])]);
	const identities = { part: { candidate: "part" }, final: { candidate: "final" } };
	const removed = [];
	const layout = () => ({
		ok: true,
		boundarySafe: true,
		part: candidates.has("part") ? { present: true, trusted: true, identity: identities.part } : { present: false },
		finals: candidates.has("final") ? [{ present: true, trusted: true, identity: identities.final }] : [],
		unknownSourceLikeEntry: unknown,
	});
	const executor = createIncompleteUploadRecoveryExecutor({
		readJob: async () => ({ job: structuredClone(stored), identity: `record-${version}`, generation: 0 }),
		persistJobAtomic: async ({ expectedIdentity, expectedGeneration, nextManifest }) => {
			assert.equal(expectedIdentity, `record-${version}`);
			assert.equal(expectedGeneration, 0);
			if (persistFailure === "prepare" && !stored.incompleteUploadDiscard) return { ok: false };
			if (persistFailure === "finalize" && stored.incompleteUploadDiscard && nextManifest.state === "discarded") return { ok: false };
			stored = structuredClone(nextManifest);
			version += 1;
			return { ok: true };
		},
		inspectIncompleteUploadLayout: async () => layout(),
		removeValidatedUploadCandidate: async ({ jobId, candidateKind, expectedIdentity }) => {
			assert.equal(jobId, JOB_ID);
			assert.equal(["part", "final"].includes(candidateKind), true);
			assert.equal(expectedIdentity, identities[candidateKind]);
			if (removeFailure === candidateKind) return { status: "failed" };
			if (!candidates.has(candidateKind)) return { status: "alreadyAbsent" };
			candidates.delete(candidateKind);
			removed.push(candidateKind);
			return { status: "removed" };
		},
		nowIso: () => nowIso,
		acquireRecoveryGuard: async () => {
			if (guardCount) throw new Error("duplicate");
			guardCount += 1;
			return async () => { guardCount -= 1; };
		},
	});
	return { executor, stored: () => stored, removed, candidates, guardCount: () => guardCount };
}

for (const setup of [
	{ part: true, final: false },
	{ part: false, final: true },
	{ part: true, final: true },
	{ part: false, final: false },
]) {
	const harness = createHarness(setup);
	const outcome = await harness.executor.executeIncompleteUploadSafeDiscard({ jobId: JOB_ID });
	assert.equal(outcome.status, "discardCompleted");
	assert.equal(harness.stored().state, "discarded");
	assert.equal(harness.stored().preExecutionRecovery, undefined);
	assert.equal(harness.stored().incompleteUploadDiscard, undefined);
	assert.equal(harness.guardCount(), 0);
}

{
	const harness = createHarness({ part: true, persistFailure: "prepare" });
	const outcome = await harness.executor.executeIncompleteUploadSafeDiscard({ jobId: JOB_ID });
	assert.equal(outcome.code, "INCOMPLETE_UPLOAD_DISCARD_PREPARE_FAILED");
	assert.equal(harness.removed.length, 0);
	assert.equal(harness.stored().incompleteUploadDiscard, undefined);
}
{
	const harness = createHarness({ part: true, final: true, removeFailure: "final" });
	const outcome = await harness.executor.executeIncompleteUploadSafeDiscard({ jobId: JOB_ID });
	assert.equal(outcome.status, "discardIncomplete");
	assert.equal(outcome.partial, true);
	assert.equal(harness.stored().state, "interrupted");
	assert.equal(harness.stored().incompleteUploadDiscard.active, true);
	assert.deepEqual(harness.removed, ["part"]);
}
{
	const harness = createHarness({ part: true, persistFailure: "finalize" });
	const outcome = await harness.executor.executeIncompleteUploadSafeDiscard({ jobId: JOB_ID });
	assert.equal(outcome.code, "INCOMPLETE_UPLOAD_DISCARD_FINALIZE_FAILED");
	assert.equal(harness.stored().incompleteUploadDiscard.active, true);
	assert.equal(harness.candidates.size, 0);
}
{
	const harness = createHarness({ part: true, unknown: true });
	const outcome = await harness.executor.executeIncompleteUploadSafeDiscard({ jobId: JOB_ID });
	assert.equal(outcome.status, "criticalFailure");
	assert.equal(harness.removed.length, 0);
}
{
	const hold = { version: 1, active: true, code: "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED", detectedAt: nowIso, lastCheckedAt: nowIso, retryAfter: nowIso };
	const harness = createHarness({ part: true, outputHold: hold });
	const outcome = await harness.executor.executeIncompleteUploadSafeDiscard({ jobId: JOB_ID });
	assert.equal(outcome.status, "rejected");
	assert.equal(harness.removed.length, 0);
}

const held = initialJob();
assert.equal(getTranscodeRecoveryOperationConflict(held, "discard").disposition, "reject");
assert.equal(getTranscodeRecoveryOperationConflict(held, "incomplete-upload-safe-discard").disposition, "allow");
assert.equal(getTranscodeRecoveryOperationConflict(initialJob({ recoveryHold: { active: "bad" } }), "incomplete-upload-safe-discard").disposition, "reject");
assert.equal(getTranscodeRecoveryOperationConflict({ ...held, state: "completed" }, "incomplete-upload-safe-discard").disposition, "allow");

console.log("incomplete upload safe discard tests passed");
