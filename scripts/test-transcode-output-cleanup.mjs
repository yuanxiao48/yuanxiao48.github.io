import assert from "node:assert/strict";
import { removeFilesWithRetry } from "../shared/transcode-runtime.mjs";

function error(code) {
	const value = new Error(code);
	value.code = code;
	return value;
}

async function runCase(files, outcomes) {
	const calls = [];
	const waits = [];
	const remaining = new Map(Object.entries(outcomes).map(([file, values]) => [file, [...values]]));
	const result = await removeFilesWithRetry({
		files,
		removeFile: async (file) => {
			calls.push(file);
			const next = remaining.get(file)?.shift();
			if (next instanceof Error) throw next;
		},
		wait: async (delay) => { waits.push(delay); },
	});
	return { result, calls, waits };
}

{
	const { result, waits } = await runCase(["output.partial.m4a"], { "output.partial.m4a": [null] });
	assert.deepEqual(result, { success: true, removedCount: 1, missingCount: 0, failedCount: 0, safeErrorCode: null });
	assert.deepEqual(waits, []);
}

{
	const { result } = await runCase(["output.partial.mp3"], { "output.partial.mp3": [error("ENOENT")] });
	assert.equal(result.success, true);
	assert.equal(result.missingCount, 1);
}

{
	const { result, waits } = await runCase(["output.m4a"], { "output.m4a": [error("EBUSY"), null] });
	assert.equal(result.success, true);
	assert.equal(result.removedCount, 1);
	assert.deepEqual(waits, [150]);
}

{
	const { result, waits } = await runCase(["output.mp3"], { "output.mp3": [error("EBUSY"), error("EPERM"), error("EACCES"), null] });
	assert.equal(result.success, true);
	assert.deepEqual(waits, [150, 400, 900]);
}

{
	const { result } = await runCase(["output.partial.m4a"], { "output.partial.m4a": [error("EBUSY"), error("EBUSY"), error("EBUSY"), error("EBUSY")] });
	assert.equal(result.success, false);
	assert.equal(result.failedCount, 1);
	assert.equal(result.safeErrorCode, "TRANSCODE_PARTIAL_CLEANUP_FAILED");
}

{
	const { result, waits } = await runCase(["output.partial.mp3"], { "output.partial.mp3": [error("EIO")] });
	assert.equal(result.success, false);
	assert.equal(result.failedCount, 1);
	assert.deepEqual(waits, []);
}

{
	const { result } = await runCase(
		["output.partial.m4a", "output.m4a"],
		{ "output.partial.m4a": [null], "output.m4a": [error("EPERM"), error("EPERM"), error("EPERM"), error("EPERM")] },
	);
	assert.equal(result.removedCount, 1);
	assert.equal(result.failedCount, 1);
	assert.equal("path" in result, false);
	assert.equal("stack" in result, false);
}

console.log("transcode output cleanup retry tests passed");
