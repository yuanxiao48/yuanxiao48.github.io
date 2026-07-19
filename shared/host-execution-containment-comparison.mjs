/**
 * Opaque startup containment policy. Windows data enters only through a
 * future trusted adapter; this module accepts fake canonical bytes for tests.
 */
import {
	isHostBootSessionWitness,
	normalizeHostBootSessionWitness,
	serializeHostBootSessionWitness,
	WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID,
	WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION,
} from "./host-boot-session-witness.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const LUID_BYTES = 8;
const MAX_LIVE_LUIDS = 4096;
const DOMAIN = Buffer.from("studio.execution-containment\0windows-logon-session-liveness\0v1\0", "ascii");
const SUPPORTED_LOGON_TYPES = Object.freeze([2, 10, 11, 12]);
const states = new WeakMap();
const consumers = new WeakMap();

export const HOST_EXECUTION_CONTAINMENT_CODES = Object.freeze({
	stateInvalid: "HOST_EXECUTION_CONTAINMENT_STATE_INVALID",
	stateAuthorityMismatch: "HOST_EXECUTION_CONTAINMENT_STATE_AUTHORITY_MISMATCH",
	witnessMalformed: "HOST_EXECUTION_CONTAINMENT_WITNESS_MALFORMED",
	providerIncomparable: "HOST_EXECUTION_CONTAINMENT_PROVIDER_INCOMPARABLE",
	unavailable: "HOST_EXECUTION_CONTAINMENT_UNAVAILABLE",
	snapshotInvalid: "WINDOWS_LOGON_SESSION_LIVENESS_SNAPSHOT_INVALID",
	currentLuidMissing: "WINDOWS_LOGON_SESSION_LIVENESS_CURRENT_LUID_MISSING",
	duplicateLuid: "WINDOWS_LOGON_SESSION_LIVENESS_DUPLICATE_LUID",
	unsorted: "WINDOWS_LOGON_SESSION_LIVENESS_UNSORTED",
	countExceeded: "WINDOWS_LOGON_SESSION_LIVENESS_COUNT_EXCEEDED",
	unsupportedLogonType: "WINDOWS_LOGON_SESSION_LIVENESS_LOGON_TYPE_UNSUPPORTED",
	hashFailed: "WINDOWS_LOGON_SESSION_LIVENESS_HASH_FAILED",
});

export const HOST_EXECUTION_CONTAINMENT_RESULTS = Object.freeze({
	retained: "retained-containment",
	terminated: "terminated-containment",
	incomparable: "incomparable",
	unavailable: "unavailable",
	malformed: "malformed",
});

export const WINDOWS_LOGON_SESSION_SUPPORTED_LOGON_TYPES = SUPPORTED_LOGON_TYPES;
export { WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID, WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION };

function freeze(value) { return Object.freeze(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function result(classification, code = null) {
	return freeze({ classification, code });
}

function bytes(value) {
	if (Buffer.isBuffer(value)) return Buffer.from(value);
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

function compareBytes(left, right) { return Buffer.compare(left, right); }

function normalizedWitness(value) {
	return isHostBootSessionWitness(value) ? value : normalizeHostBootSessionWitness(value).witness || null;
}

function currentWitness(state) {
	return states.get(state)?.currentWitness || null;
}

function isLivenessWitness(witness) {
	const details = serializeHostBootSessionWitness(witness);
	return details?.providerId === WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID
		&& details.providerVersion === WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION;
}

function digestLuid(hash, luid) {
	let digest;
	try { digest = hash(Buffer.concat([DOMAIN, luid])); } catch { return null; }
	return typeof digest === "string" && DIGEST.test(digest) ? digest : null;
}

function stateFor(authority, details) {
	const state = {};
	Object.defineProperties(state, {
		kind: { value: "host-execution-containment-startup-state", enumerable: false },
		toJSON: { value: () => ({ kind: "host-execution-containment-startup-state" }), enumerable: false },
	});
	states.set(state, freeze({ authority, ...details }));
	return freeze(state);
}

export function isHostExecutionContainmentStartupState(value) {
	return value !== null && typeof value === "object" && states.has(value);
}

export function getHostExecutionContainmentCurrentWitness(state) {
	return currentWitness(state);
}

export function compareHostExecutionContainment(state, persistedValue) {
	if (state === null || state === undefined) return result(HOST_EXECUTION_CONTAINMENT_RESULTS.unavailable, HOST_EXECUTION_CONTAINMENT_CODES.unavailable);
	const details = states.get(state);
	if (!details) return result(HOST_EXECUTION_CONTAINMENT_RESULTS.malformed, HOST_EXECUTION_CONTAINMENT_CODES.stateInvalid);
	const persisted = normalizedWitness(persistedValue);
	if (!persisted) return result(HOST_EXECUTION_CONTAINMENT_RESULTS.malformed, HOST_EXECUTION_CONTAINMENT_CODES.witnessMalformed);
	const previous = serializeHostBootSessionWitness(persisted);
	const current = serializeHostBootSessionWitness(details.currentWitness);
	if (!previous || !current) return result(HOST_EXECUTION_CONTAINMENT_RESULTS.malformed, HOST_EXECUTION_CONTAINMENT_CODES.witnessMalformed);
	if (previous.schemaVersion !== current.schemaVersion || previous.providerId !== current.providerId || previous.providerVersion !== current.providerVersion) {
		return result(HOST_EXECUTION_CONTAINMENT_RESULTS.incomparable, HOST_EXECUTION_CONTAINMENT_CODES.providerIncomparable);
	}
	if (details.strategy === "generic") {
		return previous.bootSessionDigest === current.bootSessionDigest
			? result(HOST_EXECUTION_CONTAINMENT_RESULTS.retained)
			: result(HOST_EXECUTION_CONTAINMENT_RESULTS.terminated);
	}
	return details.liveDigests.has(previous.bootSessionDigest)
		? result(HOST_EXECUTION_CONTAINMENT_RESULTS.retained)
		: result(HOST_EXECUTION_CONTAINMENT_RESULTS.terminated);
}

export function createHostExecutionContainmentComparisonAuthority() {
	const authority = {};
	const startupStateConsumer = freeze({
		getCurrentWitness(state) {
			const details = states.get(state);
			return details?.authority === authority ? details.currentWitness : null;
		},
		comparePersistedWitness(state, persistedWitness) {
			const details = states.get(state);
			return !details
				? result(HOST_EXECUTION_CONTAINMENT_RESULTS.malformed, HOST_EXECUTION_CONTAINMENT_CODES.stateInvalid)
				: details.authority !== authority
					? result(HOST_EXECUTION_CONTAINMENT_RESULTS.malformed, HOST_EXECUTION_CONTAINMENT_CODES.stateAuthorityMismatch)
					: compareHostExecutionContainment(state, persistedWitness);
		},
	});
	consumers.set(startupStateConsumer, authority);

	function createGenericStartupState({ currentWitness: value } = {}) {
		const witness = normalizedWitness(value);
		if (!witness) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.witnessMalformed, startupState: null });
		if (isLivenessWitness(witness)) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.unavailable, startupState: null });
		return freeze({ ok: true, code: null, startupState: stateFor(authority, { strategy: "generic", currentWitness: witness, liveDigests: null }) });
	}

	function createWindowsLogonSessionLivenessStartupState({ currentLuidBytes, liveLuidBytes, currentLogonType, hash } = {}) {
		if (!SUPPORTED_LOGON_TYPES.includes(currentLogonType)) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.unsupportedLogonType, startupState: null });
		if (typeof hash !== "function" || !Array.isArray(liveLuidBytes)) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.snapshotInvalid, startupState: null });
		if (liveLuidBytes.length === 0) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.currentLuidMissing, startupState: null });
		if (liveLuidBytes.length > MAX_LIVE_LUIDS) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.countExceeded, startupState: null });
		const current = bytes(currentLuidBytes);
		const live = liveLuidBytes.map(bytes);
		if (!current || current.length !== LUID_BYTES || live.some((item) => !item || item.length !== LUID_BYTES)) {
			return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.snapshotInvalid, startupState: null });
		}
		for (let index = 1; index < live.length; index += 1) {
			const order = compareBytes(live[index - 1], live[index]);
			if (order === 0) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.duplicateLuid, startupState: null });
			if (order > 0) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.unsorted, startupState: null });
		}
		if (!live.some((item) => compareBytes(item, current) === 0)) {
			return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.currentLuidMissing, startupState: null });
		}
		const currentDigest = digestLuid(hash, current);
		const liveDigests = new Set(live.map((item) => digestLuid(hash, item)));
		if (!currentDigest || liveDigests.size !== live.length || liveDigests.has(null)) {
			return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.hashFailed, startupState: null });
		}
		const witness = normalizeHostBootSessionWitness({
			schemaVersion: 1,
			providerId: WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_ID,
			providerVersion: WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_VERSION,
			bootSessionDigest: currentDigest,
		}).witness;
		if (!witness) return freeze({ ok: false, code: HOST_EXECUTION_CONTAINMENT_CODES.hashFailed, startupState: null });
		return freeze({ ok: true, code: null, startupState: stateFor(authority, { strategy: "liveness", currentWitness: witness, liveDigests: freeze(new Set(liveDigests)) }) });
	}

	return freeze({
		genericStartupStateIssuer: freeze({ createStartupState: createGenericStartupState }),
		windowsLogonSessionLivenessStartupStateIssuer: freeze({ createStartupState: createWindowsLogonSessionLivenessStartupState }),
		startupStateConsumer,
	});
}
