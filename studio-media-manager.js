function studioAssetUrl(publicPath) {
	const relative = String(publicPath || "").replace(/^\/assets\//, "");
	return `/studio-assets/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function sessionToken() {
	return document.querySelector('meta[name="studio-session-token"]')?.content || "";
}

function formatBytes(value) {
	const size = Number(value);
	if (!Number.isFinite(size) || size < 0) return "未知大小";
	if (size < 1024) return `${size} B`;
	const units = ["KB", "MB", "GB"];
	let next = size / 1024;
	let index = 0;
	while (next >= 1024 && index < units.length - 1) { next /= 1024; index += 1; }
	return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "未知时间";
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
	}).format(date);
}

function formatDuration(value) {
	if (!Number.isFinite(value) || value < 0) return "时长不可用";
	const total = Math.round(value);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

async function copyPublicPath(value) {
	try { await navigator.clipboard.writeText(value); return true; } catch {
		const input = document.createElement("textarea");
		input.value = value; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0";
		document.body.append(input); input.select(); const copied = document.execCommand("copy"); input.remove(); return copied;
	}
}

function kindLabel(kind) {
	return ({ image: "图片", audio: "音频", video: "视频" })[kind] || kind;
}

function acceptedExtensions(kind) {
	return {
		image: ["jpg", "jpeg", "png", "webp", "avif", "gif"],
		audio: ["mp3", "m4a", "aac", "wav", "ogg", "flac"],
		video: ["mp4", "webm", "mov"],
	}[kind] || [];
}

function apiError(payload, fallback) {
	const error = new Error(payload?.error || fallback);
	error.code = payload?.code || "MEDIA_REQUEST_FAILED";
	error.details = payload?.details;
	return error;
}

export function createMediaManager() {
	const list = document.querySelector("#mediaList");
	const preview = document.querySelector("#mediaPreview");
	const status = document.querySelector("#mediaStatus");
	const searchInput = document.querySelector("#mediaSearch");
	const retryButton = document.querySelector("#mediaRetry");
	const refreshButton = document.querySelector("#mediaRefresh");
	const kindButtons = [...document.querySelectorAll("[data-media-kind]")];
	const libraryTab = document.querySelector("#mediaLibraryTab");
	const transcodeTab = document.querySelector("#mediaTranscodeTab");
	const trashTab = document.querySelector("#mediaTrashTab");
	const libraryPanel = document.querySelector("#mediaLibraryPanel");
	const libraryControls = document.querySelector("#mediaLibraryControls");
	const uploadPanel = document.querySelector("#mediaUploadPanel");
	const uploadKind = document.querySelector("#mediaUploadKind");
	const uploadInput = document.querySelector("#mediaUploadInput");
	const uploadStart = document.querySelector("#mediaUploadStart");
	const uploadCancel = document.querySelector("#mediaUploadCancel");
	const uploadStatus = document.querySelector("#mediaUploadStatus");
	const videoNotice = document.querySelector("#mediaVideoNotice");
	let currentKind = "all";
	let currentView = "library";
	let items = [];
	let trashItems = [];
	let selectedPath = "";
	let selectedTrashId = "";
	let requestSequence = 0;
	let searchTimer = null;
	let bound = false;
	let uploadQueue = [];
	let uploadActive = false;
	let currentXhr = null;

	function setStatus(message, state = "") {
		if (!status) return;
		status.textContent = message;
		status.dataset.state = state;
	}

	function setUploadStatus(message, state = "") {
		if (!uploadStatus) return;
		uploadStatus.textContent = message;
		uploadStatus.dataset.state = state;
	}

	function updateUploadKindHint() {
		const kind = uploadKind?.value || "image";
		if (uploadInput) uploadInput.accept = acceptedExtensions(kind).map((ext) => `.${ext}`).join(",");
		videoNotice?.classList.toggle("hidden", kind !== "video");
	}

	function setView(view) {
		currentView = view;
		libraryTab?.classList.toggle("active", view === "library");
		libraryTab?.setAttribute("aria-selected", String(view === "library"));
		transcodeTab?.classList.toggle("active", view === "transcode");
		transcodeTab?.setAttribute("aria-selected", String(view === "transcode"));
		trashTab?.classList.toggle("active", view === "trash");
		trashTab?.setAttribute("aria-selected", String(view === "trash"));
		libraryPanel?.classList.toggle("hidden", view === "transcode");
		if (view === "transcode") {
			window.StudioTranscode?.show?.();
			window.StudioTranscode?.load?.().catch((error) => console.error(error));
			return;
		}
		window.StudioTranscode?.hide?.();
		libraryControls?.classList.toggle("hidden", view !== "library");
		uploadPanel?.classList.toggle("hidden", view !== "library");
		load().catch((error) => console.error(error));
	}

	function renderEmpty(message, failed = false) {
		if (!list || currentView === "transcode") return;
		list.replaceChildren();
		const empty = document.createElement("p");
		empty.className = `studio-media-empty${failed ? " error" : ""}`;
		empty.textContent = message;
		list.append(empty);
	}

	function appendCopyButton(container, publicPath) {
		const copyButton = document.createElement("button");
		copyButton.type = "button"; copyButton.className = "btn small"; copyButton.textContent = "复制公开路径";
		copyButton.addEventListener("click", async () => {
			copyButton.disabled = true;
			copyButton.textContent = (await copyPublicPath(publicPath)) ? "已复制" : "复制失败";
			setTimeout(() => { copyButton.disabled = false; copyButton.textContent = "复制公开路径"; }, 1200);
		});
		container.append(copyButton);
	}

	async function requestJson(url, options = {}) {
		const response = await fetch(url, { cache: "no-store", ...options });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok || payload.ok === false) throw apiError(payload, "媒体请求失败");
		return payload;
	}

	async function requestWrite(url, body) {
		return requestJson(url, {
			method: "POST",
			headers: { "content-type": "application/json", "x-studio-session": sessionToken() },
			body: JSON.stringify(body),
		});
	}

	function renderMediaPreview(item) {
		if (!preview) return;
		preview.replaceChildren();
		if (!item) {
			const message = document.createElement("p");
			message.textContent = "选择一个媒体文件即可预览、查看引用或移入回收站。";
			preview.append(message); return;
		}
		const title = document.createElement("h3"); title.textContent = item.name;
		const meta = document.createElement("p"); meta.className = "studio-media-preview-meta";
		meta.textContent = `${kindLabel(item.kind)} · ${formatBytes(item.size)} · ${formatDate(item.modifiedAt)}`;
		const pathText = document.createElement("code"); pathText.textContent = item.publicPath;
		const duration = document.createElement("p"); duration.className = "studio-media-duration";
		if (item.kind === "image") {
			const image = document.createElement("img"); image.src = studioAssetUrl(item.publicPath); image.alt = item.name; image.loading = "lazy";
			preview.append(title, meta, image, pathText);
		} else {
			const media = document.createElement(item.kind === "audio" ? "audio" : "video");
			media.src = studioAssetUrl(item.publicPath); media.controls = true; media.preload = "metadata"; if (item.kind === "video") media.playsInline = true;
			const compatibilityNotice = item.kind === "video"
				? Object.assign(document.createElement("p"), {
					className: "studio-media-video-compatibility",
					textContent: "文件已上传，但浏览器可能不支持其视频编码。建议转换为 H.264 + AAC 的 MP4。",
					hidden: true,
				})
				: null;
			const showCompatibilityNotice = () => { if (compatibilityNotice) compatibilityNotice.hidden = false; };
			if (item.kind === "video") {
				media.addEventListener("error", showCompatibilityNotice);
				media.addEventListener("loadedmetadata", () => {
					if (media.videoWidth === 0 || media.videoHeight === 0) showCompatibilityNotice();
				});
			}
			media.addEventListener("loadedmetadata", () => { duration.textContent = `时长 ${formatDuration(media.duration)}`; });
			media.addEventListener("error", () => { duration.textContent = "预览加载失败；文件没有被修改。"; });
			duration.textContent = "正在读取时长…"; preview.append(title, meta, media, duration, ...(compatibilityNotice ? [compatibilityNotice] : []), pathText);
		}
		appendCopyButton(preview, item.publicPath);
		const refsButton = document.createElement("button"); refsButton.type = "button"; refsButton.className = "btn small"; refsButton.textContent = "查看引用";
		refsButton.addEventListener("click", () => showReferences(item));
		const trashButton = document.createElement("button"); trashButton.type = "button"; trashButton.className = "btn small danger"; trashButton.textContent = "移入媒体回收站";
		trashButton.addEventListener("click", () => trashMedia(item));
		preview.append(refsButton, trashButton);
	}

	function renderTrashPreview(item) {
		if (!preview) return;
		preview.replaceChildren();
		if (!item) { preview.append(Object.assign(document.createElement("p"), { textContent: "选择一个回收站项目即可恢复。" })); return; }
		const title = document.createElement("h3"); title.textContent = item.name;
		const meta = document.createElement("p"); meta.className = "studio-media-preview-meta";
		meta.textContent = `${kindLabel(item.kind)} · ${formatBytes(item.size)} · 删除于 ${formatDate(item.deletedAt)}`;
		const pathText = document.createElement("code"); pathText.textContent = item.originalPublicPath;
		const referenceText = document.createElement("p"); referenceText.textContent = item.references?.length ? `删除时检测到 ${item.references.length} 处引用；原内容未被自动修改。` : "删除时没有检测到引用。";
		const restoreButton = document.createElement("button"); restoreButton.type = "button"; restoreButton.className = "btn primary"; restoreButton.textContent = "恢复到原位置";
		restoreButton.addEventListener("click", () => restoreMedia(item));
		preview.append(title, meta, pathText, referenceText, restoreButton);
	}

	function renderList() {
		if (!list) return;
		list.replaceChildren();
		const source = currentView === "library" ? items : trashItems;
		if (!source.length) {
			const message = currentView === "library"
				? (searchInput?.value.trim() ? "没有符合筛选条件的媒体文件。" : "媒体库为空。")
				: "媒体回收站为空。";
			renderEmpty(message); return;
		}
		for (const item of source) {
			const key = currentView === "library" ? item.publicPath : item.id;
			const card = document.createElement("button"); card.type = "button"; card.className = "studio-media-card";
			card.classList.toggle("selected", currentView === "library" ? key === selectedPath : key === selectedTrashId);
			const heading = document.createElement("strong"); heading.textContent = item.name;
			const kind = document.createElement("span"); kind.className = "studio-media-kind"; kind.textContent = kindLabel(item.kind);
			const details = document.createElement("span"); details.textContent = currentView === "library" ? `${formatBytes(item.size)} · ${formatDate(item.modifiedAt)}` : `${formatBytes(item.size)} · 删除于 ${formatDate(item.deletedAt)}`;
			const itemPath = document.createElement("code"); itemPath.textContent = currentView === "library" ? item.publicPath : item.originalPublicPath;
			card.append(heading, kind, details, itemPath);
			card.addEventListener("click", () => {
				if (currentView === "library") { selectedPath = key; renderMediaPreview(item); } else { selectedTrashId = key; renderTrashPreview(item); }
				renderList();
			});
			list.append(card);
		}
	}

	async function load() {
		if (currentView === "transcode") {
			libraryPanel?.classList.add("hidden");
			window.StudioTranscode?.show?.();
			await window.StudioTranscode?.load?.();
			return;
		}
		const sequence = ++requestSequence;
		setStatus(currentView === "library" ? "正在加载媒体库…" : "正在加载媒体回收站…", "loading");
		retryButton?.classList.add("hidden"); if (list) list.replaceChildren();
		try {
			if (currentView === "library") {
				const params = new URLSearchParams({ kind: currentKind }); if (searchInput?.value.trim()) params.set("search", searchInput.value.trim());
				const payload = await requestJson(`/api/media?${params}`);
				if (sequence !== requestSequence) return;
				items = Array.isArray(payload.items) ? payload.items : [];
				if (!items.some((item) => item.publicPath === selectedPath)) { selectedPath = ""; renderMediaPreview(null); }
				const skipped = Array.isArray(payload.errors) ? payload.errors.length : 0;
				setStatus(items.length ? `已读取 ${items.length} 个媒体文件${skipped ? `；${skipped} 个文件被安全跳过` : ""}。` : (searchInput?.value.trim() ? "没有符合筛选条件的媒体文件。" : "媒体库为空。"), items.length ? "ready" : "empty");
			} else {
				const payload = await requestJson("/api/media/trash"); if (sequence !== requestSequence) return;
				trashItems = Array.isArray(payload.items) ? payload.items : [];
				if (!trashItems.some((item) => item.id === selectedTrashId)) { selectedTrashId = ""; renderTrashPreview(null); }
				setStatus(trashItems.length ? `回收站中有 ${trashItems.length} 个媒体文件。` : "媒体回收站为空。", trashItems.length ? "ready" : "empty");
			}
			renderList();
		} catch (error) {
			if (sequence !== requestSequence) return;
			if (currentView === "library") items = []; else trashItems = [];
			renderMediaPreview(null); renderEmpty("媒体数据加载失败，请检查 Studio 服务后重试。", true);
			setStatus(error.message || "媒体数据加载失败", "error"); retryButton?.classList.remove("hidden");
		}
	}

	async function showReferences(item) {
		setStatus("正在检查媒体引用…", "loading");
		try {
			const payload = await requestJson(`/api/media/references?path=${encodeURIComponent(item.publicPath)}`);
			const refs = payload.references || [];
			const lines = refs.length ? refs.map((ref) => `${ref.file}:${ref.line}`).join("\n") : "没有发现引用。";
			window.alert(`引用检查：\n${lines}`); setStatus(refs.length ? `发现 ${refs.length} 处引用。` : "没有发现引用。", refs.length ? "" : "ready");
		} catch (error) { setStatus(error.message || "引用检查失败", "error"); }
	}

	async function trashMedia(item) {
		if (!window.confirm(`确定将“${item.name}”移入媒体回收站吗？文章和配置不会被自动修改。`)) return;
		setStatus("正在检查引用并移入回收站…", "loading");
		try {
			await requestWrite("/api/media/trash", { path: item.publicPath, confirmReferenced: false });
			setStatus("已移入媒体回收站。", "ready"); selectedPath = ""; renderMediaPreview(null); await load();
		} catch (error) {
			if (error.code === "MEDIA_REFERENCED") {
				const refs = error.details?.references || [];
				const names = refs.slice(0, 6).map((ref) => `${ref.file}:${ref.line}`).join("\n");
				if (!window.confirm(`该文件仍被 ${refs.length} 处内容引用：\n${names}\n\n仍要移入回收站吗？原引用不会自动修改。`)) { setStatus("已取消移动。", ""); return; }
				await requestWrite("/api/media/trash", { path: item.publicPath, confirmReferenced: true });
				setStatus("已在二次确认后移入媒体回收站。", "ready"); selectedPath = ""; renderMediaPreview(null); await load(); return;
			}
			setStatus(error.message || "移动到回收站失败", "error");
		}
	}

	async function restoreMedia(item) {
		setStatus("正在恢复媒体文件…", "loading");
		try {
			await requestWrite("/api/media/restore", { id: item.id });
			setStatus("媒体已恢复到原位置。", "ready"); selectedTrashId = ""; renderTrashPreview(null); await load();
		} catch (error) {
			if (error.code === "MEDIA_RESTORE_CONFLICT") {
				const next = window.prompt("原位置已有同名文件。输入新的恢复文件名，或取消。", error.details?.suggestedFilename || "");
				if (!next) { setStatus("已取消恢复。", ""); return; }
				try {
					await requestWrite("/api/media/restore", { id: item.id, filename: next });
					setStatus("媒体已使用新文件名恢复。", "ready"); selectedTrashId = ""; renderTrashPreview(null); await load(); return;
				} catch (retryError) { setStatus(retryError.message || "恢复失败", "error"); return; }
			}
			setStatus(error.message || "恢复失败", "error");
		}
	}

	function uploadOne(file, kind, position, total) {
		return new Promise((resolve) => {
			const formData = new FormData(); formData.append("file", file, file.name);
			const xhr = new XMLHttpRequest(); currentXhr = xhr;
			xhr.open("POST", `/api/media?kind=${encodeURIComponent(kind)}`); xhr.setRequestHeader("x-studio-session", sessionToken());
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) setUploadStatus(`正在上传 ${file.name}（${position}/${total}，${Math.round((event.loaded / event.total) * 100)}%）`, "loading");
			};
			xhr.onload = () => {
				let payload = {}; try { payload = JSON.parse(xhr.responseText || "{}"); } catch { /* handled below */ }
				if (xhr.status >= 200 && xhr.status < 300 && payload.ok !== false) resolve({ ok: true, item: payload.item });
				else resolve({ ok: false, error: apiError(payload, "上传失败") });
			};
			xhr.onerror = () => resolve({ ok: false, error: new Error("上传连接失败") });
			xhr.onabort = () => resolve({ ok: false, cancelled: true, error: new Error("上传已取消") });
			xhr.send(formData);
		});
	}

	async function startUpload() {
		if (uploadActive) return;
		const kind = uploadKind?.value || "image";
		const files = [...(uploadInput?.files || [])];
		if (!files.length) { setUploadStatus("请先选择要上传的文件。", "error"); return; }
		const accepted = new Set(acceptedExtensions(kind));
		const invalid = files.find((file) => !accepted.has(file.name.split(".").pop()?.toLowerCase()));
		if (invalid) { setUploadStatus(`“${invalid.name}”与当前上传类型不匹配。`, "error"); return; }
		uploadQueue = files; uploadActive = true; uploadStart && (uploadStart.disabled = true); uploadCancel?.classList.remove("hidden");
		let success = 0; let failed = 0; let cancelled = false;
		for (let index = 0; index < uploadQueue.length; index += 1) {
			if (!uploadActive) { cancelled = true; break; }
			const result = await uploadOne(uploadQueue[index], kind, index + 1, uploadQueue.length);
			currentXhr = null;
			if (result.ok) success += 1; else if (result.cancelled) { cancelled = true; break; } else { failed += 1; setUploadStatus(`${uploadQueue[index].name} 上传失败：${result.error.message}`, "error"); }
		}
		uploadActive = false; uploadQueue = []; uploadStart && (uploadStart.disabled = false); uploadCancel?.classList.add("hidden");
		if (uploadInput) uploadInput.value = "";
		setUploadStatus(cancelled ? `上传已取消；已完成 ${success} 个。` : `上传完成：成功 ${success} 个，失败 ${failed} 个。`, cancelled || failed ? "error" : "ready");
		await load();
	}

	function cancelUpload() {
		if (!uploadActive) return;
		uploadActive = false; currentXhr?.abort(); setUploadStatus("正在取消当前上传…", "loading");
	}

	function bind() {
		if (bound) return; bound = true; updateUploadKindHint();
		for (const button of kindButtons) button.addEventListener("click", () => {
			currentKind = button.dataset.mediaKind || "all"; kindButtons.forEach((item) => item.classList.toggle("active", item === button)); load();
		});
		searchInput?.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (currentView === "library") load(); }, 220); });
		refreshButton?.addEventListener("click", () => load()); retryButton?.addEventListener("click", () => load());
		libraryTab?.addEventListener("click", () => setView("library")); transcodeTab?.addEventListener("click", () => setView("transcode")); trashTab?.addEventListener("click", () => setView("trash"));
		uploadKind?.addEventListener("change", updateUploadKindHint); uploadStart?.addEventListener("click", startUpload); uploadCancel?.addEventListener("click", cancelUpload);
	}

	bind();
	return {
		load,
		isDirty: () => uploadActive,
		canLeave: () => {
			if (!uploadActive) return true;
			if (!window.confirm("媒体上传正在进行。离开会取消当前上传和未开始的队列，确定离开吗？")) return false;
			cancelUpload(); return true;
		},
	};
}
