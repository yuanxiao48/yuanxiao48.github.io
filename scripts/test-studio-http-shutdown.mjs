import assert from "node:assert/strict";
import {
	createStudioHttpRequestTracker,
	withStudioShutdownConnectionClose,
} from "../shared/transcode-runtime.mjs";

const tracker = createStudioHttpRequestTracker();
const first = tracker.beginRequest();
const second = tracker.beginRequest();
assert.equal(tracker.getActiveRequestCount(), 2);
const zero = tracker.waitForZero();
assert.equal(first.settle(), true);
assert.equal(first.settle(), false);
assert.equal(tracker.getActiveRequestCount(), 1);
assert.equal(second.settle(), true);
await zero;
assert.equal(tracker.getActiveRequestCount(), 0);
await tracker.waitForZero();

const headers = withStudioShutdownConnectionClose({ "content-type": "application/json; charset=utf-8" });
assert.equal(headers.connection, "close");
assert.equal(headers["content-type"], "application/json; charset=utf-8");
assert.equal(Object.isFrozen(headers), true);

console.log("studio HTTP shutdown fake tests passed");
