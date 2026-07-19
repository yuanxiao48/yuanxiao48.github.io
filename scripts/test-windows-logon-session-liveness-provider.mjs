import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHostExecutionContainmentComparisonAuthority, HOST_EXECUTION_CONTAINMENT_RESULTS } from "../shared/host-execution-containment-comparison.mjs";
import { createWindowsLogonSessionSnapshotProtocolAuthority } from "../shared/windows-logon-session-snapshot-protocol.mjs";
import { createWindowsLogonSessionLivenessProvider } from "../shared/windows-logon-session-liveness-provider.mjs";

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function raw() {
	const bytes = Buffer.alloc(36); bytes.write("SLS1", 0, "ascii"); bytes.writeUInt16LE(1, 4); bytes.writeUInt16LE(2, 6); bytes.writeUInt32LE(2, 8); bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 20); bytes.writeUInt32LE(2, 28); return bytes;
}
const protocol = createWindowsLogonSessionSnapshotProtocolAuthority();
const containment = createHostExecutionContainmentComparisonAuthority();
const decoded = protocol.decoder.decode(raw());
let runs = 0;
const provider = createWindowsLogonSessionLivenessProvider({
	snapshotRunner: { async runOnce() { runs += 1; return { ok: true, snapshot: decoded.snapshot }; } },
	snapshotConsumer: protocol.snapshotConsumer, containmentAuthority: containment, hash,
});
const [first, second] = await Promise.all([provider.getStartupState(), provider.getStartupState()]);
assert.equal(first.ok, true); assert.strictEqual(first, second); assert.equal(runs, 1);
const current = containment.startupStateConsumer.getCurrentWitness(first.startupState);
assert.equal(containment.startupStateConsumer.comparePersistedWitness(first.startupState, current).classification, HOST_EXECUTION_CONTAINMENT_RESULTS.retained);
const absent = { ...current.toJSON?.(), schemaVersion: 1, providerId: "windows-logon-session-liveness", providerVersion: 1, bootSessionDigest: "f".repeat(64) };
assert.equal(containment.startupStateConsumer.comparePersistedWitness(first.startupState, absent).classification, HOST_EXECUTION_CONTAINMENT_RESULTS.terminated);
assert.equal(JSON.stringify(first.startupState).includes("000000"), false);
const unavailable = createWindowsLogonSessionLivenessProvider({ snapshotRunner: { async runOnce() { return { ok: false, code: "NOPE" }; } }, snapshotConsumer: protocol.snapshotConsumer, containmentAuthority: containment, hash });
assert.equal((await unavailable.getStartupState()).unavailable, true);
assert.throws(() => createWindowsLogonSessionLivenessProvider({ snapshotRunner: {}, snapshotConsumer: protocol.snapshotConsumer, containmentAuthority: containment, hash }));
console.log("windows logon-session liveness provider tests passed");
