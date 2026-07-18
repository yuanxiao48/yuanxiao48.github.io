import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStudioShutdownPreparation, createTranscodeQueue } from "../shared/transcode-runtime.mjs";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class FakeServer extends EventEmitter {}

const active = deferred();
const recovery = deferred();
const queue = createTranscodeQueue({ runJob: async () => {} });
queue.enqueue("pending-a");
queue.enqueue("pending-b");

let controller;
let activeCalls = 0;
let recoveryCalls = 0;
controller = createStudioShutdownPreparation({
	queue,
	requestActiveShutdown: () => {
		activeCalls += 1;
		controller.markActiveStopRequested();
		return active.promise;
	},
	recoverPending: async (ids) => {
		recoveryCalls += 1;
		assert.deepEqual(ids, ["pending-a", "pending-b"]);
		return recovery.promise;
	},
});

const server = new FakeServer();
server.on("close", () => controller.markHttpClosed());

const first = controller.begin();
const duplicate = controller.begin();
assert.strictEqual(first, duplicate);
assert.equal(activeCalls, 1);
assert.equal(recoveryCalls, 0);
assert.equal(queue.isClosed(), true);

let snapshot = controller.snapshot();
assert.equal(snapshot.started, true);
assert.equal(snapshot.acceptingWrites, false);
assert.equal(snapshot.queueClosed, true);
assert.equal(snapshot.activeStopRequested, true);
assert.equal(snapshot.pendingRecoveryStarted, true);
assert.equal(snapshot.pendingRecoveryCompleted, false);
assert.equal(snapshot.httpClosed, false);
assert.equal(snapshot.completed, false);
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.degradedCodes), true);

await Promise.resolve();
assert.equal(recoveryCalls, 1);

server.emit("close");
server.emit("close");
assert.equal(controller.isHttpClosed(), true);
snapshot = controller.snapshot();
assert.equal(snapshot.httpClosed, true);
assert.equal(snapshot.completed, false);

active.resolve({ ok: true, active: true, requested: true });
recovery.resolve({ ok: true, recovered: 2 });
assert.deepEqual(await first, {
	ok: true,
	queue: { closed: true, alreadyClosed: false, pendingJobIds: ["pending-a", "pending-b"] },
	active: { ok: true, active: true, requested: true },
	recovery: { ok: true, recovered: 2 },
});

snapshot = controller.snapshot();
assert.equal(snapshot.pendingRecoveryCompleted, true);
assert.equal(snapshot.preparationCompleted, true);
assert.equal(snapshot.httpClosed, true);
assert.equal(snapshot.completed, false);
assert.equal(snapshot.degraded, false);
assert.equal(controller.markActiveStopRequested(), false);
assert.equal(controller.markHttpCloseStarted(), true);
assert.equal(controller.markHttpCloseStarted(), false);
assert.equal(controller.markHttpClosed(), false);
assert.equal(controller.markDegraded("TRANSCODE_SHUTDOWN_INTENT_PERSIST_FAILED"), true);
assert.equal(controller.markDegraded("TRANSCODE_SHUTDOWN_INTENT_PERSIST_FAILED"), true);
assert.equal(controller.markDegraded("unsafe detail"), false);
assert.deepEqual(controller.snapshot().degradedCodes, ["TRANSCODE_SHUTDOWN_INTENT_PERSIST_FAILED"]);

const unexpectedQueue = createTranscodeQueue({ runJob: async () => {} });
let unexpectedActiveCalls = 0;
const unexpected = createStudioShutdownPreparation({
	queue: unexpectedQueue,
	requestActiveShutdown: async () => { unexpectedActiveCalls += 1; return { ok: true, active: false }; },
	recoverPending: async () => ({ ok: true, recovered: 0 }),
});
const unexpectedServer = new FakeServer();
unexpectedServer.on("close", () => unexpected.markHttpClosed());
unexpectedServer.emit("close");
assert.equal(unexpected.snapshot().started, false);
assert.equal(unexpected.snapshot().httpClosed, true);
assert.equal(unexpected.snapshot().completed, false);
await unexpected.begin();
assert.equal(unexpectedActiveCalls, 1);
assert.equal(unexpected.snapshot().completed, false);

console.log("studio shutdown controller fake tests passed");
