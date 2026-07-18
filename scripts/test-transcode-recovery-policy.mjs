import assert from "node:assert/strict";
import {
	TRANSCODE_RECOVERY_HOLD_CODE,
	classifyStartupRecoveryRisk,
	classifyStartupRecoveryRequirements,
	createPreExecutionRecovery,
	createRecoveryHold,
	evaluateRecoveryRecheckEligibility,
	normalizeRecoveryHold,
	normalizeRecoveryWarning,
	updateRecoveryHold,
} from "../shared/transcode-recovery.mjs";

const nowIso = "2026-07-18T00:10:00.000Z";
const oldIso = "2026-07-18T00:00:00.000Z";
const nowMs = Date.parse(nowIso);

const hold = createRecoveryHold({ nowIso: oldIso, retryAfterIso: oldIso });
assert.deepEqual(hold, {
	version: 1,
	active: true,
	code: TRANSCODE_RECOVERY_HOLD_CODE,
	detectedAt: oldIso,
	lastCheckedAt: oldIso,
	retryAfter: oldIso,
});
assert.equal(Object.isFrozen(hold), true);

const normalized = normalizeRecoveryHold({ ...hold, lastCheckedAt: nowIso, pid: 123, path: "C:\\secret" });
assert.equal(normalized.malformed, false);
assert.equal(normalized.hold.detectedAt, oldIso);
assert.equal(normalized.hold.lastCheckedAt, nowIso);
assert.equal("pid" in normalized.hold, false);
assert.equal("path" in normalized.hold, false);

assert.equal(normalizeRecoveryHold({ active: false }).hold, null);
assert.equal(normalizeRecoveryHold({ ...hold, active: "true" }, { fallbackNowIso: nowIso }).malformed, true);
assert.equal(normalizeRecoveryHold({ ...hold, code: "OTHER" }, { fallbackNowIso: nowIso }).hold.code, TRANSCODE_RECOVERY_HOLD_CODE);
assert.equal(normalizeRecoveryHold({ ...hold, version: 2 }, { fallbackNowIso: nowIso }).malformed, true);
assert.equal(normalizeRecoveryHold({ ...hold, detectedAt: "not-time" }, { fallbackNowIso: nowIso }).malformed, true);
assert.equal(normalizeRecoveryHold({ ...hold, retryAfter: "not-time" }, { fallbackNowIso: nowIso }).malformed, true);

const updated = updateRecoveryHold(hold, { lastCheckedAt: nowIso, retryAfter: nowIso });
assert.equal(updated.detectedAt, oldIso);
assert.equal(updated.lastCheckedAt, nowIso);
assert.equal(updated.retryAfter, nowIso);

assert.deepEqual(normalizeRecoveryWarning({ code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE", errno: "EACCES", path: "C:\\secret" }), {
	code: "TRANSCODE_RECOVERY_OUTPUT_UNSAFE",
	message: "Recovery output could not be verified safely.",
});
assert.equal(normalizeRecoveryWarning({ code: "UNKNOWN", message: "secret" }), null);

assert.equal(evaluateRecoveryRecheckEligibility({ hold, holdExistedBeforeStartup: false, startupIdentity: "boot-a", wallNowMs: nowMs }).eligible, false);
assert.equal(evaluateRecoveryRecheckEligibility({ hold, holdExistedBeforeStartup: true, startupIdentity: "", wallNowMs: nowMs }).reasonCode, "TRANSCODE_RECOVERY_NOT_COLD_START");
assert.equal(evaluateRecoveryRecheckEligibility({ hold: createRecoveryHold({ nowIso: "2026-07-18T00:09:00.000Z" }), holdExistedBeforeStartup: true, startupIdentity: "boot-b", wallNowMs: nowMs }).reasonCode, "TRANSCODE_RECOVERY_HOLD_TOO_RECENT");
assert.equal(evaluateRecoveryRecheckEligibility({ hold, holdExistedBeforeStartup: true, startupIdentity: "boot-c", wallNowMs: nowMs }).eligible, true);
assert.equal(evaluateRecoveryRecheckEligibility({ hold: createRecoveryHold({ nowIso: "2026-07-18T00:20:00.000Z" }), holdExistedBeforeStartup: true, startupIdentity: "boot-c", wallNowMs: nowMs }).eligible, false);
assert.equal(evaluateRecoveryRecheckEligibility({ hold: { ...hold, lastCheckedAt: "2026-07-18T00:20:00.000Z" }, holdExistedBeforeStartup: true, startupIdentity: "boot-c", wallNowMs: nowMs }).eligible, false);

assert.equal(classifyStartupRecoveryRisk({ state: "completed" }), "terminalProtected");
assert.equal(classifyStartupRecoveryRisk({ state: "completed", completionCommitted: false }), "terminalProtected");
assert.equal(classifyStartupRecoveryRisk({ state: "validating-output" }), "needsInitialHold");
assert.equal(classifyStartupRecoveryRisk({ state: "creating" }), "needsPreExecutionInterruption");
assert.equal(classifyStartupRecoveryRisk({ state: "creating" }, { hasFixedOutput: true }), "needsInitialOutputHold");
assert.equal(classifyStartupRecoveryRisk({ state: "uploading" }), "needsIncompleteUploadRecovery");
assert.equal(classifyStartupRecoveryRisk({ state: "probing" }), "needsSourceAccessRecovery");
assert.equal(classifyStartupRecoveryRequirements({ state: "interrupted", preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: oldIso }) }), "preExecutionRecoveryRequired");
assert.equal(classifyStartupRecoveryRisk({ state: "ready" }), "noRecoveryAction");
assert.equal(classifyStartupRecoveryRisk({ state: "ready" }, { hasFixedOutput: true }), "needsInitialHold");
assert.equal(classifyStartupRecoveryRisk({ state: "queued" }), "queuedRecovery");
assert.equal(classifyStartupRecoveryRisk({ state: "queued" }, { hasFixedOutput: true }), "needsInitialHold");
assert.equal(classifyStartupRecoveryRisk({ state: "interrupted" }), "ordinaryInterrupted");
assert.equal(classifyStartupRecoveryRisk({ state: "interrupted", recoveryHold: hold }), "needsExistingHoldRecheck");
assert.equal(classifyStartupRecoveryRisk({ state: "transcoding" }), "needsInitialHold");
assert.equal(classifyStartupRecoveryRisk({ state: "ready", completionCommitStarted: true }), "needsInitialHold");
assert.equal(classifyStartupRecoveryRisk({ state: 42 }), "malformedUnsafe");

console.log("transcode recovery policy tests passed");
