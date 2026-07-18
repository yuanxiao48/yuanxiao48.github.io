import assert from "node:assert/strict";
import {
	createManifestContentIdentity,
	manifestIdentityByteLength,
	sameManifestContentIdentity,
} from "../shared/transcode-manifest-identity.mjs";
import { createStartupRecoveryManifestAdapter, RECOVERY_CODES } from "../shared/transcode-recovery-startup-adapter.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";

function job({ attempt = 0, state = "interrupted", extra = {} } = {}) {
	return {
		version: 1,
		id: jobId,
		state,
		createdAt: "2026-07-18T00:00:00.000Z",
		updatedAt: "2026-07-18T00:00:00.000Z",
		sourceType: "upload",
		runtime: { attempt, queuedAt: null, startedAt: null, finishedAt: null },
		...extra,
	};
}

function makeHarness({ initial = job(), writeFails = false } = {}) {
	let raw = Buffer.from(`${JSON.stringify(initial)}\n`);
	let inLock = false;
	let releases = 0;
	let writes = 0;
	const adapter = createStartupRecoveryManifestAdapter({
		validateJobId: (id) => id === jobId,
		withJobOperation: async (id, operation) => {
			assert.equal(id, jobId);
			assert.equal(inLock, false);
			inLock = true;
			try { return await operation(); }
			finally { inLock = false; releases += 1; }
		},
		readRawManifest: async () => Buffer.from(raw),
		validateManifest: (value) => {
			if (!value || value.id !== jobId || (value.runtime?.attempt !== undefined && !Number.isSafeInteger(value.runtime.attempt))) throw new Error("invalid");
			return value;
		},
		serializeManifest: async (value) => Buffer.from(`${JSON.stringify(value)}\n`),
		atomicWriteManifest: async (id, bytes) => {
			assert.equal(inLock, true);
			assert.equal(id, jobId);
			if (writeFails) throw new Error("write failed");
			writes += 1;
			raw = Buffer.from(bytes);
		},
	});
	return {
		adapter,
		setRaw(value) { raw = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`); },
		getRaw: () => Buffer.from(raw),
		getReleases: () => releases,
		getWrites: () => writes,
	};
}

const compact = Buffer.from('{"a":1}\n');
const spaced = Buffer.from('{ "a": 1 }\n');
const compactIdentity = createManifestContentIdentity(compact);
assert.equal(Object.isFrozen(compactIdentity), true);
assert.equal(manifestIdentityByteLength(compactIdentity), compact.byteLength);
assert.equal(compactIdentity.sha256.length, 64);
assert.equal(JSON.stringify(compactIdentity).includes(compactIdentity.sha256), false);
assert.equal(sameManifestContentIdentity(compactIdentity, createManifestContentIdentity(Buffer.from(compact))), true);
assert.equal(sameManifestContentIdentity(compactIdentity, createManifestContentIdentity(spaced)), false);
assert.notEqual(manifestIdentityByteLength(compactIdentity), manifestIdentityByteLength(createManifestContentIdentity(Buffer.concat([compact, Buffer.from(" ")]))));

const harness = makeHarness({ initial: job({ extra: { unknownTopLevel: { preserved: true } } }) });
const before = await harness.adapter.readJob(jobId);
assert.equal(before.job.unknownTopLevel.preserved, true);
const next = structuredClone(before.job);
next.error = { code: "STUDIO_RESTARTED", message: "safe" };
const written = await harness.adapter.persistJobAtomic({
	jobId,
	expectedIdentity: before.identity,
	expectedGeneration: before.generation,
	nextManifest: next,
});
assert.equal(written.ok, true);
assert.equal(harness.getWrites(), 1);
assert.equal(harness.getReleases(), 1);
assert.equal(sameManifestContentIdentity(before.identity, written.record.identity), false);
assert.equal(JSON.stringify(written.record).includes(written.record.identity.sha256), false);

const changed = await harness.adapter.readJob(jobId);
harness.setRaw(job({ extra: { changed: true } }));
const changedResult = await harness.adapter.persistJobAtomic({ jobId, expectedIdentity: changed.identity, expectedGeneration: changed.generation, nextManifest: structuredClone(changed.job) });
assert.equal(changedResult.ok, false);
assert.equal(changedResult.code, RECOVERY_CODES.changed);
assert.equal(harness.getWrites(), 1);

const generationHarness = makeHarness();
const generationRecord = await generationHarness.adapter.readJob(jobId);
const generationResult = await generationHarness.adapter.persistJobAtomic({
	jobId,
	expectedIdentity: generationRecord.identity,
	expectedGeneration: 1,
	nextManifest: structuredClone(generationRecord.job),
});
assert.equal(generationResult.ok, false);
assert.equal(generationResult.code, RECOVERY_CODES.generation);
assert.equal(generationHarness.getWrites(), 0);

const nullGenerationHarness = makeHarness({ initial: { ...job(), runtime: {} } });
const nullGenerationRecord = await nullGenerationHarness.adapter.readJob(jobId);
assert.equal(nullGenerationRecord.generation, null);
const nullGenerationNext = structuredClone(nullGenerationRecord.job);
nullGenerationNext.runtime = {};
const nullGenerationResult = await nullGenerationHarness.adapter.persistJobAtomic({
	jobId,
	expectedIdentity: nullGenerationRecord.identity,
	expectedGeneration: null,
	nextManifest: nullGenerationNext,
});
assert.equal(nullGenerationResult.ok, true);

const terminalHarness = makeHarness();
const terminalRecord = await terminalHarness.adapter.readJob(jobId);
terminalHarness.setRaw(job({ state: "completed" }));
const terminalResult = await terminalHarness.adapter.persistJobAtomic({
	jobId,
	expectedIdentity: terminalRecord.identity,
	expectedGeneration: terminalRecord.generation,
	nextManifest: structuredClone(terminalRecord.job),
});
assert.equal(terminalResult.terminalProtected, true);
assert.equal(terminalResult.code, RECOVERY_CODES.terminal);
assert.equal(terminalHarness.getWrites(), 0);

const failedWrite = makeHarness({ writeFails: true });
const failedRecord = await failedWrite.adapter.readJob(jobId);
const failedResult = await failedWrite.adapter.persistJobAtomic({
	jobId,
	expectedIdentity: failedRecord.identity,
	expectedGeneration: failedRecord.generation,
	nextManifest: structuredClone(failedRecord.job),
});
assert.equal(failedResult.ok, false);
assert.equal(failedResult.code, RECOVERY_CODES.write);
assert.equal(failedWrite.getReleases(), 1);

console.log("transcode recovery manifest CAS tests passed");
