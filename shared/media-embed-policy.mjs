/**
 * Shared rules for media embedded in Markdown.
 *
 * Keep this module browser-neutral: the Studio server and Astro build pipeline
 * can import the same canonicalisation rules without an Astro alias or a Node
 * filesystem dependency.
 */
import { normalizeMediaPublicPath } from "./media-policy.mjs";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_BVID = /^BV[A-Za-z0-9]{10}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "youtu.be", "www.youtube-nocookie.com"]);
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "player.bilibili.com"]);

export const MEDIA_EMBED_ALLOWED_ATTRIBUTES = Object.freeze({
	audio: Object.freeze(["src", "controls", "preload", "loop", "muted"]),
	video: Object.freeze(["src", "controls", "preload", "playsinline", "poster", "loop", "muted"]),
	source: Object.freeze(["src", "type"]),
	track: Object.freeze(["src", "kind", "srclang", "label", "default"]),
	iframe: Object.freeze(["src", "title", "loading", "allow", "allowfullscreen", "referrerpolicy", "width", "height"]),
});

export const EXTERNAL_VIDEO_ALLOW = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
export const EXTERNAL_VIDEO_REFERRER_POLICY = "strict-origin-when-cross-origin";

function safeHttpsUrl(value) {
	if (typeof value !== "string" || !value.trim() || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
	return url;
}

function positivePage(value) {
	if (!/^\d+$/.test(String(value || ""))) return "";
	const page = Number(value);
	return Number.isSafeInteger(page) && page > 0 && page <= 9999 ? String(page) : "";
}

function youtubeIdFrom(url) {
	const host = url.hostname.toLowerCase();
	if (!YOUTUBE_HOSTS.has(host)) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	let id = "";
	if (host === "youtu.be") {
		if (parts.length !== 1) return null;
		id = parts[0];
	} else if (parts[0] === "watch" && parts.length === 1) {
		id = url.searchParams.get("v") || "";
	} else if ((parts[0] === "shorts" || parts[0] === "embed") && parts.length === 2) {
		id = parts[1];
	} else {
		return null;
	}
	return YOUTUBE_ID.test(id) ? id : null;
}

function bilibiliDetailsFrom(url) {
	const host = url.hostname.toLowerCase();
	if (!BILIBILI_HOSTS.has(host)) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	let bvid = "";
	if (host === "player.bilibili.com") {
		if (url.pathname !== "/player.html") return null;
		bvid = url.searchParams.get("bvid") || "";
	} else {
		if (parts.length !== 2 || parts[0] !== "video") return null;
		bvid = parts[1];
	}
	if (!BILIBILI_BVID.test(bvid)) return null;
	return { id: bvid, page: positivePage(url.searchParams.get("p")) };
}

export function normalizeExternalVideoUrl(value) {
	const url = safeHttpsUrl(value);
	if (!url) return null;
	const youtubeId = youtubeIdFrom(url);
	if (youtubeId) {
		return {
			provider: "youtube",
			id: youtubeId,
			canonicalUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
			embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
		};
	}
	const bilibili = bilibiliDetailsFrom(url);
	if (!bilibili) return null;
	const pageQuery = bilibili.page ? `?p=${bilibili.page}` : "";
	return {
		provider: "bilibili",
		id: bilibili.id,
		canonicalUrl: `https://www.bilibili.com/video/${bilibili.id}${pageQuery}`,
		embedUrl: `https://player.bilibili.com/player.html?bvid=${bilibili.id}${bilibili.page ? `&p=${bilibili.page}` : ""}`,
	};
}

export function normalizeEmbeddedMediaPath(value, allowedKinds) {
	const normalized = normalizeMediaPublicPath(value);
	if (!normalized) return null;
	const kinds = Array.isArray(allowedKinds) ? allowedKinds : [allowedKinds];
	return kinds.includes(normalized.kind) ? normalized : null;
}

export function normalizeVideoPosterPath(value) {
	return normalizeEmbeddedMediaPath(value, "image");
}

export function isSafeExternalLink(value) {
	return Boolean(safeHttpsUrl(value));
}
