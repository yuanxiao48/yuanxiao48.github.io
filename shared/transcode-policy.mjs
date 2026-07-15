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
	"failed",
	"discarded",
	"interrupted",
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
