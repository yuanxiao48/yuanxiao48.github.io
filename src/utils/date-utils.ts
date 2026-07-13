import { siteConfig } from "../config";

export type ArticleDateValue = Date | string;

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const LEGACY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_OFFSET_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

type DateParts = {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
};

function datePartsInShanghai(date: Date): DateParts {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: SHANGHAI_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value || "";
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
	};
}

function isValidDate(date: Date): boolean {
	return !Number.isNaN(date.getTime());
}

export function isLegacyArticleDate(value: ArticleDateValue | undefined): boolean {
	return value instanceof Date || (typeof value === "string" && LEGACY_DATE_PATTERN.test(value));
}

export function hasArticleTime(value: ArticleDateValue | undefined): boolean {
	return typeof value === "string" && ISO_WITH_OFFSET_PATTERN.test(value);
}

export function toArticleDate(value: ArticleDateValue): Date {
	if (value instanceof Date) return value;
	if (LEGACY_DATE_PATTERN.test(value)) return new Date(`${value}T00:00:00+08:00`);
	return new Date(value);
}

/** Used only for sorting legacy date-only entries. It never changes frontmatter. */
export function articleComparableTime(value: ArticleDateValue): number {
	if (!isLegacyArticleDate(value)) return toArticleDate(value).getTime();
	const date = toArticleDate(value);
	if (!isValidDate(date)) return Number.NEGATIVE_INFINITY;
	const parts = datePartsInShanghai(date);
	return Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
}

export function formatArticleDate(value: ArticleDateValue): string {
	const date = toArticleDate(value);
	if (!isValidDate(date)) return "";
	const parts = datePartsInShanghai(date);
	const day = `${parts.year}-${parts.month}-${parts.day}`;
	return hasArticleTime(value) ? `${day} ${parts.hour}:${parts.minute}` : day;
}

export function formatDateToYYYYMMDD(value: ArticleDateValue): string {
	const date = toArticleDate(value);
	if (!isValidDate(date)) return "";
	const parts = datePartsInShanghai(date);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatArticleDateTime(value: ArticleDateValue): string {
	return formatArticleDate(value);
}

export function hasMeaningfulArticleUpdate(
	published: ArticleDateValue,
	updated: ArticleDateValue | undefined,
): boolean {
	if (!updated) return false;
	if (hasArticleTime(published) && hasArticleTime(updated)) {
		return articleComparableTime(updated) - articleComparableTime(published) >= 60_000;
	}
	if (isLegacyArticleDate(published)) {
		const publishedDay = formatDateToYYYYMMDD(published);
		const updatedDay = formatDateToYYYYMMDD(updated);
		return updatedDay > publishedDay;
	}
	return false;
}

export function currentShanghaiTimestamp(now = new Date()): string {
	const parts = datePartsInShanghai(now);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
}

export function toStudioDateTimeLocal(value: ArticleDateValue | undefined): string {
	if (!value || !hasArticleTime(value)) return "";
	const date = toArticleDate(value);
	if (!isValidDate(date)) return "";
	const parts = datePartsInShanghai(date);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function toShanghaiTimestamp(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "";
	const candidate = new Date(`${value}:00+08:00`);
	if (!isValidDate(candidate)) return "";
	const parts = datePartsInShanghai(candidate);
	const normalized = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
	return normalized === value ? `${value}:00+08:00` : "";
}

type SortableArticle = {
	id?: string;
	slug?: string;
	data?: {
		pinned?: boolean;
		published: ArticleDateValue;
		updated?: ArticleDateValue;
	};
	pinned?: boolean;
	published?: ArticleDateValue;
	updated?: ArticleDateValue;
};

function sortValues(post: SortableArticle) {
	const data = post.data || post;
	return {
		pinned: Boolean(data.pinned),
		published: data.published as ArticleDateValue,
		updated: data.updated as ArticleDateValue | undefined,
		slug: String(post.id || post.slug || ""),
	};
}

export function compareArticles(a: SortableArticle, b: SortableArticle): number {
	const left = sortValues(a);
	const right = sortValues(b);
	if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
	const published = articleComparableTime(right.published) - articleComparableTime(left.published);
	if (published !== 0) return published;
	const updated = articleComparableTime(right.updated || right.published) - articleComparableTime(left.updated || left.published);
	if (updated !== 0) return updated;
	return left.slug.localeCompare(right.slug, "zh-CN");
}

// 国际化日期格式化函数
export function formatDateI18n(
	dateInput: Date | string,
	includeTime?: boolean,
): string {
	const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
	const lang = siteConfig.lang || "en";

	// 根据语言设置不同的日期格式
	const options: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "long",
		day: "numeric",
	};

	if (includeTime) {
		options.hour = "2-digit";
		options.minute = "2-digit";
		options.second = "2-digit";
	}

	// 如果配置了时区，则将其用于格式化（IANA 时区字符串）
	if (siteConfig.timezone) {
		(options as Intl.DateTimeFormatOptions).timeZone = siteConfig.timezone;
	}

	// 语言代码映射
	const localeMap: Record<string, string> = {
		zh_CN: "zh-CN",
		zh_TW: "zh-TW",
		en: "en-US",
		ja: "ja-JP",
		ko: "ko-KR",
		es: "es-ES",
		th: "th-TH",
		vi: "vi-VN",
		tr: "tr-TR",
		id: "id-ID",
		fr: "fr-FR",
		de: "de-DE",
		ru: "ru-RU",
		ar: "ar-SA",
	};

	const locale = localeMap[lang] || "en-US";
	return includeTime
		? date.toLocaleString(locale, options)
		: date.toLocaleDateString(locale, options);
}

// 国际化日期时间格式化函数（带时分秒）
export function formatDateI18nWithTime(dateInput: Date | string): string {
	return formatDateI18n(dateInput, true);
}

// 统一格式为 YYYY-MM-DD HH:mm，支持站点时区
export function formatDateTimeToYYYYMMDDHHmm(dateInput: Date | string): string {
	const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;

	const options: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	};

	if (siteConfig.timezone) {
		options.timeZone = siteConfig.timezone;
	}

	const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value || "";

	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
