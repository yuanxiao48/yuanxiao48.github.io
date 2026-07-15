import { requestJson, setStatus } from "./studio-cms-utils.js";

export function createSettingsManager() {
	const status = document.querySelector("#contentSettingsStatus");
	const saveButton = document.querySelector("#contentSettingsSave");
	const ids = ["cmsSiteTitle", "cmsSiteSubtitle", "cmsSiteDescription", "cmsProfileName", "cmsProfileBio", "cmsProfileAvatar", "cmsProfileGithub", "cmsProfileEmail", "cmsAnnouncementVisible", "cmsAnnouncementTitle", "cmsAnnouncementContent", "cmsAnnouncementButtonText", "cmsAnnouncementButtonUrl"];
	const fields = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));
	const avatarPreview = document.querySelector("#cmsAvatarPreview");
	let baseline = ""; let revision = "";
	const value = (id) => fields[id].type === "checkbox" ? fields[id].checked : fields[id].value;
	const formState = () => ({ site: { title: value("cmsSiteTitle"), subtitle: value("cmsSiteSubtitle"), description: value("cmsSiteDescription") }, profile: { name: value("cmsProfileName"), bio: value("cmsProfileBio"), avatar: value("cmsProfileAvatar"), github: value("cmsProfileGithub"), email: value("cmsProfileEmail") }, announcement: { visible: value("cmsAnnouncementVisible"), title: value("cmsAnnouncementTitle"), content: value("cmsAnnouncementContent"), buttonText: value("cmsAnnouncementButtonText"), buttonUrl: value("cmsAnnouncementButtonUrl") } });
	const isDirty = () => JSON.stringify(formState()) !== baseline;
	const paintStatus = (message = isDirty() ? "未保存" : "已保存", tone = isDirty() ? "dirty" : "good") => setStatus(status, message, tone);

	function renderAvatar() {
		const path = value("cmsProfileAvatar");
		if (!path) { avatarPreview.textContent = "尚未选择头像。"; return; }
		avatarPreview.innerHTML = `<img src="/api/image-file?path=${encodeURIComponent(path.replace(/^\//, ""))}" alt="头像预览"><span>${path}</span>`;
	}

	function fill(settings) {
		fields.cmsSiteTitle.value = settings.site.title || ""; fields.cmsSiteSubtitle.value = settings.site.subtitle || ""; fields.cmsSiteDescription.value = settings.site.description || "";
		fields.cmsProfileName.value = settings.profile.name || ""; fields.cmsProfileBio.value = settings.profile.bio || ""; fields.cmsProfileAvatar.value = settings.profile.avatar || ""; fields.cmsProfileGithub.value = settings.profile.github || ""; fields.cmsProfileEmail.value = settings.profile.email || "";
		fields.cmsAnnouncementVisible.checked = Boolean(settings.announcement.visible); fields.cmsAnnouncementTitle.value = settings.announcement.title || ""; fields.cmsAnnouncementContent.value = settings.announcement.content || ""; fields.cmsAnnouncementButtonText.value = settings.announcement.buttonText || ""; fields.cmsAnnouncementButtonUrl.value = settings.announcement.buttonUrl || "";
		baseline = JSON.stringify(formState()); renderAvatar(); paintStatus();
	}

	async function load() { setStatus(status, "正在读取设置"); const data = await requestJson("/api/content-settings"); revision = data.revision; fill(data.settings); }
	async function save() { if (!isDirty()) return paintStatus("没有需要保存的设置", "good"); setStatus(status, "正在保存"); saveButton.disabled = true; try { const saved = await requestJson("/api/content-settings", { method: "POST", body: JSON.stringify({ revision, settings: formState() }) }); revision = saved.revision; fill(saved.settings); setStatus(status, "保存成功", "good"); } catch (error) { setStatus(status, error.status === 409 ? "与磁盘版本冲突，请重新读取后再保存" : error.message, "bad"); } finally { saveButton.disabled = false; } }

	for (const field of Object.values(fields)) field.addEventListener("input", () => { renderAvatar(); paintStatus(); });
	fields.cmsAnnouncementVisible.addEventListener("change", paintStatus);
	document.querySelector("#cmsPickAvatar").addEventListener("click", () => {
		if (!window.StudioImagePicker?.open) { setStatus(status, "图片选择器正在加载，请稍后再试", "bad"); return; }
		window.StudioImagePicker.open((path) => { fields.cmsProfileAvatar.value = path.replace(/^\//, ""); renderAvatar(); paintStatus(); });
	});
	saveButton.addEventListener("click", save);
	return { load, isDirty, canLeave: () => !isDirty() || confirm("资料与公告尚未保存。要离开并保留当前修改吗？") };
}
