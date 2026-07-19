import assert from "node:assert/strict";
import {
	createTranscodeStartupRecoveryOrchestrator,
	withFinalRecoverySnapshots,
} from "../shared/transcode-recovery-startup-adapter.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
let reads = 0;
let discovery = 0;
const events = [];
const orchestrator = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => { discovery += 1; return [JOB_ID]; },
	readJob: async () => {
		reads += 1;
		events.push(`read:${reads}`);
		return { job: { id: JOB_ID, state: reads === 1 ? "queued" : "ready", runtime: { attempt: 0 }, sourceType: "upload" }, identity: `identity-${reads}`, generation: 0 };
	},
	createStartupIdentity: () => "opaque-startup",
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
	createExecutor: () => ({
		recoverBatch: async () => {
			events.push("batch");
			assert.equal(reads, 1);
			return { total: 1, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, preExecution: 0, sourcePartial: 0, sourceAccess: 0, critical: 0, mustBlockListen: false };
		},
	}),
});
assert.throws(() => orchestrator.getFinalSnapshotCollection());
const [one, two] = await Promise.all([orchestrator.run(), orchestrator.run()]);
assert.equal(one, two);
assert.equal(one.finalSnapshotReady, true);
assert.equal("canListen" in one, false);
assert.equal(discovery, 1);
assert.equal(reads, 2);
assert.deepEqual(events, ["read:1", "batch", "read:2"]);
const collection = orchestrator.getFinalSnapshotCollection();
assert.equal(JSON.stringify(collection).includes(JOB_ID), false);
assert.equal(JSON.stringify(collection).includes("identity"), false);
assert.throws(() => withFinalRecoverySnapshots({}, () => {}));
assert.equal(withFinalRecoverySnapshots(collection, (snapshots) => {
	assert.equal(Object.isFrozen(snapshots), true);
	assert.equal(snapshots[0].job.state, "ready");
	assert.equal(Object.isFrozen(snapshots[0].job), true);
	assert.throws(() => { snapshots[0].job.state = "failed"; }, TypeError);
	return snapshots.length;
}), 1);
assert.equal((await orchestrator.run()), one);
assert.equal(reads, 2);

const blocked = createTranscodeStartupRecoveryOrchestrator({
	discoverJobIds: async () => [JOB_ID],
	readJob: async () => ({ job: { id: JOB_ID, state: "ready", runtime: { attempt: 0 } }, identity: "identity", generation: 0 }),
	wallNowMs: () => 1,
	monotonicNowMs: () => 0,
	createExecutor: () => ({ recoverBatch: async () => ({ total: 1, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, critical: 1, mustBlockListen: true }) }),
});
assert.equal((await blocked.run()).mustBlockListen, true);
assert.throws(() => blocked.getFinalSnapshotCollection());

console.log("transcode recovery final snapshot tests passed");
