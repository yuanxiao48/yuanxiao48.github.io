import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTranscodeProbeJournalAuthority } from "../shared/transcode-probe-journal.mjs";
import { createReasonAwareSourceLockRegistry, createTranscodeSourceReaderLeaseAuthority } from "../shared/transcode-recovery-locks.mjs";
import { createManagedSourceProbeManager, createManagedSourceProbePermitAuthority, MANAGED_SOURCE_PROBE_CODES } from "../shared/managed-source-probe.mjs";
import { createTranscodeDirectProbeProtectionAuthority } from "../shared/transcode-direct-probe-protection.mjs";

const witness = { schemaVersion: 1, providerId: "fake-boot", providerVersion: 1, bootSessionDigest: "b".repeat(64) };
const source = "/assets/audio/track.m4a";
const normalize = (value) => typeof value === "string" && value.startsWith("/assets/") ? value.toLowerCase() : null;
const tick = () => new Promise((resolve) => setImmediate(resolve));

class Stream extends EventEmitter {}
class Child extends EventEmitter {
	constructor() { super(); this.stdout = new Stream(); this.stderr = new Stream(); }
	close(code = 0) { this.emit("close", code, null); }
}

function store({ mode = "swapped" } = {}) {
	let raw = null;
	let currentMode = mode;
	return {
		setMode(value) { currentMode = value; },
		get raw() { return raw; },
		async readJournalRaw() { return raw === null ? { status: "missing" } : { status: "present", bytes: raw }; },
		async compareAndSwapJournalRaw({ nextBytes }) { if (currentMode !== "swapped") return { status: currentMode }; raw = Buffer.from(nextBytes); return { status: "swapped" }; },
	};
}

async function harness({ mode = "swapped", spawnPreparedProbe, evaluateClosedProbe } = {}) {
	const backing = store();
	const journal = createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey: normalize });
	const tx = journal.transactionIssuer.createRuntimeTransaction(backing);
	const added = await tx.addProtectedEntry({ sourcePublicPath: source, bootWitness: witness, entryId: "11111111-1111-4111-8111-111111111111", entryGeneration: 1 });
	assert.equal(added.ok, true);
	backing.setMode(mode);
	const readers = createTranscodeSourceReaderLeaseAuthority();
	const registry = createReasonAwareSourceLockRegistry({ targetMap: new Map(), normalizeLibrarySourceKey: normalize, readerLeaseConsumer: readers.registryConsumer });
	const acquired = registry.acquireRuntimeReader(source, readers.issuer.mintRuntimeReaderLease().leaseToken);
	const protection = createTranscodeDirectProbeProtectionAuthority({
		journalProofConsumer: journal.proofConsumer,
		journalCleanupConsumer: journal.cleanupConsumer,
		runtimeReaderAcquisitionConsumer: readers.runtimeAcquisitionConsumer,
		runtimeReaderReleaseConsumer: readers.runtimeReleaseConsumer,
	});
	const permits = createManagedSourceProbePermitAuthority({ directProtectionConsumer: protection.managedPermitConsumer });
	const prepared = await protection.preparationIssuer.prepareManagedDirectProbePermit({
		journalProof: added.proof,
		journalCleanupHandle: added.cleanupHandle,
		readerAcquisitionProof: acquired.acquisitionProof,
		readerReleaseHandle: acquired.releaseHandle,
		bindings: {
			spawnPreparedProbe,
			evaluateClosedProbe: evaluateClosedProbe || (() => ({ ok: true, value: null })),
		},
	});
	const minted = await permits.issuer.mintDirectLibrarySourcePermit({ directClaim: prepared.claim });
	const manager = createManagedSourceProbeManager({
		permitConsumer: permits.consumer,
		requestSoftStopKnownChild: async () => {},
		forceKillKnownChildTree: async () => {},
		scheduleTimer: () => ({}), cancelTimer: () => {}, createAttemptId: () => ({}),
		policy: { executionTimeoutMs: 10, softStopGraceMs: 5, stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
	});
	return { backing, registry, manager, prepared: minted };
}

{
	const child = new Child();
	const { backing, registry, manager, prepared } = await harness({ spawnPreparedProbe: () => ({ child, knownChildControl: {} }) });
	const handle = manager.start(prepared.permit);
	child.emit("error", new Error("private"));
	child.emit("exit", 1, null);
	await tick();
	assert.equal(registry.getLockView(source).hasRuntimeReader, true, "error and exit cannot release protection");
	child.close(1);
	const completion = await handle.completion;
	assert.equal(completion.code, MANAGED_SOURCE_PROBE_CODES.childError);
	assert.equal(registry.getLockView(source).hasRuntimeReader, false);
	assert.match(backing.raw.toString("utf8"), /"entries":\[\]/);
}

{
	const { backing, registry, manager, prepared } = await harness({ spawnPreparedProbe: () => { throw new Error("no child"); } });
	const completion = await manager.start(prepared.permit).completion;
	assert.equal(completion.code, MANAGED_SOURCE_PROBE_CODES.spawnFailed);
	assert.equal(registry.getLockView(source).hasRuntimeReader, false);
	assert.match(backing.raw.toString("utf8"), /"entries":\[\]/);
}

{
	const child = new Child();
	const { registry, manager, prepared } = await harness({ mode: "conflict", spawnPreparedProbe: () => ({ child, knownChildControl: {} }), evaluateClosedProbe: () => ({ ok: false, code: "PRIVATE" }) });
	const handle = manager.start(prepared.permit);
	child.close();
	const completion = await handle.completion;
	assert.equal(completion.businessProtectionFinalized, false);
	assert.equal(completion.protectionRetained, true);
	assert.equal(registry.getLockView(source).hasRuntimeReader, true, "clear conflict preserves runtime protection");
}

console.log("transcode direct probe finalization tests passed");
