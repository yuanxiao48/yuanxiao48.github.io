import assert from "node:assert/strict";
import {
	createTranscodeProbeJournalAuthority,
	TRANSCODE_PROBE_JOURNAL_CODES,
} from "../shared/transcode-probe-journal.mjs";
import {
	createRecoveryReaderLockContributionAuthority,
	createTranscodeSourceReaderLeaseAuthority,
} from "../shared/transcode-recovery-locks.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "e".repeat(64) };
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, entries: [{ schemaVersion: 1, entryId: "11111111-1111-4111-8111-111111111111", entryGeneration: 1, state: "protected", sourceReferenceVersion: 1, sourcePublicPath: "/assets/audio/track.m4a", bootWitness: witness }] }));
const store = { async readJournalRaw() { return { status: "present", bytes }; }, async compareAndSwapJournalRaw() { return { status: "swapped" }; } };
const authority = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
const resolved = await authority.createStartupResolver(store).resolve({ currentBootWitness: witness });
assert.equal(resolved.ok, true);
assert.equal(JSON.stringify(resolved.collection).includes("track"), false);
assert.throws(() => authority.finalCollectionConsumer.withEntries({}, () => {}));
assert.throws(() => createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize }).finalCollectionConsumer.withEntries(resolved.collection, () => {}));
let leases = 0;
const adapter = authority.createRecoveryContributionAdapter({
	mintRecoveryReaderLease: () => { leases += 1; return { ok: true, leaseToken: Object.freeze({}) }; },
	mintRecoveryReaderContribution: ({ sourcePublicPath, leaseToken }) => ({ ok: Boolean(sourcePublicPath && leaseToken), contribution: Object.freeze({}) }),
});
const contributions = adapter.createContributions(resolved.collection);
assert.equal(contributions.ok, true);
assert.equal(contributions.contributions.length, 1);
assert.equal(leases, 1);
assert.equal(JSON.stringify(contributions).includes("track"), false);
const leaseAuthority = createTranscodeSourceReaderLeaseAuthority();
const contributionAuthority = createRecoveryReaderLockContributionAuthority({
	normalizeLibrarySourceKey: normalize,
	readerLeaseConsumer: leaseAuthority.registryConsumer,
});
const c3aAdapter = authority.createRecoveryContributionAdapter({
	mintRecoveryReaderLease: () => leaseAuthority.issuer.mintRecoveryReaderLease(),
	mintRecoveryReaderContribution: (input) => contributionAuthority.issuer.mintRecoveryReaderContribution(input),
});
const c3aContributions = c3aAdapter.createContributions(resolved.collection);
assert.equal(c3aContributions.ok, true);
assert.equal(c3aContributions.contributions.length, 1);
assert.equal(JSON.stringify(c3aContributions).includes("track"), false);
const failed = authority.createRecoveryContributionAdapter({ mintRecoveryReaderLease: () => ({ ok: false }), mintRecoveryReaderContribution: () => ({ ok: true, contribution: {} }) }).createContributions(resolved.collection);
assert.equal(failed.code, TRANSCODE_PROBE_JOURNAL_CODES.contributionFailed);
console.log("transcode probe journal final collection tests passed");
