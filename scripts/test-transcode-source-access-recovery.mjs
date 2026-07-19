import assert from "node:assert/strict";
import { normalizeHostBootSessionWitness } from "../shared/host-boot-session-witness.mjs";
import { createPreExecutionRecovery, createRecoveryHold } from "../shared/transcode-recovery.mjs";
import { createSourceAccessRecoveryResolver } from "../shared/transcode-source-access-recovery.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";
const nowIso = "2026-07-19T00:00:00.000Z";
const witnessA = normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: "a".repeat(64) }).witness;
const witnessB = normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: "b".repeat(64) }).witness;
const witnessOther = normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "other-provider", providerVersion: 1, bootSessionDigest: "b".repeat(64) }).witness;

function job(extra = {}) {
	return { id: jobId, state: "interrupted", sourceType: "library", sourcePublicPath: "/assets/a.m4a", runtime: { attempt: 2 }, ...extra };
}

function harness(initial, { persist = true, sourceValid = true } = {}) {
	let stored = structuredClone(initial);
	let writes = 0;
	const resolver = createSourceAccessRecoveryResolver({
		persistManifestCas: async ({ nextManifest }) => {
			writes += 1;
			if (!persist) return { ok: false };
			stored = structuredClone(nextManifest);
			return { ok: true };
		},
		validateSourceAccessSource: (value) => sourceValid && ["library", "upload"].includes(value.sourceType)
			? { ok: true, sourceType: value.sourceType }
			: { ok: false },
		nowIso: () => nowIso,
	});
	const context = {};
	return {
		resolve: (currentBootWitness) => resolver.resolve({ snapshot: { job: structuredClone(stored), identity: "identity", generation: 2 }, currentBootWitness, context }),
		stored: () => stored,
		writes: () => writes,
	};
}

const legacy = harness(job({ preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso }) }));
assert.equal((await legacy.resolve(null)).status, "holdRetained");
assert.equal(legacy.writes(), 0);
assert.equal((await legacy.resolve(witnessA)).status, "witnessRecorded");
assert.equal(legacy.stored().preExecutionRecovery.version, 2);
assert.equal((await legacy.resolve(witnessB)).status, "holdRetained");
assert.equal((await legacy.resolve(witnessA)).status, "holdRetained");

const same = harness(job({ preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso, sourceAccessWitness: witnessA, evidenceOrigin: "legacy-observed" }) }));
assert.equal((await same.resolve(witnessA)).status, "holdRetained");
assert.equal(same.writes(), 0);

const different = harness(job({
	recoveryHold: createRecoveryHold({ nowIso }),
	incompleteUploadDiscard: { version: 1, active: true, phase: "prepared", preparedAt: nowIso, code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD" },
	preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso, sourceAccessWitness: witnessA, evidenceOrigin: "managed-job-probe" }),
}));
assert.equal((await different.resolve(witnessB)).status, "holdCleared");
assert.equal(different.stored().state, "interrupted");
assert.equal(different.stored().preExecutionRecovery, undefined);
assert.equal(different.stored().recoveryHold.active, true);
assert.equal(different.stored().incompleteUploadDiscard.active, true);

const incomparable = harness(job({ preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso, sourceAccessWitness: witnessA, evidenceOrigin: "legacy-observed" }) }));
assert.equal((await incomparable.resolve(witnessOther)).code, "BOOT_SESSION_WITNESS_INCOMPARABLE");
assert.equal(incomparable.writes(), 0);

const malformed = harness(job({ preExecutionRecovery: { version: 2, active: true, code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso, sourceAccessWitness: { bad: true }, evidenceOrigin: "legacy-observed" } }));
assert.equal((await malformed.resolve(witnessA)).mustBlockListen, true);
assert.equal(malformed.writes(), 0);

const unrelatedMalformed = harness(job({ preExecutionRecovery: { version: 1, active: true, code: "TRANSCODE_RECOVERY_INCOMPLETE_UPLOAD", detectedAt: "bad" } }));
assert.equal((await unrelatedMalformed.resolve(witnessA)).status, "noAction");
assert.equal(unrelatedMalformed.writes(), 0);

const invalidSource = harness(job({ preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso, sourceAccessWitness: witnessA, evidenceOrigin: "legacy-observed" }) }), { sourceValid: false });
assert.equal((await invalidSource.resolve(witnessB)).code, "SOURCE_ACCESS_SOURCE_INVALID");

const failedClear = harness(job({ preExecutionRecovery: createPreExecutionRecovery({ code: "TRANSCODE_RECOVERY_SOURCE_ACCESS_UNCONFIRMED", detectedAt: nowIso, sourceAccessWitness: witnessA, evidenceOrigin: "legacy-observed" }) }), { persist: false });
assert.equal((await failedClear.resolve(witnessB)).mustBlockListen, true);

const terminal = harness(job({ state: "completed", preExecutionRecovery: { active: "malformed" } }));
assert.equal((await terminal.resolve(witnessB)).status, "terminalProtected");
assert.equal(terminal.writes(), 0);
assert.equal(JSON.stringify(await different.resolve(witnessB)).includes("/assets"), false);

console.log("transcode source-access recovery tests passed");
