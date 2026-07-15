export async function requestJson(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: { "content-type": "application/json", ...(options.headers || {}) },
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = new Error(payload.error || "请求失败");
		error.status = response.status;
		error.payload = payload;
		throw error;
	}
	return payload;
}

export function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

export function textStats(value) {
	const text = String(value || "");
	const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
	const english = (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
	return { characters: text.length, chinese, english };
}

export function setStatus(element, message, tone = "") {
	if (!element) return;
	element.textContent = message;
	element.className = `studio4a-save-status ${tone}`.trim();
}

export function debounce(callback, delay) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => callback(...args), delay);
	};
}

export function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
	})[char]);
}
