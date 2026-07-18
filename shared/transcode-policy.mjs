/**
 * Shared policy for the local-only Studio transcoder.
 * No binary paths or executable commands are stored in this module.
 */
export const TRANSCODE_SUPPORTED_PLATFORMS = Object.freeze(["win32"]);

export const TRANSCODE_LOCAL_SETTINGS = Object.freeze({
	directory: Object.freeze([".studio-local"]),
	filename: "settings.json",
	allowedKeys: Object.freeze(["ffmpegPath", "ffprobePath"]),
});

export const TRANSCODE_TASKS = Object.freeze({
	directory: Object.freeze([".studio-tmp", "transcode"]),
	sourceMaxBytes: 1024 * 1024 * 1024,
	completedResultRetentionMs: 24 * 60 * 60 * 1000,
	manifestVersion: 1,
	diskReserveBytes: 512 * 1024 * 1024,
	diskCheckIntervalBytes: 8 * 1024 * 1024,
});

export const TRANSCODE_INPUT_KINDS = Object.freeze(["audio", "video"]);
export const TRANSCODE_PROTOCOLS = Object.freeze(["file", "pipe"]);
export const TRANSCODE_TASK_STATES = Object.freeze([
	"creating",
	"uploading",
	"probing",
	"ready",
	"queued",
	"transcoding",
	"validating-output",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
	"discarded",
	"interrupted",
]);

// Recovery-only edges let a Studio restart safely stop work that cannot continue.
export const TRANSCODE_STATE_TRANSITIONS = Object.freeze({
	creating: Object.freeze(["uploading", "probing", "failed", "interrupted"]),
	uploading: Object.freeze(["probing", "failed", "discarded", "interrupted"]),
	probing: Object.freeze(["ready", "failed", "interrupted"]),
	ready: Object.freeze(["queued", "discarded"]),
	queued: Object.freeze(["transcoding", "cancelled", "failed", "ready"]),
	transcoding: Object.freeze(["validating-output", "cancelling", "failed", "interrupted"]),
	"validating-output": Object.freeze(["completed", "failed", "interrupted"]),
	cancelling: Object.freeze(["cancelled", "failed", "interrupted"]),
	completed: Object.freeze(["queued", "discarded"]),
	failed: Object.freeze(["queued", "discarded"]),
	cancelled: Object.freeze(["queued", "discarded"]),
	interrupted: Object.freeze(["queued", "discarded"]),
	discarded: Object.freeze([]),
});

export const TRANSCODE_TERMINAL_STATES = Object.freeze([
	"completed",
	"failed",
	"cancelled",
	"interrupted",
	"discarded",
]);

export const TRANSCODE_LIBRARY_LOCK_STATES = Object.freeze([
	"creating",
	"probing",
	"ready",
	"queued",
	"transcoding",
	"validating-output",
	"cancelling",
]);

export const TRANSCODE_SOURCE_EXTENSIONS = Object.freeze({
	audio: Object.freeze([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"]),
	video: Object.freeze([".mp4", ".webm", ".mov", ".mkv"]),
});

export const TRANSCODE_PRESETS = Object.freeze({
	audioVoice: Object.freeze({ kind: "audio", label: "语音 AAC", output: "m4a", audioBitrateKbps: 96 }),
	audioStandard: Object.freeze({ kind: "audio", label: "标准 AAC", output: "m4a", audioBitrateKbps: 128 }),
	audioMusic: Object.freeze({ kind: "audio", label: "高质量 AAC", output: "m4a", audioBitrateKbps: 192 }),
	audioMp3: Object.freeze({ kind: "audio", label: "MP3 兼容", output: "mp3", audioBitrateKbps: 192 }),
	videoOriginal: Object.freeze({ kind: "video", label: "原尺寸优化", output: "mp4", maxHeight: null }),
	videoBalanced: Object.freeze({ kind: "video", label: "高清平衡", output: "mp4", maxHeight: 1080 }),
	videoCompact: Object.freeze({ kind: "video", label: "节省空间", output: "mp4", maxHeight: 720 }),
	videoSmall: Object.freeze({ kind: "video", label: "极限压缩", output: "mp4", maxHeight: 480 }),
	videoCompatibility: Object.freeze({ kind: "video", label: "浏览器兼容转换", output: "mp4", maxHeight: null }),
});

export const TRANSCODE_AUDIO_PRESETS = Object.freeze({
	"voice-aac": Object.freeze({ key: "voice-aac", label: "Voice AAC", kind: "audio", extension: "m4a", codec: "aac", targetBitrateKbps: 96 }),
	"standard-aac": Object.freeze({ key: "standard-aac", label: "Standard AAC", kind: "audio", extension: "m4a", codec: "aac", targetBitrateKbps: 128 }),
	"music-aac": Object.freeze({ key: "music-aac", label: "Music AAC", kind: "audio", extension: "m4a", codec: "aac", targetBitrateKbps: 192 }),
	"compatible-mp3": Object.freeze({ key: "compatible-mp3", label: "Compatible MP3", kind: "audio", extension: "mp3", codec: "libmp3lame", targetBitrateKbps: 192 }),
});

export const TRANSCODE_AUDIO_OUTPUT = Object.freeze({
	maxBytes: 50 * 1024 * 1024,
	minimumTrustedLossyBitrateKbps: 24,
	maximumTrustedLossyBitrateKbps: 768,
	minimumOutputBitrateKbps: 24,
});

export const TRANSCODE_FUTURE_OUTPUT = Object.freeze({
	videoCodec: "h264",
	audioCodec: "aac",
	pixelFormat: "yuv420p",
	container: "mp4",
	githubTargetBytes: 45 * 1024 * 1024,
	mediaMaxBytes: 50 * 1024 * 1024,
});

export function supportsTranscodePlatform(platform = process.platform) {
	return TRANSCODE_SUPPORTED_PLATFORMS.includes(platform);
}

export function isTranscodeInputKind(value) {
	return TRANSCODE_INPUT_KINDS.includes(value);
}

export function getTranscodeSourceKindForExtension(extension) {
	const normalized = typeof extension === "string" ? extension.toLowerCase() : "";
	return TRANSCODE_INPUT_KINDS.find((kind) => TRANSCODE_SOURCE_EXTENSIONS[kind].includes(normalized)) || null;
}

export function isTranscodeTaskState(value) {
	return TRANSCODE_TASK_STATES.includes(value);
}

export function canTransitionTranscodeJob(fromState, toState) {
	return Boolean(TRANSCODE_STATE_TRANSITIONS[fromState]?.includes(toState));
}

export function isTerminalTranscodeState(value) {
	return TRANSCODE_TERMINAL_STATES.includes(value);
}

export function shouldLockTranscodeLibrarySource(value) {
	return TRANSCODE_LIBRARY_LOCK_STATES.includes(value);
}

export function getTranscodeAudioPreset(value) {
	return typeof value === "string" ? TRANSCODE_AUDIO_PRESETS[value] || null : null;
}

export function transitionTranscodeJobState(job, nextState, patch = {}, now = new Date().toISOString()) {
	if (!job || !canTransitionTranscodeJob(job.state, nextState)) {
		const error = new Error("Transcode task state transition is not allowed");
		error.code = "TRANSCODE_STATE_TRANSITION_INVALID";
		throw error;
	}
	const runtime = {
		queuedAt: job.runtime?.queuedAt ?? null,
		startedAt: job.runtime?.startedAt ?? null,
		finishedAt: job.runtime?.finishedAt ?? null,
		attempt: Number.isSafeInteger(job.runtime?.attempt) ? job.runtime.attempt : 0,
	};
	if (nextState === "queued") {
		runtime.queuedAt = now;
		runtime.startedAt = null;
		runtime.finishedAt = null;
	}
	if (nextState === "transcoding") {
		runtime.startedAt = now;
		runtime.finishedAt = null;
		runtime.attempt += 1;
	}
	if (isTerminalTranscodeState(nextState)) runtime.finishedAt = now;
	return { ...job, ...patch, state: nextState, updatedAt: now, runtime };
}
