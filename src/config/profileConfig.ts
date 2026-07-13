import type { ProfileConfig } from "../types/profileConfig";
import userSettings from "./userSettings.json";

const settings = userSettings as {
	profile: {
		name: string;
		bio: string;
		avatar: string;
		github: string;
		email: string;
	};
};

export const profileConfig: ProfileConfig = {
	avatar: settings.profile.avatar || "assets/images/avatar.avif",
	name: settings.profile.name || "你的名字",
	bio: settings.profile.bio || "把日常、想法和慢慢成形的东西放在这里。",
	links: [
		...(settings.profile.github
			? [
					{
						name: "GitHub",
						icon: "fa7-brands:github",
						url: settings.profile.github,
						showName: false,
					},
				]
			: []),
		...(settings.profile.email
			? [
					{
						name: "Email",
						icon: "fa7-solid:envelope",
						url: settings.profile.email,
						showName: false,
					},
				]
			: []),
		{
			name: "RSS",
			icon: "fa7-solid:rss",
			url: "/rss/",
			showName: false,
		},
	],
};
