import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/verify-windows-logon-session-helper-pe-evidence.yml", import.meta.url), "utf8");

function getLiteralRunBlock(lines, runIndex) {
	const match = lines[runIndex].match(/^(\s*)run:\s*\|\s*$/);
	assert.notEqual(match, null, "literal run block");
	const indentation = match[1].length;
	let end = runIndex + 1;
	while (end < lines.length && (lines[end].trim() === "" || lines[end].match(/^\s*/)[0].length > indentation)) end += 1;
	return Object.freeze({ start: runIndex + 1, text: lines.slice(runIndex + 1, end).join("\n") });
}

const workflowLines = workflow.replace(/\r\n/g, "\n").split("\n");
const literalRunBlocks = [];
for (let index = 0; index < workflowLines.length; index += 1) {
	if (!/^\s*run:\s*\|\s*$/.test(workflowLines[index])) continue;
	literalRunBlocks.push(getLiteralRunBlock(workflowLines, index));
}

const collectStepName = "Collect static PE evidence without executing helper";
const collectStepLine = `      - name: ${collectStepName}`;
const collectStepIndices = [];
for (let index = 0; index < workflowLines.length; index += 1) {
	if (workflowLines[index] === collectStepLine) collectStepIndices.push(index);
}
assert.equal(collectStepIndices.length, 1, "exactly one collect PE evidence step");
const [collectStepIndex] = collectStepIndices;
const collectRunIndex = workflowLines.findIndex((line, index) => index > collectStepIndex && /^\s*run:\s*\|\s*$/.test(line));
assert.notEqual(collectRunIndex, -1, "collect PE evidence literal run block");
const collectEvidenceBlock = getLiteralRunBlock(workflowLines, collectRunIndex);
assert.equal(collectEvidenceBlock.text.includes("${{"), false, "collect PE evidence run block has no Actions expression interpolation");
assert.match(collectEvidenceBlock.text, /\$expectedCommit = \$env:GITHUB_SHA\s*\n\s*if \(\[string\]::IsNullOrWhiteSpace\(\$expectedCommit\) -or \$expectedCommit -cnotmatch '\^\[a-f0-9\]\{40\}\$'\) \{ throw 'GITHUB_SHA_INVALID' \}/);
assert.equal((collectEvidenceBlock.text.match(/\$expectedCommit\s*=/g) || []).length, 1, "expected commit assigned once");
assert.match(collectEvidenceBlock.text, /--source-commit \$expectedCommit --expected-powershell-sha256/);
assert.match(collectEvidenceBlock.text, /Assert-NormalizedEvidenceJson \$normalizerLines\[0\] \$expectedCommit \$powershellSha256/);
assert.match(collectEvidenceBlock.text, /Write-Output "4A3_SOURCE_COMMIT=\$sourceCommit"/);
for (const block of literalRunBlocks) {
	if (block.text.length >= 20_000) assert.equal(block.text.includes("${{"), false, `oversized run block at line ${block.start} has no Actions expression interpolation`);
}

const required = [
	"name: Verify Windows Helper PE Evidence", "verify/4a3-real-helper-bff3f755", "contents: read", "runs-on: windows-2022", "timeout-minutes: 15",
	"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2", "persist-credentials: false", "fetch-depth: 1", "Visual Studio 17 2022", "-A x64", "--config Release",
	"--target windows_logon_session_protocol", "--target windows-logon-session-snapshot-protocol-test", "--target windows-logon-session-snapshot-helper", "windows-logon-session-snapshot-protocol-test.exe", "windows-logon-session-snapshot-helper.exe",
	"/headers", "/dependents", "/imports", "/loadconfig", "vswhere.exe", "VsDevCmd.bat", "-arch=x64", "-host_arch=x64", "Get-FileHash", "-Algorithm SHA256", "Replace-LiteralPathInsensitive", "Protect-ToolOutput", "Get-VerifiedToolOutputFile", "Read-BoundedToolOutput", "FileStream", "MemoryStream", "UTF8Encoding", "Test-AbsolutePathResidue", "Assert-PathResidueDetector", "PATH_RESIDUE_DETECTOR_SELF_TEST_FAILED", "<RUNNER_TEMP>", "<GITHUB_WORKSPACE>", "<VISUAL_STUDIO>", "<USERPROFILE>",
	"maxDumpbinStdoutBytes = 8MB", "maxDumpbinStderrBytes = 1MB", "maxNormalizerStdoutBytes = 256KB", "maxNormalizerStderrBytes = 1MB", "normalizer.stdout.txt", "normalizer.stderr.txt", "normalizerExitCode = $LASTEXITCODE",
	"scripts/normalize-windows-logon-session-helper-pe-evidence.mjs", "expected-powershell-sha256", "System.Text.Json.JsonDocument", "System.Text.Json.JsonValueKind", "TryGetInt64", "EnumerateObject", "StringComparer]::Ordinal", "Get-RequiredJsonElement", "Get-ExactJsonString", "Get-ExactJsonBoolean", "Get-JsonDllArray", "Assert-NormalizedEvidenceJson", "JsonDocument", ".Dispose()",
	"NORMALIZED_JSON_INVALID", "NORMALIZED_ROOT_SCHEMA_INVALID", "NORMALIZED_PROPERTY_SET_INVALID", "NORMALIZED_PROPERTY_DUPLICATE", "NORMALIZED_PROPERTY_MISSING", "NORMALIZED_JSON_SCHEMA_INVALID", "NORMALIZED_IDENTITY_INVALID", "NORMALIZED_HELPER_INVALID", "NORMALIZED_PE_INVALID", "NORMALIZED_MITIGATION_INVALID", "NORMALIZED_DEPENDENCIES_INVALID", "NORMALIZED_POLICY_INVALID",
	"DUMPBIN_HEADERS_FAILED", "DUMPBIN_DEPENDENTS_FAILED", "DUMPBIN_IMPORTS_FAILED", "DUMPBIN_LOADCONFIG_FAILED", "DUMPBIN_HEADERS_STDERR_NONEMPTY", "DUMPBIN_DEPENDENTS_STDERR_NONEMPTY", "DUMPBIN_IMPORTS_STDERR_NONEMPTY", "DUMPBIN_LOADCONFIG_STDERR_NONEMPTY", "NORMALIZER_STDOUT_INVALID", "NORMALIZER_STDOUT_TOO_LARGE", "NORMALIZER_STDOUT_READ_FAILED", "NORMALIZER_STDERR_INVALID", "NORMALIZER_STDERR_TOO_LARGE", "NORMALIZER_STDERR_READ_FAILED", "NORMALIZER_STDERR_PATH_RESIDUE", "NORMALIZER_STDERR_NONEMPTY",
	"node scripts/test-windows-logon-session-helper-pe-evidence.mjs", "node scripts/test-windows-logon-session-helper-pe-evidence-workflow-source-contract.mjs", "node scripts/test-windows-logon-session-helper-source-contract.mjs", "node scripts/test-windows-logon-session-real-validator.mjs", "node scripts/test-windows-logon-session-real-validator-source-contract.mjs", "node scripts/test-windows-logon-session-snapshot-protocol.mjs", "node scripts/test-windows-logon-session-snapshot-runner.mjs", "node scripts/test-windows-logon-session-liveness-provider.mjs", "node scripts/test-host-execution-containment-comparison.mjs", "node scripts/test-windows-logon-session-liveness-evidence.mjs",
	"github.repository", "github.ref", "github.sha", "github.event_name", "runner.os", "runner.arch", "studio-4a3-c2a-build", "studio-4a3-c2a-evidence",
];
for (const text of required) assert.equal(workflow.includes(text), true, text);
for (const forbidden of ["workflow_dispatch", "pull_request", "schedule:", "repository_dispatch", "workflow_call", "tags:", "actions/upload-artifact", "actions/download-artifact", "actions/cache", "upload-artifact", "download-artifact", "cache@", "container:", "self-hosted", "matrix:", "services:", "environment:", "secrets.", "GITHUB_TOKEN", "npm ", "npm\n", "CMAKE_MSVC_RUNTIME_LIBRARY", "/MT", "/MD", "Start-Process", "Invoke-Expression", "ScriptBlock::Create", "ConvertFrom-Json", "ReadAllText", "Get-Content -Raw", "Tee-Object", "2>&1", "& $helper.FullName", "process.exit", "always()", "node scripts/validate-windows-logon-session-helper-real.mjs", "windows-logon-session-snapshot-helper.exe --"]) assert.equal(workflow.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
assert.match(workflow, /on:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- verify\/4a3-real-helper-bff3f755/);
assert.match(workflow, /permissions:\s*\n\s+contents: read/);
assert.equal((workflow.match(/uses:\s*actions\/checkout@/g) || []).length, 1);
assert.equal((workflow.match(/uses:/g) || []).length, 1);
assert.equal((workflow.match(/cmake --build \$build --config Release --target/g) || []).length, 3);
for (const [command, code] of [
	["& cmake -S native/windows-logon-session-snapshot-helper -B $build -G \"Visual Studio 17 2022\" -A x64", "CMAKE_CONFIGURE_FAILED"],
	["& cmake --build $build --config Release --target windows_logon_session_protocol", "CMAKE_PROTOCOL_BUILD_FAILED"],
	["& cmake --build $build --config Release --target windows-logon-session-snapshot-protocol-test", "CMAKE_PROTOCOL_TEST_BUILD_FAILED"],
	["& cmake --build $build --config Release --target windows-logon-session-snapshot-helper", "CMAKE_HELPER_BUILD_FAILED"],
]) assert.match(workflow, new RegExp(`${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n\\s*if \\(\\$LASTEXITCODE -ne 0\\) \\{ throw '${code}' \\}`));
assert.equal((workflow.match(/Remove-Item -LiteralPath \$directory -Recurse -Force/g) || []).length, 1);
assert.match(workflow, /Resolve-Path -LiteralPath \$helpers\[0\]\.FullName/);
assert.match(workflow, /& \$protocolTest\.FullName/);
for (const [switchValue, name] of [["headers", "headers"], ["dependents", "dependents"], ["imports", "imports"], ["loadconfig", "loadconfig"]]) assert.equal(workflow.includes(`Invoke-DumpbinEvidence '/${switchValue}' '${name}'`), true, name);
assert.match(workflow, /& \$dumpbin \$switch \$helper\.FullName 1> \$stdoutPath 2> \$stderrPath\s*\n\s*\$exitCode = \$LASTEXITCODE/);
assert.match(workflow, /\$protectedStdout\[\$key\] = Protect-ToolOutput \(Read-BoundedToolOutput/);
assert.match(workflow, /\$protectedStderr\[\$key\] = Protect-ToolOutput \(Read-BoundedToolOutput/);
for (const code of ["HEADERS_PATH_RESIDUE", "DEPENDENTS_PATH_RESIDUE", "IMPORTS_PATH_RESIDUE", "LOADCONFIG_PATH_RESIDUE"]) assert.equal(workflow.includes(code), true, code);
for (const name of ["HEADERS", "DEPENDENTS", "IMPORTS", "LOADCONFIG"]) for (const suffix of ["STDOUT_INVALID", "STDOUT_TOO_LARGE", "STDOUT_READ_FAILED", "STDERR_INVALID", "STDERR_TOO_LARGE", "STDERR_READ_FAILED"]) assert.equal(workflow.includes(`${name}_${suffix}`), true, `${name}_${suffix}`);
for (const text of ["C:\\secret\\helper.pdb", "D:/secret/helper.pdb", "\"E:\\folder\\file.obj\"", "\\\\server\\share\\helper.pdb", "//server/share/helper.pdb", "https://example.com/path", "http://example.com/path", "ftp://example.com/path", "8664 machine (x64)", "Guard Flags: 500"]) assert.equal(workflow.includes(text), true, text);
assert.match(workflow, /\(\?<!\[A-Za-z0-9\+\.\\-\]\)\[A-Za-z\]:\[\\\\\/\]/);
assert.match(workflow, /\(\?<!:\)\(\?<!\[A-Za-z0-9\+\.\\-\]\)\/\/\[\^\/\\r\\n\]\+\//);
assert.match(workflow, /\[regex\]::Escape\(\$needle\)/);
assert.match(workflow, /\$normalizerLines\.Count -ne 1/);
assert.match(workflow, /& node scripts\/normalize-windows-logon-session-helper-pe-evidence\.mjs[\s\S]*1> \$normalizerStdoutPath 2> \$normalizerStderrPath/);
assert.match(workflow, /\$normalizerExitCode = \$LASTEXITCODE/);
assert.match(collectEvidenceBlock.text, /Read-BoundedToolOutput \$normalizerStdoutPath \$true \$maxNormalizerStdoutBytes/);
assert.match(collectEvidenceBlock.text, /Read-BoundedToolOutput \$normalizerStderrPath \$true \$maxNormalizerStderrBytes/);
assert.equal(collectEvidenceBlock.text.indexOf("$normalizerExitCode = $LASTEXITCODE") < collectEvidenceBlock.text.indexOf("$normalizerStdout ="), true);
assert.equal(collectEvidenceBlock.text.indexOf("$normalizerStdout =") < collectEvidenceBlock.text.indexOf("$normalizerStderr ="), true);
assert.equal(collectEvidenceBlock.text.indexOf("$normalizerStderr =") < collectEvidenceBlock.text.indexOf("if ($normalizerExitCode -ne 0)"), true);
assert.match(collectEvidenceBlock.text, /function Assert-NormalizerFailureJson\(\[string\]\$jsonText, \[Int32\]\$expectedExitCode\)/);
assert.match(collectEvidenceBlock.text, /\$expectedProperties = \[string\[\]\]@\('status', 'code'\)/);
assert.match(collectEvidenceBlock.text, /foreach \(\$property in \$jsonRoot\.EnumerateObject\(\)/);
assert.match(collectEvidenceBlock.text, /\$jsonRoot\.TryGetProperty\('status', \[ref\]\$statusElement\)/);
assert.match(collectEvidenceBlock.text, /\$jsonRoot\.TryGetProperty\('code', \[ref\]\$codeElement\)/);
assert.match(collectEvidenceBlock.text, /\$statusElement\.GetString\(\) -cne 'failed'/);
assert.match(collectEvidenceBlock.text, /NORMALIZER_FAILURE_JSON_INVALID/);
assert.match(collectEvidenceBlock.text, /NORMALIZER_FAILURE_EXIT_CODE_MISMATCH/);
assert.match(collectEvidenceBlock.text, /if \(\$normalizerStdout\.Length -ne 0\) \{ throw 'NORMALIZER_FAILURE_STDOUT_NONEMPTY' \}/);
assert.match(collectEvidenceBlock.text, /if \(\$normalizerStderr\.Length -eq 0\) \{ throw 'NORMALIZER_FAILURE_STDERR_INVALID' \}/);
assert.match(collectEvidenceBlock.text, /\$normalizerFailureLines\.Count -ne 1/);
assert.match(collectEvidenceBlock.text, /Write-Output "4A3_NORMALIZER_FAILURE_CODE=\$normalizerFailureCode"/);
assert.match(collectEvidenceBlock.text, /throw \$normalizerFailureCode/);
assert.match(collectEvidenceBlock.text, /if \(\$normalizerExitCode -ne 0\)[\s\S]*if \(\$normalizerStderr\.Length -ne 0\) \{ throw 'NORMALIZER_STDERR_NONEMPTY' \}/);
assert.match(collectEvidenceBlock.text, /if \(\$normalizerStdout\.Length -eq 0\) \{ throw 'NORMALIZER_STDOUT_INVALID' \}/);
assert.equal(/Write-Output[^\r\n]*\$normalizerStderr/.test(collectEvidenceBlock.text), false, "raw normalizer stderr is not logged");
for (const [exitCode, codes] of [[2, ["WINDOWS_LOGON_PE_EVIDENCE_ARGUMENT_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_HELPER_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_HELPER_SIZE_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_EVIDENCE_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_EVIDENCE_SIZE_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_EVIDENCE_DUPLICATE"]], [3, ["WINDOWS_LOGON_PE_EVIDENCE_SHA_MISMATCH"]], [4, ["WINDOWS_LOGON_PE_EVIDENCE_HEADERS_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_ARCHITECTURE_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_PE_FORMAT_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_IMAGE_KIND_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_MITIGATION_MISSING", "WINDOWS_LOGON_PE_EVIDENCE_DEPENDENTS_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_IMPORTS_INVALID", "WINDOWS_LOGON_PE_EVIDENCE_LOADCONFIG_INVALID"]], [7, ["WINDOWS_LOGON_PE_EVIDENCE_UNEXPECTED"]]]) {
	const entry = collectEvidenceBlock.text.match(new RegExp(`\\n\\s*${exitCode} = \\[System\\.Collections\\.Generic\\.HashSet\\[string\\]\\]::new\\(\\[string\\[\\]\\]@\\(([^)]*)\\)`));
	assert.notEqual(entry, null, `normalizer exit ${exitCode} allowlist`);
	for (const code of codes) assert.equal(entry[1].includes(code), true, `${exitCode}:${code}`);
}
assert.match(workflow, /if \(\$normalizerStderr\.Length -ne 0\) \{ throw 'NORMALIZER_STDERR_NONEMPTY' \}/);
assert.match(workflow, /\$jsonRoot\.ValueKind -ne \[System\.Text\.Json\.JsonValueKind\]::Object/);
assert.match(workflow, /\$sizeElement\.ValueKind -ne \[System\.Text\.Json\.JsonValueKind\]::Number/);
assert.match(workflow, /\$element\.ValueKind -ne \[System\.Text\.Json\.JsonValueKind\]::Array/);
assert.match(workflow, /\$item\.ValueKind -ne \[System\.Text\.Json\.JsonValueKind\]::String/);
assert.match(workflow, /\$document\.Dispose\(\)/);
assert.match(workflow, /foreach \(\$property in \$jsonRoot\.EnumerateObject\(\)\)/);
assert.match(workflow, /if \(-not \$expectedPropertySet\.Contains\(\$property\.Name\)\) \{ throw 'NORMALIZED_PROPERTY_SET_INVALID' \}/);
assert.match(workflow, /if \(-not \$seenProperties\.Add\(\$property\.Name\)\) \{ throw 'NORMALIZED_PROPERTY_DUPLICATE' \}/);
assert.match(workflow, /if \(\$propertyCount -ne \$expectedProperties\.Length\) \{ throw 'NORMALIZED_PROPERTY_SET_INVALID' \}/);
assert.match(workflow, /if \(-not \$seenProperties\.Contains\(\$propertyName\)\) \{ throw 'NORMALIZED_PROPERTY_MISSING' \}/);
assert.match(workflow, /Get-ExactJsonBoolean \$jsonRoot 'allowlistApplied' \$false 'NORMALIZED_POLICY_INVALID'/);
assert.match(workflow, /Get-JsonDllArray \$jsonRoot 'directDependencies' \$true/);
assert.match(workflow, /Get-JsonDllArray \$jsonRoot 'importLibraries' \$true/);
assert.match(workflow, /Get-JsonDllArray \$jsonRoot 'delayLoadLibraries' \$false/);
assert.match(workflow, /\$normalized = Assert-NormalizedEvidenceJson \$normalizerLines\[0\]/);
for (const property of ["status", "phase", "sourceCommit", "helperBasename", "helperSha256", "helperSizeBytes", "machine", "peFormat", "imageKind", "subsystem", "dynamicBase", "nxCompat", "guardCf", "directDependencies", "importLibraries", "delayLoadLibraries", "dependencyPolicy", "allowlistApplied"]) assert.equal(workflow.includes(`'${property}'`), true, property);
assert.equal(workflow.includes("Get-Content"), false);
assert.equal(workflow.includes("Write-Host"), false);
assert.equal(workflow.lastIndexOf("Assert-PathResidueDetector") < workflow.indexOf("$protectedStdout = @{}"), true);
assert.equal(workflow.indexOf("$protectedStdout = @{}") < workflow.indexOf("Write-RedactedEvidence 'HEADERS'"), true);
assert.equal(workflow.indexOf("$normalizerStdout =") > workflow.indexOf("$protectedStderr = @{}"), true);
assert.equal(workflow.indexOf("$normalizerStdout =") > workflow.indexOf("if ($result.ExitCode -ne 0)"), true);
assert.equal(workflow.indexOf("$summary = @(") > workflow.indexOf("$subsystem ="), true);
for (const name of ["HEADERS", "DEPENDENTS", "IMPORTS", "LOADCONFIG"]) assert.match(workflow, new RegExp(`Write-RedactedEvidence '${name}'`));
assert.equal(workflow.includes("$env:GITHUB_STEP_SUMMARY"), true);
console.log("windows logon-session helper PE evidence workflow source-contract tests passed");
