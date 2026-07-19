import assert from "node:assert/strict";
import {
	createReasonAwareSourceLockRegistry,
	createTranscodeSourceReaderLeaseAuthority,
	getTranscodeSourceMutationConflict,
	TRANSCODE_RECOVERY_CONFLICT_CODE,
	TRANSCODE_SOURCE_READER_CONFLICT_CODE,
} from "../shared/transcode-recovery-locks.mjs";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const source = "/media/source.m4a";
const leases = createTranscodeSourceReaderLeaseAuthority();
const registry = createReasonAwareSourceLockRegistry({
	readerLeaseConsumer: leases.registryConsumer,
	normalizeLibrarySourceKey: (value) => typeof value === "string" && value.startsWith("/media/") ? value.toLowerCase() : null,
});

const none = registry.getLockView(source);
for (const operation of ["read", "list", "listing", "playback", "download"]) {
	assert.equal(getTranscodeSourceMutationConflict(none, operation).disposition, "allow");
}
for (const operation of ["from-library", "trash", "restore-target", "delete", "permanent-delete", "rename-source", "rename-target", "move-source", "move-target", "replace-source", "replace-target", "overwrite"]) {
	assert.equal(getTranscodeSourceMutationConflict(none, operation).disposition, "allow");
}

registry.acquire({ sourcePublicPath: source, jobId: JOB_A, reason: "active" });
const active = registry.getLockView(source);
assert.equal(getTranscodeSourceMutationConflict(active, "trash").code, "TRANSCODE_SOURCE_LOCKED");

const runtime = leases.issuer.mintRuntimeReaderLease().leaseToken;
registry.acquireRuntimeReader(source, runtime);
const runtimeView = registry.getLockView(source);
assert.equal(getTranscodeSourceMutationConflict(runtimeView, "trash").code, TRANSCODE_SOURCE_READER_CONFLICT_CODE);
assert.equal(getTranscodeSourceMutationConflict(runtimeView, "from-library").code, TRANSCODE_SOURCE_READER_CONFLICT_CODE);

const recoveryJobSource = "/media/recovery-job.m4a";
registry.acquire({ sourcePublicPath: recoveryJobSource, jobId: JOB_A, reason: "recovery" });
assert.equal(getTranscodeSourceMutationConflict(registry.getLockView(recoveryJobSource), "trash").code, TRANSCODE_RECOVERY_CONFLICT_CODE);

const recoveryReader = leases.issuer.mintRecoveryReaderLease().leaseToken;
registry.acquireRecoveryReader(source, recoveryReader);
const allReasons = registry.getLockView(source);
for (const operation of ["trash", "restore-target", "delete", "permanent-delete", "rename-source", "rename-target", "move-source", "move-target", "replace-source", "replace-target", "overwrite", "from-library"]) {
	const result = getTranscodeSourceMutationConflict(allReasons, operation);
	assert.equal(result.code, TRANSCODE_RECOVERY_CONFLICT_CODE);
	assert.equal(result.kind, "recovery");
	assert.equal("jobId" in result, false);
	assert.equal("leaseToken" in result, false);
	assert.equal("sourcePublicPath" in result, false);
	assert.equal(Object.isFrozen(result), true);
}
for (const operation of ["read", "list", "listing", "playback", "download"]) {
	assert.equal(getTranscodeSourceMutationConflict(allReasons, operation).disposition, "allow");
}

assert.equal(getTranscodeSourceMutationConflict(none, "unknown").disposition, "reject");
assert.equal(getTranscodeSourceMutationConflict({ ok: true, activeOwnerCount: 0, recoveryOwnerCount: 0, runtimeReaderOwnerCount: 0, recoveryReaderOwnerCount: 0 }, "trash").code, "TRANSCODE_SOURCE_READER_REGISTRY_INVALID");

const invalidTarget = new Map([[source, JOB_B]]);
const invalidRegistry = createReasonAwareSourceLockRegistry({
	targetMap: invalidTarget,
	readerLeaseConsumer: leases.registryConsumer,
	normalizeLibrarySourceKey: (value) => value,
});
assert.equal(getTranscodeSourceMutationConflict(invalidRegistry.getLockView(source), "trash").code, "TRANSCODE_SOURCE_READER_REGISTRY_INVALID");
assert.equal(getTranscodeSourceMutationConflict(allReasons, "trash", { globalBarrier: true }).code, TRANSCODE_RECOVERY_CONFLICT_CODE);

console.log("transcode source reader conflict tests passed");
