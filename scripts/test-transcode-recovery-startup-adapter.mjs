import assert from "node:assert/strict";
import {
	createRecoveryOffsetScheduler,
	createStartupRecoveryGuard,
	createValidatedTranscodeJobDiscovery,
} from "../shared/transcode-recovery-startup-adapter.mjs";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const discovery = createValidatedTranscodeJobDiscovery({
	validateJobId: (id) => [first, second].includes(id),
	listDirectEntries: async () => [
		{ name: "ignored", isDirectory: true, isSymbolicLink: false },
		{ name: second, isDirectory: true, isSymbolicLink: false },
		{ name: first, isDirectory: true, isSymbolicLink: false },
		{ name: "symlink", isDirectory: true, isSymbolicLink: true },
	],
	inspectJobDirectory: async (id) => ({ trusted: [first, second].includes(id) }),
});
const ids = await discovery.discoverJobIds();
assert.deepEqual(ids, [first, second]);
assert.equal(Object.isFrozen(ids), true);
assert.throws(() => ids.push(first), TypeError);

const collision = createValidatedTranscodeJobDiscovery({
	validateJobId: () => true,
	listDirectEntries: async () => [
		{ name: first, isDirectory: true, isSymbolicLink: false },
		{ name: first.toUpperCase(), isDirectory: true, isSymbolicLink: false },
	],
	inspectJobDirectory: async () => ({ trusted: true }),
});
await assert.rejects(() => collision.discoverJobIds());

const guard = createStartupRecoveryGuard();
const token = guard.acquire(first);
assert.equal(guard.getActiveCount(), 1);
assert.throws(() => guard.acquire(first));
token.release();
assert.equal(guard.getActiveCount(), 0);
assert.throws(() => token.release());

let now = 0;
const timers = new Map();
let timerId = 0;
const scheduler = createRecoveryOffsetScheduler({
	monotonicNowMs: () => now,
	setTimer: (callback, delay) => {
		const id = ++timerId;
		timers.set(id, { callback, delay });
		return id;
	},
	clearTimer: (id) => timers.delete(id),
});
const firstWait = scheduler.sleepUntilOffset(0);
assert.equal(timers.size, 1);
for (const { callback } of timers.values()) callback();
await firstWait;
now = 2000;
const secondWait = scheduler.sleepUntilOffset(2000);
for (const { callback } of timers.values()) callback();
await secondWait;
assert.equal(scheduler.getPendingCount(), 0);
await assert.rejects(() => scheduler.sleepUntilOffset(20000));
scheduler.dispose();

console.log("transcode recovery startup adapter tests passed");
