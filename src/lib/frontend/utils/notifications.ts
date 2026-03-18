// ─── Notification Utilities ──────────────────────────────────────────────────
// Push subscription management and service worker registration.
// Pure functions — integrates with service worker.

/**
 * Full push subscription lifecycle: register SW, fetch VAPID key,
 * subscribe browser, and register with server.
 *
 * Uses the registration object directly — never touches
 * navigator.serviceWorker.ready which can hang indefinitely.
 * Lets actual browser errors propagate so callers see the real reason.
 */
export async function enablePushSubscription(): Promise<PushSubscriptionJSON> {
	if (!("serviceWorker" in navigator)) {
		throw new Error("Service workers are not supported in this browser.");
	}

	// Register directly — let the real browser error propagate
	const reg = await navigator.serviceWorker.register("/sw.js", {
		scope: "/",
	});

	// Wait for the SW to activate (pushManager.subscribe requires it).
	// Uses statechange events instead of navigator.serviceWorker.ready
	// which can hang indefinitely if activation fails.
	if (!reg.active) {
		await new Promise<void>((resolve, reject) => {
			const sw = reg.installing ?? reg.waiting;
			if (!sw) {
				reject(new Error("Service worker not found after registration."));
				return;
			}
			const onStateChange = (): void => {
				if (sw.state === "activated") {
					sw.removeEventListener("statechange", onStateChange);
					resolve();
				} else if (sw.state === "redundant") {
					sw.removeEventListener("statechange", onStateChange);
					reject(new Error("Service worker failed to activate."));
				}
			};
			sw.addEventListener("statechange", onStateChange);
			setTimeout(() => {
				sw.removeEventListener("statechange", onStateChange);
				reject(new Error("Service worker activation timed out."));
			}, 10_000);
		});
	}

	// Fetch VAPID public key from server
	const resp = await fetch("/api/push/vapid-key");
	if (!resp.ok) throw new Error("Failed to fetch VAPID key from server");
	const { publicKey } = (await resp.json()) as { publicKey: string };

	// Force-unsubscribe stale subscription before re-subscribing
	const existing = await reg.pushManager.getSubscription();
	if (existing) await existing.unsubscribe();

	// Subscribe using the registration directly (not navigator.serviceWorker.ready)
	const applicationServerKey = urlBase64ToUint8Array(publicKey);
	const subscription = await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey,
	});

	// Register subscription with server
	await fetch("/api/push/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subscription: subscription.toJSON() }),
	});

	// Store VAPID key to detect rotation on next page load
	localStorage.setItem("vapid-public-key", publicKey);

	return subscription.toJSON();
}

/**
 * Convert a base64url-encoded string (VAPID key) to a Uint8Array
 * for use with PushManager.subscribe().
 */
export function urlBase64ToUint8Array(
	base64String: string,
): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; i++) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}
