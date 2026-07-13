import type { MusicPlayerConfig } from "../types/musicConfig";
import userSettings from "./userSettings.json";

type MusicSettings = {
	showInNavbar?: boolean;
	mode?: "meting" | "local";
	volume?: number;
	playMode?: "list" | "one" | "random";
	showLyrics?: boolean;
	api?: string;
	server?: "netease" | "tencent" | "kugou" | "xiami" | "baidu";
	type?: "song" | "playlist" | "album" | "search" | "artist";
	id?: string;
};

const music = (userSettings as { music?: MusicSettings }).music ?? {};

export const musicPlayerConfig: MusicPlayerConfig = {
	showInNavbar: music.showInNavbar ?? true,
	mode: music.mode ?? "meting",
	volume: music.volume ?? 0.7,
	playMode: music.playMode ?? "list",
	showLyrics: music.showLyrics ?? true,
	meting: {
		api:
			music.api ||
			"https://api.i-meto.com/meting/api?server=:server&type=:type&id=:id&r=:r",
		server: music.server ?? "netease",
		type: music.type ?? "playlist",
		id: music.id || "10046455237",
		auth: "",
		fallbackApis: [
			"https://api.injahow.cn/meting/?server=:server&type=:type&id=:id",
			"https://api.moeyao.cn/meting/?server=:server&type=:type&id=:id",
		],
	},
	local: {
		playlist: [
			{
				name: "使一颗心免于哀伤",
				artist: "知更鸟 / HOYO-MiX / Chevy",
				url: "/assets/music/使一颗心免于哀伤-哼唱.mp3",
				cover: "/assets/music/cover/109951169585655912.webp",
				lrc: "",
			},
		],
	},
};
