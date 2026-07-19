import assert from "node:assert/strict";
import {
	INCOMPLETE_UPLOAD_RECOVERY_CODES,
	createIncompleteUploadRecoveryPlan,
	normalizeIncompleteUploadDiscard,
} from "../shared/transcode-incomplete-upload-recovery.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const detectedAt = "2026-07-18T00:00:00.000Z";

function job(extra = {}) {
	return {
		id: JOB_ID,
		state: "interrupted",
		sourceType: "upload",
		preExecutionRecovery: { version: 1, active: true, code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt },
		...extra,
	};
}

function layout({ part = false, finals = [], unknown = false, trusted = true, boundarySafe = true } = {}) {
	return {
		ok: true,
		boundarySafe,
		part: { present: part, trusted, identity: part ? { token: "part" } : null },
		finals: finals.map((token) => ({ present: true, trusted, identity: { token } })),
		unknownSourceLikeEntry: unknown,
	};
}

assert.equal(createIncompleteUploadRecoveryPlan({ job: job(), layout: layout({ part: true }) }).status, "partOnly");
assert.equal(createIncompleteUploadRecoveryPlan({ job: job(), layout: layout({ finals: ["final"] }) }).status, "finalOnly");
assert.equal(createIncompleteUploadRecoveryPlan({ job: job(), layout: layout({ part: true, finals: ["final"] }) }).status, "partAndFinal");
assert.equal(createIncompleteUploadRecoveryPlan({ job: job(), layout: layout() }).status, "neither");

for (const unsafe of [
	layout({ finals: ["first", "second"] }),
	layout({ unknown: true }),
	layout({ part: true, trusted: false }),
	layout({ boundarySafe: false }),
]) {
	const plan = createIncompleteUploadRecoveryPlan({ job: job(), layout: unsafe });
	assert.equal(plan.critical, true);
	assert.equal(plan.safeDiscardAvailable, false);
}
assert.equal(createIncompleteUploadRecoveryPlan({ job: job(), layout: layout({ finals: ["a", "b"] }) }).code, INCOMPLETE_UPLOAD_RECOVERY_CODES.multipleFinals);
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ sourceType: "library" }), layout: layout() }).critical, true);
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ sourceType: "unknown" }), layout: layout() }).critical, true);
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ recoveryHold: { version: 1, active: true, code: "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED", detectedAt, lastCheckedAt: detectedAt, retryAfter: detectedAt } }), layout: layout() }).code, INCOMPLETE_UPLOAD_RECOVERY_CODES.outputHoldActive);
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ recoveryHold: { active: "bad" } }), layout: layout() }).safeDiscardAvailable, false);
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ preExecutionRecovery: { version: 1, active: true, code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt } }), layout: layout() }).status, "notApplicable");
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ preExecutionRecovery: { active: "bad" } }), layout: layout() }).critical, true);
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ state: "completed", preExecutionRecovery: { active: "bad" } }), layout: layout() }).status, "terminalProtected");
assert.equal(createIncompleteUploadRecoveryPlan({ job: job({ state: "discarded" }), layout: layout() }).status, "terminalProtected");
assert.equal(normalizeIncompleteUploadDiscard({ version: 1, active: true, phase: "prepared", code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", preparedAt: detectedAt }).malformed, false);
assert.equal(normalizeIncompleteUploadDiscard({ active: true }).malformed, true);

const sanitized = createIncompleteUploadRecoveryPlan({ job: job(), layout: layout({ part: true }) });
assert.equal(JSON.stringify(sanitized).includes("source-"), false);
assert.equal(JSON.stringify(sanitized).includes("token"), false);

console.log("incomplete upload inspector tests passed");
