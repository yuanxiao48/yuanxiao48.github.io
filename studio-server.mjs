import { createServer } from "node:http";
import {
	access,
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import sanitizeHtml from "sanitize-html";

const root = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(root, "src", "config", "userSettings.json");
const postsRoot = path.join(root, "src", "content", "posts");
const srcImagesRoot = path.join(root, "src", "assets", "images");
const publicImagesRoot = path.join(root, "public", "assets", "images");
const publicAssetsRoot = path.join(root, "public", "assets");
const publicPostImagesRoot = path.join(publicImagesRoot, "posts");
const trashPostsRoot = path.join(root, ".studio-trash", "posts");
const uiPath = path.join(root, "studio-ui.html");
const editorScriptPath = path.join(root, "studio-editor.js");
const editorStylesPath = path.join(root, "studio-editor.css");
const port = Number(process.env.STUDIO_PORT || 4322);
const MAX_PREVIEW_BODY_BYTES = 256 * 1024;

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
	"siteInfo",
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
	[".gif", "image/gif"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".webp", "image/webp"],
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
	constructor(message, status = 400) {
		super(message);
		this.status = status;
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
		],
		allowedAttributes: {
			a: ["href", "rel", "title"],
			code: ["class"],
			img: ["src", "alt", "title", "width", "height", "loading"],
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
		},
		exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
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
	if (!imageExtensions.has(ext)) throw new StudioError("预览只允许读取图片资源");
	const info = await lstat(fullPath).catch(() => null);
	if (!info?.isFile() || info.isSymbolicLink()) throw new StudioError("预览图片不存在", 404);
	return { fullPath, ext };
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
			send(res, 200, await readFile(uiPath, "utf8"), {
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
		send(res, 404, { error: "Not found" });
	} catch (error) {
		send(res, error instanceof StudioError ? error.status : 500, {
			error: error.message || "Studio error",
		});
	}
});

server.listen(port, "127.0.0.1", () => {
	console.log(`Blog Studio: http://127.0.0.1:${port}/`);
	console.log("Keep this window open while editing.");
});
