import assert from "node:assert/strict";
import { createStartupRecoveryContext, createTranscodeRecoveryExecutor } from "../shared/transcode-recovery-executor.mjs";

const ids = [
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
	"55555555-5555-4555-8555-555555555555",
];
const nowIso = "2026-07-18T00:10:00.000Z";
const nowMs = Date.parse(nowIso);
const jobs = new Map([
	[ids[0], { id: ids[0], state: "completed", runtime: { attempt: 1 } }],
	[ids[1], { id: ids[1], state: "transcoding", runtime: { attempt: 1 } }],
	[ids[2], { id: ids[2], state: "queued", runtime: { attempt: 1 } }],
]);
const order = [];
const guards = new Set();
const executor = createTranscodeRecoveryExecutor({
	readJob: async (jobId) => ({ job: structuredClone(jobs.get(jobId)), identity: `record-${jobId}`, generation: 1 }),
	persistJobAtomic: async ({ jobId, nextManifest }) => {
		order.push(`persist:${jobId}`);
		if (jobId === ids[1]) return { ok: false };
		jobs.set(jobId, structuredClone(nextManifest));
		return { ok: true };
	},
	inspectFixedOutputs: async () => ({
		ok: true,
		jobDirectory: { identity: { kind: "directory", dev: "n:1", ino: "n:10", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } },
		outputDirectory: { present: false, identity: null },
		files: {
			"output.partial.m4a": { present: false, identity: null }, "output.partial.mp3": { present: false, identity: null },
			"output.m4a": { present: false, identity: null }, "output.mp3": { present: false, identity: null },
		},
	}),
	removeFixedOutput: async () => ({ status: "alreadyAbsent" }),
	nowIso: () => nowIso,
	wallNowMs: () => nowMs,
	monotonicNowMs: () => 0,
	scheduler: { sleepUntilOffset: async () => {} },
	acquireRecoveryGuard: async (jobId) => {
		assert.equal(guards.has(jobId), false);
		guards.add(jobId);
		order.push(`guard:${jobId}`);
		return async () => { guards.delete(jobId); order.push(`release:${jobId}`); };
	},
});

const context = createStartupRecoveryContext({ startupIdentity: "batch-boot", startupWallTimeMs: nowMs, preexistingHoldJobIds: [] });
const empty = await executor.recoverBatch({ jobIds: [], context });
assert.deepEqual(empty, {
	total: 0, protected: 0, initialHolds: 0, retainedHolds: 0, cleaned: 0, partial: 0, preExecution: 0, sourcePartial: 0, sourceAccess: 0, critical: 0,
	mustBlockListen: false, lockRequiredJobIds: [], items: [],
});

const outcome = await executor.recoverBatch({ jobIds: [ids[0], ids[1], ids[1], ids[2], "not-a-job-id"], context });
assert.equal(outcome.total, 4);
assert.equal(outcome.protected, 1);
assert.equal(outcome.initialHolds, 0);
assert.equal(outcome.preExecution, 0);
assert.equal(outcome.sourcePartial, 0);
assert.equal(outcome.sourceAccess, 0);
assert.equal(outcome.critical, 2);
assert.equal(outcome.mustBlockListen, true);
assert.equal(outcome.items.some((item) => "path" in item), false);
assert.equal(Object.isFrozen(outcome), true);
assert.equal(Object.isFrozen(outcome.items), true);
assert.equal(guards.size, 0);
assert.deepEqual(order, [
	`guard:${ids[0]}`, `release:${ids[0]}`,
	`guard:${ids[1]}`, `persist:${ids[1]}`, `release:${ids[1]}`,
	`guard:${ids[2]}`, `persist:${ids[2]}`, `release:${ids[2]}`,
]);
assert.equal(jobs.get(ids[2]).state, "ready");

{
	const heldIds = ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"];
	const heldJobs = new Map(heldIds.map((id) => [id, {
		id,
		state: "interrupted",
		runtime: { attempt: 0 },
		recoveryHold: { version: 1, active: true, code: "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED", detectedAt: "2026-07-18T00:00:00.000Z", lastCheckedAt: "2026-07-18T00:00:00.000Z", retryAfter: "2026-07-18T00:00:00.000Z" },
	}]));
	const sessions = [];
	const heldExecutor = createTranscodeRecoveryExecutor({
		readJob: async (jobId) => ({ job: structuredClone(heldJobs.get(jobId)), identity: `held-${jobId}`, generation: 0 }),
		persistJobAtomic: async ({ jobId, nextManifest }) => { heldJobs.set(jobId, structuredClone(nextManifest)); return { ok: true }; },
		inspectFixedOutputs: async () => ({
			ok: true,
			jobDirectory: { identity: { kind: "directory", dev: "n:1", ino: "n:10", mtimeMs: nowMs - 180_000, ctimeMs: nowMs - 180_000, birthtimeMs: nowMs - 300_000 } },
			outputDirectory: { present: false, identity: null },
			files: {
				"output.partial.m4a": { present: false, identity: null }, "output.partial.mp3": { present: false, identity: null },
				"output.m4a": { present: false, identity: null }, "output.mp3": { present: false, identity: null },
			},
		}),
		removeFixedOutput: async () => ({ status: "alreadyAbsent" }),
		nowIso: () => nowIso,
		wallNowMs: () => nowMs,
		monotonicNowMs: () => 0,
		createSchedulerSession: () => {
			const offsets = [];
			sessions.push(offsets);
			return { sleepUntilOffset: async (offset) => { offsets.push(offset); }, dispose() {} };
		},
		acquireRecoveryGuard: async () => async () => {},
	});
	const heldContext = createStartupRecoveryContext({ startupIdentity: "held-batch", startupWallTimeMs: nowMs, preexistingHoldJobIds: heldIds });
	const heldResult = await heldExecutor.recoverBatch({ jobIds: heldIds, context: heldContext });
	assert.equal(heldResult.items.length, 2);
	assert.deepEqual(sessions, [[0, 2_000, 8_000, 20_000], [0, 2_000, 8_000, 20_000]]);
}

console.log("transcode recovery batch tests passed");
