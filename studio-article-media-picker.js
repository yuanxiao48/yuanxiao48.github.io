(() => {
	const acceptedExtensions = {
		image: ["jpg", "jpeg", "png", "webp", "avif", "gif"],
		audio: ["mp3", "m4a", "aac", "wav", "ogg", "flac"],
		video: ["mp4", "webm", "mov"],
	};

	const state = {
		mode: "audio",
		source: "local",
		posterMode: false,
		items: [],
		selectedMedia: null,
		selectedPoster: null,
		onInsert: null,
		uploading: false,
		requestSequence: 0,
		searchTimer: null,
	};

	const picker = document.querySelector("#articleMediaPicker");
	const title = document.querySelector("#articleMediaPickerTitle");
	const sourceTabs = document.querySelector("#articleMediaSourceTabs");
	const localPanel = document.querySelector("#articleMediaLocalPanel");
	const externalPanel = document.querySelector("#articleMediaExternalPanel");
	const stateText = document.querySelector("#articleMediaPickerState");
	const grid = document.querySelector("#articleMediaGrid");
	const search = document.querySelector("#articleMediaSearch");
	const uploadInput = document.querySelector("#articleMediaUpload");
	const uploadStatus = document.querySelector("#articleMediaUploadStatus");
	const selection = document.querySelector("#articleMediaSelection");
	const confirmButton = document.querySelector("#confirmArticleMediaPicker");
	const caption = document.querySelector("#articleMediaCaption");
	const preload = document.querySelector("#articleMediaPreload");
	const preloadLabel = document.querySelector("#articleMediaPreloadField");
	const posterField = document.querySelector("#articleVideoPosterField");
	const posterPath = document.querySelector("#articleVideoPosterPath");
	const externalUrl = document.querySelector("#articleExternalVideoUrl");
	const externalResult = document.querySelector("#articleExternalVideoResult");

	function sessionToken() {
		return document.querySelector('meta[name="studio-session-token"]')?.content || "";
	}

	function studioAssetUrl(publicPath) {
		const relative = String(publicPath || "").replace(/^\/assets\//, "");
		return `/studio-assets/${relative.split("/").map(encodeURIComponent).join("/")}`;
	}

	function visibleLibraryKind() {
		return state.posterMode ? "image" : state.mode;
	}

	function formatBytes(value) {
		const bytes = Number(value);
		if (!Number.isFinite(bytes)) return "unknown size";
		if (bytes < 1024) return `${bytes} B`;
		return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
	}

	function setState(message, kind = "") {
		if (!stateText) return;
		stateText.textContent = message;
		stateText.dataset.state = kind;
	}

	function setUploadStatus(message, kind = "") {
		if (!uploadStatus) return;
		uploadStatus.textContent = message;
		uploadStatus.dataset.state = kind;
	}

	function renderSelection() {
		const active = state.source === "external" ? null : state.selectedMedia;
		if (selection) selection.textContent = state.source === "external" ? "将验证外部视频链接" : active?.publicPath || "尚未选择媒体";
		if (posterPath) posterPath.textContent = state.selectedPoster?.publicPath || "未选择封面";
		if (confirmButton) confirmButton.disabled = state.source === "external" ? !externalUrl?.value.trim() : !state.selectedMedia;
	}

	function clearNode(node) {
		if (node) node.replaceChildren();
	}

	function previewFor(item) {
		if (item.kind === "image") {
			const image = document.createElement("img");
			image.src = studioAssetUrl(item.publicPath);
			image.alt = item.name;
			image.loading = "lazy";
			return image;
		}
		const media = document.createElement(item.kind === "audio" ? "audio" : "video");
		media.src = studioAssetUrl(item.publicPath);
		media.controls = true;
		media.preload = "metadata";
		if (item.kind === "video") {
			media.playsInline = true;
			const wrapper = document.createElement("div");
			wrapper.className = "article-media-video-preview";
			const compatibilityNotice = Object.assign(document.createElement("span"), {
				className: "article-media-video-compatibility",
				textContent: "文件已上传，但浏览器可能不支持其视频编码。建议转换为 H.264 + AAC 的 MP4。",
				hidden: true,
			});
			const showCompatibilityNotice = () => { compatibilityNotice.hidden = false; };
			media.addEventListener("error", showCompatibilityNotice);
			media.addEventListener("loadedmetadata", () => {
				if (media.videoWidth === 0 || media.videoHeight === 0) showCompatibilityNotice();
			});
			wrapper.append(media, compatibilityNotice);
			return wrapper;
		}
		return media;
	}

	function renderItems() {
		clearNode(grid);
		if (!grid) return;
		if (!state.items.length) {
			const empty = document.createElement("p");
			empty.className = "article-media-picker-state";
			empty.textContent = search?.value.trim() ? "没有匹配的媒体文件。" : "这个分类暂时没有可用媒体。";
			grid.append(empty);
			return;
		}
		for (const item of state.items) {
			const selected = state.posterMode ? state.selectedPoster?.publicPath === item.publicPath : state.selectedMedia?.publicPath === item.publicPath;
			const card = document.createElement("button");
			card.type = "button";
			card.className = "article-media-card";
			card.classList.toggle("selected", selected);
			const heading = document.createElement("strong");
			heading.textContent = item.name;
			const details = document.createElement("span");
			details.textContent = `${item.kind} · ${formatBytes(item.size)}`;
			const path = document.createElement("code");
			path.textContent = item.publicPath;
			card.append(previewFor(item), heading, details, path);
			card.addEventListener("click", () => selectItem(item));
			grid.append(card);
		}
	}

	function selectItem(item) {
		if (state.posterMode) {
			state.selectedPoster = item;
			state.posterMode = false;
			setState("封面已选择。继续选择本地视频。");
			loadLibrary();
		} else {
			state.selectedMedia = item;
			renderItems();
			setState(`已选择 ${item.name}。`);
		}
		renderSelection();
	}

	async function loadLibrary() {
		if (state.source !== "local") return;
		const sequence = ++state.requestSequence;
		const kind = visibleLibraryKind();
		setState(state.posterMode ? "正在读取封面图片库…" : "正在读取媒体库…", "loading");
		clearNode(grid);
		try {
			const params = new URLSearchParams({ kind });
			if (search?.value.trim()) params.set("search", search.value.trim());
			const response = await fetch(`/api/media?${params.toString()}`, { cache: "no-store" });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload.ok === false) throw new Error(payload.error || "无法读取媒体库");
			if (sequence !== state.requestSequence) return;
			state.items = Array.isArray(payload.items) ? payload.items : [];
			setState(state.items.length ? `已读取 ${state.items.length} 个文件。` : "媒体库为空。", state.items.length ? "ready" : "empty");
			renderItems();
		} catch (error) {
			if (sequence !== state.requestSequence) return;
			state.items = [];
			setState(error.message || "媒体库加载失败。", "error");
			renderItems();
		}
	}

	function updateModeUi() {
		const external = state.mode === "video" && state.source === "external";
		sourceTabs?.classList.toggle("hidden", state.mode !== "video");
		localPanel?.classList.toggle("hidden", external);
		externalPanel?.classList.toggle("hidden", !external);
		posterField?.classList.toggle("hidden", state.mode !== "video" || external);
		preload?.classList.toggle("hidden", external);
		preloadLabel?.classList.toggle("hidden", external);
		for (const button of document.querySelectorAll("[data-article-media-source]")) {
			const active = button.dataset.articleMediaSource === state.source;
			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		}
		if (title) title.textContent = state.mode === "audio" ? "插入正文音频" : external ? "插入外部视频" : "插入正文视频";
		if (confirmButton) confirmButton.textContent = external ? "插入外部视频" : "插入正文";
		if (uploadInput) uploadInput.accept = acceptedExtensions[visibleLibraryKind()].map((extension) => `.${extension}`).join(",");
	}

	function setSource(next) {
		if (next !== "local" && next !== "external") return;
		state.source = next;
		state.posterMode = false;
		state.items = [];
		updateModeUi();
		renderSelection();
		if (next === "local") loadLibrary();
	}

	function close() {
		if (!picker || state.uploading) {
			if (state.uploading) setUploadStatus("上传仍在进行，请等待完成。", "loading");
			return;
		}
		picker.classList.add("hidden");
		picker.setAttribute("aria-hidden", "true");
	}

	function open(options = {}) {
		if (!picker) return;
		state.mode = options.mode === "video" ? "video" : "audio";
		state.source = "local";
		state.posterMode = false;
		state.selectedMedia = null;
		state.selectedPoster = null;
		state.onInsert = typeof options.onInsert === "function" ? options.onInsert : null;
		state.items = [];
		if (search) search.value = "";
		if (caption) caption.value = "";
		if (preload) preload.value = "metadata";
		if (externalUrl) externalUrl.value = "";
		if (externalResult) externalResult.textContent = "仅接受 YouTube 和 Bilibili 的普通视频链接。";
		if (uploadInput) uploadInput.value = "";
		setUploadStatus("");
		updateModeUi();
		renderSelection();
		picker.classList.remove("hidden");
		picker.setAttribute("aria-hidden", "false");
		loadLibrary();
		setTimeout(() => search?.focus(), 0);
	}

	function uploadMedia() {
		if (state.uploading) return;
		const file = uploadInput?.files?.[0];
		const kind = visibleLibraryKind();
		if (!file) {
			setUploadStatus("请先选择一个文件。", "error");
			return;
		}
		const extension = file.name.split(".").pop()?.toLowerCase() || "";
		if (!acceptedExtensions[kind].includes(extension)) {
			setUploadStatus("文件扩展名与当前媒体类型不匹配。", "error");
			return;
		}
		state.uploading = true;
		setUploadStatus(`正在上传 ${file.name}…`, "loading");
		const form = new FormData();
		form.append("file", file, file.name);
		fetch(`/api/media?kind=${encodeURIComponent(kind)}`, {
			method: "POST",
			headers: { "x-studio-session": sessionToken() },
			body: form,
		})
			.then(async (response) => {
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || payload.ok === false) throw new Error(payload.error || "上传失败");
				setUploadStatus("上传成功，已选中新文件。", "ready");
				if (uploadInput) uploadInput.value = "";
				state.posterMode = kind === "image";
				await loadLibrary();
				const uploaded = state.items.find((item) => item.publicPath === payload.item?.publicPath);
				if (!uploaded) throw new Error("文件已上传，但未能在媒体库中找到它。");
				selectItem(uploaded);
			})
			.catch((error) => setUploadStatus(error.message || "上传失败。", "error"))
			.finally(() => { state.uploading = false; });
	}

	async function normaliseExternalVideo() {
		const value = externalUrl?.value.trim() || "";
		if (!value) throw new Error("请先输入视频链接。");
		if (externalResult) externalResult.textContent = "正在验证视频链接…";
		const response = await fetch("/api/media/embed/normalize", {
			method: "POST",
			headers: { "content-type": "application/json", "x-studio-session": sessionToken() },
			body: JSON.stringify({ url: value }),
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok || payload.ok === false) throw new Error(payload.error || "该视频链接不受支持。");
		if (externalResult) externalResult.textContent = `已识别为 ${payload.provider === "youtube" ? "YouTube" : "Bilibili"} 视频。`;
		return payload;
	}

	async function confirm() {
		if (!state.onInsert) return;
		try {
			let payload;
			if (state.source === "external") {
				payload = { kind: "external", ...(await normaliseExternalVideo()), caption: caption?.value || "" };
			} else {
				if (!state.selectedMedia) throw new Error("请先选择媒体文件。");
				payload = {
					kind: state.mode,
					publicPath: state.selectedMedia.publicPath,
					caption: caption?.value || "",
					preload: preload?.value === "none" ? "none" : "metadata",
					posterPath: state.mode === "video" ? state.selectedPoster?.publicPath || "" : "",
				};
			}
			state.onInsert(payload);
			close();
		} catch (error) {
			setState(error.message || "无法插入媒体。", "error");
		}
	}

	function bind() {
		document.querySelector("#closeArticleMediaPicker")?.addEventListener("click", close);
		document.querySelector("#cancelArticleMediaPicker")?.addEventListener("click", close);
		document.querySelector("#refreshArticleMedia")?.addEventListener("click", loadLibrary);
		document.querySelector("#uploadArticleMedia")?.addEventListener("click", uploadMedia);
		document.querySelector("#chooseArticleVideoPoster")?.addEventListener("click", () => {
			state.posterMode = true;
			state.items = [];
			if (search) search.value = "";
			updateModeUi();
			setState("请选择 /assets/images/posts/ 中的封面图片。", "loading");
			loadLibrary();
		});
		document.querySelector("#clearArticleVideoPoster")?.addEventListener("click", () => {
			state.selectedPoster = null;
			renderSelection();
		});
		for (const button of document.querySelectorAll("[data-article-media-source]")) {
			button.addEventListener("click", () => setSource(button.dataset.articleMediaSource));
		}
		search?.addEventListener("input", () => {
			clearTimeout(state.searchTimer);
			state.searchTimer = setTimeout(loadLibrary, 220);
		});
		externalUrl?.addEventListener("input", () => {
			if (externalResult) externalResult.textContent = "点击插入时会验证并规范化链接。";
			renderSelection();
		});
		confirmButton?.addEventListener("click", confirm);
		picker?.addEventListener("click", (event) => { if (event.target === picker) close(); });
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !picker?.classList.contains("hidden")) close();
		});
	}

	bind();
	window.StudioArticleMediaPicker = { open };
})();
