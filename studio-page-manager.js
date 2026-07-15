import { debounce, requestJson, setStatus, textStats } from "./studio-cms-utils.js";

const DB_NAME = "FireflyStudioContentDrafts";
const STORE_NAME = "drafts";
const DRAFT_KEY = "page:about";

function openDraftDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function getDraft() { const db = await openDraftDb(); return new Promise((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readonly"); const request = tx.objectStore(STORE_NAME).get(DRAFT_KEY); request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); }); }
async function putDraft(value) { const db = await openDraftDb(); return new Promise((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
async function clearDraft() { const db = await openDraftDb(); return new Promise((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readwrite"); tx.objectStore(STORE_NAME).delete(DRAFT_KEY); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }

export function createPageManager() {
	const textarea = document.querySelector("#aboutContent");
	const preview = document.querySelector("#aboutPreview");
	const stats = document.querySelector("#aboutStats");
	const status = document.querySelector("#aboutStatus");
	const saveButton = document.querySelector("#aboutSave");
	const discardButton = document.querySelector("#aboutDiscard");
	let baseline = "";
	let revision = "";
	let composing = false;
	let previewController = null;
	let previewSequence = 0;
	let draftAvailable = true;

	const isDirty = () => textarea.value !== baseline;
	const paintStats = () => { const value = textStats(textarea.value); stats.textContent = `字符 ${value.characters} · 中文 ${value.chinese} · 英文词 ${value.english}`; };
	const paintStatus = (message = isDirty() ? "未保存 · 本地草稿保护中" : "已保存", tone = isDirty() ? "dirty" : "good") => setStatus(status, message, tone);
	const queuePreview = debounce(renderPreview, 400);
	const queueDraft = debounce(saveDraft, 700);

	async function saveDraft() {
		if (!isDirty() || !draftAvailable) return;
		try { await putDraft({ key: DRAFT_KEY, content: textarea.value, revision, savedAt: Date.now() }); }
		catch { draftAvailable = false; setStatus(status, "本地草稿保护不可用，仍可手动保存", "bad"); }
	}

	async function renderPreview() {
		const sequence = ++previewSequence;
		previewController?.abort();
		previewController = new AbortController();
		if (!textarea.value.trim()) { preview.innerHTML = "<p>开始输入后，这里会显示安全的 Markdown 预览。</p>"; return; }
		try {
			const response = await fetch("/api/posts/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: textarea.value }), signal: previewController.signal });
			const payload = await response.json();
			if (!response.ok) throw new Error(payload.error || "预览失败");
			if (sequence !== previewSequence) return;
			preview.innerHTML = payload.html || "<p>没有可预览的内容。</p>";
		} catch (error) {
			if (error.name !== "AbortError" && sequence === previewSequence) preview.innerHTML = `<p>预览暂时不可用：${String(error.message || "未知错误")}</p>`;
		}
	}

	function updateEditor() { if (composing) return; paintStats(); paintStatus(); queueDraft(); queuePreview(); }

	async function load() {
		setStatus(status, "正在读取关于我");
		const server = await requestJson("/api/pages/about");
		baseline = server.content; revision = server.revision; textarea.value = baseline;
		try {
			const draft = await getDraft();
			if (draft?.content && draft.content !== baseline) {
				const restore = confirm("发现一份尚未保存的关于我本地草稿。确定恢复它吗？选择取消会保留磁盘版本并删除这份草稿。");
				if (restore) textarea.value = draft.content; else await clearDraft();
			}
		} catch { draftAvailable = false; }
		paintStats(); paintStatus(); await renderPreview();
	}

	async function save() {
		if (!isDirty()) return paintStatus("没有需要保存的修改", "good");
		setStatus(status, "正在保存"); saveButton.disabled = true;
		try {
			const saved = await requestJson("/api/pages/about", { method: "POST", body: JSON.stringify({ content: textarea.value, revision }) });
			baseline = saved.content; revision = saved.revision; textarea.value = baseline;
			await clearDraft().catch(() => {}); paintStats(); paintStatus("保存成功", "good");
		} catch (error) { setStatus(status, error.status === 409 ? "与磁盘版本冲突，请重新读取后再保存" : error.message, "bad"); }
		finally { saveButton.disabled = false; }
	}

	async function discard() {
		if (isDirty() && !confirm("放弃当前未保存内容并恢复磁盘版本吗？")) return;
		await clearDraft().catch(() => {}); textarea.value = baseline; paintStats(); paintStatus("已恢复磁盘版本", "good"); await renderPreview();
	}

	textarea.addEventListener("compositionstart", () => { composing = true; });
	textarea.addEventListener("compositionend", () => { composing = false; updateEditor(); });
	textarea.addEventListener("input", updateEditor);
	saveButton.addEventListener("click", save);
	discardButton.addEventListener("click", discard);
	return { load, isDirty, canLeave: () => !isDirty() || confirm("关于我页面尚未保存。要离开并保留本地草稿吗？") };
}
