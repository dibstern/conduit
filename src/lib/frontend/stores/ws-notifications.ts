// ─── WebSocket Notification Logic ────────────────────────────────────────────
// Extracted from ws.svelte.ts — handles sound/browser notifications when the
// tab is hidden and a notable event arrives, plus push-active tracking.

import { notificationContent } from "../../notification-content.js";
import type { RelayMessage } from "../types.js";
import { NOTIFICATION_DISMISS_MS } from "../ui-constants.js";
import { getNotifSettings } from "../utils/notif-settings.js";
import { playDoneSound } from "../utils/sound.js";
import { getCurrentSlug, navigate } from "./router.svelte.js";

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

// ─── Session navigation callback ─────────────────────────────────────────────
// Registered by ChatLayout so notification clicks can switch to the correct
// session without a circular dependency on session/router modules.

let _navigateToSession: ((sessionId: string) => void) | null = null;

/**
 * Register a callback to navigate to a session when a notification is clicked.
 * Called by ChatLayout during initialization.
 */
export function onNavigateToSession(fn: (sessionId: string) => void): void {
	_navigateToSession = fn;
}

/**
 * Clear the navigation callback (for cleanup on unmount).
 */
export function clearNavigateToSession(): void {
	_navigateToSession = null;
}

// ─── Service worker message listener ─────────────────────────────────────────
// The SW posts a `navigate_to_session` message when a push notification is
// clicked. This listener routes it to the registered callback.

let _swListenerRegistered = false;

/**
 * Register the service worker message listener for push notification clicks.
 * Safe to call multiple times — only registers once.
 */
export function initSWNavigationListener(): void {
	if (
		_swListenerRegistered ||
		typeof navigator === "undefined" ||
		!("serviceWorker" in navigator)
	)
		return;

	_swListenerRegistered = true;
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "navigate_to_session" && event.data.sessionId) {
			const { sessionId, slug, url } = event.data as {
				sessionId: string;
				slug?: string;
				url?: string;
			};

			// If the notification is for a different project than the one
			// currently viewed, navigate via URL instead of switchToSession
			// (which would send view_session on the wrong WS connection).
			const currentSlug = getCurrentSlug();
			if (slug && currentSlug && slug !== currentSlug) {
				if (url) navigate(url);
				return;
			}

			_navigateToSession?.(sessionId);
		}
	});
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
				// Extract sessionId from the message for click-to-session navigation
				const sessionId =
					"sessionId" in msg
						? (msg as { sessionId?: string }).sessionId
						: undefined;

				const n = new Notification(content.title, {
					body: content.body,
					tag: content.tag,
				});
				n.onclick = () => {
					window.focus();
					if (sessionId) {
						_navigateToSession?.(sessionId);
					}
					n.close();
				};
				setTimeout(() => n.close(), NOTIFICATION_DISMISS_MS);
			} catch {
				// Non-fatal: Notification API may not be available
			}
		}
	}
}
