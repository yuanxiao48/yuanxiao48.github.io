(() => {
const DB_NAME = "firefly-studio-drafts";
const DB_VERSION = 1;
const STORE_NAME = "article-drafts";
const ACTIVE_NEW_DRAFT_KEY = "firefly-studio-active-new-draft";
const DRAFT_DELAY = 700;
const PREVIEW_DELAY = 400;

const form = document.querySelector("#postForm");
const body = document.querySelector("#post-body");
const dirtyState = document.querySelector("#editorDirtyState");
const stats = document.querySelector("#editorStats");
const updatedOutput = document.querySelector("#post-updated");
const publishedHint = document.querySelector("#postPublishedHint");
const pathInput = document.querySelector("#editingPostPath");
const contextTitle = document.querySelector("#editorContextTitle");
const contextPath = document.querySelector("#editorContextPath");
const preview = document.querySelector("#markdownPreview");
const previewViewport = document.querySelector("#markdownPreviewViewport");
const previewStatus = document.querySelector("#markdownPreviewStatus");
const previewWarnings = document.querySelector("#markdownPreviewWarnings");
const previewTabButtons = document.querySelectorAll("[data-article-side-tab]");
const previewPanels = document.querySelectorAll("[data-article-side-panel]");
const imagePicker = document.querySelector("#articleImagePicker");
const imagePickerTitle = document.querySelector("#articleImagePickerTitle");
const imagePickerState = document.querySelector("#articleImagePickerState");
const imagePickerGrid = document.querySelector("#articleImageGrid");
const imagePickerSearch = document.querySelector("#articleImageSearch");
const imagePickerUpload = document.querySelector("#articleImageUpload");
const imagePickerUploadStatus = document.querySelector("#articleImageUploadStatus");
const imagePickerAltField = document.querySelector("#articleImageAltField");
const imagePickerAlt = document.querySelector("#articleImageAlt");
const imagePickerSelection = document.querySelector("#articleImageSelection");
const imagePickerConfirm = document.querySelector("#confirmArticleImagePicker");
const coverPreview = document.querySelector("#postCoverPreview");
const coverPreviewImage = document.querySelector("#postCoverPreviewImage");
const coverPreviewPath = document.querySelector("#postCoverPreviewPath");
const coverHint = document.querySelector("#postCoverHint");
const fields = [
	"title",
	"slug",
	"category",
	"tags",
	"description",
	"image",
	"published",
	"draft",
	"pinned",
	"comment",
	"body",
];

let draftKey = "";
let articlePath = "";
let serverUpdated = "";
let baselineHash = "";
let baselineState = null;
let saveTimer = null;
let composing = false;
let database = null;
let draftProtectionAvailable = true;
let previewTimer = null;
let previewAbortController = null;
let previewRequestSequence = 0;
let imagePickerMode = "insert";
let imagePickerImages = [];
let imagePickerSelected = null;
let imagePickerUploading = false;
let legacyPublished = "";
let newDraftPublishedIsAuto = true;

function field(id) {
	return document.querySelector(`#post-${id}`);
}

function shanghaiParts(date) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type) => parts.find((part) => part.type === type)?.value || "";
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
	};
}

function isLegacyDate(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isTimestamp(value) {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value || ""));
}

function localDate() {
	const parts = shanghaiParts(new Date());
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function toShanghaiTimestamp(value) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value || ""))) return "";
	const candidate = new Date(`${value}:00+08:00`);
	if (Number.isNaN(candidate.getTime())) return "";
	const parts = shanghaiParts(candidate);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === value
		? `${value}:00+08:00`
		: "";
}

function toStudioDateTime(value) {
	if (!isTimestamp(value)) return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const parts = shanghaiParts(date);
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function formatTimestamp(value) {
	if (!value) return "";
	if (isLegacyDate(value)) return value;
	const local = toStudioDateTime(value);
	return local ? local.replace("T", " ") : String(value);
}

function updatePublishedHint() {
	if (!publishedHint) return;
	publishedHint.textContent = legacyPublished
		? "该文章只有日期，没有具体发布时间。填写时间后才会升级为精确时间。"
		: "使用中国标准时间（Asia/Shanghai）。";
}

function setPublishedValue(value, { auto = false } = {}) {
	legacyPublished = isLegacyDate(value) ? String(value) : "";
	const localValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(value || ""))
		? String(value)
		: toStudioDateTime(value);
	field("published").value = legacyPublished ? "" : localValue;
	newDraftPublishedIsAuto = auto;
	updatePublishedHint();
}

function storedPublishedValue() {
	const datetime = field("published").value;
	return datetime ? toShanghaiTimestamp(datetime) : legacyPublished;
}

function randomDraftId() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stableHash(value) {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function editorState() {
	return {
		title: field("title").value.trim(),
		slug: field("slug").value.trim(),
		category: field("category").value.trim(),
		tags: field("tags").value,
		description: field("description").value,
		image: field("image").value.trim(),
		published: storedPublishedValue(),
		publishedAuto: newDraftPublishedIsAuto,
		draft: field("draft").checked,
		pinned: field("pinned").checked,
		comment: field("comment").checked,
		body: body.value,
	};
}

function applyEditorState(state) {
	for (const name of fields) {
		if (name === "published") continue;
		const input = name === "body" ? body : field(name);
		if (!input || !Object.hasOwn(state, name)) continue;
		if (input.type === "checkbox") input.checked = Boolean(state[name]);
		else input.value = state[name] ?? "";
	}
	setPublishedValue(state.published || "", { auto: Boolean(state.publishedAuto) });
	updateStats();
	updateCoverPreview();
	schedulePreview();
}

function currentHash() {
	return stableHash(JSON.stringify(editorState()));
}

function isDirty() {
	return Boolean(baselineHash) && currentHash() !== baselineHash;
}

function updateStateLabel(message = "") {
	const dirty = isDirty();
	dirtyState.classList.toggle("dirty", dirty);
	dirtyState.classList.toggle("warning", !draftProtectionAvailable);
	if (!draftProtectionAvailable) {
		dirtyState.textContent = dirty ? "未保存 · 本地草稿保护不可用" : "本地草稿保护不可用";
		return;
	}
	dirtyState.textContent = message || (dirty ? "未保存，本地草稿保护中" : "已保存");
}

function updateStats() {
	const text = body.value;
	const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
	const englishWords = (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
	const minutes = Math.max(1, Math.ceil(chinese / 300 + englishWords / 200));
	stats.textContent = `字符 ${text.length} · 中文 ${chinese} · 英文词 ${englishWords} · 预计 ${minutes} 分钟`;
}

function updateContext() {
	if (!contextTitle || !contextPath) return;
	if (articlePath) {
		contextTitle.textContent = `正在编辑：${field("title").value.trim() || "未命名文章"}`;
		contextPath.textContent = articlePath;
		return;
	}
	contextTitle.textContent = "新建文章";
	contextPath.textContent = `本地草稿 ${draftKey ? draftKey.slice(0, 20) : "准备中"}`;
}

function openDatabase() {
	if (database) return Promise.resolve(database);
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
			}
		};
		request.onsuccess = () => {
			database = request.result;
			resolve(database);
		};
		request.onerror = () => reject(request.error || new Error("Unable to open local drafts"));
	});
}

async function withStore(mode, operation) {
	try {
		const db = await openDatabase();
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, mode);
			const store = transaction.objectStore(STORE_NAME);
			const request = operation(store);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error || new Error("Local draft operation failed"));
		});
	} catch (error) {
		draftProtectionAvailable = false;
		updateStateLabel();
		window.dispatchEvent(new CustomEvent("studio-editor-warning", { detail: "本地草稿保护不可用，请及时正式保存文章。" }));
		throw error;
	}
}

function getDraft(key) {
	return withStore("readonly", (store) => store.get(key));
}

function putDraft(record) {
	return withStore("readwrite", (store) => store.put(record));
}

function removeDraft(key) {
	if (!key) return Promise.resolve();
	return withStore("readwrite", (store) => store.delete(key));
}

async function persistDraft() {
	if (!draftProtectionAvailable || !draftKey || !isDirty()) return;
	clearTimeout(saveTimer);
	try {
		await putDraft({
			key: draftKey,
			articlePath,
			newDraftId: articlePath ? "" : draftKey.replace(/^new:/, ""),
			data: editorState(),
			baseHash: baselineHash,
			serverUpdated,
			savedAt: new Date().toISOString(),
		});
		updateStateLabel("未保存，本地草稿已更新");
	} catch {
		// withStore has already notified the Studio about unavailable protection.
	}
}

function previewIsActive() {
	return document.querySelector('[data-article-side-panel="preview"]:not(.hidden)') !== null;
}

function setPreviewStatus(message, type = "") {
	if (!previewStatus) return;
	previewStatus.textContent = message;
	previewStatus.className = `preview-status ${type}`.trim();
}

function setPreviewWarnings(warnings = []) {
	if (!previewWarnings) return;
	previewWarnings.textContent = warnings.join(" ");
	previewWarnings.classList.toggle("hidden", warnings.length === 0);
}

function renderPreviewMessage(message, className = "preview-empty") {
	if (!preview) return;
	preview.replaceChildren();
	const paragraph = document.createElement("p");
	paragraph.className = className;
	paragraph.textContent = message;
	preview.append(paragraph);
}

function cancelPreviewRequest() {
	clearTimeout(previewTimer);
	previewTimer = null;
	previewRequestSequence += 1;
	previewAbortController?.abort();
	previewAbortController = null;
}

async function refreshPreview() {
	clearTimeout(previewTimer);
	previewTimer = null;
	if (!preview || !previewIsActive()) return;
	const markdown = body.value;
	if (!markdown.trim()) {
		cancelPreviewRequest();
		renderPreviewMessage("正文为空，开始写作后会在这里显示预览。");
		setPreviewWarnings();
		setPreviewStatus("正文为空");
		return;
	}
	previewAbortController?.abort();
	const controller = new AbortController();
	previewAbortController = controller;
	const requestSequence = ++previewRequestSequence;
	setPreviewStatus("正在渲染", "loading");
	try {
		const response = await fetch("/api/posts/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ markdown }),
			signal: controller.signal,
		});
		const payload = await response.json().catch(() => ({}));
		if (requestSequence !== previewRequestSequence || controller.signal.aborted) return;
		if (!response.ok) throw new Error(payload.error || "预览渲染失败");
		if (payload.html?.trim()) preview.innerHTML = payload.html;
		else renderPreviewMessage("内容已通过安全过滤，当前没有可显示的预览。");
		setPreviewWarnings(Array.isArray(payload.warnings) ? payload.warnings : []);
		setPreviewStatus("已更新");
	} catch (error) {
		if (controller.signal.aborted || requestSequence !== previewRequestSequence) return;
		renderPreviewMessage(error.message || "预览渲染失败，请继续编辑或稍后重试。", "preview-empty");
		setPreviewWarnings();
		setPreviewStatus("渲染失败", "error");
	} finally {
		if (previewAbortController === controller) previewAbortController = null;
	}
}

function schedulePreview({ immediate = false } = {}) {
	if (!previewIsActive()) return;
	clearTimeout(previewTimer);
	if (immediate) {
		refreshPreview();
		return;
	}
	previewTimer = setTimeout(() => refreshPreview(), PREVIEW_DELAY);
}

function selectArticleSidePanel(name) {
	for (const button of previewTabButtons) {
		const active = button.dataset.articleSideTab === name;
		button.classList.toggle("active", active);
		button.setAttribute("aria-selected", String(active));
	}
	for (const panel of previewPanels) {
		panel.classList.toggle("hidden", panel.dataset.articleSidePanel !== name);
	}
	if (name === "preview") schedulePreview({ immediate: true });
	else cancelPreviewRequest();
}

function bindPreview() {
	for (const button of previewTabButtons) {
		button.addEventListener("click", () => selectArticleSidePanel(button.dataset.articleSideTab));
	}
	for (const button of document.querySelectorAll("[data-preview-width]")) {
		button.addEventListener("click", () => {
			const width = button.dataset.previewWidth;
			for (const option of document.querySelectorAll("[data-preview-width]")) {
				option.classList.toggle("active", option.dataset.previewWidth === width);
			}
			if (previewViewport) previewViewport.dataset.previewWidth = width;
		});
	}
}

function isDeployableArticleImagePath(value) {
	const imagePath = String(value || "").trim();
	return Boolean(
		imagePath &&
		imagePath.startsWith("/assets/images/") &&
		!imagePath.startsWith("/studio-assets/") &&
		!imagePath.includes("\\") &&
		!imagePath.includes("\0") &&
		!imagePath.includes("../") &&
		!imagePath.includes("/..") &&
		!/^file:/i.test(imagePath) &&
		!/^[a-z]:[\\/]/i.test(imagePath) &&
		/\.(avif|gif|jpe?g|png|svg|webp)$/i.test(imagePath),
	);
}

function imagePathPreviewUrl(imagePath) {
	return `/api/image-file?path=${encodeURIComponent(imagePath)}`;
}

function formatFileSize(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateCoverPreview() {
	const imagePath = field("image")?.value.trim() || "";
	const clearButton = document.querySelector("#clearPostCover");
	if (!imagePath) {
		coverPreview?.classList.add("hidden");
		if (coverHint) coverHint.textContent = "图片会保留在图片库中；清除封面不会删除图片文件。";
		if (clearButton) clearButton.disabled = true;
		return;
	}
	if (!isDeployableArticleImagePath(imagePath)) {
		coverPreview?.classList.add("hidden");
		if (coverHint) coverHint.textContent = "当前封面不是可部署的公共图片路径，图片库不会改写它。";
		if (clearButton) clearButton.disabled = false;
		return;
	}
	if (coverPreviewImage) coverPreviewImage.src = imagePathPreviewUrl(imagePath);
	if (coverPreviewPath) coverPreviewPath.textContent = imagePath;
	coverPreview?.classList.remove("hidden");
	if (coverHint) coverHint.textContent = "图片会保留在图片库中；清除封面不会删除图片文件。";
	if (clearButton) clearButton.disabled = false;
}

function setCoverImage(imagePath) {
	if (!isDeployableArticleImagePath(imagePath)) {
		throw new Error("只能使用图片库返回的 /assets/images/ 站内路径");
	}
	field("image").value = imagePath;
	updateCoverPreview();
	scheduleDraft();
}

function clearCoverImage() {
	if (!field("image")?.value) return;
	field("image").value = "";
	updateCoverPreview();
	scheduleDraft();
}

function setImagePickerState(message) {
	if (imagePickerState) imagePickerState.textContent = message;
}

function selectedImageName(image) {
	return String(image?.name || "图片").replace(/\.[^.]+$/, "") || "图片";
}

function renderImagePicker() {
	if (!imagePickerGrid) return;
	const query = imagePickerSearch?.value.trim().toLocaleLowerCase() || "";
	const visible = imagePickerImages.filter((image) =>
		`${image.name} ${image.path}`.toLocaleLowerCase().includes(query),
	);
	imagePickerGrid.replaceChildren();
	if (!visible.length) {
		setImagePickerState(query ? "没有符合搜索条件的公共图片。" : "还没有可用于文章的公共图片。");
		return;
	}
	setImagePickerState(`找到 ${visible.length} 张可用于文章的图片。`);
	for (const image of visible) {
		const card = document.createElement("button");
		card.type = "button";
		card.className = "article-image-card";
		card.classList.toggle("selected", image.path === imagePickerSelected?.path);
		const thumbnail = document.createElement("img");
		thumbnail.src = image.previewUrl || imagePathPreviewUrl(image.path);
		thumbnail.alt = image.name || "文章图片";
		thumbnail.loading = "lazy";
		const title = document.createElement("strong");
		title.textContent = image.name || "未命名图片";
		const pathText = document.createElement("span");
		pathText.textContent = image.path;
		const meta = document.createElement("span");
		meta.textContent = formatFileSize(image.size) || "公共图片";
		card.append(thumbnail, title, pathText, meta);
		card.addEventListener("click", () => selectImagePickerItem(image));
		imagePickerGrid.append(card);
	}
}

function selectImagePickerItem(image) {
	if (!image || !isDeployableArticleImagePath(image.path)) return;
	imagePickerSelected = image;
	if (imagePickerAlt && imagePickerMode === "insert") imagePickerAlt.value = selectedImageName(image);
	if (imagePickerSelection) imagePickerSelection.textContent = image.path;
	if (imagePickerConfirm) imagePickerConfirm.disabled = false;
	renderImagePicker();
}

async function loadImagePickerImages() {
	setImagePickerState("正在读取图片库…");
	if (imagePickerGrid) imagePickerGrid.replaceChildren();
	const response = await fetch("/api/images");
	if (!response.ok) {
		const payload = await response.json().catch(() => ({}));
		throw new Error(payload.error || "读取图片库失败");
	}
	const images = await response.json();
	imagePickerImages = images.filter(
		(image) => image?.scope === "public" && isDeployableArticleImagePath(image.path),
	);
	if (imagePickerSelected) {
		imagePickerSelected = imagePickerImages.find((image) => image.path === imagePickerSelected.path) || null;
	}
	if (!imagePickerSelected && imagePickerConfirm) imagePickerConfirm.disabled = true;
	if (imagePickerSelection) imagePickerSelection.textContent = imagePickerSelected?.path || "尚未选择图片";
	renderImagePicker();
}

function openImagePicker(mode) {
	if (!imagePicker) return;
	imagePickerMode = mode === "cover" ? "cover" : "insert";
	imagePickerSelected = null;
	if (imagePickerTitle) imagePickerTitle.textContent = imagePickerMode === "cover" ? "选择文章封面" : "插入正文图片";
	if (imagePickerConfirm) {
		imagePickerConfirm.textContent = imagePickerMode === "cover" ? "设为封面" : "插入正文";
		imagePickerConfirm.disabled = true;
	}
	if (imagePickerAltField) imagePickerAltField.classList.toggle("hidden", imagePickerMode !== "insert");
	if (imagePickerAlt) imagePickerAlt.value = "";
	if (imagePickerSelection) imagePickerSelection.textContent = "尚未选择图片";
	if (imagePickerUploadStatus) imagePickerUploadStatus.textContent = "";
	imagePicker.classList.remove("hidden");
	imagePicker.setAttribute("aria-hidden", "false");
	loadImagePickerImages().catch((error) => setImagePickerState(error.message || "图片库读取失败"));
}

function closeImagePicker() {
	if (!imagePicker || imagePickerUploading) {
		if (imagePickerUploading && imagePickerUploadStatus) imagePickerUploadStatus.textContent = "图片正在上传，请等待完成。";
		return;
	}
	imagePicker.classList.add("hidden");
	imagePicker.setAttribute("aria-hidden", "true");
}

function escapeMarkdownAlt(value) {
	return String(value || "图片")
		.replace(/[\[\]\r\n]/g, " ")
		.trim() || "图片";
}

function insertMarkdownImage(imagePath, alt) {
	if (!isDeployableArticleImagePath(imagePath)) {
		throw new Error("图片路径不安全，无法插入正文");
	}
	const start = body.selectionStart;
	const end = body.selectionEnd;
	const before = body.value.slice(0, start);
	const after = body.value.slice(end);
	const lineBefore = before.slice(before.lastIndexOf("\n") + 1);
	const nextNewline = after.indexOf("\n");
	const lineAfter = nextNewline === -1 ? after : after.slice(0, nextNewline);
	const prefix = lineBefore ? "\n" : "";
	const suffix = lineAfter ? "\n" : "";
	const markdown = `![${escapeMarkdownAlt(alt)}](${imagePath})`;
	body.setRangeText(`${prefix}${markdown}${suffix}`, start, end, "end");
	const cursor = start + prefix.length + markdown.length;
	body.selectionStart = cursor;
	body.selectionEnd = cursor;
	body.focus();
	scheduleDraft();
}

function readImageFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("读取图片失败"));
		reader.readAsDataURL(file);
	});
}

async function uploadPickerImage() {
	if (imagePickerUploading) return;
	const file = imagePickerUpload?.files?.[0];
	if (!file) throw new Error("请先选择一张图片");
	if (!/\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.name)) {
		throw new Error("请选择项目当前支持的图片格式");
	}
	imagePickerUploading = true;
	const uploadButton = document.querySelector("#uploadArticleImage");
	if (uploadButton) uploadButton.disabled = true;
	if (imagePickerUploadStatus) imagePickerUploadStatus.textContent = "正在上传图片…";
	try {
		const response = await fetch("/api/images", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				target: "article",
				filename: file.name,
				dataUrl: await readImageFileAsDataUrl(file),
			}),
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(payload.error || "上传图片失败");
		if (!isDeployableArticleImagePath(payload.path)) {
			throw new Error("上传接口返回了不安全的图片路径");
		}
		await loadImagePickerImages();
		const uploaded = imagePickerImages.find((image) => image.path === payload.path);
		if (!uploaded) throw new Error("图片已上传，但未能在图片库中找到它");
		selectImagePickerItem(uploaded);
		if (imagePickerUploadStatus) imagePickerUploadStatus.textContent = "上传成功，已选中新图片。";
	} finally {
		imagePickerUploading = false;
		if (uploadButton) uploadButton.disabled = false;
	}
}

function confirmImagePickerSelection() {
	if (!imagePickerSelected) return;
	if (imagePickerMode === "cover") setCoverImage(imagePickerSelected.path);
	else insertMarkdownImage(imagePickerSelected.path, imagePickerAlt?.value || selectedImageName(imagePickerSelected));
	closeImagePicker();
}

function bindImagePicker() {
	document.querySelector("#choosePostCover")?.addEventListener("click", () => openImagePicker("cover"));
	document.querySelector("#clearPostCover")?.addEventListener("click", clearCoverImage);
	document.querySelector("#closeArticleImagePicker")?.addEventListener("click", closeImagePicker);
	document.querySelector("#cancelArticleImagePicker")?.addEventListener("click", closeImagePicker);
	document.querySelector("#refreshArticleImages")?.addEventListener("click", () => {
		loadImagePickerImages().catch((error) => setImagePickerState(error.message || "图片库读取失败"));
	});
	document.querySelector("#uploadArticleImage")?.addEventListener("click", () => {
		uploadPickerImage().catch((error) => {
			if (imagePickerUploadStatus) imagePickerUploadStatus.textContent = error.message || "上传图片失败";
		});
	});
	imagePickerSearch?.addEventListener("input", renderImagePicker);
	imagePickerConfirm?.addEventListener("click", () => {
		try {
			confirmImagePickerSelection();
		} catch (error) {
			setImagePickerState(error.message || "无法使用这张图片");
		}
	});
	imagePicker?.addEventListener("click", (event) => {
		if (event.target === imagePicker) closeImagePicker();
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !imagePicker?.classList.contains("hidden")) {
			event.preventDefault();
			closeImagePicker();
		}
	});
	updateCoverPreview();
}

function scheduleDraft() {
	updateStats();
	updateContext();
	updateStateLabel();
	schedulePreview();
	if (!isDirty() || !draftProtectionAvailable) return;
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => persistDraft(), DRAFT_DELAY);
}

function dialog({ title, message, actions }) {
	return new Promise((resolve) => {
		const backdrop = document.createElement("div");
		backdrop.className = "studio-dialog-backdrop";
		backdrop.innerHTML = `
			<section class="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-dialog-title">
				<h3 id="studio-dialog-title"></h3>
				<p></p>
				<div class="studio-dialog-actions"></div>
			</section>`;
		backdrop.querySelector("h3").textContent = title;
		backdrop.querySelector("p").textContent = message;
		const actionsNode = backdrop.querySelector(".studio-dialog-actions");
		for (const action of actions) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = `btn ${action.primary ? "primary" : ""} ${action.danger ? "danger" : ""}`.trim();
			button.textContent = action.label;
			button.addEventListener("click", () => {
				backdrop.remove();
				resolve(action.value);
			});
			actionsNode.append(button);
		}
		document.body.append(backdrop);
		backdrop.querySelector("button")?.focus();
	});
}

async function discardDraftWithConfirmation(record) {
	const answer = await dialog({
		title: "丢弃本地草稿？",
		message: "此操作会删除浏览器中的未保存内容，无法撤销。",
		actions: [
			{ label: "返回", value: "cancel" },
			{ label: "确认丢弃", value: "discard", danger: true },
		],
	});
	if (answer !== "discard") return false;
	await removeDraft(record.key).catch(() => {});
	return true;
}

async function offerDraftRecovery(record, conflict) {
	const answer = await dialog({
		title: conflict ? "检测到版本差异" : "恢复本地草稿？",
		message: conflict
			? "服务器文章在本地草稿产生后发生了变化。恢复只会载入编辑器，仍需你手动保存。"
			: "发现一份比服务器版本更新的本地草稿。",
		actions: [
			{ label: "继续使用服务器版本", value: "server" },
			{ label: "丢弃本地草稿", value: "discard", danger: true },
			{ label: "恢复本地草稿", value: "restore", primary: true },
		],
	});
	if (answer === "restore") {
		applyEditorState(record.data);
		updateContext();
		updateStateLabel(conflict ? "未保存，本地草稿与服务器存在差异" : "未保存，已恢复本地草稿");
		return;
	}
	if (answer === "discard") await discardDraftWithConfirmation(record);
}

async function loadDraftForCurrentArticle() {
	if (!draftProtectionAvailable || !draftKey) return;
	let record;
	try {
		record = await getDraft(draftKey);
	} catch {
		return;
	}
	if (!record) return;
	const conflict = record.baseHash !== baselineHash || record.serverUpdated !== serverUpdated;
	await offerDraftRecovery(record, conflict);
}

function setBaseline(post = {}) {
	articlePath = post.path || pathInput.value || "";
	draftKey = articlePath || draftKey || `new:${randomDraftId()}`;
	serverUpdated = post.updated || updatedOutput.value || "";
	updatedOutput.value = formatTimestamp(serverUpdated) || "尚未保存";
	baselineState = editorState();
	baselineHash = currentHash();
	updateStats();
	updateContext();
	updateStateLabel();
}

async function loadServerPost(post) {
	cancelPreviewRequest();
	applyEditorState({
		title: post.title || "",
		slug: post.slug || "",
		category: post.category || "日常",
		tags: (post.tags || []).join(", "),
		description: post.description || "",
		image: post.image || post.cover || "",
		published: post.published || "",
		publishedAuto: false,
		draft: Boolean(post.draft),
		pinned: Boolean(post.pinned),
		comment: post.comment !== false,
		body: post.body || "",
	});
	pathInput.value = post.path || "";
	field("slug").disabled = true;
	setBaseline(post);
	await loadDraftForCurrentArticle();
}

async function beginNewDraft({ resume = false } = {}) {
	cancelPreviewRequest();
	articlePath = "";
	serverUpdated = "";
	updatedOutput.value = "尚未保存";
	setPublishedValue(field("published").value ? toShanghaiTimestamp(field("published").value) : localDate(), { auto: true });
	field("draft").checked = true;
	field("comment").checked = true;
	field("pinned").checked = false;
	field("slug").disabled = false;
	if (resume) {
		draftKey = localStorage.getItem(ACTIVE_NEW_DRAFT_KEY) || `new:${randomDraftId()}`;
	} else {
		draftKey = `new:${randomDraftId()}`;
		localStorage.setItem(ACTIVE_NEW_DRAFT_KEY, draftKey);
	}
	localStorage.setItem(ACTIVE_NEW_DRAFT_KEY, draftKey);
	baselineState = editorState();
	baselineHash = currentHash();
	updateStats();
	updateCoverPreview();
	updateContext();
	updateStateLabel();
	schedulePreview();
	if (resume) await loadDraftForCurrentArticle();
}

function preparePayload({ isEditing }) {
	const state = editorState();
	const payload = {
		title: state.title,
		category: state.category,
		tags: state.tags,
		description: state.description,
		image: state.image,
		draft: state.draft,
		pinned: state.pinned,
		comment: state.comment,
		body: state.body,
	};
	if (isEditing ? Boolean(field("published").value) : !state.publishedAuto) {
		payload.published = state.published;
	}
	if (!isEditing) payload.slug = state.slug;
	return payload;
}

async function markSaved(post, previousKey = draftKey) {
	const nextPath = post.path || articlePath;
	if (previousKey && previousKey !== nextPath) await removeDraft(previousKey).catch(() => {});
	if (nextPath) await removeDraft(nextPath).catch(() => {});
	if (previousKey.startsWith("new:")) localStorage.removeItem(ACTIVE_NEW_DRAFT_KEY);
	articlePath = nextPath;
	draftKey = nextPath || "";
	pathInput.value = nextPath;
	field("slug").disabled = Boolean(nextPath);
	serverUpdated = post.updated || serverUpdated;
	updatedOutput.value = formatTimestamp(serverUpdated) || "尚未保存";
	setPublishedValue(post.published || storedPublishedValue(), { auto: false });
	baselineState = editorState();
	baselineHash = currentHash();
	updateStats();
	updateContext();
	updateStateLabel("已保存");
}

async function discardChanges() {
	if (!isDirty()) return true;
	const answer = await dialog({
		title: "放弃未保存修改？",
		message: articlePath
			? "编辑器会恢复到刚刚读取的服务器版本，并清理这篇文章的本地草稿。"
			: "编辑器会清空当前新文章的未保存修改，并清理本地草稿。",
		actions: [
			{ label: "继续编辑", value: "cancel", primary: true },
			{ label: "确认放弃", value: "discard", danger: true },
		],
	});
	if (answer !== "discard") return false;
	await removeDraft(draftKey).catch(() => {});
	if (baselineState) applyEditorState(baselineState);
	baselineHash = currentHash();
	updateStats();
	updateContext();
	updateStateLabel(articlePath ? "已恢复服务器版本" : "已放弃新文章修改");
	return true;
}

async function confirmNavigation(label) {
	if (!isDirty()) return true;
	clearTimeout(saveTimer);
	await persistDraft();
	const answer = await dialog({
		title: "存在未保存修改",
		message: `切换${label}前，当前内容已尝试保存为本地草稿。要继续吗？`,
		actions: [
			{ label: "留在当前文章", value: "stay", primary: true },
			{ label: "继续切换", value: "continue" },
		],
	});
	return answer === "continue";
}

function replaceSelection(text, selectionStart, selectionEnd) {
	body.setRangeText(text, body.selectionStart, body.selectionEnd, "preserve");
	body.selectionStart = selectionStart;
	body.selectionEnd = selectionEnd;
	body.focus();
	scheduleDraft();
}

function wrapSelection(before, after, placeholder) {
	const start = body.selectionStart;
	const end = body.selectionEnd;
	const selected = body.value.slice(start, end);
	const inner = selected || placeholder;
	replaceSelection(`${before}${inner}${after}`, start + before.length, start + before.length + inner.length);
}

function selectedLineRange() {
	const start = body.selectionStart;
	const end = body.selectionEnd;
	const lineStart = body.value.lastIndexOf("\n", start - 1) + 1;
	const lineEndIndex = body.value.indexOf("\n", end);
	const lineEnd = lineEndIndex === -1 ? body.value.length : lineEndIndex;
	return { lineStart, lineEnd, text: body.value.slice(lineStart, lineEnd) };
}

function prefixLines(prefix) {
	const { lineStart, lineEnd, text } = selectedLineRange();
	const replacement = text
		.split("\n")
		.map((line) => `${prefix}${line || "内容"}`)
		.join("\n");
	body.setRangeText(replacement, lineStart, lineEnd, "select");
	body.focus();
	scheduleDraft();
}

function insertCodeBlock() {
	const start = body.selectionStart;
	const end = body.selectionEnd;
	const selected = body.value.slice(start, end) || "代码";
	replaceSelection(`\n\`\`\`text\n${selected}\n\`\`\`\n`, start + 9, start + 9 + selected.length);
}

function insertDivider() {
	const start = body.selectionStart;
	replaceSelection("\n\n---\n\n", start + 5, start + 5);
}

function runCommand(command) {
	if (command === "heading") prefixLines("# ");
	if (command === "bold") wrapSelection("**", "**", "粗体文本");
	if (command === "italic") wrapSelection("*", "*", "斜体文本");
	if (command === "strike") wrapSelection("~~", "~~", "删除线文本");
	if (command === "quote") prefixLines("> ");
	if (command === "link") wrapSelection("[", "](https://example.com)", "链接文本");
	if (command === "image") {
		openImagePicker("insert");
		return;
	}
	if (command === "ul") prefixLines("- ");
	if (command === "ol") {
		const { lineStart, lineEnd, text } = selectedLineRange();
		const replacement = text
			.split("\n")
			.map((line, index) => `${index + 1}. ${line || "内容"}`)
			.join("\n");
		body.setRangeText(replacement, lineStart, lineEnd, "select");
		body.focus();
		scheduleDraft();
	}
	if (command === "code") wrapSelection("`", "`", "代码");
	if (command === "codeblock") insertCodeBlock();
	if (command === "hr") insertDivider();
}

function indentSelection(reverse) {
	const { lineStart, lineEnd, text } = selectedLineRange();
	const replacement = text
		.split("\n")
		.map((line) => (reverse ? line.replace(/^(\t| {1,2})/, "") : `  ${line}`))
		.join("\n");
	body.setRangeText(replacement, lineStart, lineEnd, "select");
	body.focus();
	scheduleDraft();
}

function bindEditor() {
	bindPreview();
	bindImagePicker();
	for (const name of fields) {
		const input = name === "body" ? body : field(name);
		input?.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
			if (name === "published") {
				legacyPublished = "";
				newDraftPublishedIsAuto = false;
				updatePublishedHint();
			}
			if (!composing) scheduleDraft();
		});
	}
	body.addEventListener("compositionstart", () => {
		composing = true;
	});
	body.addEventListener("compositionend", () => {
		composing = false;
		scheduleDraft();
	});
	body.addEventListener("keydown", (event) => {
		if (event.isComposing || composing) return;
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && event.key.toLowerCase() === "b") {
			event.preventDefault();
			runCommand("bold");
		}
		if (modifier && event.key.toLowerCase() === "i") {
			event.preventDefault();
			runCommand("italic");
		}
		if (modifier && event.key.toLowerCase() === "k") {
			event.preventDefault();
			runCommand("link");
		}
		if (modifier && event.key.toLowerCase() === "s") {
			event.preventDefault();
			window.dispatchEvent(new CustomEvent("studio-editor-save-request"));
		}
		if (event.key === "Tab") {
			event.preventDefault();
			indentSelection(event.shiftKey);
		}
	});
	for (const button of document.querySelectorAll("[data-editor-command]")) {
		button.addEventListener("click", () => runCommand(button.dataset.editorCommand));
	}
	window.addEventListener("beforeunload", (event) => {
		if (!isDirty()) return;
		event.preventDefault();
		event.returnValue = "";
	});
}

async function initialize() {
	if (!form || !body) return;
	bindEditor();
	window.StudioEditor = {
		loadServerPost,
		beginNewDraft,
		preparePayload,
		markSaved,
		confirmNavigation,
		discardChanges,
		isDirty,
		formatTimestamp,
	};
	await beginNewDraft({ resume: true });
	window.dispatchEvent(new CustomEvent("studio-editor-ready"));
}

initialize().catch((error) => {
	console.error(error);
	const status = document.querySelector("#status");
	if (status) {
		status.textContent = `文章编辑模块初始化失败：${error.message || "未知错误"}`;
		status.className = "status bad";
	}
});
})();
