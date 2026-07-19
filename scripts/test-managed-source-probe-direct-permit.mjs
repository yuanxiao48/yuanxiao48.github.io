import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTranscodeProbeJournalAuthority } from "../shared/transcode-probe-journal.mjs";
import { createReasonAwareSourceLockRegistry, createTranscodeSourceReaderLeaseAuthority } from "../shared/transcode-recovery-locks.mjs";
import { createManagedSourceProbeManager, createManagedSourceProbePermitAuthority, MANAGED_SOURCE_PROBE_CODES } from "../shared/managed-source-probe.mjs";
import { createTranscodeDirectProbeProtectionAuthority } from "../shared/transcode-direct-probe-protection.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "c".repeat(64) };
const source = "/assets/a.m4a";
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;
class Stream extends EventEmitter {}
class Child extends EventEmitter { constructor() { super(); this.stdout = new Stream(); this.stderr = new Stream(); } close() { this.emit("close", 0, null); } }

function manager(authority) {
	return createManagedSourceProbeManager({ permitConsumer: authority.consumer, requestSoftStopKnownChild: async () => {}, forceKillKnownChildTree: async () => {}, scheduleTimer: () => ({}), cancelTimer: () => {}, createAttemptId: () => ({}), policy: { executionTimeoutMs: 10, softStopGraceMs: 5, stdoutMaxBytes: 64, stderrMaxBytes: 64 } });
}

{
	const plain = createManagedSourceProbePermitAuthority();
	assert.equal(plain.issuer.mintDirectLibrarySourcePermit().code, MANAGED_SOURCE_PROBE_CODES.directProtectionUnavailable);
	assert.equal(JSON.stringify(plain), "{\"issuer\":{},\"consumer\":{}}");
	assert.equal(manager(plain).start({}).completion instanceof Promise, true);
}

{
	const journal = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
	let raw = null;
	const tx = journal.transactionIssuer.createRuntimeTransaction({ async readJournalRaw() { return raw ? { status: "present", bytes: raw } : { status: "missing" }; }, async compareAndSwapJournalRaw({ nextBytes }) { raw = Buffer.from(nextBytes); return { status: "swapped" }; } });
	const added = await tx.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "11111111-1111-4111-8111-111111111111", entryGeneration: 1 });
	const readers = createTranscodeSourceReaderLeaseAuthority();
	const registry = createReasonAwareSourceLockRegistry({ targetMap: new Map(), normalizeLibrarySourceKey: normalize, readerLeaseConsumer: readers.registryConsumer });
	const acquired = registry.acquireRuntimeReader(source, readers.issuer.mintRuntimeReaderLease().leaseToken);
	assert.throws(() => createManagedSourceProbePermitAuthority({ directProtectionConsumer: {} }), TypeError);
	const protection = createTranscodeDirectProbeProtectionAuthority({ journalProofConsumer: journal.proofConsumer, journalCleanupConsumer: journal.cleanupConsumer, runtimeReaderAcquisitionConsumer: readers.runtimeAcquisitionConsumer, runtimeReaderReleaseConsumer: readers.runtimeReleaseConsumer });
	const first = createManagedSourceProbePermitAuthority({ directProtectionConsumer: protection.managedPermitConsumer });
	assert.throws(() => createManagedSourceProbePermitAuthority({ directProtectionConsumer: protection.managedPermitConsumer }), TypeError);
	const child = new Child();
	const prepared = await protection.preparationIssuer.prepareManagedDirectProbePermit({ journalProof: added.proof, journalCleanupHandle: added.cleanupHandle, readerAcquisitionProof: acquired.acquisitionProof, readerReleaseHandle: acquired.releaseHandle, bindings: { spawnPreparedProbe: () => ({ child, knownChildControl: {} }), evaluateClosedProbe: () => ({ ok: true, value: null }) } });
	assert.equal(prepared.ok, true);
	const minted = await first.issuer.mintDirectLibrarySourcePermit({ directClaim: prepared.claim });
	assert.equal(minted.ok, true);
	const started = manager(first).start(minted.permit);
	child.close();
	assert.equal((await started.completion).status, "completed");
	const duplicate = manager(first).start(minted.permit);
	assert.equal((await duplicate.completion).code, MANAGED_SOURCE_PROBE_CODES.permitAlreadyUsed);
}

console.log("managed source probe direct permit tests passed");
