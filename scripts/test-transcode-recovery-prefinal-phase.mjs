import assert from "node:assert/strict";
import { normalizeHostBootSessionWitness } from "../shared/host-boot-session-witness.mjs";
import { createPreExecutionRecovery } from "../shared/transcode-recovery.mjs";
import {
	createSourceAccessRecoveryPreFinalPhase,
	createSourceAccessRecoveryResolver,
} from "../shared/transcode-source-access-recovery.mjs";
import {
	createTranscodeStartupRecoveryOrchestrator,
	withFinalRecoverySnapshots,
} from "../shared/transcode-recovery-startup-adapter.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";
const witness = normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: "d".repeat(64) }).witness;
let stored = {
	id: jobId,
	state: "interrupted",
	sourceType: "library",
	sourcePublicPath: "/assets/a.m4a",
	runtime: { attempt: 0 },
	preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: "2026-07-19T00:00:00.000Z" }),
};
const events = [];
const resolver = createSourceAccessRecoveryResolver({
	persistManifestCas: async ({ nextManifest }) => { events.push("persist"); stored = structuredClone(nextManifest); return { ok: true }; },
	validateSourceAccessSource: () => ({ ok: true, sourceType: "library" }),
	nowIso: () => "2026-07-19T00:00:00.000Z",
});
const phase = createSourceAccessRecoveryPreFinalPhase({
	readJob: async () => ({ job: structuredClone(stored), identity: "identity", generation: 0 }),
	resolver,
});
let reads = 0;
const orchestrator = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [jobId],
	readJob: async () => {
		reads += 1;
		events.push(`read:${reads}`);
		return { job: structuredClone(stored), identity: `identity-${reads}`, generation: 0 };
	},
	createStartupIdentity: () => "startup",
	getStartupSourceAccessWitness: async () => witness,
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
	createExecutor: () => ({ recoverBatch: async () => { events.push("batch"); return { total: 1, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, preExecution: 1, sourcePartial: 0, sourceAccess: 1, critical: 0, mustBlockListen: false }; } }),
	runPreFinalRecoveryPhases: (input) => phase.run(input),
});
const [first, second] = await Promise.all([orchestrator.run(), orchestrator.run()]);
assert.equal(first, second);
assert.equal(first.finalSnapshotReady, true);
assert.equal(first.preFinalResult.sourceAccessWitnessRecordedCount, 1);
assert.deepEqual(events, ["read:1", "batch", "persist", "read:2"]);
assert.equal(reads, 2);
const collection = orchestrator.getFinalSnapshotCollection();
assert.equal(withFinalRecoverySnapshots(collection, (snapshots) => snapshots[0].job.preExecutionRecovery.version), 2);
assert.equal(JSON.stringify(first).includes("/assets"), false);
assert.equal(JSON.stringify(first).includes("d".repeat(64)), false);

const blocked = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [jobId],
	readJob: async () => ({ job: { id: jobId, state: "ready", runtime: { attempt: 0 } }, identity: "identity", generation: 0 }),
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
	createExecutor: () => ({ recoverBatch: async () => ({ total: 1, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, preExecution: 0, sourcePartial: 0, sourceAccess: 0, critical: 0, mustBlockListen: false }) }),
	runPreFinalRecoveryPhases: async () => ({ mustBlockListen: true, criticalCount: 1, sourceAccessCriticalCount: 1 }),
});
assert.equal((await blocked.run()).mustBlockListen, true);
assert.throws(() => blocked.getFinalSnapshotCollection());

console.log("transcode recovery pre-final phase tests passed");
