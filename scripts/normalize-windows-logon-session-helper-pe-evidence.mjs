import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HELPER_BASENAME = "windows-logon-session-snapshot-helper.exe";
const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export const WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES = Object.freeze({
	argumentInvalid: "WINDOWS_LOGON_PE_EVIDENCE_ARGUMENT_INVALID",
	helperInvalid: "WINDOWS_LOGON_PE_EVIDENCE_HELPER_INVALID",
	helperSizeInvalid: "WINDOWS_LOGON_PE_EVIDENCE_HELPER_SIZE_INVALID",
	evidenceInvalid: "WINDOWS_LOGON_PE_EVIDENCE_EVIDENCE_INVALID",
	evidenceSizeInvalid: "WINDOWS_LOGON_PE_EVIDENCE_EVIDENCE_SIZE_INVALID",
	evidenceDuplicate: "WINDOWS_LOGON_PE_EVIDENCE_EVIDENCE_DUPLICATE",
	shaMismatch: "WINDOWS_LOGON_PE_EVIDENCE_SHA_MISMATCH",
	headersInvalid: "WINDOWS_LOGON_PE_EVIDENCE_HEADERS_INVALID",
	architectureInvalid: "WINDOWS_LOGON_PE_EVIDENCE_ARCHITECTURE_INVALID",
	peFormatInvalid: "WINDOWS_LOGON_PE_EVIDENCE_PE_FORMAT_INVALID",
	imageKindInvalid: "WINDOWS_LOGON_PE_EVIDENCE_IMAGE_KIND_INVALID",
	mitigationMissing: "WINDOWS_LOGON_PE_EVIDENCE_MITIGATION_MISSING",
	dependentsInvalid: "WINDOWS_LOGON_PE_EVIDENCE_DEPENDENTS_INVALID",
	importsInvalid: "WINDOWS_LOGON_PE_EVIDENCE_IMPORTS_INVALID",
	loadconfigInvalid: "WINDOWS_LOGON_PE_EVIDENCE_LOADCONFIG_INVALID",
	unexpected: "WINDOWS_LOGON_PE_EVIDENCE_UNEXPECTED",
});

function freeze(value) { return Object.freeze(value); }
function failure(code) { return freeze({ status: "failed", code }); }
function nonEmptyText(value) { return typeof value === "string" && value.trim().length > 0; }
function sortedNames(value) { return freeze([...new Set(value.map((name) => name.toLowerCase()))].sort()); }

function dllNames(value) {
	return [...value.matchAll(/^\s*([A-Za-z0-9._-]+\.dll)\s*$/gim)].map((match) => match[1]);
}

function normalizedSubsystem(headers) {
	const match = headers.match(/\bsubsystem\b[^\r\n]*\(([^)]+)\)/i);
	return match ? match[1].trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") : null;
}

function hasHeaderCharacteristic(headers, value) {
	return headers.split(/\r?\n/).some((line) => new RegExp(`^\\s*${value}\\s*$`, "i").test(line));
}

function loadconfigGuardFlags(loadconfig) {
	const lines = loadconfig.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		if (!/^\s*Guard\s+Flags\b/i.test(lines[index])) continue;
		const value = lines[index].match(/^\s*Guard\s+Flags\s*:?\s*((?:0[xX])?[0-9a-fA-F]+)\s*$/i);
		if (!value) return freeze({ found: true, valueValid: false, valueNonZero: false, cfInstrumented: false, fidTablePresent: false });
		const hexadecimal = value[1].replace(/^0x/i, "");
		const valueNonZero = /[1-9a-f]/i.test(hexadecimal);
		if (!valueNonZero) return freeze({ found: true, valueValid: true, valueNonZero: false, cfInstrumented: false, fidTablePresent: false });
		const block = [lines[index]];
		for (let offset = 1; offset <= 16 && index + offset < lines.length; offset += 1) {
			const line = lines[index + offset];
			if (line.trim() === "" || /^\S/.test(line)) break;
			block.push(line);
		}
		const text = block.join("\n");
		return freeze({ found: true, valueValid: true, valueNonZero: true, cfInstrumented: /\bCF\s+Instrumented\b/i.test(text), fidTablePresent: /\bFID\s+table\s+present\b/i.test(text) });
	}
	return freeze({ found: false, valueValid: false, valueNonZero: false, cfInstrumented: false, fidTablePresent: false });
}

function parseImports(imports) {
	const delayIndex = imports.search(/\bdelay\s+load\s+imports?\b/i);
	const normal = delayIndex < 0 ? imports : imports.slice(0, delayIndex);
	const delay = delayIndex < 0 ? "" : imports.slice(delayIndex);
	return freeze({ importLibraries: sortedNames(dllNames(normal)), delayLoadLibraries: sortedNames(dllNames(delay)) });
}

function parseHeaders(headers, loadconfig) {
	if (!nonEmptyText(headers)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid);
	if (!/\b[0-9a-f]{4}\s+machine\b/i.test(headers)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid);
	if (!/\b8664\s+machine\b/i.test(headers)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.architectureInvalid);
	if (!/\bPE32\+/i.test(headers)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.peFormatInvalid);
	if (hasHeaderCharacteristic(headers, "DLL(?:\\s+IMAGE)?") || !hasHeaderCharacteristic(headers, "EXECUTABLE(?:\\s+IMAGE)?")) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.imageKindInvalid);
	const subsystem = normalizedSubsystem(headers);
	if (!subsystem) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid);
	const dynamicBase = /\bdynamic\s+base\b/i.test(headers);
	const nxCompat = /\bnx\s+compatible\b/i.test(headers);
	const flags = loadconfigGuardFlags(loadconfig);
	const guardCf = hasHeaderCharacteristic(headers, "Guard\\s+CF") && flags.found && flags.valueValid && flags.valueNonZero && flags.cfInstrumented && flags.fidTablePresent;
	if (!dynamicBase || !nxCompat || !guardCf) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing);
	return freeze({ status: "passed", machine: "AMD64", peFormat: "PE32+", imageKind: "executable", subsystem, dynamicBase, nxCompat, guardCf });
}

export function normalizeWindowsLogonSessionHelperPeEvidence({ sourceCommit, helperBasename, helperSizeBytes, helperSha256, expectedPowershellSha256, headers, dependents, imports, loadconfig } = {}) {
	if (typeof sourceCommit !== "string" || !COMMIT.test(sourceCommit) || typeof helperBasename !== "string" || helperBasename.toLowerCase() !== HELPER_BASENAME || typeof helperSha256 !== "string" || !SHA256.test(helperSha256) || typeof expectedPowershellSha256 !== "string" || !SHA256.test(expectedPowershellSha256)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid);
	if (!Number.isSafeInteger(helperSizeBytes) || helperSizeBytes <= 0 || helperSizeBytes > MAX_HELPER_BYTES) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid);
	if (helperSha256 !== expectedPowershellSha256) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.shaMismatch);
	if (!nonEmptyText(loadconfig)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.loadconfigInvalid);
	const parsedHeaders = parseHeaders(headers, loadconfig);
	if (parsedHeaders.status !== "passed") return parsedHeaders;
	if (!nonEmptyText(dependents)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.dependentsInvalid);
	const directDependencies = sortedNames(dllNames(dependents));
	if (directDependencies.length === 0) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.dependentsInvalid);
	if (!nonEmptyText(imports)) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.importsInvalid);
	const parsedImports = parseImports(imports);
	if (parsedImports.importLibraries.length === 0) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.importsInvalid);
	return freeze({
		status: "passed", phase: "c2a-pe-dependency-evidence", sourceCommit, helperBasename: HELPER_BASENAME,
		helperSha256, helperSizeBytes, machine: parsedHeaders.machine, peFormat: parsedHeaders.peFormat, imageKind: parsedHeaders.imageKind,
		subsystem: parsedHeaders.subsystem, dynamicBase: parsedHeaders.dynamicBase, nxCompat: parsedHeaders.nxCompat, guardCf: parsedHeaders.guardCf,
		directDependencies, importLibraries: parsedImports.importLibraries, delayLoadLibraries: parsedImports.delayLoadLibraries,
		dependencyPolicy: "evidence-only", allowlistApplied: false,
	});
}

export function parseWindowsLogonSessionHelperPeEvidenceArguments(argv) {
	const names = new Set(["helper", "headers", "dependents", "imports", "loadconfig", "source-commit", "expected-powershell-sha256"]);
	const result = {};
	for (let index = 0; index < argv.length; index += 2) {
		const token = argv[index];
		const value = argv[index + 1];
		if (typeof token !== "string" || !token.startsWith("--") || !names.has(token.slice(2)) || typeof value !== "string" || value.length === 0 || index + 1 >= argv.length || Object.hasOwn(result, token.slice(2))) return null;
		result[token.slice(2)] = value;
	}
	return Object.keys(result).length === names.size ? freeze(result) : null;
}

async function readBounded(fileSystem, filePath, maximum) {
	let handle;
	try {
		handle = await fileSystem.open(filePath, "r");
		const chunks = [];
		let total = 0;
		for (;;) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - total));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maximum) return null;
			chunks.push(buffer.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, total);
	} finally {
		if (handle) await handle.close();
	}
}

async function inspectInput(fileSystem, filePath, { helper = false, maximum }) {
	const invalid = helper ? WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid : WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid;
	const tooLarge = helper ? WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid : WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceSizeInvalid;
	try {
		if (typeof filePath !== "string" || filePath.length === 0) return freeze({ ok: false, code: invalid });
		const stat = await fileSystem.lstat(filePath);
		if (!stat?.isFile?.() || stat.isSymbolicLink?.()) return freeze({ ok: false, code: invalid });
		if (!Number.isSafeInteger(stat.size) || stat.size <= 0) return freeze({ ok: false, code: invalid });
		if (stat.size > maximum) return freeze({ ok: false, code: tooLarge });
		const canonicalPath = await fileSystem.realpath(filePath);
		if (typeof canonicalPath !== "string" || canonicalPath.length === 0) return freeze({ ok: false, code: invalid });
		const bytes = await readBounded(fileSystem, filePath, maximum);
		if (bytes === null) return freeze({ ok: false, code: tooLarge });
		if (bytes.length === 0) return freeze({ ok: false, code: invalid });
		return freeze({ ok: true, code: null, canonicalPath, bytes });
	} catch {
		return freeze({ ok: false, code: invalid });
	}
}

function uniqueCanonicalInputs(inputs) {
	const seen = new Set();
	for (const input of inputs) {
		const key = process.platform === "win32" ? input.canonicalPath.toLowerCase() : input.canonicalPath;
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

export async function normalizeWindowsLogonSessionHelperPeEvidenceFiles(inputArguments, fileSystem = { lstat, realpath, open }) {
	if (!inputArguments) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid);
	if (typeof inputArguments.helper !== "string" || !isAbsolute(inputArguments.helper) || basename(inputArguments.helper).toLowerCase() !== HELPER_BASENAME) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
	const helper = await inspectInput(fileSystem, inputArguments.helper, { helper: true, maximum: MAX_HELPER_BYTES });
	if (!helper.ok) return failure(helper.code);
	if (basename(helper.canonicalPath).toLowerCase() !== HELPER_BASENAME) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid);
	const descriptors = [["headers", inputArguments.headers], ["dependents", inputArguments.dependents], ["imports", inputArguments.imports], ["loadconfig", inputArguments.loadconfig]];
	const evidence = [];
	for (const [, filePath] of descriptors) {
		const inspected = await inspectInput(fileSystem, filePath, { helper: false, maximum: MAX_EVIDENCE_BYTES });
		if (!inspected.ok) return failure(inspected.code);
		evidence.push(inspected);
	}
	if (!uniqueCanonicalInputs([helper, ...evidence])) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceDuplicate);
	let texts;
	try { texts = evidence.map((item) => new TextDecoder("utf-8", { fatal: true }).decode(item.bytes)); } catch { return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid); }
	if (texts.some((text) => !nonEmptyText(text))) return failure(WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid);
	const helperSha256 = createHash("sha256").update(helper.bytes).digest("hex");
	return normalizeWindowsLogonSessionHelperPeEvidence({ sourceCommit: inputArguments["source-commit"], helperBasename: basename(helper.canonicalPath), helperSizeBytes: helper.bytes.length, helperSha256, expectedPowershellSha256: inputArguments["expected-powershell-sha256"], headers: texts[0], dependents: texts[1], imports: texts[2], loadconfig: texts[3] });
}

export function getWindowsLogonSessionHelperPeEvidenceExitCode(result) {
	if (result?.status === "passed") return 0;
	if ([WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.argumentInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.helperSizeInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceSizeInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.evidenceDuplicate].includes(result?.code)) return 2;
	if (result?.code === WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.shaMismatch) return 3;
	if ([WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.headersInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.architectureInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.peFormatInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.imageKindInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.mitigationMissing, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.dependentsInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.importsInvalid, WINDOWS_LOGON_SESSION_PE_EVIDENCE_CODES.loadconfigInvalid].includes(result?.code)) return 4;
	return 7;
}

export async function runWindowsLogonSessionHelperPeEvidenceCli(argv = process.argv.slice(2)) {
	const argumentsValue = parseWindowsLogonSessionHelperPeEvidenceArguments(argv);
	const result = await normalizeWindowsLogonSessionHelperPeEvidenceFiles(argumentsValue);
	const output = JSON.stringify(result);
	if (result.status === "passed") console.log(output);
	else console.error(output);
	process.exitCode = getWindowsLogonSessionHelperPeEvidenceExitCode(result);
	return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void runWindowsLogonSessionHelperPeEvidenceCli();
}
