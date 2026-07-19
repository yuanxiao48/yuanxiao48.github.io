import assert from "node:assert/strict";
import {
	createTranscodeProbeJournalAuthority,
	createTranscodeProbeJournalRawIdentity,
	sameTranscodeProbeJournalRawIdentity,
	TRANSCODE_PROBE_JOURNAL_CODES,
} from "../shared/transcode-probe-journal.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "b".repeat(64) };
const source = "/assets/audio/track.m4a";
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;
function createStore({ mode = "swapped" } = {}) {
	let raw = null;
	return {
		get raw() { return raw; },
		set raw(value) { raw = value === null ? null : Buffer.from(value); },
		async readJournalRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; },
		async compareAndSwapJournalRaw({ expectedIdentity, nextBytes }) {
			if (mode === "throw") throw new Error("hidden");
			if (mode !== "swapped") return { status: mode };
			if (!sameTranscodeProbeJournalRawIdentity(expectedIdentity, createTranscodeProbeJournalRawIdentity(raw))) return { status: "conflict" };
			raw = Buffer.from(nextBytes); return { status: "swapped" };
		},
	};
}
const authority = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
assert.equal(sameTranscodeProbeJournalRawIdentity(createTranscodeProbeJournalRawIdentity(Buffer.from("{}")), createTranscodeProbeJournalRawIdentity(Buffer.from("{}"))), true);
assert.equal(sameTranscodeProbeJournalRawIdentity(createTranscodeProbeJournalRawIdentity(Buffer.from("{}")), createTranscodeProbeJournalRawIdentity(Buffer.from("{}\n"))), false);
assert.equal(sameTranscodeProbeJournalRawIdentity(createTranscodeProbeJournalRawIdentity(Buffer.from('{"a":1,"b":2}')), createTranscodeProbeJournalRawIdentity(Buffer.from('{"b":2,"a":1}'))), false);
assert.equal(sameTranscodeProbeJournalRawIdentity(createTranscodeProbeJournalRawIdentity(null), createTranscodeProbeJournalRawIdentity(Buffer.alloc(0))), false);

const store = createStore();
const tx = authority.transactionIssuer.createRuntimeTransaction(store);
const add = await tx.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "11111111-1111-4111-8111-111111111111", entryGeneration: 1 });
assert.equal(add.ok, true);
assert.equal(JSON.stringify(add).includes(source), false);
assert.equal(authority.proofConsumer.consume(add.proof).ok, true);
assert.equal(authority.proofConsumer.consume(add.proof).code, TRANSCODE_PROBE_JOURNAL_CODES.proofAlreadyUsed);
assert.equal(createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize }).proofConsumer.consume(add.proof).code, TRANSCODE_PROBE_JOURNAL_CODES.proofInvalid);
assert.equal((await tx.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "22222222-2222-4222-8222-222222222222", entryGeneration: 1 })).code, TRANSCODE_PROBE_JOURNAL_CODES.sourceConflict);
assert.equal((await tx.clearProtectedEntry({})).code, TRANSCODE_PROBE_JOURNAL_CODES.handleInvalid);
assert.equal((await tx.clearProtectedEntry(add.cleanupHandle)).cleared, true);
assert.equal((await tx.clearProtectedEntry(add.cleanupHandle)).alreadyCleared, true);

const staleStore = createStore();
const staleTx = authority.transactionIssuer.createRuntimeTransaction(staleStore);
const stale = await staleTx.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "44444444-4444-4444-8444-444444444444", entryGeneration: 1 });
staleStore.raw = Buffer.from('{"schemaVersion":1,"entries":[]}');
assert.equal((await staleTx.clearProtectedEntry(stale.cleanupHandle)).code, TRANSCODE_PROBE_JOURNAL_CODES.entryMissing);

for (const mode of ["conflict", "failed", "throw"]) {
	const result = await authority.transactionIssuer.createRuntimeTransaction(createStore({ mode })).addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "33333333-3333-4333-8333-333333333333", entryGeneration: 1 });
	assert.equal(result.ok, false);
	assert.equal(result.proof, null);
	assert.equal(result.cleanupHandle, null);
}
console.log("transcode probe journal CAS tests passed");
