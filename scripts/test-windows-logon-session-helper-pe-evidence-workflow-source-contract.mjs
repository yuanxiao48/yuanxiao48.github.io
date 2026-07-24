import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/verify-windows-logon-session-helper-pe-evidence.yml", import.meta.url), "utf8");
const required = [
	"name: Verify Windows Helper PE Evidence", "verify/4a3-real-helper-bff3f755", "contents: read", "runs-on: windows-2022", "timeout-minutes: 15",
	"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2", "persist-credentials: false", "fetch-depth: 1", "Visual Studio 17 2022", "-A x64", "--config Release",
	"--target windows_logon_session_protocol", "--target windows-logon-session-snapshot-protocol-test", "--target windows-logon-session-snapshot-helper", "windows-logon-session-snapshot-protocol-test.exe", "windows-logon-session-snapshot-helper.exe",
	"/headers", "/dependents", "/imports", "/loadconfig", "vswhere.exe", "VsDevCmd.bat", "-arch=x64", "-host_arch=x64", "Get-FileHash", "-Algorithm SHA256", "Replace-LiteralPathInsensitive", "Protect-DumpbinEvidence", "<RUNNER_TEMP>", "<GITHUB_WORKSPACE>", "<VISUAL_STUDIO>", "<USERPROFILE>",
	"scripts/normalize-windows-logon-session-helper-pe-evidence.mjs", "expected-powershell-sha256", "node scripts/test-windows-logon-session-helper-pe-evidence.mjs", "node scripts/test-windows-logon-session-helper-pe-evidence-workflow-source-contract.mjs",
	"node scripts/test-windows-logon-session-helper-source-contract.mjs", "node scripts/test-windows-logon-session-real-validator.mjs", "node scripts/test-windows-logon-session-real-validator-source-contract.mjs", "node scripts/test-windows-logon-session-snapshot-protocol.mjs", "node scripts/test-windows-logon-session-snapshot-runner.mjs", "node scripts/test-windows-logon-session-liveness-provider.mjs", "node scripts/test-host-execution-containment-comparison.mjs", "node scripts/test-windows-logon-session-liveness-evidence.mjs",
	"github.repository", "github.ref", "github.sha", "github.event_name", "runner.os", "runner.arch", "studio-4a3-c2a-build", "studio-4a3-c2a-evidence",
];
for (const text of required) assert.equal(workflow.includes(text), true, text);
for (const forbidden of ["workflow_dispatch", "pull_request", "schedule:", "repository_dispatch", "workflow_call", "tags:", "actions/upload-artifact", "actions/download-artifact", "actions/cache", "upload-artifact", "download-artifact", "cache@", "container:", "self-hosted", "matrix:", "services:", "environment:", "secrets.", "GITHUB_TOKEN", "npm ", "npm\n", "CMAKE_MSVC_RUNTIME_LIBRARY", "/MT", "/MD", "Start-Process", "Invoke-Expression", "ScriptBlock::Create", "& $helper.FullName", "process.exit", "always()", "node scripts/validate-windows-logon-session-helper-real.mjs", "windows-logon-session-snapshot-helper.exe --"]) assert.equal(workflow.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
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
assert.match(workflow, /\$env:RUNNER_TEMP/);
assert.match(workflow, /Resolve-Path -LiteralPath \$helpers\[0\]\.FullName/);
assert.match(workflow, /& \$protocolTest\.FullName/);
assert.match(workflow, /if \(\$LASTEXITCODE -ne 0\) \{ throw/);
assert.match(workflow, /\$normalized\.helperSha256 -ne \$powershellSha256/);
for (const field of ["status", "phase", "sourceCommit", "helperBasename", "helperSha256", "helperSizeBytes", "machine", "peFormat", "imageKind", "dynamicBase", "nxCompat", "guardCf", "directDependencies", "importLibraries", "delayLoadLibraries", "dependencyPolicy", "allowlistApplied"]) assert.equal(workflow.includes(`$normalized.${field}`), true, field);
for (const code of ["HEADERS_PATH_RESIDUE", "DEPENDENTS_PATH_RESIDUE", "IMPORTS_PATH_RESIDUE", "LOADCONFIG_PATH_RESIDUE"]) assert.equal(workflow.includes(code), true, code);
assert.match(workflow, /\(\?i\)\(\?:\[A-Z\]:\[\\\\\/\]\|\\\\\\\\/);
assert.match(workflow, /\[regex\]::Escape\(\$needle\)/);
assert.match(workflow, /\$normalizerLines\.Count -ne 1/);
assert.match(workflow, /Protect-DumpbinEvidence 'HEADERS'/);
assert.match(workflow, /Write-Output "=== BEGIN DUMPBIN \$name ==="/);
assert.match(workflow, /Write-Output "=== END DUMPBIN \$name ==="/);
assert.equal(workflow.includes("Get-Content"), false);
assert.equal(workflow.includes("Write-Host"), false);
assert.equal(workflow.indexOf("$protectedEvidence = @{") < workflow.indexOf("Write-RedactedEvidence 'HEADERS'"), true);
for (const name of ["HEADERS", "DEPENDENTS", "IMPORTS", "LOADCONFIG"]) assert.match(workflow, new RegExp(`Write-RedactedEvidence '${name}'`));
assert.equal(workflow.includes("$env:GITHUB_STEP_SUMMARY"), true);
console.log("windows logon-session helper PE evidence workflow source-contract tests passed");
