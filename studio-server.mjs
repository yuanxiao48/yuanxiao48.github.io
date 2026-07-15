import { createServer } from "node:http";
import Busboy from "busboy";
import { createReadStream, createWriteStream } from "node:fs";
import {
	access,
	copyFile,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import sanitizeHtml from "sanitize-html";
import {
	getMediaPolicy,
	MEDIA_KINDS,
	normalizeMediaKind,
	normalizeMediaPublicPath,
	normalizeMediaSearch,
} from "./shared/media-policy.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(root, "src", "config", "userSettings.json");
const aboutPath = path.join(root, "src", "content", "spec", "about.md");
const announcementPath = path.join(root, "src", "config", "announcementConfig.ts");
const widgetRegistryPath = path.join(root, "src", "config", "widgetRegistry.json");
const postsRoot = path.join(root, "src", "content", "posts");
const srcImagesRoot = path.join(root, "src", "assets", "images");
const publicImagesRoot = path.join(root, "public", "assets", "images");
const publicAssetsRoot = path.join(root, "public", "assets");
const publicPostImagesRoot = path.join(publicImagesRoot, "posts");
const trashPostsRoot = path.join(root, ".studio-trash", "posts");
const trashMediaRoot = path.join(root, ".studio-trash", "media");
const mediaTempRoot = path.join(root, ".studio-tmp", "media");
const uiPath = path.join(root, "studio-ui.html");
const editorScriptPath = path.join(root, "studio-editor.js");
const editorStylesPath = path.join(root, "studio-editor.css");
const studioAssets = new Map([
	["/studio-cms.css", [path.join(root, "studio-cms.css"), "text/css; charset=utf-8"]],
	["/studio-cms-utils.js", [path.join(root, "studio-cms-utils.js"), "text/javascript; charset=utf-8"]],
	["/studio-layout-manager.js", [path.join(root, "studio-layout-manager.js"), "text/javascript; charset=utf-8"]],
	["/studio-page-manager.js", [path.join(root, "studio-page-manager.js"), "text/javascript; charset=utf-8"]],
	["/studio-settings-manager.js", [path.join(root, "studio-settings-manager.js"), "text/javascript; charset=utf-8"]],
	["/studio-shell.js", [path.join(root, "studio-shell.js"), "text/javascript; charset=utf-8"]],
	["/studio-media-manager.js", [path.join(root, "studio-media-manager.js"), "text/javascript; charset=utf-8"]],
	["/studio-media.css", [path.join(root, "studio-media.css"), "text/css; charset=utf-8"]],
]);
const port = Number(process.env.STUDIO_PORT || 4322);
const MAX_PREVIEW_BODY_BYTES = 256 * 1024;
const MAX_CONTENT_BODY_BYTES = 512 * 1024;
const MEDIA_UPLOAD_MULTIPART_OVERHEAD = 256 * 1024;
const MEDIA_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STUDIO_SESSION_TOKEN = randomUUID();

let previewMarkdownRendererPromise;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const componentTypes = new Set([
	"profile",
	"announcement",
	"categories",
	"tags",
	"sidebarToc",
	"stats",
	"calendar",
	"music",
	"emailSubscribe",
	"siteInfo",
	"advertisement",
]);
const imageExtensions = new Set([
	".avif",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".svg",
	".webp",
]);
const previewMediaExtensions = new Set([
	".aac",
	".flac",
	".m4a",
	".mov",
	".mp3",
	".mp4",
	".ogg",
	".wav",
	".webm",
]);
const copyablePostResourceExtensions = new Set([
	".avif",
	".gif",
	".jpeg",
	".jpg",
	".m4a",
	".mp3",
	".mp4",
	".ogg",
	".pdf",
	".png",
	".svg",
	".wav",
	".webm",
	".webp",
]);
const imageContentTypes = new Map([
	[".avif", "image/avif"],
	[".aac", "audio/aac"],
	[".flac", "audio/flac"],
	[".gif", "image/gif"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".webp", "image/webp"],
	[".m4a", "audio/mp4"],
	[".mov", "video/quicktime"],
	[".mp3", "audio/mpeg"],
	[".mp4", "video/mp4"],
	[".ogg", "audio/ogg"],
	[".wav", "audio/wav"],
	[".webm", "video/webm"],
]);

const defaultSettings = {
	site: {
		title: "你的名字",
		subtitle: "Blog",
		url: "https://yuanxiao48.github.io/metawiki",
		description: "一个用来放日常、想法、作品和长期笔记的个人博客。",
	},
	theme: {
		hue: 165,
		defaultMode: "system",
	},
	profile: {
		name: "你的名字",
		bio: "把日常、想法和慢慢成形的东西放在这里。",
		avatar: "assets/images/avatar.avif",
		github: "https://github.com/yuanxiao48",
		email: "mailto:hello@example.com",
	},
	home: {
		title: "Personal notes",
		subtitles: [
			"Daily notes, quiet ideas, and things worth keeping",
			"A small room for reading, making, and remembering",
			"Write slowly. Keep what matters.",
		],
	},
	images: {
		wallpaperDesktop: [
			"assets/images/DesktopWallpaper/d1.avif",
			"assets/images/DesktopWallpaper/d2.avif",
			"assets/images/DesktopWallpaper/d3.avif",
			"assets/images/DesktopWallpaper/d4.avif",
			"assets/images/DesktopWallpaper/d5.avif",
			"assets/images/DesktopWallpaper/d6.avif",
		],
		wallpaperMobile: [
			"assets/images/MobileWallpaper/m1.avif",
			"assets/images/MobileWallpaper/m2.avif",
			"assets/images/MobileWallpaper/m3.avif",
			"assets/images/MobileWallpaper/m4.avif",
			"assets/images/MobileWallpaper/m5.avif",
			"assets/images/MobileWallpaper/m6.avif",
		],
		bannerPosition: "0% 20%",
		fullscreenPosition: "center",
		articleCover: "",
	},
	pages: {
		friends: true,
		sponsor: true,
		guestbook: true,
		bangumi: true,
		gallery: true,
	},
	music: {
		showInNavbar: true,
		showInSidebar: true,
		mode: "meting",
		server: "netease",
		type: "playlist",
		id: "10046455237",
		api: "https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r",
		volume: 0.7,
		playMode: "list",
		showLyrics: true,
	},
	comments: {
		enabled: true,
		type: "giscus",
		twikooEnvId: "",
		walineServerURL: "",
		giscusRepo: "yuanxiao48/metawiki",
		giscusRepoId: "",
		giscusCategory: "General",
		giscusCategoryId: "",
		disqusShortname: "",
		artalkServer: "",
	},
	layout: {
		left: [
			{ type: "profile", enable: true, position: "top" },
			{ type: "stats", enable: true, position: "top" },
			{ type: "announcement", enable: true, position: "top" },
			{ type: "music", enable: true, position: "sticky" },
			{ type: "categories", enable: true, position: "sticky" },
			{ type: "tags", enable: true, position: "sticky" },
		],
		right: [
			{ type: "sidebarToc", enable: true, position: "sticky" },
			{ type: "calendar", enable: true, position: "sticky" },
			{ type: "siteInfo", enable: false, position: "sticky" },
		],
		mobile: [
			{ type: "profile", enable: true },
			{ type: "stats", enable: true },
			{ type: "announcement", enable: true },
			{ type: "music", enable: true },
			{ type: "categories", enable: true },
			{ type: "tags", enable: true },
		],
	},
};

function send(res, status, body, headers = jsonHeaders) {
	res.writeHead(status, headers);
	res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendBuffer(res, status, buffer, contentType) {
	res.writeHead(status, {
		"content-type": contentType,
		"cache-control": "no-store",
	});
	res.end(buffer);
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function stringValue(value, fallback = "") {
	const text = typeof value === "string" ? value.trim() : "";
	return text || fallback;
}

class StudioError extends Error {
	constructor(message, status = 400, code = "STUDIO_ERROR", details = undefined) {
		super(message);
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

function booleanValue(value, fallback = false) {
	return typeof value === "boolean" ? value : fallback;
}

function numberValue(value, fallback, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(min, Math.min(max, number));
}

function choiceValue(value, allowed, fallback) {
	return allowed.includes(value) ? value : fallback;
}

function sanitizeTextList(value, fallback, limit = 8) {
	if (!Array.isArray(value)) return fallback;
	return value
		.map((item) => stringValue(item))
		.filter(Boolean)
		.slice(0, limit);
}

function sanitizeImageList(value, fallback, limit = 18) {
	if (!Array.isArray(value)) return fallback;
	const next = value
		.map((item) => stringValue(item))
		.filter(Boolean)
		.slice(0, limit);
	return next.length ? next : fallback;
}

function sanitizeLayoutList(input, fallback, mobile = false) {
	const source = Array.isArray(input) ? input : Array.isArray(fallback) ? fallback : [];
	const seen = new Set();
	const list = [];
	for (const item of source) {
		const type = stringValue(item?.type);
		if (!componentTypes.has(type) || seen.has(type)) continue;
		seen.add(type);
		const next = {
			type,
			enable: booleanValue(item?.enable, true),
		};
		if (!mobile) {
			next.position = choiceValue(item?.position, ["top", "sticky"], "sticky");
		}
		list.push(next);
	}
	return list;
}

function sanitizeSettings(input, current = defaultSettings) {
	const settings = input && typeof input === "object" ? input : {};
	const base = current && typeof current === "object" ? current : defaultSettings;
	const currentMusic = base.music ?? defaultSettings.music;
	const currentComments = base.comments ?? defaultSettings.comments;
	const currentLayout = base.layout ?? defaultSettings.layout;
	const currentImages = base.images ?? defaultSettings.images;

	return {
		site: {
			title: stringValue(settings.site?.title, base.site?.title),
			subtitle: stringValue(settings.site?.subtitle, base.site?.subtitle),
			url: stringValue(settings.site?.url, base.site?.url),
			description: stringValue(
				settings.site?.description,
				base.site?.description,
			),
		},
		theme: {
			hue: Math.round(numberValue(settings.theme?.hue, base.theme?.hue ?? 165, 0, 360)),
			defaultMode: choiceValue(
				settings.theme?.defaultMode,
				["light", "dark", "system"],
				base.theme?.defaultMode ?? "system",
			),
		},
		profile: {
			name: stringValue(settings.profile?.name, base.profile?.name),
			bio: stringValue(settings.profile?.bio, base.profile?.bio),
			avatar: stringValue(settings.profile?.avatar, base.profile?.avatar),
			github: stringValue(settings.profile?.github, base.profile?.github),
			email: stringValue(settings.profile?.email, base.profile?.email),
		},
		home: {
			title: stringValue(settings.home?.title, base.home?.title),
			subtitles: sanitizeTextList(
				settings.home?.subtitles,
				base.home?.subtitles ?? defaultSettings.home.subtitles,
			),
		},
		images: {
			wallpaperDesktop: sanitizeImageList(
				settings.images?.wallpaperDesktop,
				currentImages.wallpaperDesktop ?? defaultSettings.images.wallpaperDesktop,
			),
			wallpaperMobile: sanitizeImageList(
				settings.images?.wallpaperMobile,
				currentImages.wallpaperMobile ?? defaultSettings.images.wallpaperMobile,
			),
			bannerPosition: stringValue(
				settings.images?.bannerPosition,
				currentImages.bannerPosition ?? defaultSettings.images.bannerPosition,
			),
			fullscreenPosition: stringValue(
				settings.images?.fullscreenPosition,
				currentImages.fullscreenPosition ?? defaultSettings.images.fullscreenPosition,
			),
			articleCover: stringValue(
				settings.images?.articleCover,
				currentImages.articleCover ?? "",
			),
		},
		pages: {
			friends: booleanValue(settings.pages?.friends, base.pages?.friends ?? true),
			sponsor: booleanValue(settings.pages?.sponsor, base.pages?.sponsor ?? true),
			guestbook: booleanValue(settings.pages?.guestbook, base.pages?.guestbook ?? true),
			bangumi: booleanValue(settings.pages?.bangumi, base.pages?.bangumi ?? true),
			gallery: booleanValue(settings.pages?.gallery, base.pages?.gallery ?? true),
		},
		music: {
			showInNavbar: booleanValue(settings.music?.showInNavbar, currentMusic.showInNavbar ?? true),
			showInSidebar: booleanValue(settings.music?.showInSidebar, currentMusic.showInSidebar ?? true),
			mode: choiceValue(settings.music?.mode, ["meting", "local"], currentMusic.mode ?? "meting"),
			server: choiceValue(
				settings.music?.server,
				["netease", "tencent", "kugou", "xiami", "baidu"],
				currentMusic.server ?? "netease",
			),
			type: choiceValue(
				settings.music?.type,
				["song", "playlist", "album", "search", "artist"],
				currentMusic.type ?? "playlist",
			),
			id: stringValue(settings.music?.id, currentMusic.id ?? ""),
			api: stringValue(settings.music?.api, currentMusic.api ?? ""),
			volume: numberValue(settings.music?.volume, currentMusic.volume ?? 0.7, 0, 1),
			playMode: choiceValue(settings.music?.playMode, ["list", "one", "random"], currentMusic.playMode ?? "list"),
			showLyrics: booleanValue(settings.music?.showLyrics, currentMusic.showLyrics ?? true),
		},
		comments: {
			enabled: booleanValue(settings.comments?.enabled, currentComments.enabled ?? true),
			type: choiceValue(
				settings.comments?.type,
				["none", "twikoo", "waline", "giscus", "disqus", "artalk"],
				currentComments.type ?? "giscus",
			),
			twikooEnvId: stringValue(settings.comments?.twikooEnvId, currentComments.twikooEnvId ?? ""),
			walineServerURL: stringValue(settings.comments?.walineServerURL, currentComments.walineServerURL ?? ""),
			giscusRepo: stringValue(settings.comments?.giscusRepo, currentComments.giscusRepo ?? ""),
			giscusRepoId: stringValue(settings.comments?.giscusRepoId, currentComments.giscusRepoId ?? ""),
			giscusCategory: stringValue(settings.comments?.giscusCategory, currentComments.giscusCategory ?? "General"),
			giscusCategoryId: stringValue(settings.comments?.giscusCategoryId, currentComments.giscusCategoryId ?? ""),
			disqusShortname: stringValue(settings.comments?.disqusShortname, currentComments.disqusShortname ?? ""),
			artalkServer: stringValue(settings.comments?.artalkServer, currentComments.artalkServer ?? ""),
		},
		layout: {
			left: sanitizeLayoutList(settings.layout?.left, currentLayout.left),
			right: sanitizeLayoutList(settings.layout?.right, currentLayout.right),
			mobile: sanitizeLayoutList(settings.layout?.mobile, currentLayout.mobile, true),
		},
	};
}

function normalizeSettings(settings) {
	return sanitizeSettings(settings, clone(defaultSettings));
}

async function readBody(req) {
	let body = "";
	for await (const chunk of req) body += chunk;
	if (!body) return {};
	return JSON.parse(body);
}

async function readContentBody(req) {
	const declaredLength = Number(req.headers["content-length"] || 0);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTENT_BODY_BYTES) {
		throw new StudioError("Content request is too large", 413);
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_CONTENT_BODY_BYTES) {
			throw new StudioError("Content request is too large", 413);
		}
		chunks.push(buffer);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new StudioError("Content request must be valid JSON");
	}
}

function revisionFor(value) {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readWidgetRegistry() {
	const data = await readJson(widgetRegistryPath);
	if (!Array.isArray(data)) throw new StudioError("Widget registry is invalid", 500);
	const seen = new Set();
	return data.map((entry) => {
		if (!isRecord(entry)) throw new StudioError("Widget registry is invalid", 500);
		const type = stringValue(entry.type);
		if (!type || seen.has(type)) throw new StudioError("Widget registry contains duplicate types", 500);
		seen.add(type);
		return {
			type,
			name: stringValue(entry.name, type),
			description: stringValue(entry.description),
		};
	});
}

function assetPath(value, fieldName) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return "";
	if (
		raw.includes("\\") ||
		raw.includes("..") ||
		/^file:/i.test(raw) ||
		/^[a-z]:/i.test(raw)
	) {
		throw new StudioError(`${fieldName} must use a deployed /assets/images path`);
	}
	const normalized = raw.startsWith("/") ? raw : `/${raw}`;
	if (!normalized.startsWith("/assets/images/")) {
		throw new StudioError(`${fieldName} must use a deployed /assets/images path`);
	}
	return raw;
}

function optionalHttpUrl(value, fieldName, allowRelative = false) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return "";
	if (/^file:/i.test(raw) || raw.includes("\\") || raw.includes("..") || /^[a-z]:/i.test(raw)) {
		throw new StudioError(`${fieldName} is not a safe URL`);
	}
	if (allowRelative && raw.startsWith("/")) return raw;
	try {
		const url = new URL(raw);
		if (!["http:", "https:"].includes(url.protocol)) throw new Error();
		return url.toString();
	} catch {
		throw new StudioError(`${fieldName} must be an http(s) URL`);
	}
}

function optionalEmail(value) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return "";
	const email = raw.replace(/^mailto:/i, "");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new StudioError("Email address is invalid");
	}
	return raw;
}

function settingsLayout(settings) {
	const layout = isRecord(settings?.layout) ? settings.layout : {};
	return {
		left: Array.isArray(layout.left) ? layout.left : [],
		right: Array.isArray(layout.right) ? layout.right : [],
		mobile: Array.isArray(layout.mobile) ? layout.mobile : [],
	};
}

function validateLayoutInput(layout, registry) {
	if (!isRecord(layout)) throw new StudioError("Layout data is invalid");
	const validTypes = new Set(registry.map((widget) => widget.type));
	const output = {};
	for (const area of ["left", "right", "mobile"]) {
		const source = layout[area];
		if (!Array.isArray(source)) throw new StudioError(`${area} layout must be a list`);
		const seen = new Set();
		output[area] = source.map((item) => {
			if (!isRecord(item)) throw new StudioError("Layout item is invalid");
			const type = stringValue(item.type);
			if (!validTypes.has(type)) throw new StudioError(`Unknown widget type: ${type || "empty"}`);
			if (seen.has(type)) throw new StudioError(`${area} contains duplicate widget: ${type}`);
			seen.add(type);
			const next = { type, enable: booleanValue(item.enable, true) };
			if (area !== "mobile") {
				next.position = choiceValue(item.position, ["top", "sticky"], "sticky");
			}
			return next;
		});
	}
	return output;
}

function mergeLayout(currentSettings, requestedLayout) {
	const next = clone(currentSettings);
	const currentLayout = settingsLayout(currentSettings);
	next.layout = isRecord(next.layout) ? next.layout : {};
	for (const area of ["left", "right", "mobile"]) {
		const existing = new Map(
			currentLayout[area]
				.filter((item) => isRecord(item) && typeof item.type === "string")
				.map((item) => [item.type, item]),
		);
		next.layout[area] = requestedLayout[area].map((item) => {
			const original = existing.get(item.type);
			return { ...(isRecord(original) ? original : {}), ...item };
		});
	}
	return next;
}

async function getLayoutPayload() {
	const raw = await readFile(settingsPath, "utf8");
	const settings = JSON.parse(raw);
	return {
		revision: revisionFor(raw),
		layout: settingsLayout(settings),
		widgets: await readWidgetRegistry(),
	};
}

async function saveLayout(input) {
	const raw = await readFile(settingsPath, "utf8");
	if (input?.revision && input.revision !== revisionFor(raw)) {
		throw new StudioError("Layout changed on disk. Reload before saving.", 409);
	}
	const requested = validateLayoutInput(input?.layout, await readWidgetRegistry());
	const next = mergeLayout(JSON.parse(raw), requested);
	const serialized = `${JSON.stringify(next, null, 2)}\n`;
	await atomicWriteFile(settingsPath, serialized);
	return {
		revision: revisionFor(serialized),
		layout: settingsLayout(next),
		widgets: await readWidgetRegistry(),
	};
}

function readTsString(source, key, offset = 0) {
	const match = source.slice(offset).match(new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
	if (!match) throw new StudioError(`Announcement field is missing: ${key}`, 500);
	try {
		return JSON.parse(match[1]);
	} catch {
		throw new StudioError(`Announcement field is invalid: ${key}`, 500);
	}
}

function replaceTsString(source, key, value, offset = 0, end = source.length) {
	const before = source.slice(0, offset);
	const segment = source.slice(offset, end);
	const after = source.slice(end);
	const pattern = new RegExp(`(\\b${key}\\s*:\\s*)("(?:\\\\.|[^"\\\\])*")`);
	if (!pattern.test(segment)) throw new StudioError(`Announcement field is missing: ${key}`, 500);
	return before + segment.replace(pattern, `$1${JSON.stringify(value)}`) + after;
}

function announcementLinkRange(source) {
	const match = /\blink\s*:\s*\{/.exec(source);
	if (!match) throw new StudioError("Announcement link configuration is invalid", 500);
	const open = source.indexOf("{", match.index);
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let index = open; index < source.length; index += 1) {
		const char = source[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") { quote = char; continue; }
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return { start: open, end: index + 1 };
		}
	}
	throw new StudioError("Announcement link configuration is invalid", 500);
}

function announcementData(source, settings) {
	const link = announcementLinkRange(source);
	const layout = settingsLayout(settings);
	const visible = Object.values(layout).some((items) =>
		items.some((item) => item?.type === "announcement" && item?.enable !== false),
	);
	return {
		title: readTsString(source, "title"),
		content: readTsString(source, "content"),
		buttonText: readTsString(source, "text", link.start),
		buttonUrl: readTsString(source, "url", link.start),
		visible,
	};
}

function replaceAnnouncementVisibility(settings, visible) {
	const next = clone(settings);
	const layout = settingsLayout(next);
	next.layout = isRecord(next.layout) ? next.layout : {};
	for (const area of ["left", "right", "mobile"]) {
		next.layout[area] = layout[area].map((item) =>
			item?.type === "announcement" ? { ...item, enable: Boolean(visible) } : item,
		);
	}
	return next;
}

async function getContentSettings() {
	const [settingsRaw, announcementRaw] = await Promise.all([
		readFile(settingsPath, "utf8"),
		readFile(announcementPath, "utf8"),
	]);
	const settings = JSON.parse(settingsRaw);
	return {
		revision: revisionFor(`${settingsRaw}\n${announcementRaw}`),
		settings: {
			site: {
				title: String(settings.site?.title || ""),
				subtitle: String(settings.site?.subtitle || ""),
				description: String(settings.site?.description || ""),
			},
			profile: {
				name: String(settings.profile?.name || ""),
				bio: String(settings.profile?.bio || ""),
				avatar: String(settings.profile?.avatar || ""),
				github: String(settings.profile?.github || ""),
				email: String(settings.profile?.email || ""),
			},
			announcement: announcementData(announcementRaw, settings),
		},
	};
}

async function saveContentSettings(input) {
	const [settingsRaw, announcementRaw] = await Promise.all([
		readFile(settingsPath, "utf8"),
		readFile(announcementPath, "utf8"),
	]);
	if (input?.revision && input.revision !== revisionFor(`${settingsRaw}\n${announcementRaw}`)) {
		throw new StudioError("Settings changed on disk. Reload before saving.", 409);
	}
	if (!isRecord(input?.settings)) throw new StudioError("Settings data is invalid");
	const current = JSON.parse(settingsRaw);
	const next = clone(current);
	const patch = input.settings;
	if (isRecord(patch.site)) {
		next.site = { ...(isRecord(next.site) ? next.site : {}) };
		for (const key of ["title", "subtitle", "description"]) {
			if (Object.hasOwn(patch.site, key)) next.site[key] = String(patch.site[key] ?? "").trim();
		}
		if (!next.site.title) throw new StudioError("Site title is required");
	}
	if (isRecord(patch.profile)) {
		next.profile = { ...(isRecord(next.profile) ? next.profile : {}) };
		if (Object.hasOwn(patch.profile, "name")) next.profile.name = String(patch.profile.name ?? "").trim();
		if (Object.hasOwn(patch.profile, "bio")) next.profile.bio = String(patch.profile.bio ?? "").trim();
		if (Object.hasOwn(patch.profile, "avatar")) next.profile.avatar = assetPath(patch.profile.avatar, "Avatar path");
		if (Object.hasOwn(patch.profile, "github")) next.profile.github = optionalHttpUrl(patch.profile.github, "GitHub URL");
		if (Object.hasOwn(patch.profile, "email")) next.profile.email = optionalEmail(patch.profile.email);
	}
	let nextAnnouncement = announcementRaw;
	if (isRecord(patch.announcement)) {
		if (Object.hasOwn(patch.announcement, "title")) nextAnnouncement = replaceTsString(nextAnnouncement, "title", String(patch.announcement.title ?? ""));
		if (Object.hasOwn(patch.announcement, "content")) nextAnnouncement = replaceTsString(nextAnnouncement, "content", String(patch.announcement.content ?? ""));
		const freshLink = announcementLinkRange(nextAnnouncement);
		if (Object.hasOwn(patch.announcement, "buttonText")) nextAnnouncement = replaceTsString(nextAnnouncement, "text", String(patch.announcement.buttonText ?? ""), freshLink.start, freshLink.end);
		if (Object.hasOwn(patch.announcement, "buttonUrl")) nextAnnouncement = replaceTsString(nextAnnouncement, "url", optionalHttpUrl(patch.announcement.buttonUrl, "Announcement link", true), freshLink.start, freshLink.end);
		if (Object.hasOwn(patch.announcement, "visible")) {
			Object.assign(next, replaceAnnouncementVisibility(next, Boolean(patch.announcement.visible)));
		}
	}
	const nextSettingsRaw = `${JSON.stringify(next, null, 2)}\n`;
	await atomicWriteFile(settingsPath, nextSettingsRaw);
	try {
		if (nextAnnouncement !== announcementRaw) await atomicWriteFile(announcementPath, nextAnnouncement);
	} catch (error) {
		await atomicWriteFile(settingsPath, settingsRaw).catch(() => {});
		throw error;
	}
	return getContentSettings();
}

async function getAboutPage() {
	const content = await readFile(aboutPath, "utf8");
	return { content, revision: revisionFor(content) };
}

async function saveAboutPage(input) {
	if (typeof input?.content !== "string") throw new StudioError("About content is required");
	if (Buffer.byteLength(input.content, "utf8") > MAX_CONTENT_BODY_BYTES) {
		throw new StudioError("About page is too large", 413);
	}
	const current = await readFile(aboutPath, "utf8");
	if (input?.revision && input.revision !== revisionFor(current)) {
		throw new StudioError("About page changed on disk. Reload before saving.", 409);
	}
	await atomicWriteFile(aboutPath, input.content);
	return getAboutPage();
}

async function readPreviewBody(req) {
	const declaredLength = Number(req.headers["content-length"] || 0);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_BODY_BYTES) {
		throw new StudioError("预览内容过长，请将正文控制在 256 KB 以内", 413);
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_PREVIEW_BODY_BYTES) {
			throw new StudioError("预览内容过长，请将正文控制在 256 KB 以内", 413);
		}
		chunks.push(buffer);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new StudioError("预览请求格式不正确");
	}
}

function previewAssetRelative(value) {
	const raw = String(value || "").trim();
	if (!raw || raw.includes("\0") || raw.includes("\\")) return null;
	let decoded;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	const relative = decoded.replace(/^\/+/, "");
	if (!relative || relative === ".." || relative.startsWith("../") || relative.includes("/../")) {
		return null;
	}
	return relative;
}

function previewImageSource(source) {
	const value = String(source || "").trim();
	if (!value) return "";
	if (value.startsWith("/assets/")) {
		const relative = previewAssetRelative(value.slice("/assets/".length));
		return relative ? `/studio-assets/${relative}` : "";
	}
	if (/^https?:\/\//i.test(value)) return value;
	return "";
}

function previewMediaSource(source) {
	return previewImageSource(source);
}

function articleImagePath(value) {
	const imagePath = stringValue(value);
	if (!imagePath) return "";
	if (
		!imagePath.startsWith("/assets/images/") ||
		imagePath.startsWith("/studio-assets/") ||
		/^file:/i.test(imagePath) ||
		/^[a-z]:[\\/]/i.test(imagePath)
	) {
		throw new StudioError("文章图片必须使用 /assets/images/ 下的站内路径");
	}
	const relative = previewAssetRelative(imagePath.slice("/assets/".length));
	if (!relative || !relative.startsWith("images/")) {
		throw new StudioError("文章图片路径不安全");
	}
	const ext = path.extname(relative).toLowerCase();
	if (!imageExtensions.has(ext)) throw new StudioError("文章封面不是支持的图片格式");
	return `/assets/${relative}`;
}

function previewWarnings(markdown) {
	const warnings = [];
	if (/!\[[^\]]*\]\(\s*(?:<)?\.\//.test(markdown)) {
		warnings.push("文章目录相对图片（如 ./image.webp）暂不支持预览。");
	}
	if (/!\[[^\]]*\]\(\s*(?:<)?(?:file:\/\/|[a-z]:[\\/])/i.test(markdown)) {
		warnings.push("本地绝对图片路径不会在预览中显示。");
	}
	return warnings;
}

function previewSanitizer() {
	return {
		allowedTags: [
			"a",
			"audio",
			"blockquote",
			"br",
			"code",
			"del",
			"em",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"hr",
			"img",
			"li",
			"ol",
			"p",
			"pre",
			"s",
			"strong",
			"table",
			"tbody",
			"td",
			"th",
			"thead",
			"tr",
			"ul",
			"video",
			"source",
		],
		allowedAttributes: {
			a: ["href", "rel", "title"],
			code: ["class"],
			img: ["src", "alt", "title", "width", "height", "loading"],
			audio: ["src", "controls", "preload"],
			video: ["src", "controls", "preload", "poster", "width", "height"],
			source: ["src", "type"],
			ol: ["start"],
			th: ["align"],
			td: ["align"],
		},
		allowedClasses: {
			code: ["language-*"],
		},
		allowedSchemes: ["http", "https", "mailto"],
		allowProtocolRelative: false,
		disallowedTagsMode: "completelyDiscard",
		nonTextTags: ["script", "style", "textarea", "option", "iframe", "object", "embed"],
		transformTags: {
			a: (tagName, attribs) => ({
				tagName,
				attribs: { ...attribs, rel: "noopener noreferrer" },
			}),
			img: (tagName, attribs) => ({
				tagName,
				attribs: { ...attribs, src: previewImageSource(attribs.src) },
			}),
			audio: (tagName, attribs) => ({
				tagName,
				attribs: { ...attribs, src: previewMediaSource(attribs.src) },
			}),
			video: (tagName, attribs) => ({
				tagName,
				attribs: {
					...attribs,
					src: previewMediaSource(attribs.src),
					poster: previewImageSource(attribs.poster),
				},
			}),
			source: (tagName, attribs) => ({
				tagName,
				attribs: { ...attribs, src: previewMediaSource(attribs.src) },
			}),
		},
		exclusiveFilter: (frame) =>
			["img", "audio", "video", "source"].includes(frame.tag) && !frame.attribs.src,
	};
}

async function previewMarkdown(input) {
	const markdown = typeof input?.markdown === "string" ? input.markdown : "";
	if (Buffer.byteLength(markdown, "utf8") > MAX_PREVIEW_BODY_BYTES) {
		throw new StudioError("预览内容过长，请将正文控制在 256 KB 以内", 413);
	}
	previewMarkdownRendererPromise ||= createMarkdownProcessor({
		gfm: true,
		smartypants: false,
		syntaxHighlight: false,
	});
	try {
		const renderer = await previewMarkdownRendererPromise;
		const rendered = await renderer.render(markdown);
		return {
			html: sanitizeHtml(rendered.code, previewSanitizer()),
			warnings: previewWarnings(markdown),
		};
	} catch (error) {
		throw new StudioError(`Markdown 预览渲染失败：${error.message || "未知错误"}`, 422);
	}
}

async function resolvePreviewAsset(urlPath) {
	const prefix = "/studio-assets/";
	if (!urlPath.startsWith(prefix)) throw new StudioError("预览资源路径不正确");
	const relative = previewAssetRelative(urlPath.slice(prefix.length));
	if (!relative) throw new StudioError("预览资源路径不正确");
	const fullPath = path.resolve(publicAssetsRoot, relative);
	const safeRelative = path.relative(publicAssetsRoot, fullPath);
	if (safeRelative.startsWith("..") || path.isAbsolute(safeRelative)) {
		throw new StudioError("预览资源路径越界");
	}
	const ext = path.extname(fullPath).toLowerCase();
	if (!imageExtensions.has(ext) && !previewMediaExtensions.has(ext)) {
		throw new StudioError("Preview only allows image, audio, and video assets");
	}
	const info = await lstat(fullPath).catch(() => null);
	if (!info?.isFile() || info.isSymbolicLink()) throw new StudioError("预览图片不存在", 404);
	await assertNoSymlinksWithin(publicAssetsRoot, fullPath);
	return { fullPath, ext };
}

function isInsidePath(base, candidate) {
	const relative = path.relative(base, candidate);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isWithinPath(base, candidate) {
	const relative = path.relative(base, candidate);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertNoSymlinksWithin(base, candidate, includeCandidate = true) {
	const baseInfo = await lstat(base).catch(() => null);
	if (!baseInfo?.isDirectory() || baseInfo.isSymbolicLink()) {
		throw new StudioError("Approved root is unavailable", 500, "MEDIA_ROOT_UNAVAILABLE");
	}
	const resolvedBase = await realpath(base);
	const target = path.resolve(candidate);
	if (!isWithinPath(path.resolve(base), target)) {
		throw new StudioError("Path escapes its approved directory", 400, "MEDIA_PATH_INVALID");
	}
	const relative = path.relative(path.resolve(base), target);
	const parts = relative ? relative.split(path.sep) : [];
	const checked = includeCandidate ? parts : parts.slice(0, -1);
	let current = path.resolve(base);
	for (const part of checked) {
		if (!part || part === "." || part === ".." || part.startsWith(".")) {
			throw new StudioError("Path contains an unsafe segment", 400, "MEDIA_PATH_INVALID");
		}
		current = path.join(current, part);
		const info = await lstat(current).catch(() => null);
		if (!info) throw new StudioError("Approved path does not exist", 404, "MEDIA_NOT_FOUND");
		if (info.isSymbolicLink()) throw new StudioError("Symbolic links are not allowed", 400, "MEDIA_SYMLINK_BLOCKED");
		const resolvedCurrent = await realpath(current);
		if (!isWithinPath(resolvedBase, resolvedCurrent)) {
			throw new StudioError("Path escapes its approved directory", 400, "MEDIA_PATH_INVALID");
		}
	}
	return { resolvedBase, target };
}

async function ensureSafeDirectoryWithin(base, directory, { allowHidden = false } = {}) {
	const basePath = path.resolve(base);
	const target = path.resolve(directory);
	if (!isWithinPath(basePath, target)) {
		throw new StudioError("Directory escapes its approved root", 400, "MEDIA_PATH_INVALID");
	}
	const baseInfo = await lstat(basePath).catch(() => null);
	if (!baseInfo?.isDirectory() || baseInfo.isSymbolicLink()) {
		throw new StudioError("Approved root is unavailable", 500, "MEDIA_ROOT_UNAVAILABLE");
	}
	const resolvedBase = await realpath(basePath);
	let current = basePath;
	const relative = path.relative(basePath, target);
	for (const part of relative ? relative.split(path.sep) : []) {
		if (!part || part === "." || part === ".." || (!allowHidden && part.startsWith("."))) {
			throw new StudioError("Directory contains an unsafe segment", 400, "MEDIA_PATH_INVALID");
		}
		current = path.join(current, part);
		let info = await lstat(current).catch(() => null);
		if (!info) {
			await mkdir(current);
			info = await lstat(current);
		}
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new StudioError("Directory is not safe", 400, "MEDIA_SYMLINK_BLOCKED");
		}
		const resolvedCurrent = await realpath(current);
		if (!isWithinPath(resolvedBase, resolvedCurrent)) {
			throw new StudioError("Directory escapes its approved root", 400, "MEDIA_PATH_INVALID");
		}
	}
	return { directory: target, resolvedBase };
}

function hasHiddenPathPart(relativePath) {
	return relativePath.split(/[\\/]/).some((part) => part.startsWith("."));
}

async function getSafeMediaRoot(kind) {
	const policy = getMediaPolicy(kind);
	if (!policy) throw new StudioError("Unsupported media kind", 400);
	const mediaRoot = path.resolve(publicAssetsRoot, ...policy.directory);
	if (!isInsidePath(publicAssetsRoot, mediaRoot)) {
		throw new StudioError("Media root is invalid", 500);
	}
	let info;
	try {
		info = await lstat(mediaRoot);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw new StudioError("Media directory cannot be read", 500);
	}
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new StudioError("Media directory is not available", 500);
	}
	const [resolvedPublicAssets, resolvedMediaRoot] = await Promise.all([
		realpath(publicAssetsRoot),
		realpath(mediaRoot),
	]);
	if (!isInsidePath(resolvedPublicAssets, resolvedMediaRoot)) {
		throw new StudioError("Media directory escapes public assets", 500);
	}
	await assertNoSymlinksWithin(publicAssetsRoot, mediaRoot);
	return { policy, mediaRoot, resolvedMediaRoot };
}

async function getSafeWritableMediaRoot(kind) {
	const policy = getMediaPolicy(kind);
	if (!policy) throw new StudioError("Unsupported media kind", 400, "MEDIA_KIND_INVALID");
	const mediaRoot = path.resolve(publicAssetsRoot, ...policy.directory);
	const safe = await ensureSafeDirectoryWithin(publicAssetsRoot, mediaRoot);
	return { policy, mediaRoot: safe.directory, resolvedMediaRoot: await realpath(safe.directory) };
}

async function getSafeMediaFile(mediaPath) {
	const parsed = normalizeMediaPublicPath(mediaPath);
	if (!parsed) throw new StudioError("Media path is invalid", 400);
	const rootInfo = await getSafeMediaRoot(parsed.kind);
	if (!rootInfo) return { ...parsed, exists: false };
	const file = path.resolve(rootInfo.mediaRoot, parsed.relativePath);
	if (!isInsidePath(rootInfo.mediaRoot, file) || hasHiddenPathPart(parsed.relativePath)) {
		throw new StudioError("Media path is invalid", 400);
	}
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if (error?.code === "ENOENT") return { ...parsed, exists: false };
		throw new StudioError("Media file cannot be read", 500);
	}
	if (!info.isFile() || info.isSymbolicLink()) return { ...parsed, exists: false };
	await assertNoSymlinksWithin(rootInfo.mediaRoot, file);
	const resolvedFile = await realpath(file);
	if (!isInsidePath(rootInfo.resolvedMediaRoot, resolvedFile)) {
		throw new StudioError("Media file escapes its approved directory", 400);
	}
	return { ...parsed, exists: true, file, info };
}

async function listMediaFiles(kind, errors) {
	const rootInfo = await getSafeMediaRoot(kind);
	if (!rootInfo) return [];
	const items = [];
	async function visit(directory, parentRelative = "") {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			errors.push({ kind, relativePath: parentRelative, error: "Directory could not be read" });
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			const relativePath = parentRelative ? `${parentRelative}/${entry.name}` : entry.name;
			const fullPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				await visit(fullPath, relativePath);
				continue;
			}
			if (!entry.isFile()) continue;
			const extension = path.extname(entry.name).toLowerCase();
			if (!rootInfo.policy.extensions.includes(extension) || hasHiddenPathPart(relativePath)) continue;
			try {
				const resolvedFile = await realpath(fullPath);
				if (!isInsidePath(rootInfo.resolvedMediaRoot, resolvedFile)) {
					errors.push({ kind, relativePath, error: "File was skipped because its path is unsafe" });
					continue;
				}
				const info = await stat(fullPath);
				items.push({
					kind,
					name: entry.name,
					publicPath: `${rootInfo.policy.publicPrefix}${relativePath}`,
					relativePath,
					size: info.size,
					modifiedAt: info.mtime.toISOString(),
				});
			} catch {
				errors.push({ kind, relativePath, error: "File could not be read" });
			}
		}
	}
	await visit(rootInfo.mediaRoot);
	return items;
}

async function listMedia(input) {
	const kind = normalizeMediaKind(input?.kind);
	if (!kind) throw new StudioError("Media kind must be all, image, audio, or video", 400);
	const search = normalizeMediaSearch(input?.search).toLocaleLowerCase();
	const errors = [];
	const kinds = kind === "all" ? MEDIA_KINDS : [kind];
	const items = (await Promise.all(kinds.map((itemKind) => listMediaFiles(itemKind, errors))))
		.flat()
		.filter((item) => !search || item.name.toLocaleLowerCase().includes(search))
		.sort((a, b) => {
			const modified = String(b.modifiedAt).localeCompare(String(a.modifiedAt));
			return modified || a.name.localeCompare(b.name) || a.publicPath.localeCompare(b.publicPath);
		});
	return { ok: true, items, errors };
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mediaReferencePattern(publicPath) {
	const barePath = publicPath.slice(1);
	return new RegExp(
		`(?:^|[^A-Za-z0-9._/-])(?:${escapeRegExp(publicPath)}|${escapeRegExp(barePath)})(?=$|[^A-Za-z0-9._/-])`,
	);
}

async function collectReferenceFiles(directory, extensions, list = []) {
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if (error?.code === "ENOENT") return list;
		throw new StudioError("Reference directory cannot be read", 500);
	}
	if (info.isSymbolicLink()) return list;
	if (info.isFile()) {
		if (extensions.has(path.extname(directory).toLowerCase())) list.push(directory);
		return list;
	}
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
		await collectReferenceFiles(path.join(directory, entry.name), extensions, list);
	}
	return list;
}

async function findMediaReferences(mediaPath) {
	const media = await getSafeMediaFile(mediaPath);
	if (!media.exists) return { ok: true, path: media.publicPath, exists: false, references: [] };
	const markdownFiles = await Promise.all([
		collectReferenceFiles(postsRoot, new Set([".md", ".mdx"])),
		collectReferenceFiles(path.join(root, "src", "content", "spec"), new Set([".md", ".mdx"])),
	]);
	const configFiles = await collectReferenceFiles(
		path.join(root, "src", "config"),
		new Set([".json", ".js", ".mjs", ".ts"]),
	);
	const pattern = mediaReferencePattern(media.publicPath);
	const references = [];
	for (const file of [...markdownFiles.flat(), ...configFiles]) {
		try {
			const contents = await readFile(file, "utf8");
			for (const [index, line] of contents.split(/\r?\n/).entries()) {
				if (!pattern.test(line)) continue;
				references.push({
					file: path.relative(root, file).replace(/\\/g, "/"),
					line: index + 1,
					text: line.trim().slice(0, 240),
				});
			}
		} catch {
			// A single unreadable text file must not prevent a safe reference result.
		}
	}
	return { ok: true, path: media.publicPath, exists: true, references };
}

const MEDIA_MIME_TYPES = Object.freeze({
	".jpg": new Set(["image/jpeg"]),
	".jpeg": new Set(["image/jpeg"]),
	".png": new Set(["image/png"]),
	".webp": new Set(["image/webp"]),
	".avif": new Set(["image/avif"]),
	".gif": new Set(["image/gif"]),
	".mp3": new Set(["audio/mpeg", "audio/mp3"]),
	".m4a": new Set(["audio/mp4", "audio/x-m4a"]),
	".aac": new Set(["audio/aac", "audio/x-aac"]),
	".wav": new Set(["audio/wav", "audio/x-wav", "audio/wave"]),
	".ogg": new Set(["audio/ogg", "application/ogg"]),
	".flac": new Set(["audio/flac", "audio/x-flac"]),
	".mp4": new Set(["video/mp4"]),
	".webm": new Set(["video/webm"]),
	".mov": new Set(["video/quicktime"]),
});

function normalizeUploadFilename(value, policy) {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw || raw.includes("\\") || raw.includes("/") || raw.includes("\0") || /^(?:[a-z]:|file:|javascript:)/i.test(raw)) {
		throw new StudioError("Upload filename is invalid", 400, "MEDIA_FILENAME_INVALID");
	}
	const extension = path.extname(raw).toLowerCase();
	if (!policy.extensions.includes(extension)) {
		throw new StudioError("File extension is not allowed for this media type", 415, "MEDIA_EXTENSION_INVALID");
	}
	const stem = raw.slice(0, -extension.length);
	if (!stem || stem.startsWith(".") || stem.includes(".") || stem === "." || stem === "..") {
		throw new StudioError("Upload filename is unsafe", 400, "MEDIA_FILENAME_INVALID");
	}
	const cleaned = stem
		.normalize("NFKC")
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_-]+/gu, "")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 80);
	if (!cleaned || cleaned.startsWith(".")) {
		throw new StudioError("Upload filename has no safe characters", 400, "MEDIA_FILENAME_INVALID");
	}
	return `${cleaned}${extension}`;
}

function mimeMatchesExtension(mimeType, extension) {
	const mime = String(mimeType || "").trim().toLowerCase();
	if (!mime || mime === "application/octet-stream") return true;
	return MEDIA_MIME_TYPES[extension]?.has(mime) ?? false;
}

function startsWithBytes(buffer, bytes) {
	return buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
}

function hasIsoBmffBrand(buffer, extension) {
	if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") return false;
	const brands = new Set();
	for (let offset = 8; offset + 4 <= buffer.length; offset += 4) {
		brands.add(buffer.toString("ascii", offset, offset + 4));
	}
	if (extension === ".avif") return brands.has("avif") || brands.has("avis");
	if (extension === ".mov") return brands.has("qt  ");
	if (extension === ".m4a") return brands.has("M4A ") || brands.has("M4B ");
	if (extension === ".mp4") {
		return [...brands].some((brand) => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|MSNV|3gp[456])$/.test(brand));
	}
	return false;
}

function hasValidMediaSignature(buffer, extension) {
	switch (extension) {
		case ".jpg":
		case ".jpeg": return startsWithBytes(buffer, [0xff, 0xd8, 0xff]);
		case ".png": return startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case ".gif": return buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a";
		case ".webp": return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
		case ".avif":
		case ".m4a":
		case ".mp4":
		case ".mov": return hasIsoBmffBrand(buffer, extension);
		case ".mp3": return buffer.toString("ascii", 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
		case ".aac": return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
		case ".wav": return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
		case ".ogg": return buffer.toString("ascii", 0, 4) === "OggS";
		case ".flac": return buffer.toString("ascii", 0, 4) === "fLaC";
		case ".webm": return startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3]) && buffer.toString("ascii").includes("webm");
		default: return false;
	}
}

async function validateMediaFile(file, kind, extension, mimeType) {
	if (!mimeMatchesExtension(mimeType, extension)) {
		throw new StudioError("Declared MIME type does not match the file extension", 415, "MEDIA_MIME_INVALID");
	}
	const handle = await open(file, "r");
	const header = Buffer.alloc(8192);
	let bytesRead = 0;
	try {
		({ bytesRead } = await handle.read(header, 0, header.length, 0));
	} finally {
		await handle.close();
	}
	const bytes = header.subarray(0, bytesRead);
	if (!hasValidMediaSignature(bytes, extension)) {
		throw new StudioError("File header does not match the selected media type", 415, "MEDIA_SIGNATURE_INVALID");
	}
	return { kind, extension };
}

async function hashFile(file) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

async function safeRemove(file) {
	await rm(file, { force: true, recursive: false }).catch(() => {});
}

async function cleanupStaleMediaTemps() {
	const tempRoot = await ensureSafeDirectoryWithin(root, mediaTempRoot, { allowHidden: true });
	const now = Date.now();
	for (const entry of await readdir(tempRoot.directory, { withFileTypes: true })) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".part")) continue;
		const file = path.join(tempRoot.directory, entry.name);
		const info = await stat(file).catch(() => null);
		if (info && now - info.mtimeMs > MEDIA_TEMP_MAX_AGE_MS) await safeRemove(file);
	}
}

function requiredStudioOrigin() {
	return `http://127.0.0.1:${port}`;
}

function assertStudioWriteRequest(req) {
	const expectedHost = `127.0.0.1:${port}`;
	if (String(req.headers.host || "").toLowerCase() !== expectedHost) {
		throw new StudioError("Invalid Studio host", 403, "STUDIO_HOST_INVALID");
	}
	if (String(req.headers.origin || "") !== requiredStudioOrigin()) {
		throw new StudioError("Studio write requests must originate from this local Studio", 403, "STUDIO_ORIGIN_INVALID");
	}
	if (String(req.headers["x-studio-session"] || "") !== STUDIO_SESSION_TOKEN) {
		throw new StudioError("Studio session verification failed", 403, "STUDIO_SESSION_INVALID");
	}
}

async function nextAvailableMediaFilename(directory, filename) {
	const extension = path.extname(filename);
	const stem = filename.slice(0, -extension.length);
	for (let index = 1; index < 10000; index += 1) {
		const candidate = index === 1 ? filename : `${stem}-${index}${extension}`;
		if (!(await pathExists(path.join(directory, candidate)))) return candidate;
	}
	throw new StudioError("Could not allocate a non-conflicting media filename", 409, "MEDIA_NAME_CONFLICT");
}

async function receiveMediaUpload(req, kind) {
	const policy = getMediaPolicy(kind);
	if (!policy) throw new StudioError("Unsupported media kind", 400, "MEDIA_KIND_INVALID");
	const declaredLength = Number(req.headers["content-length"] || 0);
	if (Number.isFinite(declaredLength) && declaredLength > policy.maxBytes + MEDIA_UPLOAD_MULTIPART_OVERHEAD) {
		req.resume();
		throw new StudioError("Upload exceeds the allowed size", 413, "MEDIA_TOO_LARGE");
	}
	if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("multipart/form-data")) {
		throw new StudioError("Media upload must use multipart/form-data", 415, "MEDIA_MULTIPART_REQUIRED");
	}
	const tempRoot = await ensureSafeDirectoryWithin(root, mediaTempRoot, { allowHidden: true });
	let tempFile = "";
	let received = null;
	let tooLarge = false;
	let parserError = null;
	let aborted = false;
	let writePromise = Promise.resolve();
	const busboy = Busboy({
		headers: req.headers,
		limits: { files: 1, fileSize: policy.maxBytes, fields: 8, fieldSize: 4096, parts: 12 },
	});
	const complete = new Promise((resolve, reject) => {
		busboy.on("file", (fieldName, stream, info) => {
			if (fieldName !== "file" || received) {
				stream.resume();
				parserError ||= new StudioError("Upload must include exactly one file field", 400, "MEDIA_FILE_FIELD_INVALID");
				return;
			}
			tempFile = path.join(tempRoot.directory, `${randomUUID()}.part`);
			received = { filename: info.filename, mimeType: info.mimeType };
			stream.on("limit", () => { tooLarge = true; });
			writePromise = pipeline(stream, createWriteStream(tempFile, { flags: "wx" }));
			writePromise.catch((error) => { parserError ||= error; });
		});
		busboy.on("filesLimit", () => { parserError ||= new StudioError("Only one file may be uploaded at a time", 400, "MEDIA_FILE_COUNT_INVALID"); });
		busboy.on("partsLimit", () => { parserError ||= new StudioError("Upload has too many multipart parts", 400, "MEDIA_MULTIPART_INVALID"); });
		busboy.on("error", (error) => reject(error));
		busboy.on("finish", resolve);
		req.on("aborted", () => { aborted = true; reject(new StudioError("Upload was cancelled", 499, "MEDIA_UPLOAD_ABORTED")); });
	});
	try {
		req.pipe(busboy);
		await complete;
		await writePromise;
		if (aborted) throw new StudioError("Upload was cancelled", 499, "MEDIA_UPLOAD_ABORTED");
		if (parserError) throw parserError;
		if (tooLarge) throw new StudioError("Upload exceeds the allowed size", 413, "MEDIA_TOO_LARGE");
		if (!received || !tempFile) throw new StudioError("No media file was received", 400, "MEDIA_FILE_REQUIRED");
		const info = await stat(tempFile);
		if (info.size > policy.maxBytes) throw new StudioError("Upload exceeds the allowed size", 413, "MEDIA_TOO_LARGE");
		const filename = normalizeUploadFilename(received.filename, policy);
		const extension = path.extname(filename).toLowerCase();
		await validateMediaFile(tempFile, kind, extension, received.mimeType);
		const destinationRoot = await getSafeWritableMediaRoot(kind);
		const storedFilename = await nextAvailableMediaFilename(destinationRoot.mediaRoot, filename);
		const destination = path.join(destinationRoot.mediaRoot, storedFilename);
		await rename(tempFile, destination);
		tempFile = "";
		return {
			ok: true,
			item: {
				kind,
				name: storedFilename,
				publicPath: `${policy.publicPrefix}${storedFilename}`,
				relativePath: storedFilename,
				size: info.size,
				modifiedAt: (await stat(destination)).mtime.toISOString(),
			},
		};
	} finally {
		if (tempFile) await safeRemove(tempFile);
	}
}

function safeTrashId(value) {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : "";
}

function validateMediaTrashManifest(value) {
	if (!isRecord(value) || value.version !== 1 || !safeTrashId(value.id)) {
		throw new StudioError("Media trash manifest is invalid", 422, "MEDIA_TRASH_MANIFEST_INVALID");
	}
	const parsed = normalizeMediaPublicPath(value.originalPublicPath);
	const policy = parsed && getMediaPolicy(value.kind);
	if (!parsed || !policy || parsed.kind !== value.kind || typeof value.originalFilename !== "string" || typeof value.storedFilename !== "string") {
		throw new StudioError("Media trash manifest is invalid", 422, "MEDIA_TRASH_MANIFEST_INVALID");
	}
	const safeName = normalizeUploadFilename(value.storedFilename, policy);
	if (safeName !== value.storedFilename || path.basename(parsed.relativePath) !== value.originalFilename) {
		throw new StudioError("Media trash manifest is invalid", 422, "MEDIA_TRASH_MANIFEST_INVALID");
	}
	if (!Number.isSafeInteger(value.size) || value.size < 0 || !/^[a-f0-9]{64}$/i.test(String(value.sha256 || ""))) {
		throw new StudioError("Media trash manifest is invalid", 422, "MEDIA_TRASH_MANIFEST_INVALID");
	}
	return { ...value, parsed, policy };
}

async function readMediaTrashItem(id) {
	const safeId = safeTrashId(id);
	if (!safeId) throw new StudioError("Media trash item is invalid", 400, "MEDIA_TRASH_ID_INVALID");
	const trashRoot = await ensureSafeDirectoryWithin(root, trashMediaRoot, { allowHidden: true });
	const itemDir = path.join(trashRoot.directory, safeId);
	const itemInfo = await lstat(itemDir).catch(() => null);
	if (!itemInfo?.isDirectory() || itemInfo.isSymbolicLink()) {
		throw new StudioError("Media trash item was not found", 404, "MEDIA_TRASH_NOT_FOUND");
	}
	await assertNoSymlinksWithin(trashRoot.directory, itemDir);
	const manifestPath = path.join(itemDir, "manifest.json");
	const manifestInfo = await lstat(manifestPath).catch(() => null);
	if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
		throw new StudioError("Media trash manifest is invalid", 422, "MEDIA_TRASH_MANIFEST_INVALID");
	}
	const manifest = validateMediaTrashManifest(JSON.parse(await readFile(manifestPath, "utf8")));
	const mediaFile = path.join(itemDir, manifest.storedFilename);
	const mediaInfo = await lstat(mediaFile).catch(() => null);
	if (!mediaInfo?.isFile() || mediaInfo.isSymbolicLink()) {
		throw new StudioError("Media trash file is missing", 422, "MEDIA_TRASH_FILE_MISSING");
	}
	await assertNoSymlinksWithin(itemDir, mediaFile);
	return { id: safeId, itemDir, manifestPath, manifest, mediaFile, mediaInfo };
}

function mediaTrashSummary(item) {
	return {
		id: item.id,
		kind: item.manifest.kind,
		name: item.manifest.originalFilename,
		originalPublicPath: item.manifest.originalPublicPath,
		deletedAt: item.manifest.deletedAt,
		size: item.manifest.size,
		references: Array.isArray(item.manifest.detectedReferences) ? item.manifest.detectedReferences : [],
	};
}

async function listMediaTrash() {
	const trashRoot = await ensureSafeDirectoryWithin(root, trashMediaRoot, { allowHidden: true });
	const items = [];
	const errors = [];
	for (const entry of await readdir(trashRoot.directory, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || !safeTrashId(entry.name)) continue;
		try {
			items.push(mediaTrashSummary(await readMediaTrashItem(entry.name)));
		} catch (error) {
			errors.push({ id: entry.name, error: "Trash item could not be read safely" });
		}
	}
	items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)) || a.id.localeCompare(b.id));
	return { ok: true, items, errors };
}

async function moveMediaToTrash(input) {
	const media = await getSafeMediaFile(input?.path);
	if (!media.exists) throw new StudioError("Media file was not found", 404, "MEDIA_NOT_FOUND");
	const referencesPayload = await findMediaReferences(media.publicPath);
	const references = referencesPayload.references || [];
	if (references.length && input?.confirmReferenced !== true) {
		throw new StudioError(
			"This media file is still referenced and needs a second confirmation before moving to trash",
			409,
			"MEDIA_REFERENCED",
			{ path: media.publicPath, references },
		);
	}
	const trashRoot = await ensureSafeDirectoryWithin(root, trashMediaRoot, { allowHidden: true });
	const id = randomUUID();
	const stagingDir = path.join(trashRoot.directory, `staging-${id}`);
	const finalDir = path.join(trashRoot.directory, id);
	await mkdir(stagingDir, { recursive: false });
	let moved = false;
	try {
		const sha256 = await hashFile(media.file);
		const manifest = {
			version: 1,
			id,
			originalPublicPath: media.publicPath,
			kind: media.kind,
			originalFilename: path.basename(media.relativePath),
			storedFilename: path.basename(media.relativePath),
			deletedAt: new Date().toISOString(),
			size: media.info.size,
			sha256,
			detectedReferences: references,
		};
		validateMediaTrashManifest(manifest);
		await atomicWriteFile(path.join(stagingDir, "manifest.pending.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		const stagedFile = path.join(stagingDir, manifest.storedFilename);
		await rename(media.file, stagedFile);
		moved = true;
		await atomicWriteFile(path.join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await safeRemove(path.join(stagingDir, "manifest.pending.json"));
		await rename(stagingDir, finalDir);
		return { ok: true, item: mediaTrashSummary({ id, manifest }) };
	} catch (error) {
		if (moved) {
			const stagedFile = path.join(stagingDir, path.basename(media.relativePath));
			if (await pathExists(stagedFile)) await rename(stagedFile, media.file).catch(() => {});
		}
		await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function restoreFilenameFromInput(value, policy, originalFilename) {
	if (value === undefined || value === null || value === "") return originalFilename;
	const filename = normalizeUploadFilename(String(value), policy);
	if (path.extname(filename).toLowerCase() !== path.extname(originalFilename).toLowerCase()) {
		throw new StudioError("Restored filename must keep the original extension", 400, "MEDIA_RESTORE_NAME_INVALID");
	}
	return filename;
}

async function restoreMediaFromTrash(input) {
	const item = await readMediaTrashItem(input?.id);
	const manifest = item.manifest;
	const actualHash = await hashFile(item.mediaFile);
	if (actualHash !== manifest.sha256) {
		throw new StudioError("Media trash file failed integrity verification", 422, "MEDIA_TRASH_HASH_MISMATCH");
	}
	await validateMediaFile(item.mediaFile, manifest.kind, path.extname(manifest.storedFilename).toLowerCase(), "");
	const destinationRoot = await getSafeWritableMediaRoot(manifest.kind);
	const filename = restoreFilenameFromInput(input?.filename, manifest.policy, manifest.originalFilename);
	const relativeDirectory = path.dirname(manifest.parsed.relativePath);
	const destinationDirectory = relativeDirectory === "."
		? destinationRoot.mediaRoot
		: (await ensureSafeDirectoryWithin(destinationRoot.mediaRoot, path.join(destinationRoot.mediaRoot, relativeDirectory))).directory;
	const destination = path.join(destinationDirectory, filename);
	if (await pathExists(destination)) {
		const suggested = await nextAvailableMediaFilename(destinationRoot.mediaRoot, filename);
		throw new StudioError(
			"A media file already exists at the original location",
			409,
			"MEDIA_RESTORE_CONFLICT",
			{ suggestedFilename: suggested, originalFilename: filename },
		);
	}
	await rename(item.mediaFile, destination);
	try {
		await rm(item.itemDir, { recursive: true, force: true });
	} catch (error) {
		await rename(destination, item.mediaFile).catch(() => {});
		throw new StudioError("Media was not restored because trash cleanup failed", 500, "MEDIA_RESTORE_FAILED");
	}
	return {
		ok: true,
		item: {
			kind: manifest.kind,
			name: filename,
			publicPath: `${manifest.policy.publicPrefix}${relativeDirectory === "." ? "" : `${relativeDirectory.replace(/\\/g, "/")}/`}${filename}`,
			relativePath: relativeDirectory === "." ? filename : `${relativeDirectory.replace(/\\/g, "/")}/${filename}`,
			size: manifest.size,
			modifiedAt: (await stat(destination)).mtime.toISOString(),
		},
	};
}

function slugify(value) {
	const slug = stringValue(value)
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "post";
}

function yamlString(value) {
	return JSON.stringify(stringValue(value));
}

function frontmatterValue(frontmatter, key) {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1].replace(/^["']|["']$/g, "").trim() : "";
}

function tagsFromFrontmatter(frontmatter) {
	const inline = frontmatter.match(/^tags:\s*\[(.*)\]\s*$/m);
	if (inline) {
		return inline[1]
			.split(",")
			.map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	const block = frontmatter.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
	if (!block) return [];
	return block[1]
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*-\s*/, "").trim())
		.map((tag) => tag.replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function splitPost(text) {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { frontmatter: "", body: text };
	return {
		frontmatter: match[1],
		body: text.slice(match[0].length),
	};
}

function frontmatterBoolean(frontmatter, key, fallback) {
	const value = frontmatterValue(frontmatter, key).toLowerCase();
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function slugFromPostPath(postPath) {
	return String(postPath)
		.replace(/\\/g, "/")
		.replace(/\/(?:index)\.(?:md|mdx)$/i, "")
		.replace(/\.(?:md|mdx)$/i, "")
		.replace(/^\/+|\/+$/g, "");
}

function postMetaFromText(file, text) {
	const { frontmatter, body } = splitPost(text);
	const postPath = path.relative(postsRoot, file).replace(/\\/g, "/");
	const image = frontmatterValue(frontmatter, "image");
	return {
		path: postPath,
		slug: slugFromPostPath(postPath),
		title: frontmatterValue(frontmatter, "title") || path.basename(file),
		published:
			frontmatterValue(frontmatter, "published") ||
			frontmatterValue(frontmatter, "date") ||
			frontmatterValue(frontmatter, "pubDate"),
		description: frontmatterValue(frontmatter, "description"),
		image,
		cover: image,
		category: frontmatterValue(frontmatter, "category"),
		tags: tagsFromFrontmatter(frontmatter),
		draft: frontmatterBoolean(frontmatter, "draft", false),
		comment: frontmatterBoolean(frontmatter, "comment", true),
		pinned: frontmatterBoolean(frontmatter, "pinned", false),
		updated: frontmatterValue(frontmatter, "updated"),
		frontmatter,
		body,
	};
}

function resolvePostPath(postPath) {
	const relative = stringValue(postPath).replace(/\\/g, "/");
	if (!relative || relative.includes("\0")) throw new Error("文章路径不正确");
	const fullPath = path.resolve(postsRoot, relative);
	const safeRelative = path.relative(postsRoot, fullPath);
	if (
		safeRelative.startsWith("..") ||
		path.isAbsolute(safeRelative) ||
		!/\.(md|mdx)$/i.test(fullPath)
	) {
		throw new Error("文章路径不正确");
	}
	return fullPath;
}

async function pathExists(file) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

function sanitizeFileName(value) {
	return stringValue(value, "image")
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60) || "image";
}

function imageDestination(target) {
	if (target === "avatar") {
		return { dir: srcImagesRoot, prefix: "assets/images", scope: "src" };
	}
	if (target === "desktop") {
		return {
			dir: path.join(srcImagesRoot, "StudioWallpaper", "desktop"),
			prefix: "assets/images/StudioWallpaper/desktop",
			scope: "src",
		};
	}
	if (target === "mobile") {
		return {
			dir: path.join(srcImagesRoot, "StudioWallpaper", "mobile"),
			prefix: "assets/images/StudioWallpaper/mobile",
			scope: "src",
		};
	}
	if (target === "article") {
		return {
			dir: publicPostImagesRoot,
			prefix: "/assets/images/posts",
			scope: "public",
		};
	}
	return { dir: publicImagesRoot, prefix: "/assets/images", scope: "public" };
}

function imagePreviewUrl(imagePath) {
	return `/api/image-file?path=${encodeURIComponent(imagePath)}`;
}

function resolveImageFile(imagePath) {
	const clean = stringValue(imagePath).replace(/\\/g, "/");
	if (!clean || clean.startsWith("http")) {
		throw new Error("图片路径不正确");
	}
	const ext = path.extname(clean).toLowerCase();
	if (!imageExtensions.has(ext)) throw new Error("这个文件不是支持的图片格式");
	let fullPath;
	if (clean.startsWith("/")) {
		const relative = clean.replace(/^\/+/, "");
		fullPath = path.resolve(root, "public", relative);
		const safeRelative = path.relative(publicImagesRoot, fullPath);
		if (safeRelative.startsWith("..") || path.isAbsolute(safeRelative)) {
			throw new Error("只能预览 public/assets/images 里的图片");
		}
	} else {
		fullPath = path.resolve(root, "src", clean);
		const safeRelative = path.relative(srcImagesRoot, fullPath);
		if (safeRelative.startsWith("..") || path.isAbsolute(safeRelative)) {
			throw new Error("只能预览 src/assets/images 里的图片");
		}
	}
	return { fullPath, ext };
}

async function collectImages(baseDir, prefix, scope, list = []) {
	if (!(await pathExists(baseDir))) return list;
	for (const entry of await readdir(baseDir, { withFileTypes: true })) {
		const fullPath = path.join(baseDir, entry.name);
		const nextPrefix = `${prefix}/${entry.name}`.replace(/\\/g, "/");
		if (entry.isDirectory()) {
			await collectImages(fullPath, nextPrefix, scope, list);
			continue;
		}
		const ext = path.extname(entry.name).toLowerCase();
		if (!imageExtensions.has(ext)) continue;
		const info = await stat(fullPath);
		const imagePath = scope === "public" ? `/${nextPrefix}` : nextPrefix;
		list.push({
			name: entry.name,
			path: imagePath,
			scope,
			size: info.size,
			previewUrl: imagePreviewUrl(imagePath),
		});
	}
	return list;
}

async function listImages() {
	const images = [
		...(await collectImages(srcImagesRoot, "assets/images", "src")),
		...(await collectImages(publicImagesRoot, "assets/images", "public")),
	];
	return images.sort((a, b) => a.path.localeCompare(b.path));
}

async function uploadImage(input) {
	const target = choiceValue(
		input?.target,
		["avatar", "desktop", "mobile", "article", "public"],
		"public",
	);
	const dataUrl = stringValue(input?.dataUrl);
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) throw new Error("没有读到图片内容");
	const filename = stringValue(input?.filename, "image.png");
	const ext = path.extname(filename).toLowerCase();
	if (!imageExtensions.has(ext)) {
		throw new Error("只支持 png、jpg、webp、avif、gif、svg 图片");
	}
	const { dir, prefix, scope } = imageDestination(target);
	await mkdir(dir, { recursive: true });
	const name = `${sanitizeFileName(filename)}-${Date.now()}${ext}`;
	const file = path.join(dir, name);
	await writeFile(file, Buffer.from(match[2], "base64"));
	const imagePath = `${prefix}/${name}`.replace(/\\/g, "/");
	return {
		name,
		path: imagePath,
		scope,
		previewUrl: imagePreviewUrl(imagePath),
	};
}

async function uniquePostFile(rawSlug) {
	const baseSlug = slugify(rawSlug);
	for (let index = 0; index < 100; index += 1) {
		const suffix = index === 0 ? "" : `-${index + 1}`;
		const slug = `${baseSlug}${suffix}`;
		const dir = path.join(postsRoot, slug);
		const file = path.join(dir, "index.md");
		if (!(await pathExists(dir)) && !(await pathExists(file))) {
			return { slug, dir, file };
		}
	}
	throw new Error("文章地址重复太多次了，换个标题试试");
}

function tagsFromInput(input, fallback = []) {
	if (Array.isArray(input?.tags)) {
		return input.tags.map((tag) => stringValue(tag)).filter(Boolean);
	}
	const text = typeof input?.tags === "string" ? input.tags : "";
	if (!text.trim()) return fallback;
	return text
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function postContent(input, existing = {}) {
	const title = stringValue(input?.title, existing.title || "新的文章");
	const date = stringValue(
		input?.published,
		existing.published || new Date().toISOString().slice(0, 10),
	);
	const category = stringValue(input?.category, existing.category || "日常");
	const description = stringValue(input?.description, existing.description || "");
	const image = stringValue(input?.image, existing.image || "");
	const tags = tagsFromInput(input, existing.tags || []);
	const body = stringValue(input?.body, existing.body || "从这里开始写。");
	return `---\ntitle: ${yamlString(title)}\npublished: ${date}\ndescription: ${yamlString(description)}\nimage: ${yamlString(image)}\ntags: [${tags.map(yamlString).join(", ")}]\ncategory: ${yamlString(category)}\ndraft: false\ncomment: true\nlang: zh-CN\n---\n\n${body}\n`;
}

function hasOwn(input, key) {
	return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
}

function dateString(value) {
	const date = stringValue(value);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
	const [year, month, day] = date.split("-").map(Number);
	const candidate = new Date(Date.UTC(year, month - 1, day));
	return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day
		? date
		: "";
}

function timestampWithOffset(value) {
	const timestamp = stringValue(value);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(timestamp)) return "";
	const candidate = new Date(timestamp);
	if (Number.isNaN(candidate.getTime())) return "";
	const parts = shanghaiDateParts(candidate);
	const normalized = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
	return normalized === timestamp ? timestamp : "";
}

function articleTimestamp(value) {
	return dateString(value) || timestampWithOffset(value);
}

function shanghaiDateParts(date) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type) => parts.find((part) => part.type === type)?.value || "";
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
	};
}

function currentShanghaiTimestamp(now = new Date()) {
	const parts = shanghaiDateParts(now);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

function timestampHasTime(value) {
	return Boolean(timestampWithOffset(value));
}

function comparableArticleTime(value) {
	const normalized = articleTimestamp(value);
	if (!normalized) return Number.NEGATIVE_INFINITY;
	if (timestampHasTime(normalized)) return new Date(normalized).getTime();
	return new Date(`${normalized}T00:00:00+08:00`).getTime();
}

function compareStudioPosts(a, b) {
	if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
	const published = comparableArticleTime(b.published) - comparableArticleTime(a.published);
	if (published !== 0) return published;
	const updated = comparableArticleTime(b.updated || b.published) - comparableArticleTime(a.updated || a.published);
	if (updated !== 0) return updated;
	return String(a.slug || "").localeCompare(String(b.slug || ""), "zh-CN");
}

function booleanInput(value, key) {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	throw new StudioError(`${key} must be true or false`);
}

function fieldLines(key, value) {
	if (key === "tags") return [`tags: [${value.map(yamlString).join(", ")}]`];
	if (["draft", "pinned", "comment"].includes(key)) return [`${key}: ${value ? "true" : "false"}`];
	if (["published", "updated"].includes(key)) {
		return [`${key}: ${timestampHasTime(value) ? yamlString(value) : value}`];
	}
	return [`${key}: ${yamlString(value)}`];
}

function upsertFrontmatterField(frontmatter, key, replacement) {
	const lines = frontmatter ? frontmatter.split(/\r?\n/) : [];
	const fieldPattern = new RegExp(`^${key}:\\s*(?:.*)?$`);
	const start = lines.findIndex((line) => fieldPattern.test(line));
	if (start === -1) return [...lines, ...replacement].join("\n").replace(/^\n+/, "");
	let end = start + 1;
	while (end < lines.length && (/^\s+/.test(lines[end]) || /^\s*-\s+/.test(lines[end]))) end += 1;
	lines.splice(start, end - start, ...replacement);
	return lines.join("\n");
}

function validateFrontmatter(frontmatter) {
	if (!frontmatter.trim() || frontmatter.includes("\n---")) {
		throw new StudioError("Invalid frontmatter format");
	}
	const keys = new Set();
	for (const line of frontmatter.split(/\r?\n/)) {
		if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;
		const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)/);
		if (!match || keys.has(match[1])) throw new StudioError("Invalid frontmatter format");
		keys.add(match[1]);
	}
	if (!frontmatterValue(frontmatter, "title") || !articleTimestamp(frontmatterValue(frontmatter, "published"))) {
		throw new StudioError("Frontmatter requires a title and a valid published timestamp");
	}
	for (const key of ["draft", "pinned", "comment"]) {
		const value = frontmatterValue(frontmatter, key);
		if (value && value !== "true" && value !== "false") {
			throw new StudioError(`${key} must be true or false`);
		}
	}
}

function buildPostContent(frontmatter, body) {
	validateFrontmatter(frontmatter);
	return `---\n${frontmatter.trim()}\n---\n\n${body || ""}\n`;
}

function defaultFrontmatter(input) {
	const title = stringValue(input?.title, "New article");
	if (!title) throw new StudioError("Article title is required");
	const savedAt = currentShanghaiTimestamp();
	const published = hasOwn(input, "published") ? articleTimestamp(input.published) : savedAt;
	if (!published) throw new StudioError("published must use YYYY-MM-DD or a +08:00 ISO timestamp");
	const values = [
		["title", title],
		["published", published],
		["updated", savedAt],
		["draft", hasOwn(input, "draft") ? booleanInput(input.draft, "draft") : true],
		["category", stringValue(input?.category, "Daily")],
		["tags", hasOwn(input, "tags") ? tagsFromInput(input, []) : []],
		["description", stringValue(input?.description)],
		["image", articleImagePath(input?.image || input?.cover)],
		["pinned", hasOwn(input, "pinned") ? booleanInput(input.pinned, "pinned") : false],
		["comment", hasOwn(input, "comment") ? booleanInput(input.comment, "comment") : true],
		["lang", "zh-CN"],
	];
	return values.reduce(
		(frontmatter, [key, value]) => upsertFrontmatterField(frontmatter, key, fieldLines(key, value)),
		"",
	);
}

function updatedFrontmatter(existing, input, savedAt = currentShanghaiTimestamp()) {
	let frontmatter = existing.frontmatter;
	validateFrontmatter(frontmatter);
	const editable = ["title", "published", "draft", "category", "tags", "description", "image", "pinned", "comment"];
	for (const key of editable) {
		const inputKey = key === "image" && !hasOwn(input, key) && hasOwn(input, "cover") ? "cover" : key;
		if (!hasOwn(input, inputKey)) continue;
		let value = input[inputKey];
		if (key === "title") {
			value = stringValue(value);
			if (!value) throw new StudioError("Article title is required");
		} else if (key === "published") {
			value = articleTimestamp(value);
			if (!value) throw new StudioError("published must use YYYY-MM-DD or a +08:00 ISO timestamp");
		} else if (["draft", "pinned", "comment"].includes(key)) {
			value = booleanInput(value, key);
		} else if (key === "tags") {
			value = tagsFromInput({ tags: value }, []);
		} else if (key === "image") {
			value = articleImagePath(value);
		} else {
			value = stringValue(value);
		}
		frontmatter = upsertFrontmatterField(frontmatter, key, fieldLines(key, value));
	}
	return upsertFrontmatterField(frontmatter, "updated", fieldLines("updated", savedAt));
}

async function atomicWriteFile(file, content) {
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	const backup = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.bak`);
	let movedOriginal = false;
	try {
		await writeFile(temp, content, "utf8");
		if (await pathExists(file)) {
			await rename(file, backup);
			movedOriginal = true;
		}
		await rename(temp, file);
		if (movedOriginal) await rm(backup, { force: true });
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		if (movedOriginal && !(await pathExists(file)) && (await pathExists(backup))) {
			await rename(backup, file).catch(() => {});
		}
		throw new StudioError(`Could not save article safely: ${error.message}`, 500);
	}
}

async function walkPosts(dir = postsRoot, list = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkPosts(fullPath, list);
		} else if (/\.(md|mdx)$/i.test(entry.name)) {
			list.push(fullPath);
		}
	}
	return list;
}

async function listPosts() {
	const files = await walkPosts();
	const posts = [];
	for (const file of files) {
		const meta = postMetaFromText(file, await readFile(file, "utf8"));
		delete meta.body;
		delete meta.frontmatter;
		posts.push(meta);
	}
	return posts.sort(compareStudioPosts);
}

async function readPost(postPath) {
	const file = resolvePostPath(postPath);
	return postMetaFromText(file, await readFile(file, "utf8"));
}

async function createPost(input) {
	const title = stringValue(input?.title, "新的文章");
	const { slug, dir, file } = await uniquePostFile(input?.slug || title);
	await mkdir(dir, { recursive: false });
	await writeFile(file, postContent({ ...input, title }), "utf8");
	return { slug, file: path.relative(root, file).replace(/\\/g, "/") };
}

async function updatePost(postPath, input) {
	const file = resolvePostPath(postPath);
	const existing = await readPost(postPath);
	await writeFile(file, postContent(input, existing), "utf8");
	return readPost(postPath);
}

async function deletePost(postPath) {
	const file = resolvePostPath(postPath);
	const relative = path.relative(postsRoot, file).replace(/\\/g, "/");
	const trashRoot = path.join(root, ".studio-trash", "posts");
	await mkdir(trashRoot, { recursive: true });
	const safeName = relative.replace(/[\\/:"*?<>|]+/g, "__");
	const target = path.join(trashRoot, `${Date.now()}-${safeName}`);
	await rename(file, target);
	return {
		path: relative,
		trashedTo: path.relative(root, target).replace(/\\/g, "/"),
	};
}

function resolveStudioPostPath(postPath) {
	const relative = stringValue(postPath).replace(/\\/g, "/");
	if (!relative || relative.includes("\0")) throw new StudioError("Invalid article path");
	const fullPath = path.resolve(postsRoot, relative);
	const safeRelative = path.relative(postsRoot, fullPath);
	if (
		safeRelative.startsWith("..") ||
		path.isAbsolute(safeRelative) ||
		!/\.(md|mdx)$/i.test(fullPath)
	) {
		throw new StudioError("Invalid article path");
	}
	return fullPath;
}

async function safeReadPost(postPath) {
	const file = resolveStudioPostPath(postPath);
	if (!(await pathExists(file))) throw new StudioError("Article not found", 404);
	return postMetaFromText(file, await readFile(file, "utf8"));
}

function requestedSlug(input) {
	if (!hasOwn(input, "slug")) return null;
	const slug = stringValue(input.slug);
	if (!slug || slug !== slugify(slug) || slug.includes("/")) {
		throw new StudioError("Invalid article slug");
	}
	return slug;
}

async function safeCreatePost(input) {
	const title = stringValue(input?.title, "New article");
	if (!title) throw new StudioError("Article title is required");
	const { slug, dir, file } = await uniquePostFile(requestedSlug(input) || title);
	const frontmatter = defaultFrontmatter({ ...input, title });
	const content = buildPostContent(frontmatter, hasOwn(input, "body") ? stringValue(input.body) : "");
	let created = false;
	try {
		await mkdir(dir, { recursive: false });
		created = true;
		await atomicWriteFile(file, content);
	} catch (error) {
		if (created) await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
	return { slug, file: path.relative(root, file).replace(/\\/g, "/") };
}

async function moveUpdatedPost(file, content, nextSlug) {
	const oldDir = path.dirname(file);
	const oldSlug = path.basename(oldDir);
	if (!nextSlug || nextSlug === oldSlug) {
		await atomicWriteFile(file, content);
		return file;
	}
	if (path.basename(file) !== "index.md") {
		throw new StudioError("Only folder-based articles can change slug");
	}
	const nextDir = path.join(postsRoot, nextSlug);
	if (await pathExists(nextDir)) throw new StudioError("Article slug already exists", 409);
	try {
		await rename(oldDir, nextDir);
		await atomicWriteFile(path.join(nextDir, "index.md"), content);
		return path.join(nextDir, "index.md");
	} catch (error) {
		if (await pathExists(nextDir)) await rename(nextDir, oldDir).catch(() => {});
		throw new StudioError(`Could not save article safely: ${error.message}`, 500);
	}
}

async function safeUpdatePost(postPath, input) {
	const existing = await safeReadPost(postPath);
	const nextFrontmatter = updatedFrontmatter(existing, input || {});
	const nextBody = hasOwn(input, "body") ? stringValue(input.body) : existing.body;
	const nextFile = await moveUpdatedPost(
		resolveStudioPostPath(postPath),
		buildPostContent(nextFrontmatter, nextBody),
		requestedSlug(input),
	);
	return postMetaFromText(nextFile, await readFile(nextFile, "utf8"));
}

function relativeResourcePath(reference) {
	const raw = String(reference || "").trim().replace(/^<|>$/g, "");
	if (!raw || raw.startsWith("#") || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
		return null;
	}
	const withoutQuery = raw.split(/[?#]/, 1)[0];
	let decoded;
	try {
		decoded = decodeURIComponent(withoutQuery);
	} catch {
		throw new StudioError(`Copy blocked: invalid relative resource path "${raw}"`);
	}
	const normalized = decoded.replace(/\\/g, "/");
	if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new StudioError(`Copy blocked: relative resource "${raw}" leaves the article directory`);
	}
	const extension = path.extname(normalized).toLowerCase();
	if (!extension || [".md", ".mdx", ".html", ".htm"].includes(extension)) return null;
	if (!copyablePostResourceExtensions.has(extension)) {
		throw new StudioError(`Copy blocked: relative resource "${raw}" has an unsupported file type`);
	}
	return normalized;
}

function referencedRelativeResources(body) {
	const resources = new Set();
	const add = (reference) => {
		const normalized = relativeResourcePath(reference);
		if (normalized) resources.add(normalized);
	};
	for (const match of String(body || "").matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) {
		add(match[1] || match[2]);
	}
	for (const match of String(body || "").matchAll(/<(?:img|audio|video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
		add(match[1]);
	}
	return [...resources];
}

async function copyReferencedPostResources(sourceDir, destinationDir, body) {
	const resources = referencedRelativeResources(body);
	for (const resource of resources) {
		const source = path.resolve(sourceDir, resource);
		const destination = path.resolve(destinationDir, resource);
		const sourceRelative = path.relative(sourceDir, source);
		const destinationRelative = path.relative(destinationDir, destination);
		if (
			sourceRelative.startsWith("..") ||
			path.isAbsolute(sourceRelative) ||
			destinationRelative.startsWith("..") ||
			path.isAbsolute(destinationRelative)
		) {
			throw new StudioError(`Copy blocked: relative resource "${resource}" is unsafe`);
		}
		if (!(await pathExists(source))) {
			throw new StudioError(`Copy blocked: relative resource "${resource}" was not found`);
		}
		const info = await lstat(source);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new StudioError(`Copy blocked: relative resource "${resource}" is not a regular file`);
		}
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(source, destination);
	}
	return resources;
}

async function copyPost(input) {
	const sourcePath = stringValue(input?.path);
	const sourceFile = resolveStudioPostPath(sourcePath);
	const sourcePost = await safeReadPost(sourcePath);
	const { slug, dir, file } = await uniquePostFile(`${sourcePost.slug || "post"}-copy`);
	const title = `${sourcePost.title} 副本`;
	const copiedAt = currentShanghaiTimestamp();
	const frontmatter = updatedFrontmatter(sourcePost, {
		title,
		draft: true,
		published: copiedAt,
	}, copiedAt);
	const content = buildPostContent(frontmatter, sourcePost.body);
	let created = false;
	try {
		await mkdir(dir, { recursive: false });
		created = true;
		const copiedResources = await copyReferencedPostResources(path.dirname(sourceFile), dir, sourcePost.body);
		await atomicWriteFile(file, content);
		return {
			title,
			slug,
			path: path.relative(postsRoot, file).replace(/\\/g, "/"),
			copiedResources,
		};
	} catch (error) {
		if (created) await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function trashManifestPath(target) {
	return `${target}.json`;
}

function trashName(value) {
	return stringValue(value).replace(/\\/g, "/");
}

function resolveTrashTarget(value) {
	const name = trashName(value);
	if (!name || name.includes("/") || name.includes("\0")) {
		throw new StudioError("Invalid trash item");
	}
	const target = path.resolve(trashPostsRoot, name);
	if (path.relative(trashPostsRoot, target).startsWith("..")) {
		throw new StudioError("Invalid trash item");
	}
	return target;
}

async function safeDeletePost(postPath) {
	const file = resolveStudioPostPath(postPath);
	if (!(await pathExists(file))) throw new StudioError("Article not found", 404);
	const post = postMetaFromText(file, await readFile(file, "utf8"));
	const relative = path.relative(postsRoot, file).replace(/\\/g, "/");
	const directory = path.dirname(file);
	const isArticleDirectory = path.basename(file) === "index.md" && directory !== postsRoot;
	const source = isArticleDirectory ? directory : file;
	const name = `${Date.now()}-${randomUUID()}`;
	const target = path.join(trashPostsRoot, name);
	const manifest = {
		version: 1,
		title: post.title,
		slug: post.slug,
		originalPostPath: relative,
		kind: isArticleDirectory ? "directory" : "file",
		deletedAt: new Date().toISOString(),
	};
	await mkdir(trashPostsRoot, { recursive: true });
	try {
		await rename(source, target);
		await writeFile(trashManifestPath(target), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	} catch (error) {
		if (await pathExists(target)) await rename(target, source).catch(() => {});
		throw new StudioError(`Could not move article to trash: ${error.message}`, 500);
	}
	return {
		path: relative,
		trashPath: name,
		trashedTo: path.relative(root, target).replace(/\\/g, "/"),
	};
}

async function trashItemTitle(target, manifest) {
	if (manifest.title) return manifest.title;
	const file = manifest.kind === "directory" ? path.join(target, "index.md") : target;
	if (!(await pathExists(file))) return "";
	try {
		return frontmatterValue(splitPost(await readFile(file, "utf8")).frontmatter, "title");
	} catch {
		return "";
	}
}

async function listTrashedPosts() {
	if (!(await pathExists(trashPostsRoot))) return [];
	const entries = await readdir(trashPostsRoot, { withFileTypes: true });
	const items = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const manifest = JSON.parse(await readFile(path.join(trashPostsRoot, entry.name), "utf8"));
			const target = path.join(trashPostsRoot, entry.name.slice(0, -5));
			items.push({
				trashPath: entry.name.slice(0, -5),
				...manifest,
				title: await trashItemTitle(target, manifest),
			});
		} catch {
			// Ignore incomplete manifests; their content remains untouched in the trash.
		}
	}
	return items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

async function restorePost(trashPath) {
	const target = resolveTrashTarget(trashPath);
	const manifestFile = trashManifestPath(target);
	if (!(await pathExists(target)) || !(await pathExists(manifestFile))) {
		throw new StudioError("Trash item not found", 404);
	}
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestFile, "utf8"));
	} catch {
		throw new StudioError("Trash item manifest is invalid", 500);
	}
	const originalFile = resolveStudioPostPath(manifest.originalPostPath);
	const destination = manifest.kind === "directory" ? path.dirname(originalFile) : originalFile;
	if (await pathExists(destination)) throw new StudioError("Original article location is occupied", 409);
	await mkdir(path.dirname(destination), { recursive: true });
	try {
		await rename(target, destination);
		await rm(manifestFile, { force: true });
	} catch (error) {
		if (await pathExists(destination)) await rename(destination, target).catch(() => {});
		throw new StudioError(`Could not restore article: ${error.message}`, 500);
	}
	return safeReadPost(manifest.originalPostPath);
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
		if (req.method === "GET" && url.pathname === "/") {
			const html = (await readFile(uiPath, "utf8")).replace("__STUDIO_SESSION_TOKEN__", STUDIO_SESSION_TOKEN);
			send(res, 200, html, {
				"content-type": "text/html; charset=utf-8",
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/studio-editor.js") {
			send(res, 200, await readFile(editorScriptPath, "utf8"), {
				"content-type": "text/javascript; charset=utf-8",
				"cache-control": "no-store",
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/studio-editor.css") {
			send(res, 200, await readFile(editorStylesPath, "utf8"), {
				"content-type": "text/css; charset=utf-8",
				"cache-control": "no-store",
			});
			return;
		}
		if (req.method === "GET" && studioAssets.has(url.pathname)) {
			const [file, contentType] = studioAssets.get(url.pathname);
			send(res, 200, await readFile(file, "utf8"), {
				"content-type": contentType,
				"cache-control": "no-store",
			});
			return;
		}
		if (req.method === "GET" && url.pathname.startsWith("/studio-assets/")) {
			const { fullPath, ext } = await resolvePreviewAsset(url.pathname);
			sendBuffer(
				res,
				200,
				await readFile(fullPath),
				imageContentTypes.get(ext) || "application/octet-stream",
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/settings") {
			send(res, 200, normalizeSettings(await readJson(settingsPath)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/layout") {
			send(res, 200, await getLayoutPayload());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/layout") {
			send(res, 200, await saveLayout(await readContentBody(req)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/pages/about") {
			send(res, 200, await getAboutPage());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/pages/about") {
			send(res, 200, await saveAboutPage(await readContentBody(req)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/content-settings") {
			send(res, 200, await getContentSettings());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/content-settings") {
			send(res, 200, await saveContentSettings(await readContentBody(req)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/media") {
			send(res, 200, await listMedia({
				kind: url.searchParams.get("kind") || "all",
				search: url.searchParams.get("search") || "",
			}));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/media/references") {
			send(res, 200, await findMediaReferences(url.searchParams.get("path")));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/media") {
			assertStudioWriteRequest(req);
			const kind = normalizeMediaKind(url.searchParams.get("kind"), "");
			if (!kind || kind === "all") throw new StudioError("Media kind must be image, audio, or video", 400, "MEDIA_KIND_INVALID");
			send(res, 201, await receiveMediaUpload(req, kind));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/media/trash") {
			send(res, 200, await listMediaTrash());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/media/trash") {
			assertStudioWriteRequest(req);
			send(res, 200, await moveMediaToTrash(await readContentBody(req)));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/media/restore") {
			assertStudioWriteRequest(req);
			send(res, 200, await restoreMediaFromTrash(await readContentBody(req)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/images") {
			send(res, 200, await listImages());
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/image-file") {
			const { fullPath, ext } = resolveImageFile(url.searchParams.get("path"));
			sendBuffer(
				res,
				200,
				await readFile(fullPath),
				imageContentTypes.get(ext) || "application/octet-stream",
			);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/images") {
			send(res, 201, await uploadImage(await readBody(req)));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings") {
			const current = normalizeSettings(await readJson(settingsPath));
			const next = sanitizeSettings(await readBody(req), current);
			await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
			send(res, 200, next);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/posts/trash") {
			send(res, 200, await listTrashedPosts());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/posts/restore") {
			const input = await readBody(req);
			send(res, 200, await restorePost(input?.trashPath));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/posts/copy") {
			send(res, 201, await copyPost(await readBody(req)));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/posts/preview") {
			send(res, 200, await previewMarkdown(await readPreviewBody(req)));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/posts") {
			const postPath = url.searchParams.get("path");
			send(res, 200, postPath ? await safeReadPost(postPath) : await listPosts());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/posts") {
			send(res, 201, await safeCreatePost(await readBody(req)));
			return;
		}
		if (req.method === "PUT" && url.pathname === "/api/posts") {
			send(res, 200, await safeUpdatePost(url.searchParams.get("path"), await readBody(req)));
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/posts") {
			send(res, 200, await safeDeletePost(url.searchParams.get("path")));
			return;
		}
		send(res, 404, { ok: false, code: "NOT_FOUND", error: "Not found" });
	} catch (error) {
		const known = error instanceof StudioError;
		send(res, known ? error.status : 500, {
			ok: false,
			code: known ? error.code : "STUDIO_INTERNAL_ERROR",
			error: known ? error.message : "Studio request failed safely",
			...(known && error.details ? { details: error.details } : {}),
		});
	}
});

cleanupStaleMediaTemps()
	.catch((error) => console.warn("Studio media temp cleanup skipped:", error.message))
	.finally(() => {
		server.listen(port, "127.0.0.1", () => {
			console.log(`Blog Studio: http://127.0.0.1:${port}/`);
			console.log("Keep this window open while editing.");
		});
	});
