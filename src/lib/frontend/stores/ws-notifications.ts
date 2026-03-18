// ─── WebSocket Notification Logic ────────────────────────────────────────────
// Extracted from ws.svelte.ts — handles sound/browser notifications when the
// tab is hidden and a notable event arrives, plus push-active tracking.

import { notificationContent } from "../../notification-content.js";
import type { RelayMessage } from "../types.js";
import { NOTIFICATION_DISMISS_MS } from "../ui-constants.js";
import { getNotifSettings } from "../utils/notif-settings.js";
import { playDoneSound } from "../utils/sound.js";

// ─── Push-active tracking ────────────────────────────────────────────────────
// When push notifications are active, browser alerts are suppressed (the SW
// handles it via push). Set by NotifSettings.svelte on toggle.
//
// IMPORTANT: Must start as `false`, not read from localStorage. The push
// subscription is NOT automatically re-established on page load — it requires
// the user to toggle it in NotifSettings, which calls setPushActive(true)
// only after the service worker subscription succeeds. Reading `push: true`
// from localStorage would suppress browser notifications even though no SW
// subscription is actually active, creating a dead zone where neither
// browser nor push notifications fire.

let _pushActive = false;

/** Mark push notifications as active/inactive. Called by NotifSettings. */
export function setPushActive(active: boolean): void {
	_pushActive = active;
}

/** Check if push notifications are currently active. */
export function isPushActive(): boolean {
	return _pushActive;
}

// ─── Notification triggers ───────────────────────────────────────────────────
// Fire sound and/or browser alert when a notable event arrives.
// Both fire regardless of tab visibility — the user wants to know when a
// task finishes whether or not they're looking at the relay tab.

export const NOTIF_TYPES = new Set([
	"done",
	"error",
	"permission_request",
	"ask_user",
]);

export function triggerNotifications(msg: RelayMessage): void {
	if (!NOTIF_TYPES.has(msg.type)) return;

	const settings = getNotifSettings();

	// Sound — plays regardless of tab visibility
	if (settings.sound) {
		playDoneSound();
	}

	// Browser alert — fires regardless of tab visibility.
	// Skip if push is active (the service worker handles it via push).
	if (settings.browser && !_pushActive) {
		const content = notificationContent(msg);
		if (
			content &&
			typeof Notification !== "undefined" &&
			Notification.permission === "granted"
		) {
			try {
				const n = new Notification(content.title, {
					body: content.body,
					tag: content.tag,
				});
				n.onclick = () => {
					window.focus();
					n.close();
				};
				setTimeout(() => n.close(), NOTIFICATION_DISMISS_MS);
			} catch {
				// Non-fatal: Notification API may not be available
			}
		}
	}
}
