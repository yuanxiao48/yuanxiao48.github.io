import assert from "node:assert/strict";
import {
	createWindowsLogonSessionSnapshotProtocolAuthority,
	WINDOWS_LOGON_SESSION_SNAPSHOT_CODES,
	WINDOWS_LOGON_SESSION_SNAPSHOT_PROTOCOL,
} from "../shared/windows-logon-session-snapshot-protocol.mjs";

function luid(value) {
	const result = Buffer.alloc(8);
	result.writeUInt32BE(value, 4);
	return result;
}
function document({ type = 2, current = 2, live = [1, 2] } = {}) {
	const result = Buffer.alloc(20 + (live.length * 8));
	result.write("SLS1", 0, "ascii");
	result.writeUInt16LE(1, 4);
	result.writeUInt16LE(type, 6);
	result.writeUInt32LE(live.length, 8);
	luid(current).copy(result, 12);
	live.forEach((value, index) => luid(value).copy(result, 20 + (index * 8)));
	return result;
}

const first = createWindowsLogonSessionSnapshotProtocolAuthority();
const second = createWindowsLogonSessionSnapshotProtocolAuthority();
for (const type of [2, 10, 11, 12]) assert.equal(first.decoder.decode(document({ type })).ok, true);
assert.equal(first.decoder.decode(document({ live: [2] })).ok, true);
assert.equal(first.decoder.decode(document({ live: Array.from({ length: 4096 }, (_, index) => index + 1), current: 1 })).ok, true);

const cases = [
	[Buffer.alloc(0), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.lengthInvalid],
	[document({ live: [] }), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.countInvalid],
	[(() => { const value = document({ live: [1], current: 1 }); value.writeUInt32LE(4097, 8); return value; })(), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.countInvalid],
	[Buffer.concat([document(), Buffer.from([0])]), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.lengthInvalid],
	[document({ type: 3 }), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.logonTypeUnsupported],
	[document({ current: 9 }), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.currentMissing],
	[document({ live: [2, 1] }), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.unsorted],
	[document({ live: [1, 1], current: 1 }), WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.duplicate],
];
for (const [value, code] of cases) assert.equal(first.decoder.decode(value).code, code);
const badMagic = document(); badMagic.write("BAD!", 0, "ascii");
assert.equal(first.decoder.decode(badMagic).code, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.magicInvalid);
const badVersion = document(); badVersion.writeUInt16LE(2, 4);
assert.equal(first.decoder.decode(badVersion).code, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.versionUnsupported);

const mutable = document();
const decoded = first.decoder.decode(mutable);
mutable.fill(0);
assert.equal(decoded.ok, true);
assert.equal(Object.isFrozen(decoded.snapshot), true);
assert.deepEqual(JSON.parse(JSON.stringify(decoded.snapshot)), { kind: "windows-logon-session-snapshot" });
assert.equal(Object.keys(decoded.snapshot).includes("currentLuidBytes"), false);
assert.equal(first.snapshotConsumer.consume(decoded.snapshot, () => true).ok, true);
assert.equal(second.snapshotConsumer.consume(decoded.snapshot, () => true).code, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.authorityMismatch);
assert.equal(first.snapshotConsumer.consume({}, () => true).code, WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.authorityMismatch);
assert.equal(WINDOWS_LOGON_SESSION_SNAPSHOT_PROTOCOL.maxDocumentBytes, 32788);
console.log("windows logon-session snapshot protocol tests passed");
