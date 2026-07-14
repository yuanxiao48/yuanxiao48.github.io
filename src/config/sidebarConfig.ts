import type {
	MobileBottomComponentConfig,
	SidebarLayoutConfig,
	WidgetComponentConfig,
	WidgetComponentType,
} from "../types/sidebarConfig";
import userSettings from "./userSettings.json";

type Position = WidgetComponentConfig["position"];

type LayoutItem = {
	type: WidgetComponentType;
	enable?: boolean;
	position?: Position;
};

type LayoutSettings = {
	layout?: {
		left?: LayoutItem[];
		right?: LayoutItem[];
		mobile?: LayoutItem[];
	};
	music?: {
		showInSidebar?: boolean;
	};
};

const settings = userSettings as LayoutSettings;
const musicVisible = settings.music?.showInSidebar !== false;

const fallbackLayout: Required<NonNullable<LayoutSettings["layout"]>> = {
	left: [
		{ type: "profile", enable: true, position: "top" },
		{ type: "stats", enable: true, position: "top" },
		{ type: "announcement", enable: true, position: "top" },
		{ type: "music", enable: true, position: "sticky" },
		{ type: "emailSubscribe", enable: true, position: "sticky" },
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
		{ type: "emailSubscribe", enable: true },
		{ type: "categories", enable: true },
		{ type: "tags", enable: true },
	],
};

const componentDefaults: Partial<
	Record<
		WidgetComponentType,
		Partial<WidgetComponentConfig & MobileBottomComponentConfig>
	>
> = {
	categories: {
		specificConfig: {
			collapseThreshold: 5,
		},
	},
	tags: {
		specificConfig: {
			collapseThreshold: 10,
		},
	},
	calendar: {
		showTitle: false,
		showOnPostPage: false,
		specificConfig: {
			calendar: {
				showHeatmap: true,
			},
		},
	},
	sidebarToc: {
		showOnPostPage: true,
		showOnNonPostPage: false,
	},
	siteInfo: {
		specificConfig: {
			siteInfo: {
				unknownBuildPlatform: "Unknown CI",
			},
		},
	},
};

function isEnabled(item: LayoutItem): boolean {
	if (item.type === "music") return item.enable !== false && musicVisible;
	return item.enable !== false;
}

function desktopComponent(item: LayoutItem): WidgetComponentConfig {
	const defaults = componentDefaults[item.type] ?? {};
	return {
		...defaults,
		type: item.type,
		enable: isEnabled(item),
		position: item.position === "top" ? "top" : "sticky",
		showOnPostPage: defaults.showOnPostPage ?? true,
	};
}

function mobileComponent(item: LayoutItem): MobileBottomComponentConfig {
	const defaults = componentDefaults[item.type] ?? {};
	return {
		...defaults,
		type: item.type,
		enable: isEnabled(item),
		showOnPostPage: defaults.showOnPostPage ?? true,
	};
}

const layout = settings.layout ?? fallbackLayout;

export const sidebarLayoutConfig: SidebarLayoutConfig = {
	enable: true,
	position: "both",
	tabletSidebar: "left",
	showBothSidebarsOnPostPage: true,
	leftComponents: (layout.left?.length ? layout.left : fallbackLayout.left).map(
		desktopComponent,
	),
	rightComponents: (
		layout.right?.length ? layout.right : fallbackLayout.right
	).map(desktopComponent),
	mobileBottomComponents: (
		layout.mobile?.length ? layout.mobile : fallbackLayout.mobile
	).map(mobileComponent),
};
