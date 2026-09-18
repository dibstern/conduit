// ─── WebSocket Notification Logic ────────────────────────────────────────────
// Extracted from ws.svelte.ts — handles sound/browser notifications when the
// tab is hidden and a notable event arrives, plus push-active tracking.

import { notificationContent } from "../../notification-content.js";
import type { RelayMessage } from "../types.js";
import { NOTIFICATION_DISMISS_MS } from "../ui-constants.js";
import { getNotifSettings } from "../utils/notif-settings.js";
import { emitDoneSound, readyDoneSound } from "../utils/sound.js";
import { getCurrentSlug, navigate } from "./router.svelte.js";

// ─── Push-active tracking ────────────────────────────────────────────────────
// When push notifications are active, browser alerts and the in-page ding are
// suppressed: the alert travels through the service worker instead, which
// offers it back to a focused tab. Set by NotifSettings/SettingsPanel on
// toggle, and reconciled against the real subscription on startup.

let _pushActive = false;
let _pushStateKnown = true;

/** Mark push notifications as active/inactive. Called by NotifSettings. */
export function setPushActive(active: boolean): void {
	_pushActive = active;
	_pushStateKnown = true;
}

/**
 * Ask the browser whether a push subscription actually exists, and believe it.
 *
 * A subscription outlives the tab that created it, so after a reload the user
 * is still subscribed while this module has forgotten — and every alert then
 * arrives twice, once from the socket and once from push. Guessing in either
 * direction is wrong (assume active and a lapsed subscription means silence;
 * assume inactive and every reload double-dings), so ask. Called by ChatLayout
 * alongside the SW message listener (ni8.23, P2-9).
 */
export async function reconcilePushActive(): Promise<boolean> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		_pushActive = false;
		_pushStateKnown = true;
		return false;
	}
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		const subscription = await registration?.pushManager.getSubscription();
		_pushActive = subscription != null;
		_pushStateKnown = true;
	} catch (error) {
		// An unknown subscription cannot grant the WS channel ownership.
		_pushStateKnown = false;
		console.warn("Could not determine notification ownership", error);
	}
	return _pushActive;
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
// Two messages come back from the SW: `navigate_to_session` when a push
// notification is clicked, and `prepare_in_app_alert` when a push arrived while this
// tab was focused and the SW would rather the page dinged than the OS.

let _swListenerRegistered = false;

/** Prepare audio, request ownership, then acknowledge actual playback. */
async function handleInAppAlert(port: MessagePort | undefined): Promise<void> {
	if (!port) return;
	try {
		if (!getNotifSettings().sound) {
			port.postMessage({ handled: false });
			return;
		}
		await readyDoneSound();
		port.onmessage = (event: MessageEvent) => {
			if (event.data?.granted !== true) return;
			port.onmessage = null;
			try {
				emitDoneSound();
				port.postMessage({ handled: true });
			} catch {
				port.postMessage({ handled: false });
			}
			port.close();
		};
		port.postMessage({ ready: true });
	} catch {
		port.postMessage({ handled: false });
	}
}

/**
 * Register the service worker message listener.
 * Safe to call multiple times — only registers once.
 */
export function initSWMessageListener(): void {
	if (
		_swListenerRegistered ||
		typeof navigator === "undefined" ||
		!("serviceWorker" in navigator)
	)
		return;

	_swListenerRegistered = true;
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "prepare_in_app_alert") {
			void handleInAppAlert(event.ports?.[0]);
			return;
		}
		if (event.data?.type === "navigate_to_session" && event.data.sessionId) {
			const { sessionId, slug, url } = event.data as {
				sessionId: string;
				slug?: string;
				url?: string;
			};

			// If the notification is for a different project than the one
			// currently viewed, navigate via URL instead of switchToSession
			// (which would send ViewSession on the wrong project RPC route).
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
// Deliver through one channel when a notable event arrives.

export const NOTIF_TYPES = new Set([
	"done",
	"error",
	"permission_request",
	"ask_user",
]);

function alertIdentity(msg: RelayMessage): string {
	const session = "sessionId" in msg ? msg.sessionId : "";
	const project = getCurrentSlug() ?? "";
	if ("alertId" in msg && msg.alertId) return `${project}:${msg.alertId}`;
	if (msg.type === "permission_request")
		return `${project}:${session}:permission:${msg.requestId}`;
	if (msg.type === "ask_user")
		return `${project}:${session}:question:${msg.toolId}`;
	return `${project}:${session}:${msg.type}`;
}

/** Fallback: show a browser Notification API alert (no reliable tab switching). */
function showBrowserNotification(
	content: { title: string; body: string; tag: string },
	sessionId: string | undefined,
): boolean {
	try {
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
		return true;
	} catch {
		return false;
	}
}

const unpersistedReceipts = new Set<string>();
let receiptStorageWarningLogged = false;

export async function triggerNotifications(msg: RelayMessage): Promise<void> {
	if (!NOTIF_TYPES.has(msg.type)) return;
	// Idle hints update the UI; only an identified terminal event proves completion.
	if (msg.type === "done" && !msg.alertId) return;
	// A subscription survives reload and can change in another tab. Resolve it
	// before choosing a channel, including the first event after page load.
	if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
		await reconcilePushActive();
	}
	if (_pushActive || !_pushStateKnown) return;

	const settings = getNotifSettings();
	const deliver = async (): Promise<boolean> => {
		if (settings.sound) {
			try {
				await readyDoneSound();
				emitDoneSound();
				return true;
			} catch {
				// Audio could not start. Try the browser channel instead.
			}
		}
		const content = notificationContent(msg);
		if (
			!settings.browser ||
			!content ||
			typeof Notification === "undefined" ||
			Notification.permission !== "granted"
		)
			return false;
		const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
		if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
			const registration = await navigator.serviceWorker.getRegistration();
			if (registration) {
				await registration.showNotification(content.title, {
					body: content.body,
					tag: content.tag,
					data: { type: msg.type, sessionId },
				});
				return true;
			}
		}
		return showBrowserNotification(content, sessionId);
	};

	const key = `conduit-alert:${alertIdentity(msg)}`;
	const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
	try {
		if (!locks) {
			console.warn("In-app notifications require Web Locks to coordinate tabs");
			return;
		}
		await locks.request(key, async () => {
			if (unpersistedReceipts.has(key) || localStorage.getItem(key)) return;
			// The lock serializes live attempts. Record only successful delivery:
			// a crash or full quota may duplicate an alert, but must not lose it.
			if (await deliver()) {
				try {
					localStorage.setItem(key, "1");
				} catch (error) {
					unpersistedReceipts.add(key);
					if (!receiptStorageWarningLogged) {
						receiptStorageWarningLogged = true;
						console.warn(
							"Could not save notification receipt; other tabs may repeat alerts",
							error,
						);
					}
				}
			}
		});
	} catch (error) {
		console.warn("Notification delivery failed", error);
	}
}
