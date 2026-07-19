import assert from "node:assert/strict";
import {
	createReasonAwareSourceLockRegistry,
	getTranscodeRecoveryOperationConflict,
	getTranscodeSourceMutationConflict,
	TRANSCODE_RECOVERY_CONFLICT_CODE,
} from "../shared/transcode-recovery-locks.mjs";
import { createPreExecutionRecovery, createRecoveryHold } from "../shared/transcode-recovery.mjs";

const NOW = "2026-07-19T00:00:00.000Z";
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const held = { state: "interrupted", recoveryHold: createRecoveryHold({ nowIso: NOW }) };
const upload = { state: "interrupted", preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: NOW }) };
const sourceAccess = { state: "interrupted", preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: NOW }) };

for (const job of [held, upload, sourceAccess, { state: "interrupted", recoveryHold: { active: "bad" } }, { state: "interrupted", preExecutionRecovery: { active: "bad" } }]) {
	assert.equal(getTranscodeRecoveryOperationConflict(job, "start").code, TRANSCODE_RECOVERY_CONFLICT_CODE);
	assert.equal(getTranscodeRecoveryOperationConflict(job, "retry").disposition, "reject");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "cancel").disposition, "reject");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "discard").disposition, "reject");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "delete").disposition, "reject");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "cleanup").disposition, "reject");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "retention-cleanup").disposition, "skip");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "read").disposition, "allow");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "summary").disposition, "allow");
	assert.equal(getTranscodeRecoveryOperationConflict(job, "source-probe-readonly").disposition, "allow");
}

assert.equal(getTranscodeRecoveryOperationConflict({ state: "interrupted" }, "start").disposition, "allow");
assert.equal(getTranscodeRecoveryOperationConflict({ state: "completed", recoveryHold: { active: "bad" } }, "start").disposition, "allow");
assert.equal(getTranscodeRecoveryOperationConflict(held, "source-probe").disposition, "reject");
assert.equal(getTranscodeRecoveryOperationConflict(held, "unknown").disposition, "reject");

const registry = createReasonAwareSourceLockRegistry({
	normalizeLibrarySourceKey: (value) => typeof value === "string" && value.startsWith("/media/") ? value.toLowerCase() : null,
});
const none = registry.getLockView("/media/none.m4a");
registry.acquire({ sourcePublicPath: "/media/active.m4a", jobId: JOB_A, reason: "active" });
const active = registry.getLockView("/media/active.m4a");
registry.acquire({ sourcePublicPath: "/media/recovery.m4a", jobId: JOB_A, reason: "recovery" });
const recovery = registry.getLockView("/media/recovery.m4a");
registry.acquire({ sourcePublicPath: "/media/both.m4a", jobId: JOB_A, reason: "active" });
registry.acquire({ sourcePublicPath: "/media/both.m4a", jobId: JOB_B, reason: "recovery" });
const both = registry.getLockView("/media/both.m4a");
for (const operation of ["from-library", "trash", "restore-target", "delete", "permanent-delete", "rename-source", "rename-target", "move-source", "move-target", "replace-source", "replace-target"]) {
	assert.equal(getTranscodeSourceMutationConflict(none, operation).disposition, "allow");
	assert.equal(getTranscodeSourceMutationConflict(active, operation).code, "TRANSCODE_SOURCE_LOCKED");
	assert.equal(getTranscodeSourceMutationConflict(recovery, operation).code, TRANSCODE_RECOVERY_CONFLICT_CODE);
	assert.equal(getTranscodeSourceMutationConflict(both, operation).code, TRANSCODE_RECOVERY_CONFLICT_CODE);
}
assert.equal(getTranscodeSourceMutationConflict(both, "read").disposition, "allow");
assert.equal(getTranscodeSourceMutationConflict(both, "listing").disposition, "allow");
assert.equal(getTranscodeSourceMutationConflict(none, "unknown").disposition, "reject");
assert.equal(getTranscodeSourceMutationConflict({ ok: true, hasActive: false, hasRecovery: false, activeOwnerCount: 0, recoveryOwnerCount: 0 }, "trash").disposition, "reject");
assert.equal("jobId" in getTranscodeSourceMutationConflict(recovery, "trash"), false);
assert.equal("sourcePublicPath" in getTranscodeRecoveryOperationConflict(held, "start"), false);
console.log("transcode recovery conflict tests passed");
