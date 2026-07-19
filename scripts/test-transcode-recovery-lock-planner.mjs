import assert from "node:assert/strict";
import {
	createRecoveryLockPlan,
	isOpaqueRecoveryLockPlan,
} from "../shared/transcode-recovery-locks.mjs";
import {
	createPreExecutionRecovery,
	createRecoveryHold,
} from "../shared/transcode-recovery.mjs";

const NOW = "2026-07-19T00:00:00.000Z";
const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
];

function snapshot(id, state, extra = {}) {
	return { job: { id, state, sourceType: "library", sourcePublicPath: "/media/Track.M4A", ...extra } };
}

function normalizer(value) {
	if (typeof value !== "string" || !value.startsWith("/media/")) throw new Error("invalid");
	return value.toLowerCase();
}

let planResult = createRecoveryLockPlan({ snapshots: [snapshot(ids[0], "ready")], normalizeLibrarySourceKey: normalizer });
assert.equal(planResult.ok, true);
assert.equal(planResult.summary.activeOwnerCount, 1);
assert.equal(planResult.summary.recoveryOwnerCount, 0);
assert.equal(isOpaqueRecoveryLockPlan(planResult.plan), true);
assert.equal(JSON.stringify(planResult.plan).includes("Track"), false);
assert.equal(JSON.stringify(planResult.plan).includes(ids[0]), false);
assert.equal(Object.isFrozen(planResult.plan), true);

planResult = createRecoveryLockPlan({
	snapshots: [
		snapshot(ids[0], "transcoding", { recoveryHold: createRecoveryHold({ nowIso: NOW }) }),
		snapshot(ids[1], "interrupted", { recoveryHold: createRecoveryHold({ nowIso: NOW }) }),
	],
	normalizeLibrarySourceKey: normalizer,
});
assert.equal(planResult.ok, true);
assert.equal(planResult.summary.sourceCount, 1);
assert.equal(planResult.summary.activeOwnerCount, 1);
assert.equal(planResult.summary.recoveryOwnerCount, 2);

planResult = createRecoveryLockPlan({
	snapshots: [snapshot(ids[0], "uploading", {
		sourceType: "upload",
		sourcePublicPath: null,
		preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: NOW }),
	})],
	normalizeLibrarySourceKey: normalizer,
});
assert.equal(planResult.ok, true);
assert.equal(planResult.summary.sourceCount, 0);

planResult = createRecoveryLockPlan({
	snapshots: [snapshot(ids[0], "interrupted", {
		preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: NOW }),
	})],
	normalizeLibrarySourceKey: normalizer,
});
assert.equal(planResult.ok, true);
assert.equal(planResult.summary.recoveryOwnerCount, 1);

for (const bad of [
	[snapshot(ids[0], "interrupted", { sourceType: "library", preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: NOW }) })],
	[snapshot(ids[0], "ready", { sourcePublicPath: "invalid" })],
	[snapshot(ids[0], "unknown")],
	[snapshot(ids[0], "ready"), snapshot(ids[0], "queued")],
]) {
	const failed = createRecoveryLockPlan({ snapshots: bad, normalizeLibrarySourceKey: normalizer });
	assert.equal(failed.ok, false);
	assert.equal(failed.plan, undefined);
	assert.equal(failed.summary.sourceCount, 0);
}

planResult = createRecoveryLockPlan({
	snapshots: [snapshot(ids[0], "completed", { sourceType: "unknown", sourcePublicPath: null, recoveryHold: { active: "bad" } })],
	normalizeLibrarySourceKey: normalizer,
});
assert.equal(planResult.ok, true);
assert.equal(planResult.summary.sourceCount, 0);

const mutableSnapshots = [snapshot(ids[0], "ready")];
planResult = createRecoveryLockPlan({ snapshots: mutableSnapshots, normalizeLibrarySourceKey: normalizer });
mutableSnapshots[0].job.sourcePublicPath = "invalid";
assert.equal(planResult.ok, true);
assert.equal(planResult.summary.activeOwnerCount, 1);

assert.equal(isOpaqueRecoveryLockPlan({ kind: "transcode-recovery-lock-plan", summary: {} }), false);
console.log("transcode recovery lock planner tests passed");
