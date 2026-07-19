import assert from "node:assert/strict";
import { createTranscodeProbeJournalAuthority } from "../shared/transcode-probe-journal.mjs";

const source = "/assets/audio/track.m4a";
const same = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "c".repeat(64) };
const different = { ...same, bootSessionDigest: "d".repeat(64) };
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;
function document(entries) { return Buffer.from(`${JSON.stringify({ schemaVersion: 1, entries })}\n`); }
function entry(id, path, witness) { return { schemaVersion: 1, entryId: id, entryGeneration: 1, state: "protected", sourceReferenceVersion: 1, sourcePublicPath: path, bootWitness: witness }; }
function store(initial) {
	let raw = initial;
	return {
		async readJournalRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; },
		async compareAndSwapJournalRaw({ nextBytes }) { raw = Buffer.from(nextBytes); return { status: "swapped" }; },
	};
}
const authority = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
const initial = document([
	entry("11111111-1111-4111-8111-111111111111", source, same),
	entry("22222222-2222-4222-8222-222222222222", "/assets/audio/old.m4a", different),
]);
const result = await authority.createStartupResolver(store(initial)).resolve({ currentBootWitness: same });
assert.equal(result.ok, true);
assert.equal(result.summary.removedDifferentSessionCount, 1);
assert.equal(result.summary.finalEntryCount, 1);
assert.equal(result.summary.journalWasRewritten, true);
assert.equal(JSON.stringify(result.summary).includes(source), false);

const unavailable = await authority.createStartupResolver(store(initial)).resolve({ currentBootWitness: null });
assert.equal(unavailable.ok, true);
assert.equal(unavailable.summary.finalEntryCount, 2);
const malformed = await authority.createStartupResolver(store(Buffer.alloc(0))).resolve({ currentBootWitness: same });
assert.equal(malformed.ok, false);
assert.equal(malformed.collection, null);
const incomparable = await authority.createStartupResolver(store(document([entry("11111111-1111-4111-8111-111111111111", source, { ...same, providerId: "other-boot" })]))).resolve({ currentBootWitness: same });
assert.equal(incomparable.ok, true);
assert.equal(incomparable.summary.finalEntryCount, 1);
const casConflict = await authority.createStartupResolver({
	async readJournalRaw() { return { status: "present", bytes: initial }; },
	async compareAndSwapJournalRaw() { return { status: "conflict" }; },
}).resolve({ currentBootWitness: same });
assert.equal(casConflict.ok, false);
assert.equal(casConflict.collection, null);
let finalRead = 0;
const finalReadFailure = await authority.createStartupResolver({
	async readJournalRaw() { finalRead += 1; if (finalRead === 1) return { status: "present", bytes: document([entry("22222222-2222-4222-8222-222222222222", source, different)]) }; throw new Error("hidden"); },
	async compareAndSwapJournalRaw() { return { status: "swapped" }; },
}).resolve({ currentBootWitness: same });
assert.equal(finalReadFailure.ok, false);
assert.equal(finalReadFailure.collection, null);

let reads = 0;
const newlyObserved = entry("33333333-3333-4333-8333-333333333333", "/assets/audio/new.m4a", different);
const changingStore = {
	async readJournalRaw() {
		reads += 1;
		return { status: "present", bytes: reads === 1 ? document([entry("11111111-1111-4111-8111-111111111111", source, same)]) : document([entry("11111111-1111-4111-8111-111111111111", source, same), newlyObserved]) };
	},
	async compareAndSwapJournalRaw() { throw new Error("must not rewrite"); },
};
const changed = await authority.createStartupResolver(changingStore).resolve({ currentBootWitness: same });
assert.equal(changed.ok, true);
assert.equal(changed.summary.newlyObservedFinalEntryCount, 1);
assert.equal(changed.summary.finalEntryCount, 2);
assert.equal(reads, 2);
console.log("transcode probe journal recovery tests passed");
