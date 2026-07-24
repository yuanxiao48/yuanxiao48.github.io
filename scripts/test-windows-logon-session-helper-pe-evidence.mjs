import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getWindowsLogonSessionHelperPeEvidenceExitCode,
	normalizeWindowsLogonSessionHelperPeEvidence,
	normalizeWindowsLogonSessionHelperPeEvidenceFiles,
	parseWindowsLogonSessionHelperPeEvidenceArguments,
	WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES,
} from "./normalize-windows-logon-session-helper-pe-evidence.mjs";

const COMMIT = "a".repeat(40);
const HELPER = "windows-logon-session-snapshot-helper.exe";
const HEADERS = `FILE HEADER VALUES\n             8664 machine (x64)\n             EXECUTABLE IMAGE\nOPTIONAL HEADER VALUES\n             20B magic # (PE32+)\n               3 subsystem (Windows CUI)\n               Dynamic base\n               NX compatible\n               Guard CF\n`;
const DEPENDENTS = `Image has the following dependencies:\n    ADVAPI32.dll\n    KERNEL32.DLL\n    ADVAPI32.dll\n`;
const IMPORTS = `Section contains the following imports:\n    KERNEL32.dll\n    ADVAPI32.DLL\nDelay Load Imports\n    USER32.dll\n    USER32.dll\n`;
const LOADCONFIG = `Load Configuration\n    Guard Flags: CF Instrumented\n`;
const BYTES = Buffer.from([0x4d, 0x5a, 0, 1, 2, 3]);
const HASH = createHash("sha256").update(BYTES).digest("hex");

function input(overrides = {}) {
	return { sourceCommit: COMMIT, helperBasename: HELPER, helperSizeBytes: BYTES.length, helperSha256: HASH, expectedPowershellSha256: HASH, headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG, ...overrides };
}
function assertFailure(result, code) {
	assert.equal(result.status, "failed"); assert.equal(result.code, code); assert.equal(Object.isFrozen(result), true);
	assert.equal(JSON.stringify(result).includes("sentinel"), false);
}

const success = normalizeWindowsLogonSessionHelperPeEvidence(input());
assert.equal(success.status, "passed"); assert.equal(Object.isFrozen(success), true); assert.equal(Object.isFrozen(success.directDependencies), true); assert.equal(Object.isFrozen(success.importLibraries), true); assert.equal(Object.isFrozen(success.delayLoadLibraries), true);
assert.deepEqual(success.directDependencies, ["advapi32.dll", "kernel32.dll"]);
assert.deepEqual(success.importLibraries, ["advapi32.dll", "kernel32.dll"]);
assert.deepEqual(success.delayLoadLibraries, ["user32.dll"]);
assert.equal(success.machine, "AMD64"); assert.equal(success.peFormat, "PE32+"); assert.equal(success.imageKind, "executable"); assert.equal(success.subsystem, "WINDOWS_CUI");
assert.equal(success.dynamicBase, true); assert.equal(success.nxCompat, true); assert.equal(success.guardCf, true); assert.equal(success.allowlistApplied, false); assert.equal(getWindowsLogonSessionHelperPeEvidenceExitCode(success), 0);

assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ sourceCommit: "A".repeat(40) })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ helperBasename: "other.exe" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ helperSizeBytes: 0 })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ helperSizeBytes: (16 * 1024 * 1024) + 1 })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ expectedPowershellSha256: "b".repeat(64) })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.shaMismatch);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: "invalid dumpbin output" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("8664 machine (x64)", "014c machine (x86)") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.architectureInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("PE32+", "PE32 ") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.peFormatInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("EXECUTABLE IMAGE", "DLL IMAGE") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.imageKindInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("Dynamic base", "") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ dependents: "none" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.dependentsInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ imports: "none" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.importsInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ loadconfig: "" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.loadconfigInvalid);
assert.equal(getWindowsLogonSessionHelperPeEvidenceExitCode(normalizeWindowsLogonSessionHelperPeEvidence(input({ expectedPowershellSha256: "b".repeat(64) }))), 3);
assert.equal(getWindowsLogonSessionHelperPeEvidenceExitCode(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: "invalid dumpbin output" }))), 4);
const alternative = normalizeWindowsLogonSessionHelperPeEvidence(input({ dependents: "Image has the following dependencies:\n    ZEBRA.DLL\n", imports: "Section contains the following imports:\n    ZEBRA.DLL\n" }));
assert.equal(alternative.status, "passed"); assert.deepEqual(alternative.directDependencies, ["zebra.dll"]);

const validArgs = ["--helper", HELPER, "--headers", "headers.txt", "--dependents", "dependents.txt", "--imports", "imports.txt", "--loadconfig", "loadconfig.txt", "--source-commit", COMMIT, "--expected-powershell-sha256", HASH];
assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments(validArgs)?.helper, HELPER);
assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments([...validArgs, "--helper", HELPER]), null);
assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments([...validArgs, "--unknown", "x"]), null);
assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments(["--helper"]), null);

const root = await mkdtemp(join(tmpdir(), "studio-4a3-c2a-pe-evidence-"));
try {
	const helper = join(root, HELPER); const headers = join(root, "headers.txt"); const dependents = join(root, "dependents.txt"); const imports = join(root, "imports.txt"); const loadconfig = join(root, "loadconfig.txt");
	await Promise.all([writeFile(helper, BYTES), writeFile(headers, HEADERS), writeFile(dependents, DEPENDENTS), writeFile(imports, IMPORTS), writeFile(loadconfig, LOADCONFIG)]);
	const fromFiles = await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ helper, headers, dependents, imports, loadconfig, "source-commit": COMMIT, "expected-powershell-sha256": HASH });
	assert.equal(fromFiles.status, "passed"); assert.equal(fromFiles.helperSha256, HASH);
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ helper, headers, dependents, imports, loadconfig, "source-commit": COMMIT, "expected-powershell-sha256": "c".repeat(64) }), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.shaMismatch);
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ helper: join(root, "wrong.exe"), headers, dependents, imports, loadconfig, "source-commit": COMMIT, "expected-powershell-sha256": HASH }), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ helper: HELPER, headers, dependents, imports, loadconfig, "source-commit": COMMIT, "expected-powershell-sha256": HASH }), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
	const symlinkFileSystem = { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }), readFile: async () => { throw new Error("must not read symlink"); } };
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ helper, headers, dependents, imports, loadconfig, "source-commit": COMMIT, "expected-powershell-sha256": HASH }, symlinkFileSystem), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("windows logon-session helper PE evidence tests passed");
