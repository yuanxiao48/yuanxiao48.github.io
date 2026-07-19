import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	createHostExecutionContainmentComparisonAuthority,
	compareHostExecutionContainment,
	getHostExecutionContainmentCurrentWitness,
	HOST_EXECUTION_CONTAINMENT_RESULTS,
	WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID,
} from "../shared/host-execution-containment-comparison.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const luid = (tail) => Buffer.from([0, 0, 0, 0, 0, 0, 0, tail]);
const authority = createHostExecutionContainmentComparisonAuthority();
const issuer = authority.windowsLogonSessionLivenessStartupStateIssuer;
const valid = issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1), luid(2)], currentLogonType: 2, hash });
assert.equal(valid.ok, true);
const current = getHostExecutionContainmentCurrentWitness(valid.startupState);
const currentDetails = (await import("../shared/host-boot-session-witness.mjs")).serializeHostBootSessionWitness(current);
assert.equal(currentDetails.providerId, WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID);
assert.equal(compareHostExecutionContainment(valid.startupState, current).classification, HOST_EXECUTION_CONTAINMENT_RESULTS.retained);
const absent = { ...currentDetails, bootSessionDigest: "f".repeat(64) };
assert.equal(compareHostExecutionContainment(valid.startupState, absent).classification, HOST_EXECUTION_CONTAINMENT_RESULTS.terminated);
assert.equal(JSON.stringify(valid.startupState).includes(currentDetails.bootSessionDigest), false);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1)], currentLogonType: 10, hash }).ok, true);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1)], currentLogonType: 11, hash }).ok, true);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1)], currentLogonType: 12, hash }).ok, true);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1)], currentLogonType: 3, hash }).ok, false);
assert.equal(issuer.createStartupState({ currentLuidBytes: Buffer.alloc(7), liveLuidBytes: [luid(1)], currentLogonType: 2, hash }).ok, false);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(2), liveLuidBytes: [luid(1)], currentLogonType: 2, hash }).ok, false);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(2), luid(1)], currentLogonType: 2, hash }).ok, false);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1), luid(1)], currentLogonType: 2, hash }).ok, false);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: Array.from({ length: 4097 }, (_, index) => Buffer.from([index & 255, (index >> 8) & 255, 0, 0, 0, 0, 0, 0])), currentLogonType: 2, hash }).ok, false);
assert.equal(issuer.createStartupState({ currentLuidBytes: luid(1), liveLuidBytes: [luid(1)], currentLogonType: 2, hash: () => "bad" }).ok, false);
console.log("windows logon-session liveness evidence tests passed");
