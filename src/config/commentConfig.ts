import type { CommentConfig } from "../types/commentConfig";
import userSettings from "./userSettings.json";

type CommentType = CommentConfig["type"];

type CommentSettings = {
	enabled?: boolean;
	type?: CommentType;
	twikooEnvId?: string;
	walineServerURL?: string;
	giscusRepo?: string;
	giscusRepoId?: string;
	giscusCategory?: string;
	giscusCategoryId?: string;
	disqusShortname?: string;
	artalkServer?: string;
};

const comments =
	(userSettings as { comments?: CommentSettings }).comments ?? {};

export const commentConfig: CommentConfig = {
	type: comments.enabled === false ? "none" : comments.type || "giscus",
	twikoo: {
		envId: comments.twikooEnvId || "",
		lang: "zh-CN",
		visitorCount: true,
		jsUrl: "https://cdn.jsdelivr.net/npm/twikoo@1.7.12/dist/twikoo.min.js",
		cssUrl: "/assets/css/twikoo-custom.css",
	},
	waline: {
		serverURL: comments.walineServerURL || "",
		lang: "zh-CN",
		emoji: [
			"https://unpkg.com/@waline/emojis@1.4.0/weibo",
			"https://unpkg.com/@waline/emojis@1.4.0/bilibili",
			"https://unpkg.com/@waline/emojis@1.4.0/bmoji",
		],
		login: "enable",
		visitorCount: true,
	},
	artalk: {
		server: comments.artalkServer || "",
		locale: "zh-CN",
		visitorCount: true,
	},
	giscus: {
		repo: comments.giscusRepo || "yuanxiao48/metawiki",
		repoId: comments.giscusRepoId || "",
		category: comments.giscusCategory || "General",
		categoryId: comments.giscusCategoryId || "",
		mapping: "title",
		strict: "0",
		reactionsEnabled: "1",
		emitMetadata: "1",
		inputPosition: "top",
		lang: "zh-CN",
		loading: "lazy",
	},
	disqus: {
		shortname: comments.disqusShortname || "",
	},
};
