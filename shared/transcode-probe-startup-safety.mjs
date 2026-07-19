/**
 * Pure startup-safety composition. It never reads journal/marker bytes, never
 * installs a registry, and deliberately has no listen decision.
 */

const bundles = new WeakMap();

export const TRANSCODE_PROBE_STARTUP_SAFETY_CODES = Object.freeze({
	inputInvalid: "TRANSCODE_PROBE_STARTUP_SAFETY_INPUT_INVALID",
	contributionFailed: "TRANSCODE_PROBE_STARTUP_SAFETY_CONTRIBUTION_FAILED",
	planCombineFailed: "TRANSCODE_PROBE_STARTUP_SAFETY_PLAN_COMBINE_FAILED",
	barrierInvalid: "TRANSCODE_PROBE_STARTUP_SAFETY_BARRIER_INVALID",
	bundleInvalid: "TRANSCODE_PROBE_STARTUP_SAFETY_BUNDLE_INVALID",
	bundleAlreadyUsed: "TRANSCODE_PROBE_STARTUP_SAFETY_BUNDLE_ALREADY_USED",
});

function freeze(value) {
	return Object.freeze(value);
}

function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summary(values = {}) {
	return freeze({
		manifestSourceCount: Number.isSafeInteger(values.manifestSourceCount) ? values.manifestSourceCount : 0,
		recoveryContributionCount: Number.isSafeInteger(values.recoveryContributionCount) ? values.recoveryContributionCount : 0,
		barrierActive: values.barrierActive === true,
		migrationComplete: values.migrationComplete === true,
	});
}

/**
 * The plan combiner is deliberately injected already bound to C3A's opaque
 * contribution consumer. This keeps this module independent of lock internals.
 */
export function createTranscodeProbeStartupSafetyAuthority({
	journalRecoveryContributionAdapter,
	combineSourceLockPlans,
	barrierViewConsumer,
} = {}) {
	if (!record(journalRecoveryContributionAdapter) || typeof journalRecoveryContributionAdapter.createContributions !== "function"
		|| typeof combineSourceLockPlans !== "function"
		|| !record(barrierViewConsumer) || typeof barrierViewConsumer.inspect !== "function") {
		throw new TypeError("Probe startup safety dependencies are invalid");
	}
	const authority = {};

	function build({ manifestPlan, finalJournalCollection, migrationBarrierView } = {}) {
		let barrier;
		try { barrier = barrierViewConsumer.inspect(migrationBarrierView); }
		catch { return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.barrierInvalid, bundle: null, safeSummary: summary() }); }
		if (!record(barrier) || typeof barrier.barrierActive !== "boolean" || typeof barrier.migrationComplete !== "boolean") {
			return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.barrierInvalid, bundle: null, safeSummary: summary() });
		}
		let contributionResult;
		try { contributionResult = journalRecoveryContributionAdapter.createContributions(finalJournalCollection); }
		catch { return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.contributionFailed, bundle: null, safeSummary: summary({ barrierActive: barrier.barrierActive, migrationComplete: barrier.migrationComplete }) }); }
		if (!contributionResult?.ok || !Array.isArray(contributionResult.contributions)) {
			return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.contributionFailed, bundle: null, safeSummary: summary({ barrierActive: barrier.barrierActive, migrationComplete: barrier.migrationComplete }) });
		}
		let combined;
		try { combined = combineSourceLockPlans({ manifestPlan, contributions: contributionResult.contributions }); }
		catch { return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.planCombineFailed, bundle: null, safeSummary: summary({ recoveryContributionCount: contributionResult.contributions.length, barrierActive: barrier.barrierActive, migrationComplete: barrier.migrationComplete }) }); }
		if (!combined?.ok || !combined.plan || !record(combined.summary)) {
			return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.planCombineFailed, bundle: null, safeSummary: summary({ recoveryContributionCount: contributionResult.contributions.length, barrierActive: barrier.barrierActive, migrationComplete: barrier.migrationComplete }) });
		}
		const bundle = freeze({ kind: "transcode-probe-startup-safety-bundle" });
		const safeSummary = summary({
			manifestSourceCount: Number.isSafeInteger(combined.summary.sourceCount) ? combined.summary.sourceCount : 0,
			recoveryContributionCount: contributionResult.contributions.length,
			barrierActive: barrier.barrierActive,
			migrationComplete: barrier.migrationComplete,
		});
		bundles.set(bundle, { authority, plan: combined.plan, barrierView: migrationBarrierView, used: false });
		return freeze({ ok: true, code: null, bundle, safeSummary });
	}

	const bundleConsumer = freeze({
		consume(bundle, callback) {
			const details = bundles.get(bundle);
			if (!details || details.authority !== authority || typeof callback !== "function") {
				return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.bundleInvalid });
			}
			if (details.used) return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.bundleAlreadyUsed });
			details.used = true;
			try {
				callback(freeze({ combinedSourceLockPlan: details.plan, migrationBarrierView: details.barrierView }));
				return freeze({ ok: true, code: null });
			} catch {
				return freeze({ ok: false, code: TRANSCODE_PROBE_STARTUP_SAFETY_CODES.bundleInvalid });
			}
		},
	});

	return freeze({ builder: freeze({ build }), bundleConsumer });
}
