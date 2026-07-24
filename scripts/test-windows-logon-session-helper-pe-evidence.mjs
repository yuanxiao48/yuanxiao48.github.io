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
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const HEADERS = `FILE HEADER VALUES\n             8664 machine (x64)\n             EXECUTABLE IMAGE\nOPTIONAL HEADER VALUES\n             20B magic # (PE32+)\n               3 subsystem (Windows CUI)\n               Dynamic base\n               NX compatible\n               Guard CF\n`;
const DEPENDENTS = `Image has the following dependencies:\n    ADVAPI32.dll\n    KERNEL32.DLL\n    ADVAPI32.dll\n`;
const IMPORTS = `Section contains the following imports:\n    KERNEL32.dll\n    ADVAPI32.DLL\nDelay Load Imports\n    USER32.dll\n    USER32.dll\n`;
const LOADCONFIG = `Load Configuration\n    Guard Flags: 500\n        CF Instrumented\n        FID table present\n`;
const BYTES = Buffer.from([0x4d, 0x5a, 0, 1, 2, 3]);
const HASH = createHash("sha256").update(BYTES).digest("hex");

function input(overrides = {}) { return { sourceCommit: COMMIT, helperBasename: HELPER, helperSizeBytes: BYTES.length, helperSha256: HASH, expectedPowershellSha256: HASH, headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG, ...overrides }; }
function assertFailure(result, code) { assert.equal(result.status, "failed"); assert.equal(result.code, code); assert.equal(Object.isFrozen(result), true); assert.equal(JSON.stringify(result).includes("sentinel"), false); }

const success = normalizeWindowsLogonSessionHelperPeEvidence(input());
assert.equal(success.status, "passed"); assert.equal(Object.isFrozen(success), true); assert.equal(Object.isFrozen(success.directDependencies), true); assert.equal(Object.isFrozen(success.importLibraries), true); assert.equal(Object.isFrozen(success.delayLoadLibraries), true);
assert.deepEqual(success.directDependencies, ["advapi32.dll", "kernel32.dll"]); assert.deepEqual(success.importLibraries, ["advapi32.dll", "kernel32.dll"]); assert.deepEqual(success.delayLoadLibraries, ["user32.dll"]);
assert.equal(success.machine, "AMD64"); assert.equal(success.peFormat, "PE32+"); assert.equal(success.imageKind, "executable"); assert.equal(success.subsystem, "WINDOWS_CUI"); assert.equal(success.dynamicBase, true); assert.equal(success.nxCompat, true); assert.equal(success.guardCf, true); assert.equal(success.allowlistApplied, false); assert.equal(success.dependencyPolicy, "evidence-only"); assert.equal(getWindowsLogonSessionHelperPeEvidenceExitCode(success), 0);

assert.equal(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("8664 machine (x64)", "8664 machine") })).status, "passed");
for (const headers of [HEADERS.replace("8664 machine (x64)", "machine (x64)"), HEADERS.replace("8664 machine (x64)", "unrelated x64 text")]) assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid);
for (const headers of [HEADERS.replace("8664 machine (x64)", "014C machine (x86)"), HEADERS.replace("8664 machine (x64)", "AA64 machine (ARM64)")]) assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.architectureInvalid);
const guardFlags = (value, details = "    CF Instrumented\n    FID table present\n") => `Load Configuration\n    Guard Flags: ${value}\n${details}`;
assert.equal(normalizeWindowsLogonSessionHelperPeEvidence(input({ loadconfig: guardFlags("0x00000500") })).status, "passed");
for (const loadconfig of ["Load Configuration\n", guardFlags("0"), guardFlags("00000000"), guardFlags("0x00000000"), guardFlags("", "    CF Instrumented\n    FID table present\n"), guardFlags("not-a-number"), guardFlags("500 600"), guardFlags("500", "    CF Instrumented\n"), guardFlags("500", "    FID table present\n"), guardFlags("500", "\n    CF Instrumented\n    FID table present\n"), "unrelated CF Instrumented\n unrelated FID table present\n"]) assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ loadconfig })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
const zeroFlagsFailure = normalizeWindowsLogonSessionHelperPeEvidence(input({ loadconfig: guardFlags("0x00000000") })); assertFailure(zeroFlagsFailure, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing); assert.equal(JSON.stringify(zeroFlagsFailure).includes("0x00000000"), false);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("Guard CF", "Guard CF function table"), loadconfig: LOADCONFIG })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("Guard CF", ""), loadconfig: LOADCONFIG })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
assert.equal(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.toLowerCase(), loadconfig: LOADCONFIG.toLowerCase().replace("    ", "\t") })).status, "passed");
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("NX compatible", "") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("Dynamic base", "") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ sourceCommit: "A".repeat(40) })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ expectedPowershellSha256: "not-a-hash" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ helperSizeBytes: 0 })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ helperSizeBytes: (16 * 1024 * 1024) + 1 })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ expectedPowershellSha256: "b".repeat(64) })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.shaMismatch);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: "invalid dumpbin output" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("PE32+", "PE32 ") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.peFormatInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: HEADERS.replace("EXECUTABLE IMAGE", "DLL IMAGE") })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.imageKindInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ dependents: "none" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.dependentsInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ imports: "none" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.importsInvalid);
assertFailure(normalizeWindowsLogonSessionHelperPeEvidence(input({ loadconfig: "" })), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.loadconfigInvalid);
assert.equal(getWindowsLogonSessionHelperPeEvidenceExitCode(normalizeWindowsLogonSessionHelperPeEvidence(input({ expectedPowershellSha256: "b".repeat(64) }))), 3);
assert.equal(getWindowsLogonSessionHelperPeEvidenceExitCode(normalizeWindowsLogonSessionHelperPeEvidence(input({ headers: "invalid dumpbin output" }))), 4);
const alternative = normalizeWindowsLogonSessionHelperPeEvidence(input({ dependents: "Image has the following dependencies:\n    ZEBRA.DLL\n", imports: "Section contains the following imports:\n    ZEBRA.DLL\n" })); assert.equal(alternative.status, "passed"); assert.deepEqual(alternative.directDependencies, ["zebra.dll"]);

const validArgs = ["--helper", HELPER, "--headers", "headers.txt", "--dependents", "dependents.txt", "--imports", "imports.txt", "--loadconfig", "loadconfig.txt", "--source-commit", COMMIT, "--expected-powershell-sha256", HASH];
assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments(validArgs)?.helper, HELPER); assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments([...validArgs, "--helper", HELPER]), null); assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments([...validArgs, "--unknown", "x"]), null); assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments(["--helper"]), null); assert.equal(parseWindowsLogonSessionHelperPeEvidenceArguments([...validArgs.slice(0, 1), "", ...validArgs.slice(2)]), null);

const root = await mkdtemp(join(tmpdir(), "studio-4a3-c2a-pe-evidence-"));
try {
	const helper = join(root, HELPER); const headers = join(root, "headers.txt"); const dependents = join(root, "dependents.txt"); const imports = join(root, "imports.txt"); const loadconfig = join(root, "loadconfig.txt");
	await Promise.all([writeFile(helper, BYTES), writeFile(headers, HEADERS), writeFile(dependents, DEPENDENTS), writeFile(imports, IMPORTS), writeFile(loadconfig, LOADCONFIG)]);
	const argumentsValue = { helper, headers, dependents, imports, loadconfig, "source-commit": COMMIT, "expected-powershell-sha256": HASH };
	const fromFiles = await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue); assert.equal(fromFiles.status, "passed"); assert.equal(fromFiles.helperSha256, HASH);
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ ...argumentsValue, "expected-powershell-sha256": "c".repeat(64) }), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.shaMismatch);
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ ...argumentsValue, helper: join(root, "wrong.exe") }), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
	for (const field of ["headers", "dependents", "imports", "loadconfig"]) assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles({ ...argumentsValue, [field]: root }), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid);
	for (const field of ["headers", "dependents", "imports", "loadconfig"]) { await writeFile(argumentsValue[field], ""); assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid); await writeFile(argumentsValue[field], ({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[field]); }
	const exactLimit = Buffer.concat([Buffer.from(HEADERS), Buffer.alloc(MAX_EVIDENCE_BYTES - Buffer.byteLength(HEADERS), 0x20)]); await writeFile(headers, exactLimit); assert.equal((await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue)).status, "passed"); await writeFile(headers, Buffer.concat([exactLimit, Buffer.from("x")])); assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceSizeInvalid); await writeFile(headers, HEADERS);
	const symlinkFileSystem = { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }), realpath: async () => root, open: async () => { throw new Error("must not open symlink"); } };
	assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, symlinkFileSystem), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
	function memoryFileSystem(entries) { return { lstat: async (path) => entries[path].stat, realpath: async (path) => entries[path].canonical, open: async (path) => { let offset = 0; const value = entries[path].bytes; return { read: async (buffer, start, length) => { const size = Math.min(length, value.length - offset); if (size > 0) value.copy(buffer, start, offset, offset + size); offset += Math.max(size, 0); return { bytesRead: Math.max(size, 0) }; }, close: async () => {} }; } }; }
	const paths = { helper, headers, dependents, imports, loadconfig }; const validStat = (size) => ({ size, isFile: () => true, isSymbolicLink: () => false });
	for (const field of ["headers", "dependents", "imports", "loadconfig"]) { const entries = Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, { bytes: Buffer.from(name === "helper" ? BYTES : ({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name]), canonical: path, stat: validStat(name === "helper" ? BYTES.length : Buffer.byteLength(({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name])) }])); entries[paths[field]].stat = { size: 1, isFile: () => false, isSymbolicLink: () => false }; assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, memoryFileSystem(entries)), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid); }
	for (const field of ["headers", "dependents", "imports", "loadconfig"]) { const entries = Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, { bytes: Buffer.from(name === "helper" ? BYTES : ({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name]), canonical: path, stat: validStat(name === "helper" ? BYTES.length : Buffer.byteLength(({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name])) }])); entries[paths[field]].stat = { size: 1, isFile: () => true, isSymbolicLink: () => true }; assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, memoryFileSystem(entries)), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid); }
	const duplicateEntries = Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, { bytes: Buffer.from(name === "helper" ? BYTES : ({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name]), canonical: path, stat: validStat(name === "helper" ? BYTES.length : Buffer.byteLength(({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name])) }])); duplicateEntries[paths.headers].canonical = join(root, "same.txt"); duplicateEntries[paths.imports].canonical = join(root, "same.txt"); assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, memoryFileSystem(duplicateEntries)), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceDuplicate);
	const helperDuplicateEntries = Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, { bytes: Buffer.from(name === "helper" ? BYTES : ({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name]), canonical: path, stat: validStat(name === "helper" ? BYTES.length : Buffer.byteLength(({ headers: HEADERS, dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name])) }])); helperDuplicateEntries[paths.headers].canonical = helperDuplicateEntries[paths.helper].canonical; assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, memoryFileSystem(helperDuplicateEntries)), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceDuplicate);
	const growingEntries = Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, { bytes: Buffer.from(name === "headers" ? Buffer.concat([Buffer.from(HEADERS), Buffer.alloc(MAX_EVIDENCE_BYTES, 0x20)]) : name === "helper" ? BYTES : ({ dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name]), canonical: path, stat: validStat(name === "headers" ? 1 : name === "helper" ? BYTES.length : Buffer.byteLength(({ dependents: DEPENDENTS, imports: IMPORTS, loadconfig: LOADCONFIG })[name])) }])); assertFailure(await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, memoryFileSystem(growingEntries)), WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceSizeInvalid);
	const sentinelFileSystem = { lstat: async () => { throw new Error(`sentinel ${helper}`); }, realpath: async () => { throw new Error("must not resolve"); }, open: async () => { throw new Error("must not open"); } };
	const sentinelResult = await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue, sentinelFileSystem); assertFailure(sentinelResult, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid); assert.equal(JSON.stringify(sentinelResult).includes(helper), false);
} finally { await rm(root, { recursive: true, force: true }); }

console.log("windows logon-session helper PE evidence tests passed");
