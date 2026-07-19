import assert from "node:assert/strict";
import {
	combineTranscodeRecoveryLockPlans,
	createReasonAwareSourceLockRegistry,
	createRecoveryLockPlan,
	createRecoveryReaderLockContributionAuthority,
	createTranscodeSourceReaderLeaseAuthority,
	installRecoveryLockPlan,
} from "../shared/transcode-recovery-locks.mjs";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const sourceA = "/media/Track.M4A";
const sourceB = "/media/Other.M4A";
const calls = [];
const target = new Map();
const leasesA = createTranscodeSourceReaderLeaseAuthority();
const leasesB = createTranscodeSourceReaderLeaseAuthority();
const registry = createReasonAwareSourceLockRegistry({
	targetMap: target,
	readerLeaseConsumer: leasesA.registryConsumer,
	normalizeLibrarySourceKey(value) {
		calls.push(value);
		if (typeof value !== "string" || !value.startsWith("/media/")) throw new Error("invalid fake source");
		return value.replace(/\\/g, "/").toLowerCase();
	},
});

assert.equal(target.size, 0);
assert.equal(registry.getSafeSummary().runtimeReaderOwnerCount, 0);
assert.equal(registry.acquireRuntimeReader(sourceA, {}).code, "TRANSCODE_SOURCE_READER_LEASE_INVALID");
assert.equal(registry.acquireRuntimeReader(sourceA, leasesB.issuer.mintRuntimeReaderLease().leaseToken).code, "TRANSCODE_SOURCE_READER_LEASE_INVALID");

const runtimeA = leasesA.issuer.mintRuntimeReaderLease().leaseToken;
const runtimeB = leasesA.issuer.mintRuntimeReaderLease().leaseToken;
const recoveryA = leasesA.issuer.mintRecoveryReaderLease().leaseToken;
const recoveryB = leasesA.issuer.mintRecoveryReaderLease().leaseToken;
assert.equal(JSON.stringify(runtimeA), "{\"kind\":\"transcode-source-reader-lease\"}");
assert.equal(Object.keys(runtimeA).length, 0);

assert.equal(registry.acquireRuntimeReader(sourceA, recoveryA).code, "TRANSCODE_SOURCE_READER_LEASE_KIND_INVALID");
assert.equal(registry.acquireRecoveryReader(sourceA, runtimeA).code, "TRANSCODE_SOURCE_READER_LEASE_KIND_INVALID");
assert.equal(registry.acquireRuntimeReader(sourceA, runtimeA).acquired, true);
assert.equal(registry.acquireRuntimeReader("/media/TRACK.m4a", runtimeA).acquired, false);
assert.equal(registry.acquireRuntimeReader(sourceB, runtimeA).code, "TRANSCODE_SOURCE_READER_LEASE_SOURCE_MISMATCH");
assert.equal(registry.releaseRuntimeReader(sourceB, runtimeA).code, "TRANSCODE_SOURCE_READER_LEASE_SOURCE_MISMATCH");
assert.equal(registry.acquireRuntimeReader(sourceA, runtimeB).acquired, true);
assert.equal(registry.acquireRecoveryReader(sourceA, recoveryA).acquired, true);
assert.equal(registry.acquireRecoveryReader(sourceA, recoveryB).acquired, true);
assert.equal(registry.acquire({ sourcePublicPath: sourceA, jobId: JOB_A, reason: "active" }).acquired, true);
assert.equal(registry.acquire({ sourcePublicPath: sourceA, jobId: JOB_B, reason: "recovery" }).acquired, true);

const view = registry.getLockView(sourceA);
assert.equal(Object.isFrozen(view), true);
assert.deepEqual(view, {
	ok: true,
	code: null,
	hasActive: true,
	hasRecovery: true,
	hasRuntimeReader: true,
	hasRecoveryReader: true,
	activeOwnerCount: 1,
	recoveryOwnerCount: 1,
	runtimeReaderOwnerCount: 2,
	recoveryReaderOwnerCount: 2,
});
assert.equal("activeJobIds" in view, false);
assert.equal("leaseToken" in view, false);
assert.equal(JSON.stringify(view).includes("Track"), false);
assert.equal(JSON.stringify(view).includes("11111111"), false);
assert.equal(registry.getSafeSummary().runtimeReaderOwnerCount, 2);
assert.equal(registry.getSafeSummary().recoveryReaderOwnerCount, 2);
assert.equal(registry.hasAnyLock(sourceA).locked, true);
assert.equal(registry.hasRecoveryLock(sourceA).locked, true);

assert.equal(registry.releaseRuntimeReader(sourceA, runtimeA).released, true);
assert.equal(registry.getLockView(sourceA).runtimeReaderOwnerCount, 1);
assert.equal(registry.releaseRuntimeReader(sourceA, runtimeA).released, false);
assert.equal(registry.releaseRuntimeReader(sourceA, {}).code, "TRANSCODE_SOURCE_READER_LEASE_INVALID");
assert.equal(registry.releaseRecoveryReader(sourceA, recoveryA).released, true);
assert.equal(registry.getLockView(sourceA).recoveryReaderOwnerCount, 1);
assert.equal(registry.release({ sourcePublicPath: sourceA, jobId: JOB_A, reason: "active" }).released, true);
assert.equal(registry.getLockView(sourceA).recoveryReaderOwnerCount, 1);
assert.equal(registry.release({ sourcePublicPath: sourceA, jobId: JOB_B, reason: "recovery" }).released, true);
assert.equal(registry.releaseRuntimeReader(sourceA, runtimeB).released, true);
assert.equal(registry.releaseRecoveryReader(sourceA, recoveryB).released, true);
assert.equal(target.size, 0);
assert.equal(registry.validateInternalState(), true);
assert.ok(calls.length > 10);
assert.equal(registry.acquireRuntimeReader({ sourcePublicPath: sourceA, alreadyNormalized: true }, leasesA.issuer.mintRuntimeReaderLease().leaseToken).ok, false);

for (const invalid of [
	new Map([["/media/legacy.m4a", JOB_A]]),
	new Map([["/media/old.m4a", { activeJobIds: new Set(), recoveryJobIds: new Set() }]]),
	new Map([["/media/version.m4a", { version: 1, activeJobIds: new Set(), recoveryJobIds: new Set(), runtimeReaderLeaseIds: new Set(), recoveryReaderLeaseIds: new Set() }]]),
]) {
	const broken = createReasonAwareSourceLockRegistry({ targetMap: invalid, readerLeaseConsumer: leasesA.registryConsumer, normalizeLibrarySourceKey: (value) => value });
	assert.equal(broken.validateInternalState(), false);
	assert.equal(broken.getLockView("/media/old.m4a").ok, false);
	assert.equal(broken.acquireRuntimeReader("/media/old.m4a", leasesA.issuer.mintRuntimeReaderLease().leaseToken).ok, false);
}

const manifestPlan = createRecoveryLockPlan({
	snapshots: [{ job: { id: JOB_A, state: "ready", sourceType: "library", sourcePublicPath: sourceA } }],
	normalizeLibrarySourceKey: (value) => value.toLowerCase(),
});
assert.equal(manifestPlan.ok, true);
assert.equal(manifestPlan.summary.runtimeReaderOwnerCount, 0);
assert.equal(manifestPlan.summary.recoveryReaderOwnerCount, 0);

const contributionAuthority = createRecoveryReaderLockContributionAuthority({
	normalizeLibrarySourceKey: (value) => typeof value === "string" && value.startsWith("/media/") ? value.toLowerCase() : null,
	readerLeaseConsumer: leasesA.registryConsumer,
});
const journalLeaseA = leasesA.issuer.mintRecoveryReaderLease().leaseToken;
const journalLeaseB = leasesA.issuer.mintRecoveryReaderLease().leaseToken;
const contributionA = contributionAuthority.issuer.mintRecoveryReaderContribution({ sourcePublicPath: sourceA, leaseToken: journalLeaseA });
const contributionB = contributionAuthority.issuer.mintRecoveryReaderContribution({ sourcePublicPath: "/media/TRACK.m4a", leaseToken: journalLeaseB });
assert.equal(contributionA.ok, true);
assert.equal(JSON.stringify(contributionA.contribution), "{\"kind\":\"transcode-recovery-reader-contribution\"}");
assert.equal(contributionAuthority.issuer.mintRecoveryReaderContribution({ sourcePublicPath: sourceA, leaseToken: runtimeA }).code, "TRANSCODE_SOURCE_READER_LEASE_KIND_INVALID");
const combined = combineTranscodeRecoveryLockPlans({
	plan: manifestPlan.plan,
	contributionConsumer: contributionAuthority.contributionConsumer,
	contributions: [contributionA.contribution, contributionB.contribution],
});
assert.equal(combined.ok, true);
assert.equal(combined.summary.activeOwnerCount, 1);
assert.equal(combined.summary.recoveryReaderOwnerCount, 2);
assert.equal(JSON.stringify(combined.plan).includes("Track"), false);
assert.equal(JSON.stringify(combined.plan).includes("lease"), false);
assert.equal(combineTranscodeRecoveryLockPlans({ plan: manifestPlan.plan, contributionConsumer: contributionAuthority.contributionConsumer, contributions: [{}] }).ok, false);
const wrongContributionAuthority = createRecoveryReaderLockContributionAuthority({ normalizeLibrarySourceKey: (value) => value, readerLeaseConsumer: leasesA.registryConsumer });
assert.equal(combineTranscodeRecoveryLockPlans({ plan: manifestPlan.plan, contributionConsumer: wrongContributionAuthority.contributionConsumer, contributions: [contributionA.contribution] }).ok, false);

const installTarget = new Map();
assert.equal(installRecoveryLockPlan({ targetMap: installTarget, plan: combined.plan }).ok, true);
const installed = installTarget.get("/media/track.m4a");
assert.equal(installed.version, 2);
assert.equal(installed.activeJobIds.has(JOB_A), true);
assert.equal(installed.recoveryReaderLeaseIds.size, 2);
assert.equal(installed.runtimeReaderLeaseIds.size, 0);
installed.recoveryReaderLeaseIds.clear();
const secondInstallTarget = new Map();
assert.equal(installRecoveryLockPlan({ targetMap: secondInstallTarget, plan: combined.plan }).ok, true);
assert.equal(secondInstallTarget.get("/media/track.m4a").recoveryReaderLeaseIds.size, 2);

class SetFailureMap extends Map {
	set(key, value) {
		if (!this.failed) {
			this.failed = true;
			throw new Error("fake set failure");
		}
		return super.set(key, value);
	}
}

class RollbackFailureMap extends Map {
	clear() {
		this.clearCalls = (this.clearCalls || 0) + 1;
		if (this.clearCalls === 2) throw new Error("fake rollback clear failure");
		return super.clear();
	}
	set() { throw new Error("fake set failure"); }
}

const failedInstall = new SetFailureMap();
assert.equal(installRecoveryLockPlan({ targetMap: failedInstall, plan: combined.plan }).installed, false);
assert.equal(failedInstall.size, 0);
const unknownInstall = new RollbackFailureMap();
assert.equal(installRecoveryLockPlan({ targetMap: unknownInstall, plan: combined.plan }).registryStateUnknown, true);

console.log("transcode source reader lease tests passed");
