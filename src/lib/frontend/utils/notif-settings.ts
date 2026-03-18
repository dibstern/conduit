// ─── Notification Settings ───────────────────────────────────────────────────
// Shared reader/writer for the notification toggle preferences stored in
// localStorage. Used by both NotifSettings.svelte (UI) and ws.svelte.ts
// (trigger logic) so neither needs to import the other.

export interface NotifSettings {
	push: boolean;
	browser: boolean;
	sound: boolean;
}

const STORAGE_KEY = "notif-settings";
const DEFAULTS: NotifSettings = { push: false, browser: true, sound: false };

/** Load notification settings from localStorage (returns defaults on any error). */
export function getNotifSettings(): NotifSettings {
	if (typeof localStorage === "undefined") return { ...DEFAULTS };
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return { ...DEFAULTS };
		const parsed = JSON.parse(stored) as Partial<NotifSettings>;
		return {
			push: typeof parsed.push === "boolean" ? parsed.push : DEFAULTS.push,
			browser:
				typeof parsed.browser === "boolean" ? parsed.browser : DEFAULTS.browser,
			sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULTS.sound,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

/** Persist notification settings to localStorage. */
export function saveNotifSettings(settings: NotifSettings): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
