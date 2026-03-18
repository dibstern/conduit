// ─── Push Notifications (Ticket 4.6) ──────────────────────────────────────────
// Server-side push notification delivery using the web-push library.
// Manages VAPID keys, browser subscriptions, and sending notifications.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { DEFAULT_CONFIG_DIR } from "../env.js";

// web-push is CJS-only — use createRequire (same pattern as ws in ws-handler.ts)
const require = createRequire(import.meta.url);
const defaultWebpush = require("web-push") as WebPushModule;

// ─── web-push type shims (no @types/web-push available) ──────────────────────

/** Minimal interface matching web-push API surface */
export interface WebPushModule {
	generateVAPIDKeys(): { publicKey: string; privateKey: string };
	sendNotification(
		subscription: PushSubscriptionData,
		payload: string,
		options?: { TTL?: number; vapidDetails?: VapidDetails },
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
	/** Override config directory (default: ~/.opencode-relay) */
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

// ─── PushNotificationManager ─────────────────────────────────────────────────

export class PushNotificationManager {
	private readonly vapidSubject: string;
	private readonly configDir: string;
	private readonly webpush: WebPushModule;
	private vapidKeys: { publicKey: string; privateKey: string } | null = null;
	private subscriptions = new Map<string, PushSubscriptionData>();

	constructor(options?: PushManagerOptions) {
		this.vapidSubject =
			options?.vapidSubject ?? "mailto:admin@opencode-relay.dev";
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

	// ─── Push delivery ──────────────────────────────────────────────────

	/** Send push notification to all subscribed clients. */
	async sendToAll(payload: PushPayload): Promise<void> {
		if (!this.vapidKeys) {
			throw new Error(
				"PushNotificationManager not initialized — call init() first",
			);
		}

		const json = JSON.stringify(payload);
		const vapidDetails = this.getVapidDetails();
		const toRemove: string[] = [];

		const promises = Array.from(this.subscriptions.entries()).map(
			async ([clientId, sub]) => {
				try {
					await this.webpush.sendNotification(sub, json, { vapidDetails });
				} catch (err: unknown) {
					const statusCode = (err as { statusCode?: number }).statusCode;
					// Remove invalid/expired subscriptions
					if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
						toRemove.push(clientId);
					}
				}
			},
		);

		await Promise.all(promises);

		// Clean up invalid subscriptions
		if (toRemove.length > 0) {
			for (const clientId of toRemove) {
				this.subscriptions.delete(clientId);
			}
			this.saveSubscriptions();
		}
	}

	/** Send push notification to a specific client. */
	async sendTo(clientId: string, payload: PushPayload): Promise<void> {
		if (!this.vapidKeys) {
			throw new Error(
				"PushNotificationManager not initialized — call init() first",
			);
		}

		const sub = this.subscriptions.get(clientId);
		if (!sub) return;

		const json = JSON.stringify(payload);
		const vapidDetails = this.getVapidDetails();

		try {
			await this.webpush.sendNotification(sub, json, { vapidDetails });
		} catch (err: unknown) {
			const statusCode = (err as { statusCode?: number }).statusCode;
			if (statusCode === 403 || statusCode === 404 || statusCode === 410) {
				this.subscriptions.delete(clientId);
				this.saveSubscriptions();
			}
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
					await this.webpush.sendNotification(sub, testPayload, {
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
			throw new Error("VAPID keys not initialized");
		}
		return {
			subject: this.vapidSubject,
			publicKey: this.vapidKeys.publicKey,
			privateKey: this.vapidKeys.privateKey,
		};
	}
}
