function sessionToken() {
	return document.querySelector('meta[name="studio-session-token"]')?.content || "";
}

function apiError(payload, fallback) {
	const error = new Error(payload?.error || fallback);
	error.code = payload?.code || "TRANSCODE_REQUEST_FAILED";
	return error;
}

function formatBytes(value) {
	const bytes = Number(value || 0);
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
	const units = ["KB", "MB", "GB"];
	let size = bytes / 1024;
	let index = 0;
	while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
	return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(value) {
	const seconds = Number(value || 0);
	if (!Number.isFinite(seconds) || seconds < 0) return "未知";
	const total = Math.round(seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatTime(value) {
	const date = new Date(value || "");
	return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN", { hour12: false });
}

function setText(element, value) {
	if (element) element.textContent = value || "未检测";
}

export function createTranscodeManager() {
	const panel = document.querySelector("#mediaTranscodePanel");
	const tab = document.querySelector("#mediaTranscodeTab");
	const status = document.querySelector("#transcodeStatus");
	const retry = document.querySelector("#transcodeRetry");
	const refresh = document.querySelector("#transcodeRefresh");
	const save = document.querySelector("#transcodeSavePaths");
	const clear = document.querySelector("#transcodeClearPaths");
	const ffmpegPath = document.querySelector("#transcodeFfmpegPath");
	const ffprobePath = document.querySelector("#transcodeFfprobePath");
	const mediaSelect = document.querySelector("#transcodeMediaSelect");
	const refreshMedia = document.querySelector("#transcodeRefreshMedia");
	const createLibraryTask = document.querySelector("#transcodeAnalyze");
	const result = document.querySelector("#transcodeProbeResult");
	const sourceInput = document.querySelector("#transcodeSourceInput");
	const uploadStart = document.querySelector("#transcodeUploadStart");
	const uploadCancel = document.querySelector("#transcodeUploadCancel");
	const uploadStatus = document.querySelector("#transcodeUploadStatus");
	const jobList = document.querySelector("#transcodeJobList");
	const cleanup = document.querySelector("#transcodeCleanup");
	const fields = {
		ffmpeg: document.querySelector("#transcodeFfmpegState"),
		ffprobe: document.querySelector("#transcodeFfprobeState"),
		x264: document.querySelector("#transcodeX264State"),
		nvenc: document.querySelector("#transcodeNvencState"),
		aac: document.querySelector("#transcodeAacState"),
		mp3: document.querySelector("#transcodeMp3State"),
	};
	let loaded = false;
	let loading = null;
	let canProbe = false;
	let currentXhr = null;
	let uploadActive = false;
	let jobPollTimer = null;

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

	async function request(url, options = {}) {
		const response = await fetch(url, { cache: "no-store", ...options });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok || payload.ok === false) throw apiError(payload, "转码准备请求失败");
		return payload;
	}

	function write(url, body) {
		return request(url, {
			method: "POST",
			headers: { "content-type": "application/json", "x-studio-session": sessionToken() },
			body: JSON.stringify(body),
		});
	}

	function setCapabilityCards(capabilities) {
		canProbe = Boolean(capabilities.canProbe);
		setText(fields.ffmpeg, capabilities.ffmpeg?.available ? `已检测到 ${capabilities.ffmpeg.version || "FFmpeg"}` : "未检测到");
		setText(fields.ffprobe, capabilities.ffprobe?.available ? `已检测到 ${capabilities.ffprobe.version || "ffprobe"}` : "未检测到");
		setText(fields.x264, capabilities.encoders?.libx264 ? "可用" : "不可用");
		setText(fields.nvenc, capabilities.encoders?.h264NvencCompiled ? "已编译支持，尚未测试 GPU" : "未检测到");
		setText(fields.aac, capabilities.encoders?.aac ? "可用" : "不可用");
		setText(fields.mp3, capabilities.encoders?.libmp3lame ? "可用" : "不可用");
		updateSourceControls();
	}

	function updateSourceControls() {
		if (createLibraryTask) createLibraryTask.disabled = !canProbe || !mediaSelect?.value;
		if (uploadStart) uploadStart.disabled = !canProbe || uploadActive || !(sourceInput?.files?.length);
	}

	async function loadCapabilities() {
		setStatus("正在检测本机 FFmpeg 与 ffprobe…", "loading");
		retry?.classList.add("hidden");
		try {
			const [capabilities, settings] = await Promise.all([
				request("/api/transcode/capabilities"),
				request("/api/transcode/settings"),
			]);
			setCapabilityCards(capabilities);
			if (ffmpegPath) ffmpegPath.placeholder = settings.hasFfmpegPath ? "已保存本机路径；填写新路径可替换" : "例如 C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe";
			if (ffprobePath) ffprobePath.placeholder = settings.hasFfprobePath ? "已保存本机路径；填写新路径可替换" : "例如 C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe";
			setStatus(capabilities.canProbe ? "工具检测完成。可以准备并分析本地源文件。" : "未检测到可用 ffprobe。配置后才能分析源文件。", capabilities.canProbe ? "ready" : "empty");
		} catch (error) {
			setStatus(error.message || "工具检测失败。", "error");
			retry?.classList.remove("hidden");
		}
	}

	async function loadMediaOptions() {
		if (!mediaSelect) return;
		const previous = mediaSelect.value;
		mediaSelect.replaceChildren(new Option("正在读取音频和视频…", ""));
		try {
			const payload = await request("/api/media?kind=all");
			const items = (payload.items || []).filter((item) => item.kind === "audio" || item.kind === "video");
			mediaSelect.replaceChildren(new Option(items.length ? "选择已入库媒体" : "媒体库中还没有音频或视频", ""));
			for (const item of items) {
				const option = new Option(`${item.kind === "video" ? "视频" : "音频"} · ${item.name} · ${formatBytes(item.size)}`, item.publicPath);
				option.selected = item.publicPath === previous;
				mediaSelect.add(option);
			}
			updateSourceControls();
		} catch (error) {
			mediaSelect.replaceChildren(new Option("读取媒体库失败", ""));
			setStatus(error.message || "媒体库读取失败。", "error");
		}
	}

	function renderProbe(probe) {
		if (!result) return;
		result.replaceChildren();
		const compatibility = probe?.compatibility || {};
		const title = document.createElement("h3");
		title.textContent = compatibility.label || "媒体分析";
		const reason = document.createElement("p");
		reason.textContent = compatibility.reason || "无法可靠判断浏览器兼容性。";
		const details = document.createElement("dl");
		const entries = [
			["容器", probe?.container || "未知"], ["大小", formatBytes(probe?.size)], ["时长", formatDuration(probe?.duration)],
			["视频", probe?.video ? `${probe.video.codec || "未知"} · ${probe.video.width || "?"}x${probe.video.height || "?"} · ${probe.video.pixelFormat || "未知"}` : "无"],
			["音频", probe?.audio ? `${probe.audio.codec || "未知"} · ${probe.audio.sampleRate || "?"} Hz · ${probe.audio.channels || "?"} 声道` : "无"],
		];
		for (const [label, value] of entries) {
			const dt = document.createElement("dt"); dt.textContent = label;
			const dd = document.createElement("dd"); dd.textContent = value;
			details.append(dt, dd);
		}
		result.append(title, reason, details);
		result.classList.remove("hidden");
	}

	function renderJobs(payload) {
		if (!jobList) return;
		jobList.replaceChildren();
		const jobs = Array.isArray(payload?.items) ? payload.items : [];
		if (!jobs.length) {
			jobList.append(Object.assign(document.createElement("p"), { className: "studio-media-empty", textContent: "还没有准备任务。" }));
			return;
		}
		for (const job of jobs) {
			const card = document.createElement("article");
			card.className = "studio-transcode-job";
			card.dataset.state = job.state || "";
			const heading = document.createElement("strong");
			heading.textContent = job.sourceFilename || "未命名源文件";
			const actions = document.createElement("div"); actions.className = "studio-transcode-job-actions";
			const discard = document.createElement("button"); discard.type = "button"; discard.className = "btn small"; discard.textContent = "丢弃任务";
			discard.addEventListener("click", () => discardJob(job)); actions.append(discard);
			const meta = document.createElement("p");
			meta.textContent = `${job.sourceType === "library" ? "媒体库来源" : "电脑来源"} · ${formatBytes(job.sourceSize)} · ${job.state} · ${formatTime(job.updatedAt)}`;
			const detail = document.createElement("p");
			const progress = job.progress;
			if (["queued", "transcoding", "validating-output"].includes(job.state)) {
				const percent = typeof progress?.percent === "number" ? `${progress.percent.toFixed(1)}%` : "正在等待进度";
				const processed = typeof progress?.processedSeconds === "number" ? formatDuration(progress.processedSeconds) : "--:--";
				const speed = typeof progress?.speed === "number" ? `${progress.speed.toFixed(2)}x` : "速度未知";
				const eta = typeof progress?.etaSeconds === "number" ? `预计剩余 ${formatDuration(progress.etaSeconds)}` : "预计剩余未知";
				detail.textContent = `${percent} · 已处理 ${processed} · ${speed} · ${eta}`;
			} else if (job.state === "cancelling") {
				if (job.error?.code === "TRANSCODE_PROCESS_STUCK") {
					detail.textContent = "无法确认 FFmpeg 已停止。任务保持锁定，请重启 Studio 后恢复。";
				} else if (job.forceStopInProgress) {
					detail.textContent = "FFmpeg 未在宽限时间内退出，正在强制停止。";
				} else {
					detail.textContent = "正在停止 FFmpeg。";
				}
			} else if (job.state === "cancelled" && job.cleanupWarning) {
				detail.textContent = "任务已取消，但部分临时文件将在下次启动时继续清理。";
			} else if (job.state === "completed" && job.output) {
				const ratio = job.sourceSize && job.output.size ? `${Math.max(0, ((1 - job.output.size / job.sourceSize) * 100)).toFixed(1)}%` : "--";
				detail.textContent = `已完成技术验证 · ${job.output.codec || "未知编码"} · ${formatBytes(job.output.size)} · 体积变化 ${ratio}`;
			} else detail.textContent = job.error?.message || job.probe?.compatibility?.reason || "真实音频运行器已接入。用户启动与取消操作将在下一阶段开放。";
			card.append(heading, actions, meta, detail);
			card.addEventListener("click", (event) => { if (!event.target.closest("button") && job.probe) renderProbe(job.probe); });
			jobList.append(card);
		}
	}

	function stopJobPolling() {
		if (jobPollTimer) window.clearTimeout(jobPollTimer);
		jobPollTimer = null;
	}

	function scheduleJobPolling(jobs) {
		stopJobPolling();
		if (panel?.classList.contains("hidden")) return;
		const isRunning = jobs.some((job) => ["queued", "transcoding", "cancelling", "validating-output"].includes(job.state));
		if (!isRunning) return;
		jobPollTimer = window.setTimeout(() => {
			jobPollTimer = null;
			loadJobs();
		}, 800);
	}

	async function loadJobs() {
		try {
			const payload = await request("/api/transcode/jobs");
			renderJobs(payload);
			scheduleJobPolling(Array.isArray(payload?.items) ? payload.items : []);
		} catch (error) {
			stopJobPolling();
			if (jobList) jobList.replaceChildren(Object.assign(document.createElement("p"), { className: "studio-media-empty error", textContent: error.message || "准备任务读取失败。" }));
		}
	}

	async function createTaskFromLibrary() {
		const mediaPath = mediaSelect?.value;
		if (!mediaPath) { setStatus("请先选择一个已入库的音频或视频。", "error"); return; }
		setStatus("正在创建并分析媒体库来源任务…", "loading");
		try {
			const payload = await write("/api/transcode/jobs/from-library", { path: mediaPath });
			renderProbe(payload.job?.probe);
			setStatus(payload.job?.state === "ready" ? "源文件准备完成。" : payload.job?.error?.message || "源文件准备失败。", payload.job?.state === "ready" ? "ready" : "error");
			await loadJobs();
		} catch (error) {
			setStatus(error.message || "创建准备任务失败。", "error");
		}
	}

	function uploadSource() {
		if (uploadActive || !sourceInput?.files?.length) return;
		const file = sourceInput.files[0];
		uploadActive = true;
		updateSourceControls();
		uploadCancel?.classList.remove("hidden");
		setUploadStatus(`正在上传 ${file.name}…`, "loading");
		const formData = new FormData(); formData.append("file", file, file.name);
		const xhr = new XMLHttpRequest(); currentXhr = xhr;
		xhr.open("POST", "/api/transcode/jobs/upload");
		xhr.setRequestHeader("x-studio-session", sessionToken());
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) setUploadStatus(`正在上传 ${file.name}：${Math.round((event.loaded / event.total) * 100)}%`, "loading");
		};
		xhr.onload = async () => {
			let payload = {}; try { payload = JSON.parse(xhr.responseText || "{}"); } catch { /* use generic failure */ }
			uploadActive = false; currentXhr = null; uploadCancel?.classList.add("hidden"); updateSourceControls();
			if (xhr.status >= 200 && xhr.status < 300 && payload.ok !== false) {
				if (sourceInput) sourceInput.value = "";
				renderProbe(payload.job?.probe);
				setUploadStatus(payload.job?.state === "ready" ? "源文件上传并分析完成。" : payload.job?.error?.message || "源文件准备失败。", payload.job?.state === "ready" ? "ready" : "error");
				await loadJobs();
			} else setUploadStatus(apiError(payload, "源文件上传失败").message, "error");
		};
		xhr.onerror = () => { uploadActive = false; currentXhr = null; uploadCancel?.classList.add("hidden"); updateSourceControls(); setUploadStatus("源文件上传连接失败。", "error"); };
		xhr.onabort = () => { uploadActive = false; currentXhr = null; uploadCancel?.classList.add("hidden"); updateSourceControls(); setUploadStatus("源文件上传已取消，临时分片已清理。", "error"); };
		xhr.send(formData);
	}

	function cancelUpload() {
		if (!uploadActive) return;
		setUploadStatus("正在取消上传…", "loading");
		currentXhr?.abort();
	}

	async function discardJob(job) {
		if (!window.confirm(`丢弃“${job.sourceFilename || "此源文件"}”的准备任务吗？媒体库原文件不会被删除。`)) return;
		try {
			await write(`/api/transcode/jobs/${encodeURIComponent(job.id)}/discard`, {});
			setStatus("任务已丢弃。", "ready");
			await loadJobs();
		} catch (error) { setStatus(error.message || "丢弃任务失败。", "error"); }
	}

	async function savePaths() {
		setStatus("正在验证并保存本机路径…", "loading");
		try {
			await write("/api/transcode/settings", { ffmpegPath: ffmpegPath?.value || "", ffprobePath: ffprobePath?.value || "" });
			if (ffmpegPath) ffmpegPath.value = "";
			if (ffprobePath) ffprobePath.value = "";
			await loadCapabilities();
			setStatus("本机路径已保存并完成验证。", "ready");
		} catch (error) { setStatus(error.message || "本机路径未保存。", "error"); }
	}

	async function clearPaths() {
		if (!window.confirm("清除本机保存的 FFmpeg 和 ffprobe 路径吗？不会删除电脑中的程序。")) return;
		try {
			await write("/api/transcode/settings", { clearFfmpegPath: true, clearFfprobePath: true });
			if (ffmpegPath) ffmpegPath.value = "";
			if (ffprobePath) ffprobePath.value = "";
			await loadCapabilities();
			setStatus("本机路径已清除。", "ready");
		} catch (error) { setStatus(error.message || "本机路径未清除。", "error"); }
	}

	function bind() {
		retry?.addEventListener("click", () => loadCapabilities());
		refresh?.addEventListener("click", () => load());
		refreshMedia?.addEventListener("click", () => loadMediaOptions());
		createLibraryTask?.addEventListener("click", createTaskFromLibrary);
		mediaSelect?.addEventListener("change", updateSourceControls);
		sourceInput?.addEventListener("change", updateSourceControls);
		uploadStart?.addEventListener("click", uploadSource);
		uploadCancel?.addEventListener("click", cancelUpload);
		cleanup?.addEventListener("click", async () => { try { const result = await write("/api/transcode/jobs/cleanup", {}); setStatus(result.removed ? `已清理 ${result.removed} 个过期任务。` : "没有可清理的过期任务。", "ready"); await loadJobs(); } catch (error) { setStatus(error.message || "清理过期任务失败。", "error"); } });
		save?.addEventListener("click", savePaths);
		clear?.addEventListener("click", clearPaths);
	}

	bind();
	return {
		load: async () => {
			if (loading) return loading;
			loading = Promise.all([loadCapabilities(), loadMediaOptions(), loadJobs()]).finally(() => { loaded = true; loading = null; });
			return loading;
		},
		show: () => { panel?.classList.remove("hidden"); tab?.classList.add("active"); tab?.setAttribute("aria-selected", "true"); },
		hide: () => { stopJobPolling(); panel?.classList.add("hidden"); tab?.classList.remove("active"); tab?.setAttribute("aria-selected", "false"); },
		isDirty: () => uploadActive,
		canLeave: () => {
			if (!uploadActive) return true;
			if (!window.confirm("源文件上传正在进行。离开会取消上传并清理未完成分片，确定离开吗？")) return false;
			cancelUpload(); return true;
		},
	};
}
