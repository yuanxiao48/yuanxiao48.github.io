import assert from "node:assert/strict";
import { createTranscodeProbeMigrationBarrierAuthority, TRANSCODE_PROBE_MIGRATION_CODES } from "../shared/transcode-probe-migration-barrier.mjs";

const one = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "b".repeat(64) };
const two = { ...one, bootSessionDigest: "c".repeat(64) };
function active(witness) { return Buffer.from(`${JSON.stringify({ schemaVersion: 1, state: "active", baselineWitness: witness })}\n`); }
function complete() { return Buffer.from('{"schemaVersion":1,"state":"complete"}\n'); }
function store(initial, mode = "swapped") {
	let raw = initial;
	let writes = 0;
	return {
		get writes() { return writes; },
		async readMarkerRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; },
		async compareAndSwapMarkerRaw({ nextBytes }) { writes += 1; if (mode === "throw") throw new Error("hidden"); if (mode !== "swapped") return { status: mode }; raw = Buffer.from(nextBytes); return { status: "swapped" }; },
	};
}
const authority = createTranscodeProbeMigrationBarrierAuthority();
const firstStore = store(null);
const first = await authority.resolverIssuer.createStartupResolver(firstStore).resolve({ currentBootWitness: one });
assert.equal(first.ok, true); assert.equal(first.safeSummary.barrierActive, true); assert.equal(firstStore.writes, 1);
const unavailableStore = store(null);
const unavailable = await authority.resolverIssuer.createStartupResolver(unavailableStore).resolve({ currentBootWitness: null });
assert.equal(unavailable.ok, true); assert.equal(unavailable.safeSummary.barrierActive, true); assert.equal(unavailableStore.writes, 0);
const sameStore = store(active(one));
assert.equal((await authority.resolverIssuer.createStartupResolver(sameStore).resolve({ currentBootWitness: one })).safeSummary.barrierActive, true);
assert.equal(sameStore.writes, 0);
const differentStore = store(active(one));
const different = await authority.resolverIssuer.createStartupResolver(differentStore).resolve({ currentBootWitness: two });
assert.equal(different.safeSummary.migrationComplete, true); assert.equal(differentStore.writes, 1);
const incomparable = await authority.resolverIssuer.createStartupResolver(store(active({ ...one, providerId: "other" }))).resolve({ currentBootWitness: one });
assert.equal(incomparable.safeSummary.barrierActive, true);
for (const current of [one, two, null]) assert.equal((await authority.resolverIssuer.createStartupResolver(store(complete())).resolve({ currentBootWitness: current })).safeSummary.migrationComplete, true);
const conflict = await authority.resolverIssuer.createStartupResolver(store(active(one), "conflict")).resolve({ currentBootWitness: two });
assert.equal(conflict.code, TRANSCODE_PROBE_MIGRATION_CODES.casConflict); assert.equal(conflict.barrierView, null);
const failed = await authority.resolverIssuer.createStartupResolver(store(active(one), "failed")).resolve({ currentBootWitness: two });
assert.equal(failed.code, TRANSCODE_PROBE_MIGRATION_CODES.casFailed);
console.log("transcode probe migration resolver tests passed");
