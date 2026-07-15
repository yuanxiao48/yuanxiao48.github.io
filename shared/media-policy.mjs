/**
 * Shared media rules for the local Studio server and Astro build tools.
 * This module intentionally has no Astro aliases or TypeScript dependency.
 */
export const MEDIA_KINDS = Object.freeze(["image", "audio", "video"]);

export const MEDIA_POLICIES = Object.freeze({
	image: Object.freeze({
		kind: "image",
		directory: Object.freeze(["images", "posts"]),
		publicPrefix: "/assets/images/posts/",
		extensions: Object.freeze([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]),
		maxBytes: 20 * 1024 * 1024,
	}),
	audio: Object.freeze({
		kind: "audio",
		directory: Object.freeze(["audio"]),
		publicPrefix: "/assets/audio/",
		extensions: Object.freeze([".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"]),
		maxBytes: 50 * 1024 * 1024,
	}),
	video: Object.freeze({
		kind: "video",
		directory: Object.freeze(["video"]),
		publicPrefix: "/assets/video/",
		extensions: Object.freeze([".mp4", ".webm", ".mov"]),
		maxBytes: 90 * 1024 * 1024,
	}),
});

export const MEDIA_REPOSITORY_GUIDANCE =
	"仓库内视频建议尽量控制在约 25 MB；更大的视频更适合使用外部平台。";

export function normalizeMediaKind(value, fallback = "all") {
	if (value === "all" || value === undefined || value === null || value === "") return fallback;
	return MEDIA_KINDS.includes(value) ? value : null;
}

export function getMediaPolicy(kind) {
	return MEDIA_POLICIES[kind] || null;
}

export function normalizeMediaPublicPath(value) {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (!raw || raw.includes("\\") || raw.includes("\0")) return null;
	if (/^(?:[a-z]:|file:|javascript:|data:)/i.test(raw)) return null;
	let decoded;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (!decoded.startsWith("/") || decoded.includes("//") || decoded.split("/").includes("..")) return null;
	for (const kind of MEDIA_KINDS) {
		const policy = MEDIA_POLICIES[kind];
		if (!decoded.startsWith(policy.publicPrefix)) continue;
		const relativePath = decoded.slice(policy.publicPrefix.length);
		if (!relativePath || relativePath.startsWith(".") || relativePath.split("/").some((part) => !part || part.startsWith("."))) {
			return null;
		}
		const extension = `.${relativePath.split(".").pop()?.toLowerCase() || ""}`;
		if (!policy.extensions.includes(extension)) return null;
		return { kind, publicPath: decoded, relativePath, extension };
	}
	return null;
}

export function normalizeMediaSearch(value) {
	if (typeof value !== "string") return "";
	return value.replace(/[\0\\/]/g, "").trim().slice(0, 120);
}
