import assert from "node:assert/strict";
import {
	createTranscodeProbeJournalAuthority,
	TRANSCODE_PROBE_JOURNAL_CODES,
} from "../shared/transcode-probe-journal.mjs";
import { normalizeHostBootSessionWitness } from "../shared/host-boot-session-witness.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "a".repeat(64) };
const source = "/assets/audio/track.m4a";
function normalize(value) { return typeof value === "string" && value.toLowerCase().startsWith("/assets/") ? value.toLowerCase() : null; }
function storage(initial = null) {
	let raw = initial;
	return {
		async readJournalRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; },
		async compareAndSwapJournalRaw({ nextBytes }) { raw = Buffer.from(nextBytes); return { status: "swapped" }; },
	};
}
const authority = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize, policy: { maxRawBytes: 1024, maxEntries: 2, maxSourceBytes: 64 } });
const transaction = authority.transactionIssuer.createRuntimeTransaction(storage());
assert.equal(authority.getPolicy().maxEntries, 2);
assert.equal(JSON.stringify(authority.getPolicy()).includes(source), false);
assert.equal((await transaction.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "11111111-1111-4111-8111-111111111111", entryGeneration: 1 })).ok, true);
assert.equal((await authority.transactionIssuer.createRuntimeTransaction(storage()).addProtectedEntry({ sourcePublicPath: source, bootWitness: normalizeHostBootSessionWitness(witness).witness, entryId: "99999999-9999-4999-8999-999999999999", entryGeneration: 1 })).ok, true);

function validEntry(overrides = {}) {
	return { schemaVersion: 1, entryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", entryGeneration: 1, state: "protected", sourceReferenceVersion: 1, sourcePublicPath: source, bootWitness: witness, ...overrides };
}
for (const document of [
	{ schemaVersion: 2, entries: [] },
	{ schemaVersion: 1 },
	{ schemaVersion: 1, entries: {} },
	{ schemaVersion: 1, entries: [validEntry({ entryId: "BAD" })] },
	{ schemaVersion: 1, entries: [validEntry({ entryGeneration: 0 })] },
	{ schemaVersion: 1, entries: [validEntry({ entryGeneration: Number.MAX_SAFE_INTEGER + 1 })] },
	{ schemaVersion: 1, entries: [validEntry({ state: "active" })] },
	{ schemaVersion: 1, entries: [validEntry({ sourceReferenceVersion: 2 })] },
	{ schemaVersion: 1, entries: [validEntry({ bootWitness: { ...witness, providerVersion: 0 } })] },
	{ schemaVersion: 1, entries: [validEntry(), validEntry()] },
]) {
	const result = await authority.transactionIssuer.createRuntimeTransaction(storage(Buffer.from(JSON.stringify(document)))).addProtectedEntry({ sourcePublicPath: "/assets/audio/other.m4a", bootWitness: witness, entryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", entryGeneration: 1 });
	assert.equal(result.ok, false);
}

for (const raw of [Buffer.alloc(0), Buffer.from(" \n\t"), Buffer.from("{\"schemaVersion\":1,\"schemaVersion\":1,\"entries\":[]}"), Buffer.from("{\"schemaVersion\":1,\"entries\":[],}"), Buffer.from("{\"schemaVersion\":1,\"entries\":[],\"pid\":1}")]) {
	const result = await authority.transactionIssuer.createRuntimeTransaction(storage(raw)).addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "22222222-2222-4222-8222-222222222222", entryGeneration: 1 });
	assert.equal(result.ok, false);
}

const duplicateEscaped = Buffer.from(`{"schemaVersion":1,"entries":[{"schemaVersion":1,"entryId":"33333333-3333-4333-8333-333333333333","entryGeneration":1,"state":"protected","st\\u0061te":"protected","sourceReferenceVersion":1,"sourcePublicPath":"${source}","bootWitness":${JSON.stringify(witness)}}]}`);
const duplicateResult = await authority.transactionIssuer.createRuntimeTransaction(storage(duplicateEscaped)).addProtectedEntry({ sourcePublicPath: "/assets/audio/other.m4a", bootWitness: witness, entryId: "44444444-4444-4444-8444-444444444444", entryGeneration: 1 });
assert.equal(duplicateResult.code, TRANSCODE_PROBE_JOURNAL_CODES.duplicateKey);

const invalidSource = await authority.transactionIssuer.createRuntimeTransaction(storage()).addProtectedEntry({ sourcePublicPath: "C:\\unsafe.m4a", bootWitness: witness, entryId: "55555555-5555-4555-8555-555555555555", entryGeneration: 1 });
assert.equal(invalidSource.code, TRANSCODE_PROBE_JOURNAL_CODES.sourceInvalid);
const collision = authority.transactionIssuer.createRuntimeTransaction(storage());
assert.equal((await collision.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "12121212-1212-4212-8212-121212121212", entryGeneration: 1 })).ok, true);
assert.equal((await collision.addProtectedEntry({ sourcePublicPath: source.toUpperCase(), bootWitness: witness, entryId: "13131313-1313-4313-8313-131313131313", entryGeneration: 1 })).code, TRANSCODE_PROBE_JOURNAL_CODES.sourceConflict);
const invalidWitness = await authority.transactionIssuer.createRuntimeTransaction(storage()).addProtectedEntry({ sourcePublicPath: source, bootWitness: { ...witness, bootSessionDigest: "A".repeat(64) }, entryId: "66666666-6666-4666-8666-666666666666", entryGeneration: 1 });
assert.equal(invalidWitness.code, TRANSCODE_PROBE_JOURNAL_CODES.witnessInvalid);
const oversized = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize, policy: { maxRawBytes: 10, maxEntries: 2, maxSourceBytes: 64 } });
assert.equal((await oversized.transactionIssuer.createRuntimeTransaction(storage()).addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "77777777-7777-4777-8777-777777777777", entryGeneration: 1 })).code, TRANSCODE_PROBE_JOURNAL_CODES.tooLarge);
assert.equal(JSON.stringify(duplicateResult).includes(source), false);
console.log("transcode probe journal schema tests passed");
