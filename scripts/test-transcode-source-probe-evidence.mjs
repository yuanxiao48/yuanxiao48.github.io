import assert from "node:assert/strict";
import { normalizeHostBootSessionWitness } from "../shared/host-boot-session-witness.mjs";
import {
	createSourceProbeEvidence,
	evaluateSourceProbeEvidenceClear,
	normalizeSourceProbeEvidence,
} from "../shared/transcode-recovery.mjs";
import { evaluateSourceProbeEvidencePersistence } from "../shared/transcode-source-access-recovery.mjs";

const witness = normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: "c".repeat(64) }).witness;
const evidence = createSourceProbeEvidence({ generation: 7, bootWitness: witness });
assert.equal(evidence.version, 1);
assert.equal(evidence.active, true);
assert.equal(evidence.generation, 7);
assert.equal("pid" in evidence, false);
assert.equal("path" in evidence, false);
assert.equal("argv" in evidence, false);
assert.equal(normalizeSourceProbeEvidence(evidence).malformed, false);
assert.equal(evaluateSourceProbeEvidencePersistence({ evidence, persisted: false }).status, "spawnBlocked");
assert.equal(evaluateSourceProbeEvidencePersistence({ evidence, persisted: true }).status, "spawnPermitted");
assert.equal(evaluateSourceProbeEvidenceClear({ evidence, generation: 7, closeConfirmed: false }).permitted, false);
assert.equal(evaluateSourceProbeEvidenceClear({ evidence, generation: 6, closeConfirmed: true }).permitted, false);
assert.equal(evaluateSourceProbeEvidenceClear({ evidence, generation: 7, closeConfirmed: true }).permitted, true);
assert.equal(normalizeSourceProbeEvidence({ ...evidence, generation: -1 }).malformed, true);
assert.equal(JSON.stringify(evaluateSourceProbeEvidencePersistence({ evidence, persisted: false })).includes("c".repeat(64)), false);

console.log("transcode source-probe evidence tests passed");
