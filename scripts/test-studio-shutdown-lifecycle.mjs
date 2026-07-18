import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStudioShutdownPreparation, createTranscodeQueue } from "../shared/transcode-runtime.mjs";

function deferred() {
	let resolve;
	const promise = new Promise((next) => { resolve = next; });
	return { promise, resolve };
}

function createFakeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		setTimeout(callback, delay) {
			const id = nextId++;
			timers.set(id, { callback, at: now + delay });
			return id;
		},
		clearTimeout(id) { timers.delete(id); },
		advance(ms) {
			now += ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, timer]) => timer.at <= now)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				due[1].callback();
			}
		},
		count() { return timers.size; },
	};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

{
	const clock = createFakeClock();
	const signalSource = new EventEmitter();
	const recovery = deferred();
	const active = deferred();
	const httpClose = deferred();
	const requests = deferred();
	const queue = createTranscodeQueue({ runJob: async () => {} });
	queue.enqueue("pending");
	let closeCalls = 0;
	let idleCalls = 0;
	let forceCloseCalls = 0;
	let exitCode = null;
	let forceExitCalls = 0;
	const messages = [];
	const controller = createStudioShutdownPreparation({
		queue,
		recoverPending: () => recovery.promise,
		requestActiveShutdown: async () => ({ ok: true, active: true }),
		closeHttp: () => { closeCalls += 1; return httpClose.promise; },
		closeIdleConnections: () => { idleCalls += 1; return { ok: true }; },
		forceCloseHttp: () => { forceCloseCalls += 1; return { ok: true }; },
		waitForHttpRequests: () => requests.promise,
		waitForActiveSafety: () => active.promise,
		processAdapter: {
			setExitCode(code) { exitCode = code; },
			forceExit(code) { assert.equal(code, 1); forceExitCalls += 1; },
		},
		logger(message) { messages.push(message); },
		setTimeoutImpl: clock.setTimeout,
		clearTimeoutImpl: clock.clearTimeout,
	});

	assert.equal(controller.registerTerminationHandlers(signalSource), true);
	assert.equal(signalSource.listenerCount("SIGINT"), 1);
	assert.equal(signalSource.listenerCount("SIGTERM"), 1);
	signalSource.emit("SIGINT");
	await tick();
	assert.equal(closeCalls, 1);
	assert.equal(idleCalls, 1);
	assert.equal(queue.isClosed(), true);
	assert.equal(controller.snapshot().signalCount, 1);
	assert.equal(controller.snapshot().lifecycleStarted, true);
	assert.equal(controller.snapshot().completed, false);

	recovery.resolve({ ok: true, recovered: 1 });
	active.resolve({ ok: true });
	httpClose.resolve({ ok: true, closed: true });
	requests.resolve();
	await tick();
	await tick();
	const result = await controller.beginLifecycle();
	assert.equal(result.status, "completed");
	assert.equal(controller.snapshot().safeCompletionReached, true);
	assert.equal(controller.snapshot().completed, true);
	assert.equal(exitCode, null);
	assert.equal(forceExitCalls, 0);
	assert.equal(signalSource.listenerCount("SIGINT"), 0);
	assert.equal(signalSource.listenerCount("SIGTERM"), 0);
	assert.equal(clock.count(), 0);
	assert.equal(messages.some((message) => /SIGINT|SIGTERM|pid|taskkill/i.test(message)), false);
}

{
	const clock = createFakeClock();
	const signalSource = new EventEmitter();
	const active = deferred();
	const httpClose = deferred();
	const requests = deferred();
	const queue = createTranscodeQueue({ runJob: async () => {} });
	let forceCloseCalls = 0;
	let exitCode = null;
	let forceExitCalls = 0;
	const controller = createStudioShutdownPreparation({
		queue,
		recoverPending: async () => ({ ok: true, recovered: 0 }),
		requestActiveShutdown: async () => ({ ok: true, active: true }),
		closeHttp: () => httpClose.promise,
		closeIdleConnections: () => ({ ok: true }),
		forceCloseHttp: () => { forceCloseCalls += 1; return { ok: true }; },
		waitForHttpRequests: () => requests.promise,
		waitForActiveSafety: () => active.promise,
		processAdapter: {
			setExitCode(code) { exitCode = code; },
			forceExit(code) { assert.equal(code, 1); forceExitCalls += 1; },
		},
		setTimeoutImpl: clock.setTimeout,
		clearTimeoutImpl: clock.clearTimeout,
	});
	controller.registerTerminationHandlers(signalSource);
	signalSource.emit("SIGTERM");
	await tick();
	clock.advance(12_000);
	await tick();
	assert.equal(forceCloseCalls, 1);
	assert.equal(exitCode, 1);
	clock.advance(2_000);
	await tick();
	const result = await controller.beginLifecycle();
	assert.equal(result.status, "degraded");
	assert.equal(result.awaitingChild, true);
	assert.equal(result.awaitingHttp, true);
	assert.equal(controller.snapshot().completed, false);
	assert.equal(signalSource.listenerCount("SIGINT"), 1);

	signalSource.emit("SIGINT");
	await tick();
	assert.equal(forceCloseCalls, 1);
	assert.equal(forceExitCalls, 1);
	signalSource.emit("SIGTERM");
	await tick();
	assert.equal(forceExitCalls, 1);

	active.resolve({ ok: true });
	httpClose.resolve({ ok: true, closed: true });
	requests.resolve();
	await tick();
	await tick();
	assert.equal(controller.snapshot().completed, true);
	assert.equal(controller.snapshot().awaitingChild, false);
	assert.equal(controller.snapshot().awaitingHttp, false);
	assert.equal(signalSource.listenerCount("SIGINT"), 0);
	assert.equal(signalSource.listenerCount("SIGTERM"), 0);
	assert.equal(clock.count(), 0);
}

{
	const clock = createFakeClock();
	const close = deferred();
	const requests = deferred();
	const active = deferred();
	const controller = createStudioShutdownPreparation({
		queue: createTranscodeQueue({ runJob: async () => {} }),
		recoverPending: async () => ({ ok: true, recovered: 0 }),
		requestActiveShutdown: async () => ({ ok: true, active: false }),
		closeHttp: () => close.promise,
		waitForHttpRequests: () => requests.promise,
		waitForActiveSafety: () => active.promise,
		processAdapter: { setExitCode() {}, forceExit() {} },
		setTimeoutImpl: clock.setTimeout,
		clearTimeoutImpl: clock.clearTimeout,
	});
	const lifecycle = controller.beginLifecycle();
	close.resolve({ ok: false, code: "STUDIO_HTTP_CLOSE_TIMEOUT" });
	requests.resolve();
	active.resolve({ ok: true });
	await tick();
	await tick();
	assert.equal(controller.snapshot().completed, false);
	assert.equal(controller.snapshot().httpRequestsSettled, true);
	controller.markHttpClosed();
	assert.equal((await lifecycle).status, "completed");
	assert.equal(controller.snapshot().completed, true);
	assert.equal(clock.count(), 0);
}

console.log("studio shutdown lifecycle fake tests passed");
