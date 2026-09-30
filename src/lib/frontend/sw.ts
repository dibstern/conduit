/// <reference lib="webworker" />
// ─── Service Worker ──────────────────────────────────────────────────────────
// Handles push events to show notifications and manages notification clicks
// to focus/open the relay. Only successful alert receipts are cached;
// application assets still require a live server connection.

import type { PermissionId } from "../shared-types.js";

declare const self: ServiceWorkerGlobalScope;

const ALERT_RECEIPT_CACHE = "conduit-alert-receipts-v1";
const activeDeliveries = new Map<string, Promise<void>>();

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
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key !== ALERT_RECEIPT_CACHE)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// ─── Push: show notification ─────────────────────────────────────────────

interface PushPayload {
	alertId?: string;
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

	// Offer the alert to a focused tab first; show the OS notification unless
	// that tab says, explicitly, that it dinged (ni8.23, decision 3.1 = F).
	event.waitUntil(deliverPush(data, options));
});

function deliverPush(
	data: PushPayload,
	options: NotificationOptions,
): Promise<void> {
	const receiptKey = data.alertId
		? `${self.location.origin}/__alert_receipts__/${encodeURIComponent(JSON.stringify([data.slug ?? "", data.sessionId ?? "", data.alertId]))}`
		: undefined;
	// A queued retry waits for the live delivery and then checks its receipt.
	// Failed deliveries leave no receipt, so that retry remains eligible.
	const previous = receiptKey ? activeDeliveries.get(receiptKey) : undefined;
	const delivery = (previous ?? Promise.resolve()).then(async () => {
		let receipts: Cache | undefined;
		if (receiptKey) {
			try {
				receipts = await caches.open(ALERT_RECEIPT_CACHE);
				if (await receipts.match(receiptKey)) return;
			} catch {
				// Storage failure permits a duplicate rather than suppressing an alert.
			}
		}
		try {
			if (!(await dingInFocusedTab(data))) {
				await self.registration.showNotification(
					data.title ?? "Conduit",
					options,
				);
			}
		} catch (err: unknown) {
			console.warn("[sw] Failed to show notification:", err);
			return;
		}
		if (receipts && receiptKey) {
			try {
				await receipts.put(receiptKey, new Response("delivered"));
			} catch {
				// Delivery succeeded; without a durable receipt replay may repeat it.
			}
		}
	});
	if (receiptKey) {
		activeDeliveries.set(receiptKey, delivery);
		void delivery.finally(() => {
			if (activeDeliveries.get(receiptKey) === delivery)
				activeDeliveries.delete(receiptKey);
		});
	}
	return delivery;
}

// Readiness only prepares playback. Both preparation and delivery need bounded
// acknowledgements so a disappearing tab cannot swallow the notification.
const IN_APP_ACK_MS = 150;
const IN_APP_HANDLED_MS = 100;

async function dingInFocusedTab(data: PushPayload): Promise<boolean> {
	let focused: WindowClient | undefined;
	try {
		const windows = await self.clients.matchAll({
			type: "window",
			includeUncontrolled: true,
		});
		focused = windows.find(
			(client) => client.focused && client.visibilityState === "visible",
		);
	} catch {
		return false;
	}
	if (!focused) return false;

	const tab = focused;
	return await new Promise<boolean>((resolve) => {
		const channel = new MessageChannel();
		let state: "offered" | "granted" | "settled" = "offered";
		const settle = (handled: boolean) => {
			state = "settled";
			clearTimeout(timer);
			channel.port1.close();
			resolve(handled);
		};
		let timer = setTimeout(() => settle(false), IN_APP_ACK_MS);
		channel.port1.onmessage = (event: MessageEvent) => {
			if (state === "settled") return;
			if (event.data?.ready === true && state === "offered") {
				state = "granted";
				clearTimeout(timer);
				timer = setTimeout(() => settle(false), IN_APP_HANDLED_MS);
				channel.port1.postMessage({ granted: true });
			} else if (event.data?.handled === false) {
				settle(false);
			} else if (state === "granted" && event.data?.handled === true) {
				settle(true);
			}
		};
		try {
			tab.postMessage({ type: "prepare_in_app_alert", payload: data }, [
				channel.port2,
			]);
		} catch {
			settle(false);
		}
	});
}

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
				const firstClient = clientList[0];
				if (firstClient) {
					if (data.sessionId) {
						postNavigate(firstClient, data, targetUrl);
					}
					return firstClient.focus();
				}
				// Open a new window
				return self.clients.openWindow(targetUrl);
			}),
	);
});
