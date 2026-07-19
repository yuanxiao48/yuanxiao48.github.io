/**
 * Pure policy for the one-time direct-probe migration barrier. Persistence and
 * boot-witness acquisition are explicit capabilities owned by future wiring.
 */
import { createHash } from "node:crypto";
import {
	compareHostBootSessionWitness,
	isHostBootSessionWitness,
	normalizeHostBootSessionWitness,
	serializeHostBootSessionWitness,
} from "./host-boot-session-witness.mjs";

const DEFAULT_POLICY = Object.freeze({ maxRawBytes: 8 * 1024 });
const identities = new WeakMap();
const views = new WeakMap();
const viewConsumers = new WeakSet();

const READ_OPERATIONS = new Set(["read", "list", "listing", "playback", "download"]);
const BLOCKED_OPERATIONS = new Set([
	"trash", "restore-target", "delete", "permanent-delete", "rename-source", "rename-target",
	"move-source", "move-target", "replace-source", "replace-target", "overwrite", "from-library", "direct-library-probe",
]);

export const TRANSCODE_PROBE_MIGRATION_CODES = Object.freeze({
	invalid: "TRANSCODE_PROBE_MIGRATION_MARKER_INVALID",
	tooLarge: "TRANSCODE_PROBE_MIGRATION_MARKER_TOO_LARGE",
	duplicateKey: "TRANSCODE_PROBE_MIGRATION_MARKER_DUPLICATE_KEY",
	witnessInvalid: "TRANSCODE_PROBE_MIGRATION_WITNESS_INVALID",
	witnessUnavailable: "TRANSCODE_PROBE_MIGRATION_WITNESS_UNAVAILABLE",
	readFailed: "TRANSCODE_PROBE_MIGRATION_MARKER_READ_FAILED",
	casConflict: "TRANSCODE_PROBE_MIGRATION_CAS_CONFLICT",
	casFailed: "TRANSCODE_PROBE_MIGRATION_CAS_FAILED",
	finalReadFailed: "TRANSCODE_PROBE_MIGRATION_FINAL_READ_FAILED",
	viewInvalid: "TRANSCODE_PROBE_MIGRATION_BARRIER_VIEW_INVALID",
	operationInvalid: "TRANSCODE_PROBE_MIGRATION_OPERATION_INVALID",
	barrierActive: "TRANSCODE_SOURCE_MIGRATION_BARRIER_ACTIVE",
});

function freeze(value) {
	return Object.freeze(value);
}

function exactKeys(value, expected) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bytesFrom(value) {
	if (Buffer.isBuffer(value)) return Buffer.from(value);
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

function policyFrom(value) {
	const policy = freeze({ ...DEFAULT_POLICY, ...(value || {}) });
	if (!Number.isSafeInteger(policy.maxRawBytes) || policy.maxRawBytes <= 0) throw new TypeError("Migration marker policy is invalid");
	return policy;
}

class StrictJsonError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

function strictParse(bytes, maxRawBytes) {
	if (bytes.byteLength > maxRawBytes) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.tooLarge);
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid); }
	let index = 0;
	const whitespace = () => { while (index < text.length && /[\u0020\u000a\u000d\u0009]/.test(text[index])) index += 1; };
	const invalid = () => { throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid); };
	const expect = (character) => { if (text[index] !== character) invalid(); index += 1; };
	const string = () => {
		expect('"'); let value = "";
		while (index < text.length) {
			const character = text[index++];
			if (character === '"') return value;
			if (character < " ") invalid();
			if (character !== "\\") { value += character; continue; }
			const escaped = text[index++];
			if (escaped === '"' || escaped === "\\" || escaped === "/") value += escaped;
			else if (escaped === "b") value += "\b";
			else if (escaped === "f") value += "\f";
			else if (escaped === "n") value += "\n";
			else if (escaped === "r") value += "\r";
			else if (escaped === "t") value += "\t";
			else if (escaped === "u") {
				const hex = text.slice(index, index + 4);
				if (!/^[0-9a-f]{4}$/i.test(hex)) invalid();
				value += String.fromCharCode(Number.parseInt(hex, 16)); index += 4;
			} else invalid();
		}
		invalid();
	};
	const number = () => {
		const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (!match) invalid(); index += match[0].length;
		const value = Number(match[0]); if (!Number.isFinite(value)) invalid(); return value;
	};
	const literal = (raw, value) => { if (text.slice(index, index + raw.length) !== raw) invalid(); index += raw.length; return value; };
	const value = () => {
		whitespace(); const character = text[index];
		if (character === '"') return string();
		if (character === "{") return object();
		if (character === "[") return array();
		if (character === "t") return literal("true", true);
		if (character === "f") return literal("false", false);
		if (character === "n") return literal("null", null);
		if (character === "-" || (character >= "0" && character <= "9")) return number();
		invalid();
	};
	const object = () => {
		expect("{"); whitespace();
		const result = Object.create(null); const keys = new Set();
		if (text[index] === "}") { index += 1; return result; }
		for (;;) {
			whitespace(); if (text[index] !== '"') invalid();
			const key = string();
			if (keys.has(key)) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.duplicateKey);
			keys.add(key); whitespace(); expect(":"); result[key] = value(); whitespace();
			if (text[index] === "}") { index += 1; return result; }
			expect(",");
		}
	};
	const array = () => {
		expect("["); whitespace(); const result = [];
		if (text[index] === "]") { index += 1; return result; }
		for (;;) { result.push(value()); whitespace(); if (text[index] === "]") { index += 1; return result; } expect(","); }
	};
	const parsed = value(); whitespace(); if (index !== text.length) invalid(); return parsed;
}

function normalizeWitness(value) {
	if (isHostBootSessionWitness(value)) return value;
	if (!exactKeys(value, ["bootSessionDigest", "providerId", "providerVersion", "schemaVersion"])) return null;
	return normalizeHostBootSessionWitness(value).witness || null;
}

function persistedWitness(value) {
	const witness = normalizeWitness(value);
	return witness ? serializeHostBootSessionWitness(witness) : null;
}

function parsePresent(bytes, policy) {
	if (bytes.byteLength === 0 || !bytes.toString("utf8").trim()) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid);
	const value = strictParse(bytes, policy.maxRawBytes);
	if (!exactKeys(value, ["schemaVersion", "state"]) && !exactKeys(value, ["baselineWitness", "schemaVersion", "state"])) {
		throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid);
	}
	if (value.schemaVersion !== 1 || (value.state !== "active" && value.state !== "complete")) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid);
	if (value.state === "complete") {
		if (!exactKeys(value, ["schemaVersion", "state"])) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid);
		return freeze({ state: "complete", baselineWitness: null });
	}
	if (!exactKeys(value, ["baselineWitness", "schemaVersion", "state"])) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid);
	const baselineWitness = persistedWitness(value.baselineWitness);
	if (!baselineWitness) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.witnessInvalid);
	return freeze({ state: "active", baselineWitness });
}

function serializeMarker(marker, policy) {
	let value;
	if (marker?.state === "complete" && marker.baselineWitness === null) {
		value = { schemaVersion: 1, state: "complete" };
	} else if (marker?.state === "active") {
		const baselineWitness = persistedWitness(marker.baselineWitness);
		if (!baselineWitness) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.witnessInvalid);
		value = {
			schemaVersion: 1,
			state: "active",
			baselineWitness: {
				schemaVersion: baselineWitness.schemaVersion,
				providerId: baselineWitness.providerId,
				providerVersion: baselineWitness.providerVersion,
				bootSessionDigest: baselineWitness.bootSessionDigest,
			},
		};
	} else throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.invalid);
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (bytes.byteLength > policy.maxRawBytes) throw new StrictJsonError(TRANSCODE_PROBE_MIGRATION_CODES.tooLarge);
	parsePresent(bytes, policy);
	return bytes;
}

export function createTranscodeProbeMigrationMarkerRawIdentity(value) {
	if (value === null) {
		const identity = {}; identities.set(identity, freeze({ missing: true, byteLength: 0, sha256: null })); return freeze(identity);
	}
	const bytes = bytesFrom(value);
	if (!bytes) throw new TypeError("Migration marker identity requires raw bytes or null");
	const identity = {};
	identities.set(identity, freeze({ missing: false, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }));
	return freeze(identity);
}

export function isTranscodeProbeMigrationMarkerRawIdentity(value) {
	return value !== null && typeof value === "object" && identities.has(value);
}

export function sameTranscodeProbeMigrationMarkerRawIdentity(left, right) {
	const first = identities.get(left); const second = identities.get(right);
	return Boolean(first && second && first.missing === second.missing && first.byteLength === second.byteLength && first.sha256 === second.sha256);
}

function normalizeRead(value) {
	if (exactKeys(value, ["status"]) && value.status === "missing") return freeze({ kind: "missing", bytes: null, identity: createTranscodeProbeMigrationMarkerRawIdentity(null) });
	if (!exactKeys(value, ["bytes", "status"]) || value.status !== "present") return null;
	const bytes = bytesFrom(value.bytes);
	return bytes ? freeze({ kind: "present", bytes, identity: createTranscodeProbeMigrationMarkerRawIdentity(bytes) }) : null;
}

function createView(authority, marker) {
	const view = freeze({ barrierActive: marker.state === "active", migrationComplete: marker.state === "complete" });
	views.set(view, { authority, marker });
	return view;
}

function summary(values = {}) {
	return freeze({
		markerInitiallyMissing: values.markerInitiallyMissing === true,
		markerWasWritten: values.markerWasWritten === true,
		markerWasCompleted: values.markerWasCompleted === true,
		finalMarkerState: values.finalMarkerState || "missing",
		barrierActive: values.barrierActive === true,
		migrationComplete: values.migrationComplete === true,
		witnessAvailable: values.witnessAvailable === true,
		witnessComparison: values.witnessComparison || "not-required",
	});
}

function failure(code, values = {}) {
	return freeze({ ok: false, code, barrierView: null, safeSummary: summary(values) });
}

/**
 * Creates independent resolver, view-consumer and conflict-checker
 * capabilities. No normal boolean can stand in for a branded view.
 */
export function createTranscodeProbeMigrationBarrierAuthority({ policy: suppliedPolicy } = {}) {
	const policy = policyFrom(suppliedPolicy);
	const authority = {};
	const barrierViewConsumer = freeze({
		inspect(view) {
			const details = views.get(view);
			if (!details || details.authority !== authority) throw new TypeError(TRANSCODE_PROBE_MIGRATION_CODES.viewInvalid);
			return freeze({ barrierActive: view.barrierActive, migrationComplete: view.migrationComplete });
		},
	});
	viewConsumers.add(barrierViewConsumer);
	const conflictChecker = freeze({
		check(barrierView, operation) {
			const details = views.get(barrierView);
			if (!details || details.authority !== authority) return freeze({ ok: false, code: TRANSCODE_PROBE_MIGRATION_CODES.viewInvalid, kind: "invalid-view" });
			if (!READ_OPERATIONS.has(operation) && !BLOCKED_OPERATIONS.has(operation)) {
				return freeze({ ok: false, code: TRANSCODE_PROBE_MIGRATION_CODES.operationInvalid, kind: "invalid-operation" });
			}
			if (details.marker.state === "active" && BLOCKED_OPERATIONS.has(operation)) {
				return freeze({ ok: false, code: TRANSCODE_PROBE_MIGRATION_CODES.barrierActive, kind: "migration-barrier" });
			}
			return freeze({ ok: true, code: null, kind: null });
		},
	});

	function createStartupResolver({ readMarkerRaw, compareAndSwapMarkerRaw } = {}) {
		if (typeof readMarkerRaw !== "function" || typeof compareAndSwapMarkerRaw !== "function") {
			throw new TypeError("Migration marker resolver capabilities are invalid");
		}
		async function read(final = false) {
			let snapshot;
			try { snapshot = normalizeRead(await readMarkerRaw()); } catch { snapshot = null; }
			if (!snapshot) return failure(final ? TRANSCODE_PROBE_MIGRATION_CODES.finalReadFailed : TRANSCODE_PROBE_MIGRATION_CODES.readFailed);
			if (snapshot.kind === "missing") return freeze({ ok: true, snapshot, marker: null });
			try { return freeze({ ok: true, snapshot, marker: parsePresent(snapshot.bytes, policy) }); }
			catch (error) { return failure(error?.code || (final ? TRANSCODE_PROBE_MIGRATION_CODES.finalReadFailed : TRANSCODE_PROBE_MIGRATION_CODES.invalid)); }
		}
		async function cas(expectedIdentity, nextBytes) {
			let outcome;
			try { outcome = await compareAndSwapMarkerRaw({ expectedIdentity, nextBytes: Buffer.from(nextBytes) }); } catch { return TRANSCODE_PROBE_MIGRATION_CODES.casFailed; }
			return exactKeys(outcome, ["status"]) && outcome.status === "swapped" ? null
				: exactKeys(outcome, ["status"]) && outcome.status === "conflict" ? TRANSCODE_PROBE_MIGRATION_CODES.casConflict
				: TRANSCODE_PROBE_MIGRATION_CODES.casFailed;
		}
		return freeze({
			async resolve({ currentBootWitness = null } = {}) {
				const current = currentBootWitness === null ? null : normalizeWitness(currentBootWitness);
				if (currentBootWitness !== null && !current) return failure(TRANSCODE_PROBE_MIGRATION_CODES.witnessInvalid);
				const initial = await read(false);
				if (!initial.ok) return initial;
				let marker = initial.marker;
				let markerWasWritten = false;
				let markerWasCompleted = false;
				let comparison = current === null ? "unavailable" : "not-required";
				if (marker === null && current !== null) {
					let bytes;
					try { bytes = serializeMarker({ state: "active", baselineWitness: current }, policy); }
					catch (error) { return failure(error?.code || TRANSCODE_PROBE_MIGRATION_CODES.invalid); }
					const code = await cas(initial.snapshot.identity, bytes);
					if (code) return failure(code, { markerInitiallyMissing: true, witnessAvailable: true, witnessComparison: comparison });
					markerWasWritten = true;
				} else if (marker?.state === "active") {
					const baseline = normalizeWitness(marker.baselineWitness);
					if (!baseline) return failure(TRANSCODE_PROBE_MIGRATION_CODES.witnessInvalid);
					if (current === null) comparison = "unavailable";
					else {
						const relation = compareHostBootSessionWitness(baseline, current).relation;
						comparison = relation;
						if (relation === "different-session") {
							let bytes;
							try { bytes = serializeMarker({ state: "complete", baselineWitness: null }, policy); }
							catch (error) { return failure(error?.code || TRANSCODE_PROBE_MIGRATION_CODES.invalid); }
							const code = await cas(initial.snapshot.identity, bytes);
							if (code) return failure(code, { witnessAvailable: true, witnessComparison: comparison });
							markerWasCompleted = true;
						}
					}
				}
				const final = await read(true);
				if (!final.ok) return final;
				if (final.marker === null) {
					if (initial.marker === null && current === null) {
						const ephemeral = createView(authority, freeze({ state: "active", baselineWitness: null }));
						return freeze({ ok: true, code: null, barrierView: ephemeral, safeSummary: summary({ markerInitiallyMissing: true, finalMarkerState: "missing", barrierActive: true, witnessAvailable: false, witnessComparison: "unavailable" }) });
					}
					return failure(TRANSCODE_PROBE_MIGRATION_CODES.finalReadFailed, { markerInitiallyMissing: initial.marker === null, markerWasWritten, markerWasCompleted, witnessAvailable: current !== null, witnessComparison: comparison });
				}
				const view = createView(authority, final.marker);
				return freeze({
					ok: true,
					code: null,
					barrierView: view,
					safeSummary: summary({
						markerInitiallyMissing: initial.marker === null,
						markerWasWritten,
						markerWasCompleted,
						finalMarkerState: final.marker.state,
						barrierActive: final.marker.state === "active",
						migrationComplete: final.marker.state === "complete",
						witnessAvailable: current !== null,
						witnessComparison: comparison,
					}),
				});
			},
		});
	}

	return freeze({
		resolverIssuer: freeze({ createStartupResolver }),
		barrierViewConsumer,
		conflictChecker,
		getPolicy() { return freeze({ ...policy }); },
	});
}

