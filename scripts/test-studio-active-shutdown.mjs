import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	createManagedTranscodeProcesses,
	resolveManagedStopIntent,
	resolveTranscodeAttemptFinalization,
} from "../shared/transcode-runtime.mjs";

class FakeChild extends EventEmitter {
	constructor(pid) {
		super();
		this.pid = pid;
		this.exitCode = null;
	}
}

const processes = createManagedTranscodeProcesses();

const preStart = processes.requestShutdown("job-pre-start", 1);
assert.equal(preStart.requested, true);
assert.equal(preStart.pending, true);
const preStartRecord = processes.reserve("job-pre-start", { attempt: 1 });
assert.equal(preStartRecord.shutdownRequested, true);
assert.equal(preStartRecord.shutdownReason, "studio-shutdown");
assert.equal(preStartRecord.executionStarted, true);
assert.equal(preStartRecord.spawnStarted, false);
assert.equal(preStartRecord.qSent, false);
assert.equal(preStartRecord.graceTimer, null);
assert.equal(preStartRecord.forceKillPromise, null);
const initialRequestedAt = preStartRecord.shutdownRequestedAt;
assert.equal(processes.requestShutdown("job-pre-start", 1).requested, false);
assert.equal(preStartRecord.shutdownRequestedAt, initialRequestedAt);
const preStartChild = new FakeChild(701);
processes.attach("job-pre-start", preStartChild, { attempt: 1 });
assert.equal(preStartRecord.child, preStartChild);
assert.equal(preStartRecord.spawnStarted, true);
assert.equal(preStartRecord.shutdownRequested, true);
processes.finish("job-pre-start", 1);

const activeChild = new FakeChild(702);
const activeRecord = processes.attach("job-active", activeChild, { attempt: 2 });
assert.equal(activeRecord.shutdownRequested, false);
assert.equal(activeRecord.cancelRequested, false);
assert.equal(processes.requestCancel("job-active", 2).requested, true);
assert.equal(activeRecord.cancelRequested, true);
assert.equal(processes.requestShutdown("job-active", 2).requested, true);
assert.equal(activeRecord.shutdownRequested, true);
assert.equal(activeRecord.shutdownReason, "studio-shutdown");
assert.equal(activeRecord.qSent, false);
assert.equal(activeRecord.graceTimer, null);
assert.equal(activeRecord.forceKillPromise, null);
assert.equal(resolveTranscodeAttemptFinalization({ shutdownRequested: activeRecord.shutdownRequested, cancelRequested: activeRecord.cancelRequested }), "interrupted");
processes.finish("job-active", 2);

const completionChild = new FakeChild(703);
const completionRecord = processes.attach("job-complete", completionChild, { attempt: 3 });
assert.equal(processes.beginCompletionCommit("job-complete", 3), true);
assert.equal(completionRecord.completionCommitStarted, true);
assert.equal(completionRecord.completionCommitted, false);
const shutdownDuringCompletion = processes.requestShutdown("job-complete", 3);
assert.equal(shutdownDuringCompletion.requested, true);
assert.equal(shutdownDuringCompletion.completionCommitInProgress, true);
assert.equal(completionRecord.shutdownRequested, true);
assert.equal(completionRecord.completionCommitted, false);
assert.equal(resolveManagedStopIntent(completionRecord), "shutdown");
assert.equal(resolveTranscodeAttemptFinalization({ shutdownRequested: completionRecord.shutdownRequested, cancelRequested: completionRecord.cancelRequested }), "interrupted");
processes.markCompletionCommitted("job-complete", 3);
assert.equal(completionRecord.completionCommitted, true);
assert.equal(completionRecord.completionCommitStarted, false);
assert.equal(processes.requestShutdown("job-complete", 3).completionCommitted, true);
assert.equal(resolveTranscodeAttemptFinalization({ terminal: true, shutdownRequested: true }), "terminal");
processes.finish("job-complete", 3);

const failedCommitChild = new FakeChild(705);
const failedCommitRecord = processes.attach("job-commit-failed", failedCommitChild, { attempt: 5 });
assert.equal(processes.beginCompletionCommit("job-commit-failed", 5), true);
assert.equal(processes.requestShutdown("job-commit-failed", 5).requested, true);
assert.equal(failedCommitRecord.completionCommitted, false);
assert.equal(resolveManagedStopIntent(failedCommitRecord), "shutdown");
assert.equal(processes.abortCompletionCommit("job-commit-failed", 5), true);
assert.equal(failedCommitRecord.completionCommitStarted, false);
assert.equal(failedCommitRecord.completionCommitted, false);
processes.finish("job-commit-failed", 5);

assert.equal(resolveManagedStopIntent({}), null);
assert.equal(resolveManagedStopIntent({ cancelRequested: true }), "cancel");
assert.equal(resolveManagedStopIntent({ cancelRequested: true, shutdownRequested: true }), "shutdown");
assert.equal(resolveTranscodeAttemptFinalization({ cancelRequested: true }), "cancelled");

const failedChild = new FakeChild(704);
const failedRecord = processes.attach("job-failed", failedChild, { attempt: 4 });
assert.equal(resolveTranscodeAttemptFinalization({ terminal: true, shutdownRequested: failedRecord.shutdownRequested }), "terminal");
processes.finish("job-failed", 4);

assert.equal(processes.get("job-pre-start"), null);
assert.equal(processes.get("job-active"), null);
assert.equal(processes.get("job-complete"), null);
assert.equal(processes.get("job-commit-failed"), null);
assert.equal(processes.get("job-failed"), null);

console.log("studio active shutdown fake tests passed");
