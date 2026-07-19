import assert from "node:assert/strict";
import {
	createReasonAwareSourceLockRegistry,
} from "../shared/transcode-recovery-locks.mjs";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const calls = [];
const target = new Map();
const registry = createReasonAwareSourceLockRegistry({
	targetMap: target,
	normalizeLibrarySourceKey(value) {
		calls.push(value);
		if (typeof value !== "string" || !value.startsWith("/media/")) throw new Error("bad source");
		return value.replace(/\\/g, "/").toLowerCase();
	},
});

assert.equal(registry.getSafeSummary().sourceCount, 0);
const active = registry.acquire({ sourcePublicPath: "/media/Track.M4A", jobId: JOB_A, reason: "active" });
assert.equal(active.ok, true);
assert.equal(active.acquired, true);
assert.equal(active.view.activeOwnerCount, 1);
assert.equal(calls.length, 1);

const duplicate = registry.acquire({ sourcePublicPath: "/media/TRACK.m4a", jobId: JOB_A, reason: "active" });
assert.equal(duplicate.ok, true);
assert.equal(duplicate.acquired, false);
assert.equal(duplicate.view.activeOwnerCount, 1);

assert.equal(registry.acquire({ sourcePublicPath: "/media/track.m4a", jobId: JOB_B, reason: "active" }).view.activeOwnerCount, 2);
assert.equal(registry.acquire({ sourcePublicPath: "/media/track.m4a", jobId: JOB_A, reason: "recovery" }).view.recoveryOwnerCount, 1);
assert.equal(registry.acquire({ sourcePublicPath: "/media/track.m4a", jobId: JOB_B, reason: "recovery" }).view.recoveryOwnerCount, 2);

const view = registry.getLockView("/media/track.m4a");
assert.deepEqual(view, {
	ok: true,
	code: null,
	hasActive: true,
	hasRecovery: true,
	activeOwnerCount: 2,
	recoveryOwnerCount: 2,
});
assert.equal(Object.isFrozen(view), true);
assert.equal("activeJobIds" in view, false);
assert.equal("sourceKey" in view, false);
assert.equal(registry.getSafeSummary().activeOwnerCount, 2);
assert.equal(registry.getSafeSummary().recoveryOwnerCount, 2);
assert.equal(JSON.stringify(registry.getSafeSummary()).includes("track"), false);

assert.equal(registry.release({ sourcePublicPath: "/media/track.m4a", jobId: JOB_A, reason: "active" }).released, true);
assert.equal(registry.getLockView("/media/track.m4a").recoveryOwnerCount, 2);
assert.equal(registry.release({ sourcePublicPath: "/media/track.m4a", jobId: JOB_A, reason: "recovery" }).released, true);
assert.equal(registry.getLockView("/media/track.m4a").activeOwnerCount, 1);
assert.equal(registry.release({ sourcePublicPath: "/media/track.m4a", jobId: JOB_A, reason: "recovery" }).released, false);

assert.equal(registry.acquire({ sourcePublicPath: "/media/track.m4a", jobId: "bad", reason: "active" }).ok, false);
assert.equal(registry.acquire({ sourcePublicPath: "/media/track.m4a", jobId: JOB_A, reason: "other" }).ok, false);
assert.equal(registry.acquire({ sourcePublicPath: "/unsafe/file.m4a", jobId: JOB_A, reason: "active" }).ok, false);
assert.equal(registry.getLockView("/unsafe/file.m4a").ok, false);

assert.equal(registry.release({ sourcePublicPath: "/media/track.m4a", jobId: JOB_B, reason: "active" }).released, true);
assert.equal(registry.release({ sourcePublicPath: "/media/track.m4a", jobId: JOB_B, reason: "recovery" }).released, true);
assert.equal(registry.getSafeSummary().sourceCount, 0);
assert.equal(target.size, 0);
assert.equal(registry.validateInternalState(), true);

console.log("transcode recovery lock manager tests passed");
