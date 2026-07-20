import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const core = await readFile(new URL("shared/windows-logon-session-real-validator.mjs", root), "utf8");
const cli = await readFile(new URL("scripts/validate-windows-logon-session-helper-real.mjs", root), "utf8");

for (const name of ["createWindowsLogonSessionSnapshotProtocolAuthority", "createWindowsLogonSessionSnapshotRunner", "createWindowsLogonSessionLivenessProvider", "createHostExecutionContainmentComparisonAuthority", "serializeHostBootSessionWitness"]) assert.match(core, new RegExp(name));
for (const name of ["windows-logon-session-snapshot-helper.exe", "1500", "250", "3000", "waitForIdle", "activeChildCount", "comparePersistedWitness", "hashHelperFile"]) assert.match(core, new RegExp(name));
for (const forbidden of ["node:child_process", "node:fs", "process.env", ".studio-local", ".studio-tmp", "taskkill", "powershell", "wmic", "registry"]) assert.equal(core.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
assert.match(cli, /spawn\(/); assert.equal(cli.includes("exec("), false); assert.equal(cli.includes("execFile"), false); assert.equal(cli.includes("spawnSync"), false);
for (const text of ["shell: false", "windowsHide: true", "detached: false", 'stdio: ["ignore", "pipe", "pipe"]', "spawn(helperPath, []", "--helper", "--sha256", "waitForIdleWithDeadline", "process.exitCode"]) assert.equal(cli.includes(text), true, text);
for (const forbidden of ["cmd.exe", "powershell", "taskkill", "wmic", "where", "which", ".studio-local", ".studio-tmp", "bootSessionDigest", "AuthenticationId", "OpenProcessToken", "LsaEnumerateLogonSessions", "process.exit("]) assert.equal(cli.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
assert.equal(cli.includes("process.env.PATH"), false);
console.log("windows logon-session real validator source-contract tests passed");
