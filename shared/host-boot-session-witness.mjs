/**
 * Opaque policy for a host boot-session witness. Providers belong in a future
 * production adapter; this module neither reads host state nor hashes raw IDs.
 */

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const witnesses = new WeakMap();

export const HOST_BOOT_SESSION_WITNESS_CODES = Object.freeze({
	invalid: "BOOT_SESSION_WITNESS_INVALID",
	unsupported: "BOOT_SESSION_WITNESS_UNSUPPORTED",
	incomparable: "BOOT_SESSION_WITNESS_INCOMPARABLE",
});

function freeze(value) {
	return Object.freeze(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDetails(value) {
	return record(value)
		&& value.schemaVersion === 1
		&& typeof value.providerId === "string"
		&& PROVIDER_ID.test(value.providerId)
		&& Number.isSafeInteger(value.providerVersion)
		&& value.providerVersion > 0
		&& typeof value.bootSessionDigest === "string"
		&& DIGEST.test(value.bootSessionDigest);
}

function safeResult(ok, code, witness = null) {
	return freeze({ ok, code, ...(witness ? { witness } : {}) });
}

/**
 * Accepts only an already-digested, versioned provider result. The digest is
 * held in a private WeakMap and cannot be emitted through ordinary JSON.
 */
export function normalizeHostBootSessionWitness(value) {
	if (!validDetails(value)) return safeResult(false, value?.schemaVersion !== undefined && value?.schemaVersion !== 1
		? HOST_BOOT_SESSION_WITNESS_CODES.unsupported
		: HOST_BOOT_SESSION_WITNESS_CODES.invalid);
	const details = freeze({
		schemaVersion: 1,
		providerId: value.providerId,
		providerVersion: value.providerVersion,
		bootSessionDigest: value.bootSessionDigest,
	});
	const witness = {};
	Object.defineProperties(witness, {
		kind: { value: "host-boot-session-witness", enumerable: false },
		toJSON: { value: () => ({ kind: "host-boot-session-witness" }), enumerable: false },
	});
	witnesses.set(witness, details);
	return safeResult(true, null, freeze(witness));
}

export function isHostBootSessionWitness(value) {
	return value !== null && typeof value === "object" && witnesses.has(value);
}

/**
 * Explicit internal serialization for trusted manifest writers only.
 */
export function serializeHostBootSessionWitness(witness) {
	const details = witnesses.get(witness);
	return details ? freeze({ ...details }) : null;
}

export function compareHostBootSessionWitness(previous, current) {
	const left = witnesses.get(previous);
	const right = witnesses.get(current);
	if (!left || !right) return freeze({ relation: "malformed", code: HOST_BOOT_SESSION_WITNESS_CODES.invalid });
	if (left.schemaVersion !== right.schemaVersion) return freeze({ relation: "unsupported", code: HOST_BOOT_SESSION_WITNESS_CODES.unsupported });
	if (left.providerId !== right.providerId || left.providerVersion !== right.providerVersion) {
		return freeze({ relation: "incomparable", code: HOST_BOOT_SESSION_WITNESS_CODES.incomparable });
	}
	return freeze({
		relation: left.bootSessionDigest === right.bootSessionDigest ? "same-session" : "different-session",
		code: null,
	});
}
