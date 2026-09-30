// ─── Push Notifications (Ticket 4.6) ──────────────────────────────────────────
// Server-side push notification delivery using the web-push library.
// Manages VAPID keys, browser subscriptions, and sending notifications.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import { join } from "node:path";

import { Data } from "effect";
import { DEFAULT_CONFIG_DIR } from "../env.js";

// web-push is CJS-only — use createRequire (same pattern as ws in ws-handler.ts)
const require = createRequire(import.meta.url);
const webpush = require("web-push") as {
	generateVAPIDKeys: WebPushModule["generateVAPIDKeys"];
	generateRequestDetails(
		subscription: PushSubscriptionData,
		payload: string,
		options?: { TTL?: number; vapidDetails?: VapidDetails; timeout?: number },
	): {
		endpoint: string;
		method: string;
		headers: Record<string, string | number>;
		body?: Buffer;
	};
};

const defaultWebpush: WebPushModule = {
	generateVAPIDKeys: () => webpush.generateVAPIDKeys(),
	async sendNotification(subscription, payload, options) {
		const { signal, ...encodingOptions } = options ?? {};
		const details = webpush.generateRequestDetails(
			subscription,
			payload,
			encodingOptions,
		);
		signal?.throwIfAborted();
		// web-push hides its request and only supports an inactivity timeout.
		// Keep its encryption/signing, but own the request so abort stops the send.
		let abort = () => {};
		try {
			return await new Promise<{ statusCode: number }>((resolve, reject) => {
				const request = https.request(
					new URL(details.endpoint),
					{
						method: details.method,
						headers: details.headers,
					},
					(response) => {
						response.on("error", reject);
						response.on("end", () => {
							const statusCode = response.statusCode ?? 0;
							if (statusCode >= 200 && statusCode < 300)
								resolve({ statusCode });
							else
								reject(
									Object.assign(
										new Error("Received unexpected response code"),
										{ statusCode },
									),
								);
						});
						response.resume();
					},
				);
				request.on("error", reject);
				// An unhandled upgrade can close without a response or error.
				// Promise settlement is idempotent if a prior outcome already won.
				request.on("close", () =>
					reject(new Error("Push request closed before response completed")),
				);
				abort = () => request.destroy(signal?.reason);
				signal?.addEventListener("abort", abort, { once: true });
				if (details.body) request.write(details.body);
				request.end();
			});
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	},
};

// FCM requires at least 10s because its internal RPCs use that timeout:
// https://firebase.google.com/docs/cloud-messaging/scale-fcm#timeouts
const PUSH_SEND_TIMEOUT_MS = 10_000;

// ─── web-push type shims (no @types/web-push available) ──────────────────────

/** Minimal interface matching web-push API surface */
export interface WebPushModule {
	generateVAPIDKeys(): { publicKey: string; privateKey: string };
	sendNotification(
		subscription: PushSubscriptionData,
		payload: string,
		options?: {
			TTL?: number;
			vapidDetails?: VapidDetails;
			timeout?: number;
			signal?: AbortSignal;
		},
	): Promise<{ statusCode: number }>;
}

export interface VapidDetails {
	subject: string;
	publicKey: string;
	privateKey: string;
}

export interface PushSubscriptionData {
	endpoint: string;
	keys?: {
		p256dh?: string;
		auth?: string;
	};
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PushManagerOptions {
	/** VAPID subject, e.g. "mailto:admin@example.com" */
	vapidSubject?: string;
	/** Override config directory (default: ~/.conduit) */
	configDir?: string;
	/** Override web-push module (for testing) */
	_webpush?: WebPushModule;
}

export interface PushPayload {
	title: string;
	body: string;
	tag?: string;
	url?: string;
	type?: string;
	[key: string]: unknown;
}

/**
 * Who actually got the push (ni8.23).
 *
 * The delivery ledger marks a receipt only after the push service accepts it. It can only
 * be honest if the send tells it whether anyone was: a `sendToAll` that caught
 * every per-device failure and resolved anyway made every outcome — delivered,
 * refused, no devices at all — look identical to the caller, and the ledger then
 * suppressed every retry of an alert nobody ever received.
 *
 * Three outcomes, because they mean three different things to a retry:
 *  - `delivered`: the push service accepted it for this device.
 *  - `expired`: 403/404/410. The subscription is gone and has been dropped;
 *    retrying it is pointless, but it is also not a delivery.
 *  - `failed`: anything else — a 503, a dead network. This device could still
 *    be reached by a later attempt.
 */
export interface PushDeliveryReport {
	readonly delivered: readonly string[];
	readonly expired: readonly string[];
	readonly failed: readonly {
		readonly clientId: string;
		readonly cause: unknown;
	}[];
}

/** Human-readable outcome, for the log line that says a ding did not land. */
export const describeDelivery = (report: PushDeliveryReport): string =>
	`delivered=${report.delivered.length} expired=${report.expired.length} ` +
	`failed=${report.failed.length}` +
	(report.failed.length > 0
		? ` (${report.failed.map((f) => `${f.clientId}: ${f.cause}`).join("; ")})`
		: "");

export interface PushNotificationSender {
	getPublicKey(): string | null;
	addSubscription(clientId: string, subscription: PushSubscriptionData): void;
	removeSubscription(clientId: string): void;
	sendToAll(payload: PushPayload): Promise<PushDeliveryReport>;
	getSubscriptionIds?(): readonly string[];
	sendTo?(clientId: string, payload: PushPayload): Promise<PushDeliveryReport>;
}

export class PushNotificationManagerNotInitializedError extends Data.TaggedError(
	"PushNotificationManagerNotInitializedError",
)<{
	readonly operation: "sendToAll" | "sendTo";
}> {
	override get message(): string {
		return "PushNotificationManager not initialized — call init() first";
	}
}

export class PushVapidKeysNotInitializedError extends Data.TaggedError(
	"PushVapidKeysNotInitializedError",
)<{
	readonly operation: "getVapidDetails";
}> {
	override get message(): string {
		return "VAPID keys not initialized";
	}
}

// ─── PushNotificationManager ─────────────────────────────────────────────────

export class PushNotificationManager implements PushNotificationSender {
	private readonly vapidSubject: string;
	private readonly configDir: string;
	private readonly webpush: WebPushModule;
	private vapidKeys: { publicKey: string; privateKey: string } | null = null;
	private subscriptions = new Map<string, PushSubscriptionData>();

	constructor(options?: PushManagerOptions) {
		this.vapidSubject = options?.vapidSubject ?? "mailto:admin@conduit.dev";
		this.configDir = options?.configDir ?? DEFAULT_CONFIG_DIR;
		this.webpush = options?._webpush ?? defaultWebpush;
	}

	// ─── Init: generate or load VAPID keys, restore subscriptions ──────

	/** Generate or load VAPID keys, restore persisted subscriptions. Returns public key for frontend. */
	async init(): Promise<{ publicKey: string }> {
		this.vapidKeys = this.loadOrCreateVapidKeys();
		this.loadSubscriptions();
		await this.purgeDeadSubscriptions();
		return { publicKey: this.vapidKeys.publicKey };
	}

	/** Get the VAPID public key (null before init). */
	getPublicKey(): string | null {
		return this.vapidKeys?.publicKey ?? null;
	}

	// ─── Subscription management ────────────────────────────────────────

	/** Register a push subscription from a browser. */
	addSubscription(clientId: string, subscription: PushSubscriptionData): void {
		if (!subscription?.endpoint) return;
		this.subscriptions.set(clientId, subscription);
		this.saveSubscriptions();
	}

	/** Remove a subscription. */
	removeSubscription(clientId: string): void {
		this.subscriptions.delete(clientId);
		this.saveSubscriptions();
	}

	/** Number of active subscriptions. */
	getSubscriptionCount(): number {
		return this.subscriptions.size;
	}

	getSubscriptionIds(): readonly string[] {
		return [...this.subscriptions.keys()];
	}

	// ─── Push delivery ──────────────────────────────────────────────────

	private async sendNotification(
		subscription: PushSubscriptionData,
		payload: string,
		options: { TTL?: number; vapidDetails: VapidDetails },
	): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort(new Error("Push send timed out after 10000ms"));
		}, PUSH_SEND_TIMEOUT_MS);
		try {
			// Wait for transport cancellation before the caller releases its claim.
			await this.webpush.sendNotification(subscription, payload, {
				...options,
				timeout: PUSH_SEND_TIMEOUT_MS,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Send to every subscribed client and report what happened to each.
	 *
	 * Per-device failures are still not thrown — one dead phone must not stop the
	 * laptop from being told — but they are no longer discarded. The report is
	 * the whole point: it is what lets the delivery ledger tell "everybody got
	 * it" apart from "nobody did".
	 */
	async sendToAll(payload: PushPayload): Promise<PushDeliveryReport> {
		if (!this.vapidKeys) {
			throw new PushNotificationManagerNotInitializedError({
				operation: "sendToAll",
			});
		}

		const json = JSON.stringify(payload);
		const vapidDetails = this.getVapidDetails();
		const delivered: string[] = [];
		const expired: string[] = [];
		const failed: { clientId: string; cause: unknown }[] = [];

		const promises = Array.from(this.subscriptions.entries()).map(
			async ([clientId, sub]) => {
				try {
					await this.sendNotification(sub, json, { vapidDetails });
					delivered.push(clientId);
				} catch (err: unknown) {
					const statusCode = (err as { statusCode?: number }).statusCode;
					// Remove invalid/expired subscriptions
					if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
						expired.push(clientId);
					} else {
						failed.push({ clientId, cause: err });
					}
				}
			},
		);

		await Promise.all(promises);

		// Clean up invalid subscriptions
		if (expired.length > 0) {
			for (const clientId of expired) {
				this.subscriptions.delete(clientId);
			}
			this.saveSubscriptions();
		}

		return { delivered, expired, failed };
	}

	/** Send push notification to a specific client, and report the outcome. */
	async sendTo(
		clientId: string,
		payload: PushPayload,
	): Promise<PushDeliveryReport> {
		if (!this.vapidKeys) {
			throw new PushNotificationManagerNotInitializedError({
				operation: "sendTo",
			});
		}

		const empty: PushDeliveryReport = {
			delivered: [],
			expired: [],
			failed: [],
		};
		const sub = this.subscriptions.get(clientId);
		// No subscription is not a delivery, and saying so is the point: a caller
		// that treats it as one claims the user was told by a device that is not
		// there.
		if (!sub) return empty;

		const json = JSON.stringify(payload);
		const vapidDetails = this.getVapidDetails();

		try {
			await this.sendNotification(sub, json, { vapidDetails });
			return { ...empty, delivered: [clientId] };
		} catch (err: unknown) {
			const statusCode = (err as { statusCode?: number }).statusCode;
			if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
				this.subscriptions.delete(clientId);
				this.saveSubscriptions();
				return { ...empty, expired: [clientId] };
			}
			return { ...empty, failed: [{ clientId, cause: err }] };
		}
	}

	// ─── Subscription persistence ───────────────────────────────────────

	/** Save current subscriptions to push-subs.json with the VAPID public key. */
	private saveSubscriptions(): void {
		if (!this.vapidKeys) return;
		const subFile = join(this.configDir, "push-subs.json");
		const entries = Array.from(this.subscriptions.entries()).map(
			([clientId, sub]) => ({ clientId, ...sub }),
		);
		try {
			writeFileSync(
				subFile,
				JSON.stringify(
					{ vapidKey: this.vapidKeys.publicKey, subs: entries },
					null,
					2,
				),
			);
		} catch {
			// Best-effort — directory may not exist yet before init
		}
	}

	/** Load subscriptions from push-subs.json. Clears if VAPID key changed. */
	private loadSubscriptions(): void {
		if (!this.vapidKeys) return;
		const subFile = join(this.configDir, "push-subs.json");
		try {
			const data = readFileSync(subFile, "utf8");
			const saved = JSON.parse(data);
			// VAPID key mismatch — subscriptions are invalid
			if (saved.vapidKey && saved.vapidKey !== this.vapidKeys.publicKey) {
				return;
			}
			const subs = saved.subs;
			if (Array.isArray(subs)) {
				for (const entry of subs) {
					if (entry?.clientId && entry?.endpoint) {
						this.subscriptions.set(entry.clientId, {
							endpoint: entry.endpoint,
							keys: entry.keys,
						});
					}
				}
			}
		} catch {
			// File doesn't exist or is corrupted — start fresh
		}
	}

	/** Send test notification to each subscription, remove dead ones (403/404/410). */
	private async purgeDeadSubscriptions(): Promise<void> {
		if (!this.vapidKeys || this.subscriptions.size === 0) return;

		const vapidDetails = this.getVapidDetails();
		const testPayload = JSON.stringify({ type: "test" });
		const toRemove: string[] = [];

		const promises = Array.from(this.subscriptions.entries()).map(
			async ([clientId, sub]) => {
				try {
					await this.sendNotification(sub, testPayload, {
						TTL: 0,
						vapidDetails,
					});
				} catch (err: unknown) {
					const statusCode = (err as { statusCode?: number }).statusCode;
					if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
						toRemove.push(clientId);
					}
				}
			},
		);

		await Promise.all(promises);

		if (toRemove.length > 0) {
			for (const clientId of toRemove) {
				this.subscriptions.delete(clientId);
			}
			this.saveSubscriptions();
		}
	}

	// ─── VAPID key management ──────────────────────────────────────────

	private loadOrCreateVapidKeys(): {
		publicKey: string;
		privateKey: string;
	} {
		const keyFile = join(this.configDir, "vapid.json");

		try {
			const data = readFileSync(keyFile, "utf8");
			const keys = JSON.parse(data);
			if (keys.publicKey && keys.privateKey) {
				return keys;
			}
		} catch {
			// Key file doesn't exist or is invalid — generate new keys
		}

		const keys = this.webpush.generateVAPIDKeys();
		mkdirSync(this.configDir, { recursive: true });
		writeFileSync(keyFile, JSON.stringify(keys, null, 2));
		return keys;
	}

	private getVapidDetails(): VapidDetails {
		if (!this.vapidKeys) {
			throw new PushVapidKeysNotInitializedError({
				operation: "getVapidDetails",
			});
		}
		return {
			subject: this.vapidSubject,
			publicKey: this.vapidKeys.publicKey,
			privateKey: this.vapidKeys.privateKey,
		};
	}
}
