import assert from "node:assert/strict";
import { createTranscodeProbeMigrationBarrierAuthority, TRANSCODE_PROBE_MIGRATION_CODES } from "../shared/transcode-probe-migration-barrier.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "d".repeat(64) };
function store(raw) { return { async readMarkerRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; }, async compareAndSwapMarkerRaw() { return { status: "swapped" }; } }; }
const activeBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, state: "active", baselineWitness: witness })}\n`);
const completeBytes = Buffer.from('{"schemaVersion":1,"state":"complete"}\n');
const authority = createTranscodeProbeMigrationBarrierAuthority();
const active = (await authority.resolverIssuer.createStartupResolver(store(activeBytes)).resolve({ currentBootWitness: witness })).barrierView;
const complete = (await authority.resolverIssuer.createStartupResolver(store(completeBytes)).resolve({ currentBootWitness: witness })).barrierView;
assert.equal(Object.isFrozen(active), true);
assert.equal(JSON.stringify(active).includes("fake-boot"), false);
assert.equal(createTranscodeProbeMigrationBarrierAuthority().conflictChecker.check(active, "read").code, TRANSCODE_PROBE_MIGRATION_CODES.viewInvalid);
for (const operation of ["read", "list", "listing", "playback", "download"]) assert.equal(authority.conflictChecker.check(active, operation).ok, true);
for (const operation of ["trash", "restore-target", "delete", "permanent-delete", "rename-source", "rename-target", "move-source", "move-target", "replace-source", "replace-target", "overwrite", "from-library", "direct-library-probe"]) {
	const result = authority.conflictChecker.check(active, operation);
	assert.equal(result.code, TRANSCODE_PROBE_MIGRATION_CODES.barrierActive);
	assert.equal(Object.isFrozen(result), true);
}
assert.equal(authority.conflictChecker.check(active, "unknown").code, TRANSCODE_PROBE_MIGRATION_CODES.operationInvalid);
assert.equal(authority.conflictChecker.check({ barrierActive: false }, "trash").code, TRANSCODE_PROBE_MIGRATION_CODES.viewInvalid);
for (const operation of ["read", "trash", "from-library", "direct-library-probe"]) assert.equal(authority.conflictChecker.check(complete, operation).ok, true);
console.log("transcode probe migration barrier tests passed");
