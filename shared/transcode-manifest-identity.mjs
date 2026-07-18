/**
 * Opaque, in-memory identity for a raw transcode manifest payload.
 * The digest intentionally cannot be serialized through JSON.
 */
import { createHash } from "node:crypto";

const identities = new WeakMap();

function asBytes(value) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError("Manifest identity requires raw bytes");
}

export function createManifestContentIdentity(rawBytes) {
	const bytes = asBytes(rawBytes);
	const details = Object.freeze({
		byteLength: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	const identity = {};
	Object.defineProperties(identity, {
		byteLength: { value: details.byteLength, enumerable: false },
		sha256: { value: details.sha256, enumerable: false },
		toJSON: { value: () => ({ kind: "transcode-manifest-content" }), enumerable: false },
	});
	identities.set(identity, details);
	return Object.freeze(identity);
}

export function isManifestContentIdentity(value) {
	return value !== null && typeof value === "object" && identities.has(value);
}

export function sameManifestContentIdentity(left, right) {
	const leftDetails = identities.get(left);
	const rightDetails = identities.get(right);
	return Boolean(leftDetails && rightDetails
		&& leftDetails.byteLength === rightDetails.byteLength
		&& leftDetails.sha256 === rightDetails.sha256);
}

export function manifestIdentityByteLength(identity) {
	return identities.get(identity)?.byteLength ?? null;
}
