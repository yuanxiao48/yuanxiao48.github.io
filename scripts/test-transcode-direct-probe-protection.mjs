import assert from "node:assert/strict";
import {
	createTranscodeProbeJournalAuthority,
} from "../shared/transcode-probe-journal.mjs";
import {
	createReasonAwareSourceLockRegistry,
	createTranscodeSourceReaderLeaseAuthority,
} from "../shared/transcode-recovery-locks.mjs";
import {
	createManagedSourceProbePermitAuthority,
} from "../shared/managed-source-probe.mjs";
import {
	createTranscodeDirectProbeProtectionAuthority,
	TRANSCODE_DIRECT_PROBE_PROTECTION_CODES,
} from "../shared/transcode-direct-probe-protection.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "a".repeat(64) };
const sourceA = "/assets/audio/a.m4a";
const sourceB = "/assets/audio/b.m4a";
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;

function createStore() {
	let raw = null;
	return {
		async readJournalRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; },
		async compareAndSwapJournalRaw({ nextBytes }) { raw = Buffer.from(nextBytes); return { status: "swapped" }; },
	};
}

async function setup({ source = sourceA } = {}) {
	const journal = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
	const transaction = journal.transactionIssuer.createRuntimeTransaction(createStore());
	const added = await transaction.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: source.endsWith("a.m4a") ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", entryGeneration: 1 });
	assert.equal(added.ok, true);
	const readers = createTranscodeSourceReaderLeaseAuthority();
	const registry = createReasonAwareSourceLockRegistry({ targetMap: new Map(), normalizeLibrarySourceKey: normalize, readerLeaseConsumer: readers.registryConsumer });
	const token = readers.issuer.mintRuntimeReaderLease().leaseToken;
	const acquired = registry.acquireRuntimeReader(source, token);
	assert.equal(acquired.ok, true);
	assert.ok(acquired.acquisitionProof);
	assert.ok(acquired.releaseHandle);
	const protection = createTranscodeDirectProbeProtectionAuthority({
		journalProofConsumer: journal.proofConsumer,
		journalCleanupConsumer: journal.cleanupConsumer,
		runtimeReaderAcquisitionConsumer: readers.runtimeAcquisitionConsumer,
		runtimeReaderReleaseConsumer: readers.runtimeReleaseConsumer,
	});
	const managed = createManagedSourceProbePermitAuthority({ directProtectionConsumer: protection.managedPermitConsumer });
	return { added, acquired, readers, registry, managed, protection };
}

assert.throws(() => createTranscodeDirectProbeProtectionAuthority({}), TypeError);

{
	const { added, protection } = await setup();
	const invalid = await protection.preparationIssuer.prepareManagedDirectProbePermit({
		journalProof: {}, journalCleanupHandle: added.cleanupHandle,
		bindings: { spawnPreparedProbe: () => ({ child: {}, knownChildControl: {} }), evaluateClosedProbe: () => ({ ok: true }) },
	});
	assert.equal(invalid.code, TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.journalProofInvalid);
}

{
	const { added, readers, registry, protection } = await setup({ source: sourceA });
	const otherReader = registry.acquireRuntimeReader(sourceB, readers.issuer.mintRuntimeReaderLease().leaseToken);
	const mismatch = await protection.preparationIssuer.prepareManagedDirectProbePermit({
		journalProof: added.proof,
		journalCleanupHandle: added.cleanupHandle,
		readerAcquisitionProof: otherReader.acquisitionProof,
		readerReleaseHandle: otherReader.releaseHandle,
		bindings: { spawnPreparedProbe: () => { throw new Error("must not spawn"); }, evaluateClosedProbe: () => ({ ok: true }) },
	});
	assert.equal(mismatch.code, TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.mismatch);
	assert.equal(readers.runtimeAcquisitionConsumer.consume(otherReader.acquisitionProof).ok, true, "preflight mismatch must not consume either proof");
}

{
	const { added, acquired, managed, protection } = await setup();
	const prepared = await protection.preparationIssuer.prepareManagedDirectProbePermit({
		journalProof: added.proof,
		journalCleanupHandle: added.cleanupHandle,
		readerAcquisitionProof: acquired.acquisitionProof,
		readerReleaseHandle: acquired.releaseHandle,
		bindings: { spawnPreparedProbe: () => ({ child: {}, knownChildControl: {} }), evaluateClosedProbe: () => ({ ok: true }) },
	});
	assert.equal(prepared.ok, true);
	assert.equal(JSON.stringify(prepared.claim).includes(sourceA), false);
	const minted = await managed.issuer.mintDirectLibrarySourcePermit({ directClaim: prepared.claim });
	assert.equal(minted.ok, true);
	assert.equal(managed.consumer.consume(minted.permit).ok, true);
	assert.equal(managed.consumer.consume(minted.permit).ok, false);
}

{
	const journalA = await setup();
	const journalB = await setup();
	const cross = await journalA.protection.preparationIssuer.prepareManagedDirectProbePermit({
		journalProof: journalB.added.proof,
		journalCleanupHandle: journalA.added.cleanupHandle,
		readerAcquisitionProof: journalA.registry.acquireRuntimeReader(sourceA, journalA.readers.issuer.mintRuntimeReaderLease().leaseToken).acquisitionProof,
		readerReleaseHandle: null,
		bindings: { spawnPreparedProbe: () => ({ child: {}, knownChildControl: {} }), evaluateClosedProbe: () => ({ ok: true }) },
	});
	assert.equal(cross.ok, false);
}

{
	const { registry, readers } = await setup();
	const token = readers.issuer.mintRuntimeReaderLease().leaseToken;
	const acquired = registry.acquireRuntimeReader(sourceA, token);
	assert.equal(registry.releaseRuntimeReader(sourceA, token).released, true);
	assert.equal(readers.runtimeAcquisitionConsumer.consume(acquired.acquisitionProof).ok, false, "release invalidates the prior proof");
	assert.equal(readers.runtimeReleaseConsumer.release(acquired.releaseHandle).ok, false);
}

console.log("transcode direct probe protection tests passed");
