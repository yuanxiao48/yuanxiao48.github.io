import { isWindowsLogonSessionSnapshotConsumer } from "./windows-logon-session-snapshot-protocol.mjs";

export const WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_CODES = Object.freeze({
	unavailable: "WINDOWS_LOGON_SESSION_LIVENESS_UNAVAILABLE",
	runnerInvalid: "WINDOWS_LOGON_SESSION_LIVENESS_RUNNER_INVALID",
	snapshotInvalid: "WINDOWS_LOGON_SESSION_LIVENESS_SNAPSHOT_INVALID",
	issuerInvalid: "WINDOWS_LOGON_SESSION_LIVENESS_ISSUER_INVALID",
});

function freeze(value) { return Object.freeze(value); }

export function createWindowsLogonSessionLivenessProvider({ snapshotRunner, snapshotConsumer, containmentAuthority, hash } = {}) {
	if (!snapshotRunner || typeof snapshotRunner.runOnce !== "function" || !isWindowsLogonSessionSnapshotConsumer(snapshotConsumer)) {
		throw new TypeError("Windows logon-session liveness provider dependencies are invalid");
	}
	const issuer = containmentAuthority?.windowsLogonSessionLivenessStartupStateIssuer;
	if (!issuer || typeof issuer.createStartupState !== "function" || typeof hash !== "function") {
		throw new TypeError("Windows logon-session liveness containment issuer is invalid");
	}
	let startupPromise = null;
	function unavailable(code) { return freeze({ ok: false, code, unavailable: true, startupState: null }); }
	function getStartupState() {
		if (startupPromise) return startupPromise;
		startupPromise = (async () => {
			let run;
			try { run = await snapshotRunner.runOnce(); } catch { return unavailable(WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_CODES.unavailable); }
			if (!run?.ok || !run.snapshot) return unavailable(run?.code || WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_CODES.unavailable);
			const consumed = snapshotConsumer.consume(run.snapshot, (snapshot) => issuer.createStartupState({ ...snapshot, hash }));
			if (!consumed?.ok || !consumed.value?.ok || !consumed.value.startupState) {
				return unavailable(consumed?.code || consumed?.value?.code || WINDOWS_LOGON_SESSION_LIVENESS_PROVIDER_CODES.snapshotInvalid);
			}
			return freeze({ ok: true, code: null, unavailable: false, startupState: consumed.value.startupState });
		})();
		return startupPromise;
	}
	return freeze({ getStartupState });
}
