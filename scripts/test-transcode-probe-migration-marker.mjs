import assert from "node:assert/strict";
import {
	createTranscodeProbeMigrationBarrierAuthority,
	createTranscodeProbeMigrationMarkerRawIdentity,
	sameTranscodeProbeMigrationMarkerRawIdentity,
	TRANSCODE_PROBE_MIGRATION_CODES,
} from "../shared/transcode-probe-migration-barrier.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "a".repeat(64) };
function store(raw = null) {
	let value = raw;
	return {
		async readMarkerRaw() { return value === null ? { status: "missing" } : { status: "present", bytes: value }; },
		async compareAndSwapMarkerRaw({ nextBytes }) { value = Buffer.from(nextBytes); return { status: "swapped" }; },
	};
}
const authority = createTranscodeProbeMigrationBarrierAuthority({ policy: { maxRawBytes: 1024 } });
assert.equal(sameTranscodeProbeMigrationMarkerRawIdentity(createTranscodeProbeMigrationMarkerRawIdentity(null), createTranscodeProbeMigrationMarkerRawIdentity(Buffer.alloc(0))), false);
assert.equal(sameTranscodeProbeMigrationMarkerRawIdentity(createTranscodeProbeMigrationMarkerRawIdentity(Buffer.from("{}")), createTranscodeProbeMigrationMarkerRawIdentity(Buffer.from("{}\n"))), false);
assert.equal((await authority.resolverIssuer.createStartupResolver(store()).resolve({ currentBootWitness: witness })).safeSummary.barrierActive, true);
for (const raw of [
	Buffer.alloc(0), Buffer.from(" \n"), Buffer.from('{"schemaVersion":1,"schemaVersion":1,"state":"complete"}'),
	Buffer.from('{"schemaVersion":1,"state":"complete",}'), Buffer.from('{"schemaVersion":1,"state":"complete","baselineWitness":{}}'),
	Buffer.from('{"schemaVersion":1,"state":"active"}'), Buffer.from('{"schemaVersion":2,"state":"complete"}'),
	Buffer.from('{"schemaVersion":1,"state":"unknown"}'), Buffer.from('{"schemaVersion":1,"state":"complete","pid":1}'),
]) {
	const result = await authority.resolverIssuer.createStartupResolver(store(raw)).resolve({ currentBootWitness: witness });
	assert.equal(result.ok, false);
}
const duplicateEscaped = Buffer.from(`{"schemaVersion":1,"state":"active","baselineWitness":{"schemaVersion":1,"providerId":"fake-boot","providerVersion":1,"bootSessionDigest":"${"a".repeat(64)}","bootSessionD\\u0069gest":"${"a".repeat(64)}"}}`);
assert.equal((await authority.resolverIssuer.createStartupResolver(store(duplicateEscaped)).resolve({ currentBootWitness: witness })).code, TRANSCODE_PROBE_MIGRATION_CODES.duplicateKey);
assert.equal(JSON.stringify((await authority.resolverIssuer.createStartupResolver(store()).resolve({ currentBootWitness: witness })).safeSummary).includes("fake-boot"), false);
console.log("transcode probe migration marker tests passed");
