import { clone, escapeHtml, requestJson, setStatus } from "./studio-cms-utils.js";

export function createLayoutManager() {
	const status = document.querySelector("#layoutStatus");
	const saveButton = document.querySelector("#layoutSave");
	const lists = Object.fromEntries(["left", "right", "mobile"].map((area) => [area, document.querySelector(`[data-layout-list="${area}"]`)]));
	let state = null;
	let baseline = "";
	let drag = null;

	const snapshot = () => JSON.stringify(state?.layout || {});
	const dirty = () => Boolean(state) && snapshot() !== baseline;
	const paintStatus = (message = dirty() ? "未保存" : "已保存", tone = dirty() ? "dirty" : "good") => setStatus(status, message, tone);
	const widget = (type) => state.widgets.find((entry) => entry.type === type);

	function availableFor(area) {
		const used = new Set(state.layout[area].map((item) => item.type));
		return state.widgets.filter((entry) => !used.has(entry.type));
	}

	function renderAdders() {
		for (const select of document.querySelectorAll("[data-layout-add]")) {
			const area = select.dataset.layoutAdd;
			const options = availableFor(area).map((entry) => `<option value="${escapeHtml(entry.type)}">添加：${escapeHtml(entry.name)}</option>`).join("");
			select.innerHTML = `<option value="">添加组件…</option>${options}`;
		}
	}

	function render() {
		if (!state) return;
		for (const [area, list] of Object.entries(lists)) {
			list.innerHTML = state.layout[area].map((item, index) => {
				const info = widget(item.type) || { name: item.type, description: "" };
				const zoneOptions = area === "mobile" ? "" : ["left", "right"].map((zone) => `<option value="${zone}" ${zone === area ? "selected" : ""}>${zone === "left" ? "左栏" : "右栏"}</option>`).join("");
				const position = area === "mobile" ? "" : `<select data-layout-field="position" data-area="${area}" data-index="${index}"><option value="top" ${item.position === "top" ? "selected" : ""}>top</option><option value="sticky" ${item.position === "sticky" ? "selected" : ""}>sticky</option></select>`;
				return `<article class="studio4a-widget-card" draggable="true" data-layout-card data-area="${area}" data-index="${index}"><header><div><strong>${escapeHtml(info.name)}</strong><br><code>${escapeHtml(item.type)}</code></div><label class="studio4a-check"><input type="checkbox" data-layout-field="enable" data-area="${area}" data-index="${index}" ${item.enable !== false ? "checked" : ""}>启用</label></header><p>${escapeHtml(info.description)}</p><div class="studio4a-widget-controls">${position}${zoneOptions ? `<select data-layout-field="zone" data-area="${area}" data-index="${index}">${zoneOptions}</select>` : ""}</div><div class="studio4a-widget-tools"><button type="button" data-layout-action="up" data-area="${area}" data-index="${index}">上移</button><button type="button" data-layout-action="down" data-area="${area}" data-index="${index}">下移</button></div></article>`;
			}).join("") || `<div class="empty-state">这个区域还没有组件。</div>`;
		}
		renderAdders();
		paintStatus();
	}

	function move(area, index, direction) {
		const list = state.layout[area];
		const target = index + direction;
		if (target < 0 || target >= list.length) return;
		[list[index], list[target]] = [list[target], list[index]];
		render();
	}

	function moveTo(area, index, destination) {
		if (area === destination) return;
		const [item] = state.layout[area].splice(index, 1);
		if (state.layout[destination].some((entry) => entry.type === item.type)) {
			state.layout[area].splice(index, 0, item);
			setStatus(status, "同一区域不能重复放置同一个组件", "bad");
			return;
		}
		state.layout[destination].push(destination === "mobile" ? { type: item.type, enable: item.enable !== false } : { ...item, position: item.position || "sticky" });
		render();
	}

	async function load() {
		setStatus(status, "正在读取布局");
		state = await requestJson("/api/layout");
		baseline = snapshot();
		render();
	}

	async function save() {
		if (!dirty()) return paintStatus("没有需要保存的布局", "good");
		setStatus(status, "正在保存");
		saveButton.disabled = true;
		try {
			const saved = await requestJson("/api/layout", { method: "POST", body: JSON.stringify({ revision: state.revision, layout: state.layout }) });
			state = saved;
			baseline = snapshot();
			render();
			setStatus(status, "保存成功", "good");
		} catch (error) {
			setStatus(status, error.status === 409 ? "与磁盘版本冲突，请重新读取后再保存" : error.message, "bad");
		} finally { saveButton.disabled = false; }
	}

	document.addEventListener("change", (event) => {
		const add = event.target.closest("[data-layout-add]");
		if (add?.value) { const area = add.dataset.layoutAdd; state.layout[area].push(area === "mobile" ? { type: add.value, enable: true } : { type: add.value, enable: true, position: "sticky" }); render(); return; }
		const field = event.target.closest("[data-layout-field]");
		if (!field || !state) return;
		const area = field.dataset.area; const index = Number(field.dataset.index); const item = state.layout[area]?.[index];
		if (!item) return;
		if (field.dataset.layoutField === "enable") item.enable = field.checked;
		if (field.dataset.layoutField === "position") item.position = field.value;
		if (field.dataset.layoutField === "zone") moveTo(area, index, field.value);
		else render();
	});
	document.addEventListener("click", (event) => {
		const button = event.target.closest("[data-layout-action]");
		if (!button || !state) return;
		move(button.dataset.area, Number(button.dataset.index), button.dataset.layoutAction === "up" ? -1 : 1);
	});
	document.addEventListener("dragstart", (event) => { const card = event.target.closest("[data-layout-card]"); if (!card) return; drag = { area: card.dataset.area, index: Number(card.dataset.index) }; card.classList.add("dragging"); });
	document.addEventListener("dragend", (event) => event.target.closest("[data-layout-card]")?.classList.remove("dragging"));
	for (const list of Object.values(lists)) {
		list.addEventListener("dragover", (event) => event.preventDefault());
		list.addEventListener("drop", (event) => { event.preventDefault(); if (!drag) return; const target = event.target.closest("[data-layout-list]"); const destination = target?.dataset.layoutList; if (!destination) return; const [item] = state.layout[drag.area].splice(drag.index, 1); if (state.layout[destination].some((entry) => entry.type === item.type)) { state.layout[drag.area].splice(drag.index, 0, item); setStatus(status, "同一区域不能重复放置同一个组件", "bad"); } else { state.layout[destination].push(destination === "mobile" ? { type: item.type, enable: item.enable !== false } : { ...item, position: item.position || "sticky" }); render(); } drag = null; });
	}
	saveButton.addEventListener("click", save);
	return { load, isDirty: dirty, canLeave: () => !dirty() || confirm("布局尚未保存。要离开并保留本地修改吗？") };
}
