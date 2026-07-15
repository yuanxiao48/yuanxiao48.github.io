import { createLayoutManager } from "./studio-layout-manager.js";
import { createMediaManager } from "./studio-media-manager.js";
import { createPageManager } from "./studio-page-manager.js";
import { createSettingsManager } from "./studio-settings-manager.js";
import { createTranscodeManager } from "./studio-transcode-manager.js";

const navItems = [...document.querySelectorAll("[data-studio-module]")];
const panels = [...document.querySelectorAll("[data-studio-module-panel]")];
const legacyTabs = document.querySelector(".tabs");
const postsPanel = document.querySelector('[data-panel="posts"]');
const postsMount = document.querySelector("#studio4a-posts-mount");
const layout = createLayoutManager();
const media = createMediaManager();
const transcode = createTranscodeManager();
const pages = createPageManager();
const settings = createSettingsManager();
window.StudioTranscode = transcode;
const modules = { layout, media, pages, settings };
let active = "overview";

legacyTabs?.classList.add("legacy-tabs");

function mountPostsWorkspace() {
	if (!postsPanel || !postsMount) return false;
	// The legacy editor remains the single owner of article behavior. 4A only mounts it.
	if (postsPanel.parentElement !== postsMount) postsMount.append(postsPanel);
	postsPanel.classList.remove("hidden");
	return true;
}

async function guardCurrent(next) {
	if (active === next) return true;
	if (active === "posts" || active === "trash") {
		return window.StudioEditor ? window.StudioEditor.confirmNavigation(next === "trash" ? "回收站" : "其他模块") : true;
	}
	return modules[active]?.canLeave?.() ?? true;
}

async function activate(name) {
	if (!(await guardCurrent(name))) return;
	if (name === "trash" || name === "posts") mountPostsWorkspace();
	for (const item of navItems) item.classList.toggle("active", item.dataset.studioModule === name);
	for (const panel of panels) panel.classList.toggle("hidden", panel.dataset.studioModulePanel !== (name === "trash" ? "posts" : name));
	active = name;
	if (name === "trash" || name === "posts") {
		const view = name === "trash" ? "trash" : "articles";
		if (window.StudioPosts?.show) await window.StudioPosts.show(view);
		else document.querySelector(`[data-post-view="${view}"]`)?.click();
	}
	if (name === "layout") layout.load().catch((error) => console.error(error));
	if (name === "media") media.load().catch((error) => console.error(error));
	if (name === "pages") pages.load().catch((error) => console.error(error));
	if (name === "settings") settings.load().catch((error) => console.error(error));
}

for (const item of navItems) item.addEventListener("click", () => activate(item.dataset.studioModule).catch(console.error));
for (const item of document.querySelectorAll("[data-studio-go]")) item.addEventListener("click", () => activate(item.dataset.studioGo).catch(console.error));
window.addEventListener("beforeunload", (event) => {
	const needsWarning = (active === "posts" || active === "trash") ? window.StudioEditor?.isDirty?.() : modules[active]?.isDirty?.();
	if (!needsWarning) return;
	event.preventDefault(); event.returnValue = "";
});

window.Studio4A = { activate };
