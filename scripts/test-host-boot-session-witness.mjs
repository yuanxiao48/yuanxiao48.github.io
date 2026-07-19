import assert from "node:assert/strict";
import {
	compareHostBootSessionWitness,
	normalizeHostBootSessionWitness,
	serializeHostBootSessionWitness,
} from "../shared/host-boot-session-witness.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const raw = { schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: digestA };
const normalized = normalizeHostBootSessionWitness(raw);
assert.equal(normalized.ok, true);
assert.equal(Object.isFrozen(normalized.witness), true);
assert.equal(JSON.stringify(normalized).includes(digestA), false);
raw.providerId = "changed";
assert.equal(serializeHostBootSessionWitness(normalized.witness).providerId, "windows-boot-id");

assert.equal(compareHostBootSessionWitness(normalized.witness, normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: digestA }).witness).relation, "same-session");
assert.equal(compareHostBootSessionWitness(normalized.witness, normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 1, bootSessionDigest: digestB }).witness).relation, "different-session");
assert.equal(compareHostBootSessionWitness(normalized.witness, normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "other-provider", providerVersion: 1, bootSessionDigest: digestB }).witness).relation, "incomparable");
assert.equal(compareHostBootSessionWitness(normalized.witness, normalizeHostBootSessionWitness({ schemaVersion: 1, providerId: "windows-boot-id", providerVersion: 2, bootSessionDigest: digestB }).witness).relation, "incomparable");

for (const invalid of [
	{ ...raw, bootSessionDigest: digestA.toUpperCase() },
	{ ...raw, bootSessionDigest: "a".repeat(63) },
	{ ...raw, providerId: "" },
	{ ...raw, providerId: "Invalid" },
	{ ...raw, providerId: "a".repeat(65) },
	{ ...raw, providerVersion: 0 },
	{ ...raw, providerVersion: 1.5 },
]) assert.equal(normalizeHostBootSessionWitness(invalid).ok, false);
assert.equal(normalizeHostBootSessionWitness({ ...raw, schemaVersion: 2 }).code, "BOOT_SESSION_WITNESS_UNSUPPORTED");
assert.equal(compareHostBootSessionWitness({}, normalized.witness).relation, "malformed");
assert.equal(JSON.stringify(compareHostBootSessionWitness(normalized.witness, normalized.witness)).includes(digestA), false);

console.log("host boot-session witness tests passed");
