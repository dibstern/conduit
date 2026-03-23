// ─── Service Worker ──────────────────────────────────────────────────────────
// Handles push events to show notifications and manages notification clicks
// to focus/open the relay. No caching — the relay requires a live server
// connection, so offline caching adds no value and broken cache URLs
// (hashed Vite assets) prevent the SW from installing.

import type { PermissionId } from "../shared-types.js";

declare const self: ServiceWorkerGlobalScope;

// ─── Install: activate immediately ───────────────────────────────────────

self.addEventListener("install", () => {
	self.skipWaiting();
});

// ─── Activate: claim clients ─────────────────────────────────────────────

self.addEventListener("activate", (event: ExtendableEvent) => {
	// Clean up any caches left by earlier versions of the SW
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

// ─── Push: show notification ─────────────────────────────────────────────

interface PushPayload {
	type?: string;
	title?: string;
	body?: string;
	tag?: string;
	url?: string;
	requestId?: PermissionId;
	slug?: string;
	sessionId?: string;
}

self.addEventListener("push", (event: PushEvent) => {
	let data: PushPayload = {};
	try {
		data = event.data?.json() ?? {};
	} catch {
		return;
	}

	// Silent validation push — do not show notification
	if (data.type === "test") return;

	const options: NotificationOptions = {
		body: data.body ?? "",
		tag: data.tag ?? "conduit",
		data,
	};

	// Permission requests and errors need user interaction
	if (data.type === "permission_request") {
		options.requireInteraction = true;
		options.tag = `perm-${data.requestId ?? "unknown"}`;
	} else if (data.type === "error") {
		options.requireInteraction = true;
		options.tag = "opencode-error";
	} else if (data.type === "done") {
		options.tag = data.tag ?? "opencode-done";
	}

	// Always show the notification — no visibility suppression.
	// When push is enabled, browser Notification API alerts are already
	// suppressed client-side (_pushActive flag in ws-notifications.ts).
	// The SW is the sole notification path for push users, so it must
	// always display; otherwise there's a dead zone where neither
	// browser nor push notifications fire when the tab is visible.
	event.waitUntil(
		self.registration
			.showNotification(data.title ?? "Conduit", options)
			.catch((err: unknown) => {
				console.warn("[sw] Failed to show notification:", err);
			}),
	);
});

// ─── Notification click: focus or open relay ─────────────────────────────

/** Post a navigate_to_session message to a client. Swallows errors
 *  (client may have closed between matchAll and postMessage). */
function postNavigate(
	client: { postMessage(message: unknown): void },
	data: PushPayload,
	targetUrl: string,
): void {
	try {
		client.postMessage({
			type: "navigate_to_session",
			sessionId: data.sessionId,
			slug: data.slug,
			url: targetUrl,
		});
	} catch {
		// Client may have closed — non-fatal
	}
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
	const data: PushPayload = event.notification.data ?? {};
	event.notification.close();

	const baseUrl = self.registration.scope || "/";

	// Build target URL with session specificity when available
	let targetUrl: string;
	if (data.url) {
		targetUrl = data.url;
	} else if (data.slug && data.sessionId) {
		targetUrl = `${baseUrl}p/${data.slug}/s/${data.sessionId}`;
	} else if (data.slug) {
		targetUrl = `${baseUrl}p/${data.slug}/`;
	} else {
		targetUrl = baseUrl;
	}

	const projectPrefix = data.slug ? `${baseUrl}p/${data.slug}/` : null;

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clientList) => {
				// Prefer a client already on the exact URL
				for (const client of clientList) {
					if (client.url.includes(targetUrl)) {
						return client.focus();
					}
				}
				// Client on the same project — tell it to navigate to the session
				if (projectPrefix && data.sessionId) {
					for (const client of clientList) {
						if (client.url.includes(projectPrefix)) {
							postNavigate(client, data, targetUrl);
							return client.focus();
						}
					}
				}
				// Fall back to any visible client — navigate it
				for (const client of clientList) {
					if (client.visibilityState !== "hidden") {
						if (data.sessionId) {
							postNavigate(client, data, targetUrl);
						}
						return client.focus();
					}
				}
				// Fall back to any client
				if (clientList.length > 0) {
					if (data.sessionId) {
						postNavigate(clientList[0], data, targetUrl);
					}
					return clientList[0].focus();
				}
				// Open a new window
				return self.clients.openWindow(targetUrl);
			}),
	);
});
