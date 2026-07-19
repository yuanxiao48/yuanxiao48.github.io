import assert from "node:assert/strict";
import { createRecoveryOffsetScheduler } from "../shared/transcode-recovery-startup-adapter.mjs";

let now = 0;
let nextTimer = 0;
const timers = new Map();
const factory = createRecoveryOffsetScheduler({
	monotonicNowMs: () => now,
	setTimer: (callback, delay) => {
		const id = ++nextTimer;
		timers.set(id, { callback, delay });
		return id;
	},
	clearTimer: (id) => timers.delete(id),
});

async function wait(session, offset) {
	const pending = session.sleepUntilOffset(offset);
	assert.equal(timers.size, 1);
	const [[id, { callback, delay }]] = timers.entries();
	assert.equal(delay, Math.max(0, offset - now));
	timers.delete(id);
	callback();
	await pending;
	now = offset;
}

for (const ignored of [0, 1, 2]) {
	const session = factory.createSession();
	now = 0;
	for (const offset of [0, 2_000, 8_000, 20_000]) await wait(session, offset);
	assert.equal(session.getPendingCount(), 0);
	session.dispose();
}

const first = factory.createSession();
const second = factory.createSession();
await wait(first, 0);
now = 0;
await wait(second, 0);
await assert.rejects(() => second.sleepUntilOffset(8_000));
await assert.rejects(() => second.sleepUntilOffset(-1));
const cancelled = factory.createSession();
const waiting = cancelled.sleepUntilOffset(0);
cancelled.cancel();
cancelled.cancel();
await assert.rejects(waiting);
assert.equal(cancelled.getPendingCount(), 0);
assert.equal(timers.size, 0);

console.log("transcode recovery scheduler session tests passed");
