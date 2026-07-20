import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const core = await readFile(new URL("shared/windows-logon-session-real-validator.mjs", root), "utf8");
const cli = await readFile(new URL("scripts/validate-windows-logon-session-helper-real.mjs", root), "utf8");

for (const name of ["createWindowsLogonSessionSnapshotProtocolAuthority", "createWindowsLogonSessionSnapshotRunner", "createWindowsLogonSessionLivenessProvider", "createHostExecutionContainmentComparisonAuthority", "serializeHostBootSessionWitness", "createWindowsLogonSessionKnownChildControl", "createLivenessProvider"]) assert.match(core, new RegExp(name));
for (const name of ["windows-logon-session-snapshot-helper.exe", "1500", "250", "3000", "4000", "monotonicNow", "waitForIdle", "activeChildCount", "comparePersistedWitness", "hashHelperFile", "inspectHelperDirectory", "containAfterDeadline", "SIGKILL", "stdoutReleaseAttempted", "stderrReleaseAttempted", "childUnrefAttempted", "disposeAfterIdle"]) assert.match(core, new RegExp(name));
for (const forbidden of ["node:child_process", "node:fs", "process.env", ".studio-local", ".studio-tmp", "taskkill", "powershell", "wmic", "registry", "process.exit("]) assert.equal(core.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
assert.match(cli, /spawn\(/); assert.equal(cli.includes("exec("), false); assert.equal(cli.includes("execFile"), false); assert.equal(cli.includes("spawnSync"), false);
for (const text of ["shell: false", "windowsHide: true", "detached: false", 'stdio: ["ignore", "pipe", "pipe"]', "spawn(helperPath, []", "cwd: trustedWorkingDirectory", "--helper", "--sha256", "SystemRoot", "System32", "process.exitCode"]) assert.equal(cli.includes(text), true, text);
assert.equal(/cwd:\s*dirname\(helperPath\)/.test(cli), false); assert.equal(/cwd:\s*process\.cwd\(\)/.test(cli), false);
for (const forbidden of ["cmd.exe", "powershell", "taskkill", "wmic", "where", "which", ".studio-local", ".studio-tmp", "bootSessionDigest", "AuthenticationId", "OpenProcessToken", "LsaEnumerateLogonSessions", "process.exit("]) assert.equal(cli.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
assert.equal(cli.includes("process.env.PATH"), false);
assert.equal(/Promise\.all\(\[runPromise, providerPromise\]\)/.test(core), false);
assert.equal(/const providerPromise\s*=/.test(core), false);
const idleGate = core.indexOf("if (idleConfirmed !== true)");
const postHashGate = core.indexOf("if (postHash !== expectedSha256");
const providerFactory = core.indexOf("provider = createLivenessProvider");
assert.ok(idleGate >= 0 && postHashGate > idleGate && providerFactory > postHashGate);
const force = core.indexOf("requestForceStop();");
const stdout = core.indexOf('release("stdout"', force);
const stderr = core.indexOf('release("stderr"', stdout);
const stdin = core.indexOf('release("stdin"', stderr);
const unref = core.indexOf("child.unref()", stdin);
assert.ok(force >= 0 && stdout > force && stderr > stdout && stdin > stderr && unref > stdin);
console.log("windows logon-session real validator source-contract tests passed");
