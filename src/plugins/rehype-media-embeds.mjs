import { h } from "hastscript";
import { visit } from "unist-util-visit";
import {
	EXTERNAL_VIDEO_ALLOW,
	EXTERNAL_VIDEO_REFERRER_POLICY,
	normalizeEmbeddedMediaPath,
	normalizeExternalVideoUrl,
	normalizeVideoPosterPath,
} from "../../shared/media-embed-policy.mjs";

const MEDIA_FIGURE_CLASSES = new Set(["article-media", "article-media-audio", "article-media-video", "article-media-embed"]);

function stringProperty(value) {
	return typeof value === "string" ? value.trim() : "";
}

function classNames(value) {
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
	return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function warning(file, node, message) {
	file.message(`Media directive filtered: ${message}`, node, "rehype-media-embeds");
}

function mediaNotice(message) {
	return h("p", { className: ["article-media-notice"] }, message);
}

function normalizedPreload(value) {
	return stringProperty(value) === "none" ? "none" : "metadata";
}

function captionFrom(properties) {
	return stringProperty(properties?.caption).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function mediaFigure(className, player, caption) {
	const children = [player];
	if (caption) children.push(h("figcaption", caption));
	return h("figure", { className: ["article-media", className] }, children);
}

function localPlayer(node, file) {
	const properties = node.properties || {};
	const kind = node.tagName === "audio" ? "audio" : "video";
	const source = normalizeEmbeddedMediaPath(stringProperty(properties.src), kind);
	if (!source) {
		warning(file, node, `${kind} source is outside the approved directory`);
		return mediaNotice("An unsafe media source was removed.");
	}

	const playerProperties = {
		src: source.publicPath,
		controls: true,
		preload: normalizedPreload(properties.preload),
		"data-pagefind-ignore": true,
	};
	if (kind === "video") {
		playerProperties.playsinline = true;
		const poster = stringProperty(properties.poster);
		if (poster) {
			const normalizedPoster = normalizeVideoPosterPath(poster);
			if (normalizedPoster) playerProperties.poster = normalizedPoster.publicPath;
			else warning(file, node, "video poster is outside /assets/images/posts/");
		}
	}

	return mediaFigure(`article-media-${kind}`, h(kind, playerProperties), captionFrom(properties));
}

function embedPlayer(node, file) {
	const properties = node.properties || {};
	const provider = stringProperty(properties.provider).toLowerCase();
	const id = stringProperty(properties.id);
	const canonicalUrl = stringProperty(properties.canonicalUrl || properties.canonical);
	const normalized = normalizeExternalVideoUrl(canonicalUrl);
	if (!normalized || normalized.provider !== provider || normalized.id !== id) {
		warning(file, node, "embed provider, id, or canonical URL is not approved");
		return mediaNotice("An unsafe external video was removed.");
	}

	const title = stringProperty(properties.title).replace(/[\r\n<>]/g, " ").slice(0, 180)
		|| (provider === "youtube" ? "YouTube video" : "Bilibili video");
	const iframe = h("iframe", {
		src: normalized.embedUrl,
		title,
		loading: "lazy",
		allow: EXTERNAL_VIDEO_ALLOW,
		allowfullscreen: true,
		referrerpolicy: EXTERNAL_VIDEO_REFERRER_POLICY,
	});
	const frame = h("div", { className: ["article-media-frame"], "data-pagefind-ignore": true }, [iframe]);
	return mediaFigure("article-media-embed", frame, captionFrom(properties));
}

function normaliseMediaFigure(node) {
	if (node?.tagName !== "figure") return;
	const classes = classNames(node.properties?.className).filter((name) => MEDIA_FIGURE_CLASSES.has(name));
	if (!classes.length) return;
	node.properties = { className: classes };
}

/**
 * Converts only structured media directives. Raw HTML is intentionally handled
 * earlier by remark-raw-html-policy and never becomes a player node here.
 */
export default function rehypeMediaEmbeds() {
	return (tree, file) => {
		visit(tree, "element", (node, index, parent) => {
			if (node.tagName === "figure") {
				normaliseMediaFigure(node);
				return;
			}
			if (!parent || typeof index !== "number") return;
			if (node.tagName === "audio" || node.tagName === "video") {
				parent.children[index] = localPlayer(node, file);
			}
			if (node.tagName === "embed") parent.children[index] = embedPlayer(node, file);
		});
	};
}
