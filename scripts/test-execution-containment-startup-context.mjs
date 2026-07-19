import assert from "node:assert/strict";
import { createTranscodeStartupRecoveryOrchestrator } from "../shared/transcode-recovery-startup-adapter.mjs";
import { createHostExecutionContainmentComparisonAuthority } from "../shared/host-execution-containment-comparison.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "a".repeat(64) };
const authority = createHostExecutionContainmentComparisonAuthority();
const state = authority.genericStartupStateIssuer.createStartupState({ currentWitness: witness }).startupState;
let providerCalls = 0;
let contexts = 0;
const orchestrator = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [id],
	readJob: async () => ({ job: { id, state: "ready", runtime: { attempt: 0 } }, identity: "id", generation: 0 }),
	createExecutor: () => ({ recoverBatch: async ({ context }) => { contexts += 1; assert.equal(context.getExecutionContainmentStartupState(), state); assert.equal(JSON.stringify(context).includes("fake-boot"), false); return { total: 1, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, critical: 0, mustBlockListen: false }; } }),
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
	getExecutionContainmentStartupState: async () => { providerCalls += 1; return state; },
});
await Promise.all([orchestrator.run(), orchestrator.run()]);
assert.equal(providerCalls, 1);
assert.equal(contexts, 1);
const conflict = createTranscodeStartupRecoveryOrchestrator({ discoverJobIds: async () => [], readJob: async () => null, createExecutor: () => ({ recoverBatch: async () => ({}) }), wallNowMs: () => 1, monotonicNowMs: () => 0, getExecutionContainmentStartupState: async () => state, getStartupSourceAccessWitness: async () => null });
assert.equal((await conflict.run()).mustBlockListen, true);
console.log("execution containment startup context tests passed");
