<script lang="ts">
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";
import { DARK_MODE, LIGHT_MODE, SYSTEM_MODE } from "@/constants/constants";
import type { LIGHT_DARK_MODE } from "@/types/config.ts";
import {
	applyThemeToDocument,
	getStoredTheme,
	setTheme,
} from "@/utils/setting-utils";

interface SwupHooks {
	on(event: string, callback: () => void): void;
}

interface SwupInstance {
	hooks?: SwupHooks;
}

type WindowWithSwup = Window & { swup?: SwupInstance };

let mode: LIGHT_DARK_MODE = $state(LIGHT_MODE);
let displayedMode: LIGHT_DARK_MODE = $state(LIGHT_MODE);

function updateDisplayedMode() {
	if (mode === SYSTEM_MODE) {
		displayedMode = window.matchMedia("(prefers-color-scheme: dark)").matches
			? DARK_MODE
			: LIGHT_MODE;
		return;
	}
	displayedMode = mode;
}

function switchScheme(newMode: LIGHT_DARK_MODE) {
	mode = newMode;
	setTheme(newMode);
	updateDisplayedMode();
	window.dispatchEvent(new CustomEvent("theme-change"));
}

function toggleScheme() {
	switchScheme(displayedMode === DARK_MODE ? LIGHT_MODE : DARK_MODE);
}

onMount(() => {
	mode = getStoredTheme();
	updateDisplayedMode();

	if (mode !== SYSTEM_MODE) {
		const currentTheme = document.documentElement.classList.contains("dark")
			? DARK_MODE
			: LIGHT_MODE;
		if (mode !== currentTheme) applyThemeToDocument(mode);
	}

	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	const handleSystemChange = () => {
		if (mode === SYSTEM_MODE) updateDisplayedMode();
	};
	mediaQuery.addEventListener("change", handleSystemChange);

	const handleContentReplace = () => {
		mode = getStoredTheme();
		updateDisplayedMode();
	};

	const win = window as WindowWithSwup;
	if (win.swup?.hooks) {
		win.swup.hooks.on("content:replace", handleContentReplace);
	} else {
		document.addEventListener("swup:enable", () => {
			const w = window as WindowWithSwup;
			if (w.swup?.hooks) w.swup.hooks.on("content:replace", handleContentReplace);
		});
	}

	const handleThemeChange = () => {
		mode = getStoredTheme();
		updateDisplayedMode();
	};
	window.addEventListener("theme-change", handleThemeChange);

	return () => {
		mediaQuery.removeEventListener("change", handleSystemChange);
		window.removeEventListener("theme-change", handleThemeChange);
	};
});
</script>

<div class="relative z-50">
	<button
		aria-label="切换明暗模式"
		class="relative btn-plain scale-animation rounded-lg h-11 w-11 active:scale-90"
		id="scheme-switch"
		onclick={toggleScheme}
		type="button"
	>
		<div
			class="absolute inset-0 flex items-center justify-center transition"
			class:opacity-0={displayedMode !== LIGHT_MODE}
		>
			<Icon icon="material-symbols:wb-sunny-outline-rounded" class="text-[1.25rem]" />
		</div>
		<div
			class="absolute inset-0 flex items-center justify-center transition"
			class:opacity-0={displayedMode !== DARK_MODE}
		>
			<Icon icon="material-symbols:dark-mode-outline-rounded" class="text-[1.25rem]" />
		</div>
	</button>
</div>
