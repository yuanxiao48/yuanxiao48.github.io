const snapshots = new WeakMap();
const decoders = new WeakSet();
const consumers = new WeakSet();

const MAGIC = Buffer.from("SLS1", "ascii");
const HEADER_BYTES = 20;
const LUID_BYTES = 8;
const MAX_SESSION_COUNT = 4096;
const MAX_DOCUMENT_BYTES = HEADER_BYTES + (MAX_SESSION_COUNT * LUID_BYTES);
const SUPPORTED_LOGON_TYPES = new Set([2, 10, 11, 12]);

export const WINDOWS_LOGON_SESSION_SNAPSHOT_CODES = Object.freeze({
	invalid: "WINDOWS_LOGON_SNAPSHOT_INVALID",
	tooLarge: "WINDOWS_LOGON_SNAPSHOT_TOO_LARGE",
	magicInvalid: "WINDOWS_LOGON_SNAPSHOT_MAGIC_INVALID",
	versionUnsupported: "WINDOWS_LOGON_SNAPSHOT_VERSION_UNSUPPORTED",
	logonTypeUnsupported: "WINDOWS_LOGON_SNAPSHOT_LOGON_TYPE_UNSUPPORTED",
	countInvalid: "WINDOWS_LOGON_SNAPSHOT_COUNT_INVALID",
	lengthInvalid: "WINDOWS_LOGON_SNAPSHOT_LENGTH_INVALID",
	unsorted: "WINDOWS_LOGON_SNAPSHOT_UNSORTED",
	duplicate: "WINDOWS_LOGON_SNAPSHOT_DUPLICATE",
	currentMissing: "WINDOWS_LOGON_SNAPSHOT_CURRENT_MISSING",
	authorityMismatch: "WINDOWS_LOGON_SNAPSHOT_AUTHORITY_MISMATCH",
});

export const WINDOWS_LOGON_SESSION_SNAPSHOT_PROTOCOL = Object.freeze({
	magic: "SLS1",
	schemaVersion: 1,
	headerBytes: HEADER_BYTES,
	luidBytes: LUID_BYTES,
	maxSessionCount: MAX_SESSION_COUNT,
	maxDocumentBytes: MAX_DOCUMENT_BYTES,
});

function freeze(value) { return Object.freeze(value); }
function copyBytes(value) {
	if (Buffer.isBuffer(value)) return Buffer.from(value);
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}
function safeFailure(code) { return freeze({ ok: false, code, snapshot: null }); }

function decodeBytes(authority, value) {
	const bytes = copyBytes(value);
	if (!bytes) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.invalid);
	if (bytes.length > MAX_DOCUMENT_BYTES) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.tooLarge);
	if (bytes.length < HEADER_BYTES) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.lengthInvalid);
	if (!bytes.subarray(0, 4).equals(MAGIC)) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.magicInvalid);
	if (bytes.readUInt16LE(4) !== 1) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.versionUnsupported);
	const currentLogonType = bytes.readUInt16LE(6);
	if (!SUPPORTED_LOGON_TYPES.has(currentLogonType)) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.logonTypeUnsupported);
	const count = bytes.readUInt32LE(8);
	if (count < 1 || count > MAX_SESSION_COUNT) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.countInvalid);
	const expected = HEADER_BYTES + (count * LUID_BYTES);
	if (!Number.isSafeInteger(expected) || bytes.length !== expected) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.lengthInvalid);
	const current = Buffer.from(bytes.subarray(12, 20));
	const live = [];
	let currentFound = false;
	for (let index = 0; index < count; index += 1) {
		const item = Buffer.from(bytes.subarray(HEADER_BYTES + (index * LUID_BYTES), HEADER_BYTES + ((index + 1) * LUID_BYTES)));
		if (index > 0) {
			const order = Buffer.compare(live[index - 1], item);
			if (order === 0) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.duplicate);
			if (order > 0) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.unsorted);
		}
		if (Buffer.compare(item, current) === 0) currentFound = true;
		live.push(item);
	}
	if (!currentFound) return safeFailure(WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.currentMissing);
	const snapshot = {};
	Object.defineProperties(snapshot, {
		kind: { value: "windows-logon-session-snapshot", enumerable: false },
		toJSON: { value: () => ({ kind: "windows-logon-session-snapshot" }), enumerable: false },
	});
	snapshots.set(snapshot, freeze({ authority, currentLuidBytes: current, liveLuidBytes: freeze(live), currentLogonType }));
	return freeze({ ok: true, code: null, snapshot: freeze(snapshot) });
}

export function isWindowsLogonSessionSnapshotDecoder(value) { return decoders.has(value); }
export function isWindowsLogonSessionSnapshotConsumer(value) { return consumers.has(value); }

export function createWindowsLogonSessionSnapshotProtocolAuthority() {
	const authority = {};
	const decoder = freeze({ decode(value) { return decodeBytes(authority, value); } });
	const snapshotConsumer = freeze({
		consume(snapshot, callback) {
			const details = snapshots.get(snapshot);
			if (!details || details.authority !== authority) return freeze({ ok: false, code: WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.authorityMismatch, value: null });
			if (typeof callback !== "function") return freeze({ ok: false, code: WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.invalid, value: null });
			try {
				const value = callback(freeze({
					currentLuidBytes: Buffer.from(details.currentLuidBytes),
					liveLuidBytes: freeze(details.liveLuidBytes.map((item) => Buffer.from(item))),
					currentLogonType: details.currentLogonType,
				}));
				return freeze({ ok: true, code: null, value });
			} catch {
				return freeze({ ok: false, code: WINDOWS_LOGON_SESSION_SNAPSHOT_CODES.invalid, value: null });
			}
		},
	});
	decoders.add(decoder);
	consumers.add(snapshotConsumer);
	return freeze({ decoder, snapshotConsumer });
}
