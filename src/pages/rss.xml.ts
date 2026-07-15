import { loadRenderers } from "astro:container";
import { render } from "astro:content";
import { getContainerRenderer as getMDXRenderer } from "@astrojs/mdx";
import rss, { type RSSFeedItem } from "@astrojs/rss";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { getSortedPosts } from "@utils/content-utils";
import { formatDateI18nWithTime, toArticleDate } from "@utils/date-utils";
import { url } from "@utils/url-utils";
import type { APIContext } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import sanitizeHtml from "sanitize-html";
import { siteConfig } from "@/config";
import pkg from "../../package.json";
import { normalizeEmbeddedMediaPath, normalizeExternalVideoUrl } from "../../shared/media-embed-policy.mjs";

function stripInvalidXmlChars(str: string): string {
	return str.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: https://www.w3.org/TR/xml/#charsets
		/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
		"",
	);
}

function absoluteMediaUrl(publicPath: string, site: URL | undefined) {
	return new URL(publicPath, site ?? new URL("https://yuanxiao48.github.io")).href;
}

function rssMediaSanitizer(site: URL | undefined) {
	const localMediaLink = (tagName: string, attribs: Record<string, string | undefined>, kind: "audio" | "video") => {
		const media = normalizeEmbeddedMediaPath(attribs.src, kind);
		return media
			? { tagName: "a", attribs: { href: absoluteMediaUrl(media.publicPath, site), rel: "noopener noreferrer" }, text: tagName === "audio" ? "Listen to audio" : "Watch video" }
			: { tagName: "span", text: "Media removed from RSS" };
	};
	return {
		allowedTags: sanitizeHtml.defaults.allowedTags.concat(["figure", "figcaption", "img"]),
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			a: ["href", "rel", "title"],
			img: ["src", "alt", "title", "width", "height", "loading"],
		},
		allowedSchemes: ["https", "mailto"],
		allowProtocolRelative: false,
		nonTextTags: ["script", "style", "object", "embed", "source", "track"],
		transformTags: {
			audio: (tagName: string, attribs: Record<string, string | undefined>) => localMediaLink(tagName, attribs, "audio"),
			video: (tagName: string, attribs: Record<string, string | undefined>) => localMediaLink(tagName, attribs, "video"),
			iframe: (_tagName: string, attribs: Record<string, string | undefined>) => {
				const video = normalizeExternalVideoUrl(attribs.src);
				return video
					? { tagName: "a", attribs: { href: video.canonicalUrl, rel: "noopener noreferrer" }, text: "Open external video" }
					: { tagName: "span", text: "External video removed from RSS" };
			},
		},
	};
}

export async function GET(context: APIContext) {
	const blog = await getSortedPosts();
	const renderers = await loadRenderers([getMDXRenderer()]);
	const container = await AstroContainer.create({ renderers });
	const feedItems: RSSFeedItem[] = [];
	for (const post of blog) {
		if (post.data.password) {
			feedItems.push({
				title: post.data.title,
				pubDate: toArticleDate(post.data.published),
				description: post.data.description || "",
				link: url(`/posts/${post.id}/`),
				content: i18n(I18nKey.passwordProtectedRss),
			});
			continue;
		}
		const { Content } = await render(post);
		const rawContent = await container.renderToString(Content);
		const cleanedContent = stripInvalidXmlChars(rawContent);
		feedItems.push({
			title: post.data.title,
			pubDate: toArticleDate(post.data.published),
			description: post.data.description || "",
			link: url(`/posts/${post.id}/`),
			content: sanitizeHtml(cleanedContent, rssMediaSanitizer(context.site)),
		});
	}
	return rss({
		title: siteConfig.title,
		description: siteConfig.subtitle || "No description",
		site: context.site ?? "https://firefly.cuteleaf.cn",
		customData: `<templateTheme>Firefly</templateTheme>
		<templateThemeVersion>${pkg.version}</templateThemeVersion>
		<templateThemeUrl>https://github.com/CuteLeaf/Firefly</templateThemeUrl>
		<lastBuildDate>${formatDateI18nWithTime(new Date())}</lastBuildDate>`,
		items: feedItems,
	});
}
