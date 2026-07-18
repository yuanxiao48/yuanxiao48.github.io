import assert from "node:assert/strict";
import { createTranscodeStartupRecoveryOrchestrator } from "../shared/transcode-recovery-startup-adapter.mjs";

const heldId = "11111111-1111-4111-8111-111111111111";
const normalId = "22222222-2222-4222-8222-222222222222";
function job(id, state, recoveryHold = null) {
	return { id, state, runtime: { attempt: 0 }, recoveryHold };
}

let discoveryCalls = 0;
let reads = 0;
let executorCalls = 0;
const events = [];
const orchestrator = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => { discoveryCalls += 1; return [heldId, normalId]; },
	readJob: async (id) => {
		reads += 1;
		events.push(`read:${id}`);
		return {
			job: id === heldId
				? job(id, "interrupted", { version: 1, active: true, code: "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED", detectedAt: "2026-07-18T00:00:00.000Z", lastCheckedAt: "2026-07-18T00:00:00.000Z", retryAfter: "2026-07-18T00:02:00.000Z" })
				: job(id, "ready"),
			identity: `identity-${id}`,
			generation: 0,
		};
	},
	createStartupIdentity: () => "startup-test",
	wallNowMs: () => Date.parse("2026-07-18T00:05:00.000Z"),
	monotonicNowMs: () => 0,
	createExecutor: () => ({
		recoverBatch: async ({ jobIds, context }) => {
			executorCalls += 1;
			events.push("batch");
			assert.equal(reads, 2);
			assert.equal(context.hasPreexistingHold(heldId), true);
			assert.equal(context.hasPreexistingHold(normalId), false);
			assert.deepEqual(jobIds, [heldId, normalId]);
			return { total: 2, protected: 0, initialHolds: 0, retainedHolds: 1, cleaned: 0, partial: 0, critical: 0, mustBlockListen: false };
		},
	}),
});
const [first, second] = await Promise.all([orchestrator.run(), orchestrator.run()]);
assert.equal(first, second);
assert.equal(first.status, "degradedHeldJobs");
assert.equal(first.requiresLockPlanning, true);
assert.equal("canListen" in first, false);
assert.equal(JSON.stringify(first).includes("startup-test"), false);
assert.equal(discoveryCalls, 1);
assert.equal(executorCalls, 1);
assert.deepEqual(events, [`read:${heldId}`, `read:${normalId}`, "batch"]);

const blocked = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [heldId],
	readJob: async () => { throw new Error("manifest unreadable"); },
	createExecutor: () => { throw new Error("must not execute"); },
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
});
const blockedResult = await blocked.run();
assert.equal(blockedResult.status, "blockedBeforeRecovery");
assert.equal(blockedResult.mustBlockListen, true);

const completed = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [heldId],
	readJob: async () => ({ job: job(heldId, "completed", { active: "malformed" }), identity: "record", generation: 0 }),
	createExecutor: () => ({ recoverBatch: async ({ context }) => {
		assert.equal(context.hasPreexistingHold(heldId), false);
		return { total: 1, protected: 1, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, critical: 0, mustBlockListen: false };
	} }),
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
});
assert.equal((await completed.run()).status, "terminalOnly");

const sourceRecovery = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [heldId],
	readJob: async () => ({ job: job(heldId, "interrupted", { preExecutionRecovery: { version: 1, active: true, code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: "2026-07-18T00:00:00.000Z" } }), identity: "record", generation: 0 }),
	createExecutor: () => ({ recoverBatch: async () => ({ total: 1, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, preExecution: 1, sourcePartial: 1, sourceAccess: 0, critical: 0, mustBlockListen: false }) }),
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
});
const sourceResult = await sourceRecovery.run();
assert.equal(sourceResult.status, "degradedHeldJobs");
assert.equal(sourceResult.batchResult.sourcePartial, 1);
assert.equal(sourceResult.batchResult.sourceAccess, 0);

console.log("transcode recovery startup orchestration tests passed");
