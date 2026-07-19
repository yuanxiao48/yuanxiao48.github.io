/**
 * Pure direct-probe journal policy. All persistence is supplied through
 * explicit capabilities; importing this module has no filesystem or process
 * side effects.
 */
import { createHash } from "node:crypto";
import {
	compareHostBootSessionWitness,
	isHostBootSessionWitness,
	normalizeHostBootSessionWitness,
	serializeHostBootSessionWitness,
} from "./host-boot-session-witness.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const DEFAULT_POLICY = Object.freeze({ maxRawBytes: 64 * 1024, maxEntries: 32, maxSourceBytes: 4096 });
const identities = new WeakMap();
const proofs = new WeakMap();
const proofClaims = new WeakMap();
const handles = new WeakMap();
const finalCollections = new WeakMap();
const collectionConsumers = new WeakSet();

export const TRANSCODE_PROBE_JOURNAL_CODES = Object.freeze({
	invalid: "TRANSCODE_PROBE_JOURNAL_INVALID",
	tooLarge: "TRANSCODE_PROBE_JOURNAL_TOO_LARGE",
	duplicateKey: "TRANSCODE_PROBE_JOURNAL_DUPLICATE_KEY",
	entryInvalid: "TRANSCODE_PROBE_JOURNAL_ENTRY_INVALID",
	entryIdConflict: "TRANSCODE_PROBE_JOURNAL_ENTRY_ID_CONFLICT",
	sourceConflict: "TRANSCODE_PROBE_JOURNAL_SOURCE_CONFLICT",
	sourceInvalid: "TRANSCODE_PROBE_JOURNAL_SOURCE_INVALID",
	witnessInvalid: "TRANSCODE_PROBE_JOURNAL_WITNESS_INVALID",
	readFailed: "TRANSCODE_PROBE_JOURNAL_READ_FAILED",
	casConflict: "TRANSCODE_PROBE_JOURNAL_CAS_CONFLICT",
	casFailed: "TRANSCODE_PROBE_JOURNAL_CAS_FAILED",
	clearFailed: "TRANSCODE_PROBE_JOURNAL_CLEAR_FAILED",
	entryMissing: "TRANSCODE_PROBE_JOURNAL_ENTRY_MISSING",
	proofInvalid: "TRANSCODE_PROBE_JOURNAL_PROOF_INVALID",
	proofAlreadyUsed: "TRANSCODE_PROBE_JOURNAL_PROOF_ALREADY_USED",
	handleInvalid: "TRANSCODE_PROBE_JOURNAL_HANDLE_INVALID",
	finalReadFailed: "TRANSCODE_PROBE_JOURNAL_FINAL_READ_FAILED",
	finalCollectionInvalid: "TRANSCODE_PROBE_JOURNAL_FINAL_COLLECTION_INVALID",
	contributionFailed: "TRANSCODE_PROBE_JOURNAL_CONTRIBUTION_FAILED",
});

function freeze(value) {
	return Object.freeze(value);
}

function bytesFrom(value) {
	if (Buffer.isBuffer(value)) return Buffer.from(value);
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

function exactKeys(value, expected) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validPolicy(policy) {
	return Number.isSafeInteger(policy?.maxRawBytes) && policy.maxRawBytes > 0
		&& Number.isSafeInteger(policy?.maxEntries) && policy.maxEntries >= 0
		&& Number.isSafeInteger(policy?.maxSourceBytes) && policy.maxSourceBytes > 0;
}

function policyFrom(value) {
	const policy = freeze({ ...DEFAULT_POLICY, ...(value || {}) });
	if (!validPolicy(policy)) throw new TypeError("Transcode probe journal policy is invalid");
	return policy;
}

function safeResult(ok, code = null, extra = {}) {
	return freeze({ ok, code, ...extra });
}

class StrictJsonError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

/** A small JSON parser that rejects duplicate decoded object keys. */
function parseStrictJson(bytes, maxRawBytes) {
	if (bytes.byteLength > maxRawBytes) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.tooLarge);
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.invalid); }
	let index = 0;
	const whitespace = () => {
		while (index < text.length && /[\u0020\u000a\u000d\u0009]/.test(text[index])) index += 1;
	};
	const invalid = () => { throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.invalid); };
	const expect = (character) => {
		if (text[index] !== character) invalid();
		index += 1;
	};
	const string = () => {
		expect('"');
		let value = "";
		while (index < text.length) {
			const character = text[index++];
			if (character === '"') return value;
			if (character < " ") invalid();
			if (character !== "\\") { value += character; continue; }
			if (index >= text.length) invalid();
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
				value += String.fromCharCode(Number.parseInt(hex, 16));
				index += 4;
			} else invalid();
		}
		invalid();
	};
	const number = () => {
		const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (!match) invalid();
		index += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value)) invalid();
		return value;
	};
	const literal = (raw, value) => {
		if (text.slice(index, index + raw.length) !== raw) invalid();
		index += raw.length;
		return value;
	};
	const value = () => {
		whitespace();
		const character = text[index];
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
		expect("{");
		whitespace();
		const result = Object.create(null);
		const keys = new Set();
		if (text[index] === "}") { index += 1; return result; }
		for (;;) {
			whitespace();
			if (text[index] !== '"') invalid();
			const key = string();
			if (keys.has(key)) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.duplicateKey);
			keys.add(key);
			whitespace(); expect(":");
			result[key] = value();
			whitespace();
			if (text[index] === "}") { index += 1; return result; }
			expect(",");
		}
	};
	const array = () => {
		expect("[");
		whitespace();
		const result = [];
		if (text[index] === "]") { index += 1; return result; }
		for (;;) {
			result.push(value());
			whitespace();
			if (text[index] === "]") { index += 1; return result; }
			expect(",");
		}
	};
	const parsed = value();
	whitespace();
	if (index !== text.length) invalid();
	return parsed;
}

function normalizeWitness(value) {
	if (isHostBootSessionWitness(value)) return value;
	if (!exactKeys(value, ["bootSessionDigest", "providerId", "providerVersion", "schemaVersion"])) return null;
	const normalized = normalizeHostBootSessionWitness(value);
	return normalized.witness || null;
}

function serializedWitness(value) {
	const witness = normalizeWitness(value);
	return witness ? serializeHostBootSessionWitness(witness) : null;
}

function sameWitness(left, right) {
	return left.schemaVersion === right.schemaVersion && left.providerId === right.providerId
		&& left.providerVersion === right.providerVersion && left.bootSessionDigest === right.bootSessionDigest;
}

function canonicalSource(normalizeLibrarySourceKey, value, policy, { requireCanonical = false } = {}) {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > policy.maxSourceBytes) return null;
	let canonical;
	try { canonical = normalizeLibrarySourceKey(value); } catch { canonical = null; }
	if (typeof canonical !== "string" || !canonical || Buffer.byteLength(canonical, "utf8") > policy.maxSourceBytes) return null;
	if (requireCanonical && canonical !== value) return null;
	return canonical;
}

function validateEntry(value, normalizeLibrarySourceKey, policy) {
	if (!exactKeys(value, ["bootWitness", "entryGeneration", "entryId", "schemaVersion", "sourcePublicPath", "sourceReferenceVersion", "state"])) {
		throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.entryInvalid);
	}
	if (value.schemaVersion !== 1 || typeof value.entryId !== "string" || !UUID.test(value.entryId)
		|| !Number.isSafeInteger(value.entryGeneration) || value.entryGeneration < 1
		|| value.state !== "protected" || value.sourceReferenceVersion !== 1) {
		throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.entryInvalid);
	}
	const sourcePublicPath = canonicalSource(normalizeLibrarySourceKey, value.sourcePublicPath, policy, { requireCanonical: true });
	if (!sourcePublicPath) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.sourceInvalid);
	const bootWitness = serializedWitness(value.bootWitness);
	if (!bootWitness) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.witnessInvalid);
	return freeze({
		schemaVersion: 1,
		entryId: value.entryId,
		entryGeneration: value.entryGeneration,
		state: "protected",
		sourceReferenceVersion: 1,
		sourcePublicPath,
		bootWitness,
	});
}

function validateDocument(value, normalizeLibrarySourceKey, policy) {
	if (!exactKeys(value, ["entries", "schemaVersion"]) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
		throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.invalid);
	}
	if (value.entries.length > policy.maxEntries) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.tooLarge);
	const entryIds = new Set();
	const sources = new Set();
	const entries = [];
	for (const raw of value.entries) {
		const entry = validateEntry(raw, normalizeLibrarySourceKey, policy);
		if (entryIds.has(entry.entryId)) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.entryIdConflict);
		if (sources.has(entry.sourcePublicPath)) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.sourceConflict);
		entryIds.add(entry.entryId);
		sources.add(entry.sourcePublicPath);
		entries.push(entry);
	}
	return freeze({ schemaVersion: 1, entries: freeze(entries) });
}

function serializeDocument(document, normalizeLibrarySourceKey, policy) {
	const validated = validateDocument(document, normalizeLibrarySourceKey, policy);
	const entries = [...validated.entries]
		.sort((left, right) => left.sourcePublicPath.localeCompare(right.sourcePublicPath) || left.entryId.localeCompare(right.entryId))
		.map((entry) => ({
			schemaVersion: 1,
			entryId: entry.entryId,
			entryGeneration: entry.entryGeneration,
			state: "protected",
			sourceReferenceVersion: 1,
			sourcePublicPath: entry.sourcePublicPath,
			bootWitness: {
				schemaVersion: entry.bootWitness.schemaVersion,
				providerId: entry.bootWitness.providerId,
				providerVersion: entry.bootWitness.providerVersion,
				bootSessionDigest: entry.bootWitness.bootSessionDigest,
			},
		}));
	const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, entries })}\n`, "utf8");
	if (bytes.byteLength > policy.maxRawBytes) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.tooLarge);
	validateDocument(parseStrictJson(bytes, policy.maxRawBytes), normalizeLibrarySourceKey, policy);
	return bytes;
}

function emptyDocument() {
	return freeze({ schemaVersion: 1, entries: freeze([]) });
}

function parsePresentBytes(bytes, normalizeLibrarySourceKey, policy) {
	if (bytes.byteLength === 0 || !bytes.toString("utf8").trim()) throw new StrictJsonError(TRANSCODE_PROBE_JOURNAL_CODES.invalid);
	return validateDocument(parseStrictJson(bytes, policy.maxRawBytes), normalizeLibrarySourceKey, policy);
}

/** Opaque raw identity for either exact bytes or the explicit missing sentinel. */
export function createTranscodeProbeJournalRawIdentity(value) {
	if (value === null) {
		const identity = {};
		identities.set(identity, freeze({ missing: true, byteLength: 0, sha256: null }));
		return freeze(identity);
	}
	const bytes = bytesFrom(value);
	if (!bytes) throw new TypeError("Journal identity requires raw bytes or null");
	const identity = {};
	identities.set(identity, freeze({ missing: false, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }));
	return freeze(identity);
}

export function isTranscodeProbeJournalRawIdentity(value) {
	return value !== null && typeof value === "object" && identities.has(value);
}

export function sameTranscodeProbeJournalRawIdentity(left, right) {
	const first = identities.get(left);
	const second = identities.get(right);
	return Boolean(first && second && first.missing === second.missing && first.byteLength === second.byteLength && first.sha256 === second.sha256);
}

function normalizeRead(value) {
	if (exactKeys(value, ["status"]) && value.status === "missing") return freeze({ kind: "missing", bytes: null, identity: createTranscodeProbeJournalRawIdentity(null) });
	if (!exactKeys(value, ["bytes", "status"]) || value.status !== "present") return null;
	const bytes = bytesFrom(value.bytes);
	if (!bytes) return null;
	return freeze({ kind: "present", bytes, identity: createTranscodeProbeJournalRawIdentity(bytes) });
}

function stableRuntimeFailure(code, { cleared = false } = {}) {
	return freeze({ ok: false, code, proof: null, cleanupHandle: null, cleared });
}

function makeProof(authority, entry) {
	const proof = freeze({ kind: "transcode-probe-journal-proof" });
	proofs.set(proof, { authority, entry, used: false });
	return proof;
}

function makeHandle(authority, entry, clear) {
	const handle = freeze({ kind: "transcode-probe-journal-cleanup" });
	handles.set(handle, { authority, entry, clear, cleared: false });
	return handle;
}

function matchingEntry(entry, expected) {
	return entry.entryId === expected.entryId && entry.entryGeneration === expected.entryGeneration
		&& entry.sourcePublicPath === expected.sourcePublicPath && entry.state === expected.state
		&& sameWitness(entry.bootWitness, expected.bootWitness);
}

function safeSummary(values = {}) {
	return freeze({
		initialEntryCount: values.initialEntryCount || 0,
		removedDifferentSessionCount: values.removedDifferentSessionCount || 0,
		retainedInitialEntryCount: values.retainedInitialEntryCount || 0,
		finalEntryCount: values.finalEntryCount || 0,
		newlyObservedFinalEntryCount: values.newlyObservedFinalEntryCount || 0,
		recoveryContributionCount: values.recoveryContributionCount || 0,
		journalWasMissing: values.journalWasMissing === true,
		journalWasRewritten: values.journalWasRewritten === true,
		critical: values.critical === true,
	});
}

/**
 * Creates a journal authority. The caller owns all injected raw I/O
 * capabilities; this object never discovers or computes a journal path.
 */
export function createTranscodeProbeJournalAuthority({ normalizeLibrarySourceKey, policy: suppliedPolicy } = {}) {
	if (typeof normalizeLibrarySourceKey !== "function") throw new TypeError("Journal source normalizer is invalid");
	const policy = policyFrom(suppliedPolicy);
	const authority = {};
	const proofConsumer = freeze({
		inspect(proof, cleanupHandle, callback) {
			const details = proofs.get(proof);
			const handle = handles.get(cleanupHandle);
			if (!details || details.authority !== authority || details.used || !handle || handle.authority !== authority
				|| handle.cleared || !matchingEntry(details.entry, handle.entry) || typeof callback !== "function") {
				return freeze({ ok: false, code: !details || details.authority !== authority || !handle || handle.authority !== authority
					? TRANSCODE_PROBE_JOURNAL_CODES.proofInvalid
					: details.used ? TRANSCODE_PROBE_JOURNAL_CODES.proofAlreadyUsed : TRANSCODE_PROBE_JOURNAL_CODES.handleInvalid });
			}
			try {
				return callback(freeze({ sourceKey: details.entry.sourcePublicPath }));
			} catch {
				return freeze({ ok: false, code: TRANSCODE_PROBE_JOURNAL_CODES.proofInvalid });
			}
		},
		consume(proof) {
			const details = proofs.get(proof);
			if (!details || details.authority !== authority) return safeResult(false, TRANSCODE_PROBE_JOURNAL_CODES.proofInvalid, { claim: null });
			if (details.used) return safeResult(false, TRANSCODE_PROBE_JOURNAL_CODES.proofAlreadyUsed, { claim: null });
			details.used = true;
			const claim = freeze({ kind: "transcode-probe-journal-proof-claim" });
			proofClaims.set(claim, { authority, entry: details.entry });
			return safeResult(true, null, { claim });
		},
	});
	const cleanupConsumer = freeze({
		async clear(cleanupHandle) {
			const details = handles.get(cleanupHandle);
			if (!details || details.authority !== authority || typeof details.clear !== "function") {
				return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.handleInvalid);
			}
			try { return await details.clear(cleanupHandle); }
			catch { return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.clearFailed); }
		},
	});
	const finalCollectionConsumer = freeze({
		withEntries(collection, callback) {
			const details = finalCollections.get(collection);
			if (!details || details.authority !== authority || typeof callback !== "function") {
				throw new TypeError(TRANSCODE_PROBE_JOURNAL_CODES.finalCollectionInvalid);
			}
			const entries = freeze(details.entries.map((entry) => freeze({
				...entry,
				bootWitness: freeze({ ...entry.bootWitness }),
			})));
			return callback(entries);
		},
	});
	collectionConsumers.add(finalCollectionConsumer);

	function parseRead(read) {
		if (read.kind === "missing") return emptyDocument();
		return parsePresentBytes(read.bytes, normalizeLibrarySourceKey, policy);
	}

	function createRuntimeTransaction({ readJournalRaw, compareAndSwapJournalRaw } = {}) {
		if (typeof readJournalRaw !== "function" || typeof compareAndSwapJournalRaw !== "function") {
			throw new TypeError("Journal transaction capabilities are invalid");
		}
		async function readCurrent() {
			let raw;
			try { raw = normalizeRead(await readJournalRaw()); } catch { raw = null; }
			if (!raw) return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.readFailed);
			try { return freeze({ ok: true, raw, document: parseRead(raw) }); }
			catch (error) { return stableRuntimeFailure(error?.code || TRANSCODE_PROBE_JOURNAL_CODES.invalid); }
		}
		async function cas(expectedIdentity, nextBytes) {
			let outcome;
			try { outcome = await compareAndSwapJournalRaw({ expectedIdentity, nextBytes: Buffer.from(nextBytes) }); }
			catch { return TRANSCODE_PROBE_JOURNAL_CODES.casFailed; }
			return exactKeys(outcome, ["status"]) && outcome.status === "swapped" ? null
				: exactKeys(outcome, ["status"]) && outcome.status === "conflict" ? TRANSCODE_PROBE_JOURNAL_CODES.casConflict
				: TRANSCODE_PROBE_JOURNAL_CODES.casFailed;
		}
		const transaction = freeze({
			async addProtectedEntry({ sourcePublicPath, bootWitness, entryId, entryGeneration } = {}) {
				const current = await readCurrent();
				if (!current.ok) return current;
				const source = canonicalSource(normalizeLibrarySourceKey, sourcePublicPath, policy);
				if (!source) return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.sourceInvalid);
				if (typeof entryId !== "string" || !UUID.test(entryId) || !Number.isSafeInteger(entryGeneration) || entryGeneration < 1) {
					return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.entryInvalid);
				}
				const witness = serializedWitness(bootWitness);
				if (!witness) return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.witnessInvalid);
				if (current.document.entries.some((entry) => entry.entryId === entryId)) return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.entryIdConflict);
				if (current.document.entries.some((entry) => entry.sourcePublicPath === source)) return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.sourceConflict);
				const entry = freeze({ schemaVersion: 1, entryId, entryGeneration, state: "protected", sourceReferenceVersion: 1, sourcePublicPath: source, bootWitness: witness });
				let nextBytes;
				try { nextBytes = serializeDocument({ schemaVersion: 1, entries: [...current.document.entries, entry] }, normalizeLibrarySourceKey, policy); }
				catch (error) { return stableRuntimeFailure(error?.code || TRANSCODE_PROBE_JOURNAL_CODES.invalid); }
				const code = await cas(current.raw.identity, nextBytes);
				if (code) return stableRuntimeFailure(code);
				return freeze({ ok: true, code: null, proof: makeProof(authority, entry), cleanupHandle: makeHandle(authority, entry, transaction.clearProtectedEntry), cleared: false });
			},
			async clearProtectedEntry(cleanupHandle) {
				const details = handles.get(cleanupHandle);
				if (!details || details.authority !== authority) return stableRuntimeFailure(TRANSCODE_PROBE_JOURNAL_CODES.handleInvalid);
				if (details.cleared) return freeze({ ok: true, code: null, proof: null, cleanupHandle: null, cleared: true, alreadyCleared: true });
				const current = await readCurrent();
				if (!current.ok) return stableRuntimeFailure(current.code === TRANSCODE_PROBE_JOURNAL_CODES.readFailed ? current.code : TRANSCODE_PROBE_JOURNAL_CODES.clearFailed);
				const matching = current.document.entries.filter((entry) => matchingEntry(entry, details.entry));
				if (matching.length !== 1) return stableRuntimeFailure(matching.length === 0 ? TRANSCODE_PROBE_JOURNAL_CODES.entryMissing : TRANSCODE_PROBE_JOURNAL_CODES.clearFailed);
				let nextBytes;
				try { nextBytes = serializeDocument({ schemaVersion: 1, entries: current.document.entries.filter((entry) => !matchingEntry(entry, details.entry)) }, normalizeLibrarySourceKey, policy); }
				catch (error) { return stableRuntimeFailure(error?.code || TRANSCODE_PROBE_JOURNAL_CODES.clearFailed); }
				const code = await cas(current.raw.identity, nextBytes);
				if (code) return stableRuntimeFailure(code === TRANSCODE_PROBE_JOURNAL_CODES.casConflict ? code : TRANSCODE_PROBE_JOURNAL_CODES.clearFailed);
				details.cleared = true;
				return freeze({ ok: true, code: null, proof: null, cleanupHandle: null, cleared: true, alreadyCleared: false });
			},
		});
		return transaction;
	}

	function createStartupResolver({ readJournalRaw, compareAndSwapJournalRaw } = {}) {
		if (typeof readJournalRaw !== "function" || typeof compareAndSwapJournalRaw !== "function") {
			throw new TypeError("Journal resolver capabilities are invalid");
		}
		async function readForResolver(final = false) {
			let raw;
			try { raw = normalizeRead(await readJournalRaw()); } catch { raw = null; }
			if (!raw) return safeResult(false, final ? TRANSCODE_PROBE_JOURNAL_CODES.finalReadFailed : TRANSCODE_PROBE_JOURNAL_CODES.readFailed);
			try { return freeze({ ok: true, raw, document: parseRead(raw) }); }
			catch (error) { return safeResult(false, error?.code || (final ? TRANSCODE_PROBE_JOURNAL_CODES.finalReadFailed : TRANSCODE_PROBE_JOURNAL_CODES.invalid)); }
		}
		async function rewrite(expectedIdentity, nextBytes) {
			let outcome;
			try { outcome = await compareAndSwapJournalRaw({ expectedIdentity, nextBytes: Buffer.from(nextBytes) }); }
			catch { return TRANSCODE_PROBE_JOURNAL_CODES.casFailed; }
			return exactKeys(outcome, ["status"]) && outcome.status === "swapped" ? null
				: exactKeys(outcome, ["status"]) && outcome.status === "conflict" ? TRANSCODE_PROBE_JOURNAL_CODES.casConflict
				: TRANSCODE_PROBE_JOURNAL_CODES.casFailed;
		}
		return freeze({
			async resolve({ currentBootWitness = null } = {}) {
				const currentWitness = currentBootWitness === null ? null : normalizeWitness(currentBootWitness);
				if (currentBootWitness !== null && !currentWitness) {
					return freeze({ ok: false, code: TRANSCODE_PROBE_JOURNAL_CODES.witnessInvalid, collection: null, summary: safeSummary({ critical: true }) });
				}
				const initial = await readForResolver(false);
				if (!initial.ok) return freeze({ ok: false, code: initial.code, collection: null, summary: safeSummary({ critical: true }) });
				const initialIds = new Set(initial.document.entries.map((entry) => entry.entryId));
				const remove = currentWitness === null ? [] : initial.document.entries.filter((entry) => {
					const persisted = normalizeHostBootSessionWitness(entry.bootWitness).witness;
					return compareHostBootSessionWitness(persisted, currentWitness).relation === "different-session";
				});
				let rewritten = false;
				if (remove.length) {
					let nextBytes;
					try {
						const removed = new Set(remove.map((entry) => entry.entryId));
						nextBytes = serializeDocument({ schemaVersion: 1, entries: initial.document.entries.filter((entry) => !removed.has(entry.entryId)) }, normalizeLibrarySourceKey, policy);
					} catch (error) {
						return freeze({ ok: false, code: error?.code || TRANSCODE_PROBE_JOURNAL_CODES.invalid, collection: null, summary: safeSummary({ critical: true }) });
					}
					const code = await rewrite(initial.raw.identity, nextBytes);
					if (code) return freeze({ ok: false, code, collection: null, summary: safeSummary({ initialEntryCount: initial.document.entries.length, critical: true }) });
					rewritten = true;
				}
				const final = await readForResolver(true);
				if (!final.ok) return freeze({ ok: false, code: final.code, collection: null, summary: safeSummary({ initialEntryCount: initial.document.entries.length, critical: true }) });
				const collection = freeze({ kind: "transcode-probe-journal-final-collection" });
				finalCollections.set(collection, { authority, entries: final.document.entries });
				const retainedInitialEntryCount = final.document.entries.filter((entry) => initialIds.has(entry.entryId)).length;
				return freeze({
					ok: true,
					code: null,
					collection,
					summary: safeSummary({
						initialEntryCount: initial.document.entries.length,
						removedDifferentSessionCount: remove.length,
						retainedInitialEntryCount,
						finalEntryCount: final.document.entries.length,
						newlyObservedFinalEntryCount: final.document.entries.filter((entry) => !initialIds.has(entry.entryId)).length,
						journalWasMissing: initial.raw.kind === "missing",
						journalWasRewritten: rewritten,
					}),
				});
			},
		});
	}

	function createRecoveryContributionAdapter({ mintRecoveryReaderLease, mintRecoveryReaderContribution } = {}) {
		if (typeof mintRecoveryReaderLease !== "function" || typeof mintRecoveryReaderContribution !== "function") {
			throw new TypeError("Journal recovery contribution dependencies are invalid");
		}
		return freeze({
			createContributions(collection) {
				const details = finalCollections.get(collection);
				if (!details || details.authority !== authority) return freeze({ ok: false, code: TRANSCODE_PROBE_JOURNAL_CODES.finalCollectionInvalid, contributions: freeze([]), summary: safeSummary({ critical: true }) });
				const contributions = [];
				try {
					for (const entry of details.entries) {
						const lease = mintRecoveryReaderLease();
						if (lease?.ok !== true || !lease.leaseToken) throw new Error("lease");
						const contribution = mintRecoveryReaderContribution({ sourcePublicPath: entry.sourcePublicPath, leaseToken: lease.leaseToken });
						if (contribution?.ok !== true || !contribution.contribution) throw new Error("contribution");
						contributions.push(contribution.contribution);
					}
				} catch {
					return freeze({ ok: false, code: TRANSCODE_PROBE_JOURNAL_CODES.contributionFailed, contributions: freeze([]), summary: safeSummary({ critical: true }) });
				}
				return freeze({ ok: true, code: null, contributions: freeze([...contributions]), summary: safeSummary({ finalEntryCount: details.entries.length, recoveryContributionCount: contributions.length }) });
			},
		});
	}

	return freeze({
		transactionIssuer: freeze({ createRuntimeTransaction }),
		proofConsumer,
		cleanupConsumer,
		finalCollectionConsumer,
		createStartupResolver,
		createRecoveryContributionAdapter,
		getPolicy() { return freeze({ ...policy }); },
	});
}

export function isOpaqueTranscodeProbeJournalProofClaim(value) {
	return value !== null && typeof value === "object" && proofClaims.has(value);
}
