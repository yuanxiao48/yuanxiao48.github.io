/**
 * Pure direct-probe protection composition. Persistence, registry mutation,
 * and child lifecycle stay in their owning modules; this module only joins
 * their opaque proofs and preserves the clear-then-release invariant.
 */
const finalizations = new WeakMap();
const managedPermitConsumers = new WeakSet();
const directClaims = new WeakMap();

export const TRANSCODE_DIRECT_PROBE_PROTECTION_CODES = Object.freeze({
	journalProofInvalid: "TRANSCODE_DIRECT_PROBE_JOURNAL_PROOF_INVALID",
	journalHandleInvalid: "TRANSCODE_DIRECT_PROBE_JOURNAL_HANDLE_INVALID",
	readerProofInvalid: "TRANSCODE_DIRECT_PROBE_READER_PROOF_INVALID",
	readerHandleInvalid: "TRANSCODE_DIRECT_PROBE_READER_HANDLE_INVALID",
	mismatch: "TRANSCODE_DIRECT_PROBE_PROTECTION_MISMATCH",
	alreadyUsed: "TRANSCODE_DIRECT_PROBE_PROTECTION_ALREADY_USED",
	managedAuthorityMismatch: "TRANSCODE_DIRECT_PROBE_MANAGED_AUTHORITY_MISMATCH",
	permitMintFailed: "TRANSCODE_DIRECT_PROBE_PERMIT_MINT_FAILED",
	compensationFailed: "TRANSCODE_DIRECT_PROBE_COMPENSATION_FAILED",
	journalClearFailed: "TRANSCODE_DIRECT_PROBE_JOURNAL_CLEAR_FAILED",
	readerReleaseFailed: "TRANSCODE_DIRECT_PROBE_READER_RELEASE_FAILED",
	runtimeProtectionRetained: "TRANSCODE_DIRECT_PROBE_RUNTIME_PROTECTION_RETAINED",
	finalizerFailed: "TRANSCODE_DIRECT_PROBE_FINALIZER_FAILED",
});

export function isTranscodeDirectProbeManagedPermitConsumer(value) {
	return managedPermitConsumers.has(value);
}

function freeze(value) {
	return Object.freeze(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBindings(value) {
	return record(value) && typeof value.spawnPreparedProbe === "function" && typeof value.evaluateClosedProbe === "function";
}

function result(ok, code = null, extra = {}) {
	return freeze({ ok, code, ...extra });
}

function safeFinalizerResult({ ok, code = null, persistentProtectionRetained = false, runtimeProtectionRetained = false } = {}) {
	return freeze({ ok, code, persistentProtectionRetained, runtimeProtectionRetained });
}

function invalid(code) {
	return result(false, code, { permit: null });
}

function readJournalSource(consumer, proof, handle) {
	if (!consumer || typeof consumer.inspect !== "function") return null;
	const inspected = consumer.inspect(proof, handle, (claim) => claim?.sourceKey || null);
	return typeof inspected === "string" ? inspected : null;
}

function readReaderSource(consumer, proof, handle) {
	if (!consumer || typeof consumer.inspect !== "function") return null;
	const inspected = consumer.inspect(proof, handle, (claim) => claim?.sourceKey || null);
	return typeof inspected === "string" ? inspected : null;
}

/**
 * Creates a composition authority bound once to the four restricted journal /
 * reader capabilities and one managed direct-permit issuer. It has no source,
 * filesystem, registry, process, or HTTP capability of its own.
 */
export function createTranscodeDirectProbeProtectionAuthority({
	journalProofConsumer,
	journalCleanupConsumer,
	runtimeReaderAcquisitionConsumer,
	runtimeReaderReleaseConsumer,
} = {}) {
	if (!record(journalProofConsumer) || typeof journalProofConsumer.inspect !== "function" || typeof journalProofConsumer.consume !== "function"
		|| !record(journalCleanupConsumer) || typeof journalCleanupConsumer.clear !== "function"
		|| !record(runtimeReaderAcquisitionConsumer) || typeof runtimeReaderAcquisitionConsumer.inspect !== "function" || typeof runtimeReaderAcquisitionConsumer.consume !== "function"
		|| !record(runtimeReaderReleaseConsumer) || typeof runtimeReaderReleaseConsumer.release !== "function") {
		throw new TypeError("Direct probe protection dependencies are invalid");
	}
	const authority = {};
	let boundManagedAuthority = null;

	function finalize(cleanupHandle, releaseHandle) {
		const existing = finalizations.get(cleanupHandle);
		if (existing) return existing;
		const pending = (async () => {
			let cleared;
			try { cleared = await journalCleanupConsumer.clear(cleanupHandle); }
			catch { return safeFinalizerResult({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.journalClearFailed, persistentProtectionRetained: true, runtimeProtectionRetained: true }); }
			if (!cleared?.ok || cleared.cleared !== true) {
				return safeFinalizerResult({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.journalClearFailed, persistentProtectionRetained: true, runtimeProtectionRetained: true });
			}
			let released;
			try { released = runtimeReaderReleaseConsumer.release(releaseHandle); }
			catch { return safeFinalizerResult({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.readerReleaseFailed, runtimeProtectionRetained: true }); }
			if (!released?.ok || released.released !== true) {
				return safeFinalizerResult({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.runtimeProtectionRetained, runtimeProtectionRetained: true });
			}
			return safeFinalizerResult({ ok: true });
		})();
		finalizations.set(cleanupHandle, pending);
		return pending;
	}

	async function prepareManagedDirectProbePermit({ journalProof, journalCleanupHandle, readerAcquisitionProof, readerReleaseHandle, bindings } = {}) {
		if (!validBindings(bindings)) return invalid(TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.permitMintFailed);
		const journalSource = readJournalSource(journalProofConsumer, journalProof, journalCleanupHandle);
		if (journalSource === null) return invalid(TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.journalProofInvalid);
		const readerSource = readReaderSource(runtimeReaderAcquisitionConsumer, readerAcquisitionProof, readerReleaseHandle);
		if (readerSource === null) return invalid(TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.readerProofInvalid);
		if (journalSource !== readerSource) return invalid(TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.mismatch);

		const wrappedBindings = freeze({
			spawnPreparedProbe() {
				const spawned = bindings.spawnPreparedProbe();
				if (spawned && typeof spawned.then === "function") throw new TypeError("Direct probe spawn must be synchronous");
				return spawned;
			},
			evaluateClosedProbe: bindings.evaluateClosedProbe,
			async finalizeBusinessProtection() {
				const finalized = await finalize(journalCleanupHandle, readerReleaseHandle);
				return freeze({ ok: finalized.ok, protectionRetained: finalized.persistentProtectionRetained || finalized.runtimeProtectionRetained });
			},
		});
		const claim = freeze({ kind: "transcode-direct-probe-managed-claim" });
		directClaims.set(claim, {
			authority, journalProof, journalCleanupHandle, readerAcquisitionProof, readerReleaseHandle,
			bindings: wrappedBindings, finalize: () => finalize(journalCleanupHandle, readerReleaseHandle), used: false, managedAuthority: null,
		});
		return result(true, null, { claim });
	}

	const managedPermitConsumer = freeze({
		bind(managedAuthority) {
			if (!managedAuthority || typeof managedAuthority !== "object" || (boundManagedAuthority !== null && boundManagedAuthority !== managedAuthority)) return false;
			boundManagedAuthority = managedAuthority;
			return true;
		},
		consume(claim, managedAuthority) {
			const details = directClaims.get(claim);
			if (!details || details.authority !== authority || !managedAuthority || typeof managedAuthority !== "object") {
				return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.managedAuthorityMismatch });
			}
			if (details.used) return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.alreadyUsed });
			if (boundManagedAuthority !== managedAuthority || (details.managedAuthority !== null && details.managedAuthority !== managedAuthority)) {
				return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.managedAuthorityMismatch });
			}
			const journalSource = readJournalSource(journalProofConsumer, details.journalProof, details.journalCleanupHandle);
			const readerSource = readReaderSource(runtimeReaderAcquisitionConsumer, details.readerAcquisitionProof, details.readerReleaseHandle);
			if (journalSource === null) return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.journalProofInvalid });
			if (readerSource === null) return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.readerProofInvalid });
			if (journalSource !== readerSource) return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.mismatch });
			const journalClaim = journalProofConsumer.consume(details.journalProof);
			if (!journalClaim?.ok) return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.journalProofInvalid });
			const readerClaim = runtimeReaderAcquisitionConsumer.consume(details.readerAcquisitionProof);
			if (!readerClaim?.ok) {
				details.used = true;
				return freeze({ ok: false, code: TRANSCODE_DIRECT_PROBE_PROTECTION_CODES.readerProofInvalid, compensate: details.finalize });
			}
			details.managedAuthority = managedAuthority;
			details.used = true;
			return freeze({ ok: true, code: null, bindings: details.bindings, compensate: details.finalize });
		},
	});
	managedPermitConsumers.add(managedPermitConsumer);

	const resultAuthority = { preparationIssuer: freeze({ prepareManagedDirectProbePermit }) };
	Object.defineProperty(resultAuthority, "managedPermitConsumer", { value: managedPermitConsumer, enumerable: false });
	return freeze(resultAuthority);
}
