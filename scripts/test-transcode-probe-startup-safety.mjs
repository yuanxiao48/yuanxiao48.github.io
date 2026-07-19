import assert from "node:assert/strict";
import { createTranscodeProbeJournalAuthority } from "../shared/transcode-probe-journal.mjs";
import { createTranscodeProbeMigrationBarrierAuthority } from "../shared/transcode-probe-migration-barrier.mjs";
import { combineTranscodeRecoveryLockPlans, createRecoveryLockPlan, createRecoveryReaderLockContributionAuthority, createTranscodeSourceReaderLeaseAuthority } from "../shared/transcode-recovery-locks.mjs";
import { createTranscodeProbeStartupSafetyAuthority, TRANSCODE_PROBE_STARTUP_SAFETY_CODES } from "../shared/transcode-probe-startup-safety.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";
const source = "/assets/audio/track.m4a";
const one = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "d".repeat(64) };
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;

function journalStore() {
	let raw = Buffer.from(JSON.stringify({ schemaVersion: 1, entries: [{ schemaVersion: 1, entryId: jobId, entryGeneration: 1, state: "protected", sourceReferenceVersion: 1, sourcePublicPath: source, bootWitness: one }] }));
	return { async readJournalRaw() { return { status: "present", bytes: raw }; }, async compareAndSwapJournalRaw({ nextBytes }) { raw = Buffer.from(nextBytes); return { status: "swapped" }; } };
}
function markerStore() {
	let raw = null;
	return { async readMarkerRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; }, async compareAndSwapMarkerRaw({ nextBytes }) { raw = Buffer.from(nextBytes); return { status: "swapped" }; } };
}

const journal = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
const finalJournal = await journal.createStartupResolver(journalStore()).resolve({ currentBootWitness: one });
assert.equal(finalJournal.ok, true);
const leases = createTranscodeSourceReaderLeaseAuthority();
const contributions = createRecoveryReaderLockContributionAuthority({ normalizeLibrarySourceKey: normalize, readerLeaseConsumer: leases.registryConsumer });
const adapter = journal.createRecoveryContributionAdapter({
	mintRecoveryReaderLease: () => leases.issuer.mintRecoveryReaderLease(),
	mintRecoveryReaderContribution: (input) => contributions.issuer.mintRecoveryReaderContribution(input),
});
const barrierAuthority = createTranscodeProbeMigrationBarrierAuthority();
const barrier = await barrierAuthority.resolverIssuer.createStartupResolver(markerStore()).resolve({ currentBootWitness: one });
assert.equal(barrier.ok, true);
const manifest = createRecoveryLockPlan({ snapshots: [{ job: { id: jobId, state: "ready", sourceType: "library", sourcePublicPath: source } }], normalizeLibrarySourceKey: normalize });
assert.equal(manifest.ok, true);

const safety = createTranscodeProbeStartupSafetyAuthority({
	journalRecoveryContributionAdapter: adapter,
	combineSourceLockPlans: ({ manifestPlan, contributions: items }) => combineTranscodeRecoveryLockPlans({ plan: manifestPlan, contributionConsumer: contributionsAuthority.contributionConsumer, contributions: items }),
	barrierViewConsumer: barrierAuthority.barrierViewConsumer,
});
const contributionsAuthority = contributions;
const bundle = safety.builder.build({ manifestPlan: manifest.plan, finalJournalCollection: finalJournal.collection, migrationBarrierView: barrier.barrierView });
assert.equal(bundle.ok, true);
assert.equal(bundle.safeSummary.barrierActive, true);
assert.equal("canListen" in bundle.safeSummary, false);
assert.equal(JSON.stringify(bundle.bundle).includes(source), false);
let consumed = null;
assert.equal(safety.bundleConsumer.consume(bundle.bundle, (value) => { consumed = value; }).ok, true);
assert.ok(consumed.combinedSourceLockPlan);
assert.equal(barrierAuthority.barrierViewConsumer.inspect(consumed.migrationBarrierView).barrierActive, true);
assert.equal(safety.bundleConsumer.consume(bundle.bundle, () => {}).code, TRANSCODE_PROBE_STARTUP_SAFETY_CODES.bundleAlreadyUsed);
assert.equal(safety.builder.build({ manifestPlan: {}, finalJournalCollection: finalJournal.collection, migrationBarrierView: barrier.barrierView }).ok, false);
assert.equal(safety.builder.build({ manifestPlan: manifest.plan, finalJournalCollection: {}, migrationBarrierView: barrier.barrierView }).code, TRANSCODE_PROBE_STARTUP_SAFETY_CODES.contributionFailed);
assert.equal(safety.builder.build({ manifestPlan: manifest.plan, finalJournalCollection: finalJournal.collection, migrationBarrierView: {} }).code, TRANSCODE_PROBE_STARTUP_SAFETY_CODES.barrierInvalid);

console.log("transcode probe startup safety tests passed");
