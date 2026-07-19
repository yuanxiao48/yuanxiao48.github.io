import assert from "node:assert/strict";
import {
	createRecoveryLockPlan,
	installRecoveryLockPlan,
} from "../shared/transcode-recovery-locks.mjs";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const normalize = (value) => typeof value === "string" && value.startsWith("/media/") ? value.toLowerCase() : null;
const plan = createRecoveryLockPlan({
	snapshots: [
		{ job: { id: JOB_A, state: "ready", sourceType: "library", sourcePublicPath: "/media/a.m4a" } },
		{ job: { id: JOB_B, state: "interrupted", sourceType: "library", sourcePublicPath: "/media/b.m4a", recoveryHold: { version: 1, active: true, code: "TRANSCODE_RECOVERY_OUTPUT_UNCONFIRMED", detectedAt: "2026-07-18T00:00:00.000Z", lastCheckedAt: "2026-07-18T00:00:00.000Z", retryAfter: "2026-07-18T00:00:00.000Z" } } },
	],
	normalizeLibrarySourceKey: normalize,
});
assert.equal(plan.ok, true);

const target = new Map();
const sameReference = target;
let installed = installRecoveryLockPlan({ targetMap: target, plan: plan.plan });
assert.equal(installed.ok, true);
assert.equal(target, sameReference);
assert.equal(target.size, 2);
assert.equal(target.get("/media/a.m4a").version, 2);
assert.equal(target.get("/media/a.m4a").activeJobIds.has(JOB_A), true);
assert.equal(target.get("/media/b.m4a").recoveryJobIds.has(JOB_B), true);
assert.equal(target.get("/media/a.m4a").runtimeReaderLeaseIds.size, 0);
assert.equal(target.get("/media/b.m4a").recoveryReaderLeaseIds.size, 0);

const legacy = new Map([["/media/old.m4a", JOB_A]]);
installed = installRecoveryLockPlan({ targetMap: legacy, plan: plan.plan });
assert.equal(installed.ok, false);
assert.equal(legacy.get("/media/old.m4a"), JOB_A);

installed = installRecoveryLockPlan({ targetMap: target, plan: plan.plan });
assert.equal(installed.ok, false);
assert.equal(installed.code, "TRANSCODE_RECOVERY_LOCK_INSTALL_TARGET_NOT_EMPTY");

class OneFailureMap extends Map {
	constructor(entries) {
		super(entries);
		this.failAt = null;
		this.setCalls = 0;
	}
	set(key, value) {
		this.setCalls += 1;
		if (this.failAt !== null && this.setCalls === this.failAt) {
			this.failAt = null;
			throw new Error("injected");
		}
		return super.set(key, value);
	}
}

const failing = new OneFailureMap();
failing.setCalls = 0;
failing.failAt = 1;
installed = installRecoveryLockPlan({ targetMap: failing, plan: plan.plan });
assert.equal(installed.ok, false);
assert.equal(installed.registryStateUnknown, false);
assert.equal(failing.size, 0);

installed = installRecoveryLockPlan({ targetMap: target, plan: { kind: "transcode-recovery-lock-plan" } });
assert.equal(installed.ok, false);
assert.equal(installed.installed, false);

class RollbackFailureMap extends Map {
	clear() {
		this.clearCalls = (this.clearCalls || 0) + 1;
		if (this.clearCalls === 2) throw new Error("rollback failure");
		return super.clear();
	}
	set() { throw new Error("set failure"); }
}

installed = installRecoveryLockPlan({ targetMap: new RollbackFailureMap(), plan: plan.plan });
assert.equal(installed.ok, false);
assert.equal(installed.registryStateUnknown, true);
console.log("transcode recovery lock installation tests passed");
