function studioAssetUrl(publicPath) {
	const relative = String(publicPath || "").replace(/^\/assets\//, "");
	return `/studio-assets/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function formatBytes(value) {
	const size = Number(value);
	if (!Number.isFinite(size) || size < 0) return "未知大小";
	if (size < 1024) return `${size} B`;
	const units = ["KB", "MB", "GB"];
	let next = size / 1024;
	let index = 0;
	while (next >= 1024 && index < units.length - 1) {
		next /= 1024;
		index += 1;
	}
	return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "未知时间";
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date);
}

function formatDuration(value) {
	if (!Number.isFinite(value) || value < 0) return "时长不可用";
	const total = Math.round(value);
	const minutes = Math.floor(total / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return `${minutes}:${seconds}`;
}

async function copyPublicPath(value) {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		const input = document.createElement("textarea");
		input.value = value;
		input.setAttribute("readonly", "");
		input.style.position = "fixed";
		input.style.opacity = "0";
		document.body.append(input);
		input.select();
		const copied = document.execCommand("copy");
		input.remove();
		return copied;
	}
}

export function createMediaManager() {
	const list = document.querySelector("#mediaList");
	const preview = document.querySelector("#mediaPreview");
	const status = document.querySelector("#mediaStatus");
	const searchInput = document.querySelector("#mediaSearch");
	const retryButton = document.querySelector("#mediaRetry");
	const refreshButton = document.querySelector("#mediaRefresh");
	const kindButtons = [...document.querySelectorAll("[data-media-kind]")];
	let currentKind = "all";
	let items = [];
	let selectedPath = "";
	let requestSequence = 0;
	let searchTimer = null;
	let bound = false;

	function setStatus(message, state = "") {
		if (!status) return;
		status.textContent = message;
		status.dataset.state = state;
	}

	function renderPreview(item) {
		if (!preview) return;
		preview.replaceChildren();
		if (!item) {
			const message = document.createElement("p");
			message.textContent = "选择一个媒体文件即可预览并复制公开路径。";
			preview.append(message);
			return;
		}
		const title = document.createElement("h3");
		title.textContent = item.name;
		const meta = document.createElement("p");
		meta.className = "studio-media-preview-meta";
		meta.textContent = `${item.kind === "image" ? "图片" : item.kind === "audio" ? "音频" : "视频"} · ${formatBytes(item.size)} · ${formatDate(item.modifiedAt)}`;
		const pathText = document.createElement("code");
		pathText.textContent = item.publicPath;
		const duration = document.createElement("p");
		duration.className = "studio-media-duration";
		if (item.kind === "image") {
			const image = document.createElement("img");
			image.src = studioAssetUrl(item.publicPath);
			image.alt = item.name;
			image.loading = "lazy";
			preview.append(title, meta, image, pathText);
		} else {
			const media = document.createElement(item.kind === "audio" ? "audio" : "video");
			media.src = studioAssetUrl(item.publicPath);
			media.controls = true;
			media.preload = "metadata";
			if (item.kind === "video") media.playsInline = true;
			media.addEventListener("loadedmetadata", () => {
				duration.textContent = `时长 ${formatDuration(media.duration)}`;
			});
			media.addEventListener("error", () => {
				duration.textContent = "预览加载失败；文件仍未被修改。";
			});
			duration.textContent = "正在读取时长…";
			preview.append(title, meta, media, duration, pathText);
		}
		const copyButton = document.createElement("button");
		copyButton.type = "button";
		copyButton.className = "btn small";
		copyButton.textContent = "复制公开路径";
		copyButton.addEventListener("click", async () => {
			copyButton.disabled = true;
			const copied = await copyPublicPath(item.publicPath);
			copyButton.textContent = copied ? "已复制" : "复制失败";
			setTimeout(() => {
				copyButton.disabled = false;
				copyButton.textContent = "复制公开路径";
			}, 1400);
		});
		preview.append(copyButton);
	}

	function renderList() {
		if (!list) return;
		list.replaceChildren();
		if (!items.length) {
			const empty = document.createElement("p");
			empty.className = "studio-media-empty";
			empty.textContent = searchInput?.value.trim() ? "没有符合筛选条件的媒体文件。" : "媒体库为空。";
			list.append(empty);
			return;
		}
		for (const item of items) {
			const card = document.createElement("button");
			card.type = "button";
			card.className = "studio-media-card";
			card.classList.toggle("selected", item.publicPath === selectedPath);
			const heading = document.createElement("strong");
			heading.textContent = item.name;
			const kind = document.createElement("span");
			kind.className = "studio-media-kind";
			kind.textContent = item.kind === "image" ? "图片" : item.kind === "audio" ? "音频" : "视频";
			const details = document.createElement("span");
			details.textContent = `${formatBytes(item.size)} · ${formatDate(item.modifiedAt)}`;
			const itemPath = document.createElement("code");
			itemPath.textContent = item.publicPath;
			card.append(heading, kind, details, itemPath);
			card.addEventListener("click", () => {
				selectedPath = item.publicPath;
				renderList();
				renderPreview(item);
			});
			list.append(card);
		}
	}

	async function load() {
		const sequence = ++requestSequence;
		setStatus("正在加载媒体库…", "loading");
		retryButton?.classList.add("hidden");
		if (list) list.replaceChildren();
		try {
			const params = new URLSearchParams({ kind: currentKind });
			if (searchInput?.value.trim()) params.set("search", searchInput.value.trim());
			const response = await fetch(`/api/media?${params.toString()}`, { cache: "no-store" });
			const payload = await response.json().catch(() => ({}));
			if (sequence !== requestSequence) return;
			if (!response.ok || payload.ok !== true) throw new Error(payload.error || "媒体库读取失败");
			items = Array.isArray(payload.items) ? payload.items : [];
			if (!items.some((item) => item.publicPath === selectedPath)) {
				selectedPath = "";
				renderPreview(null);
			}
			renderList();
			const skipped = Array.isArray(payload.errors) ? payload.errors.length : 0;
			setStatus(items.length ? `已读取 ${items.length} 个媒体文件${skipped ? `，${skipped} 个文件被安全跳过` : ""}。` : searchInput?.value.trim() ? "没有符合筛选条件的媒体文件。" : "媒体库为空。", items.length ? "ready" : "empty");
		} catch (error) {
			if (sequence !== requestSequence) return;
			items = [];
			renderPreview(null);
			if (list) {
				const failed = document.createElement("p");
				failed.className = "studio-media-empty error";
				failed.textContent = "媒体库加载失败，请检查服务后重试。";
				list.append(failed);
			}
			setStatus(error.message || "媒体库加载失败", "error");
			retryButton?.classList.remove("hidden");
		}
	}

	function bind() {
		if (bound) return;
		bound = true;
		for (const button of kindButtons) {
			button.addEventListener("click", () => {
				currentKind = button.dataset.mediaKind || "all";
				for (const item of kindButtons) item.classList.toggle("active", item === button);
				load();
			});
		}
		searchInput?.addEventListener("input", () => {
			clearTimeout(searchTimer);
			searchTimer = setTimeout(() => load(), 220);
		});
		refreshButton?.addEventListener("click", () => load());
		retryButton?.addEventListener("click", () => load());
	}

	bind();
	return { load, canLeave: () => true };
}
