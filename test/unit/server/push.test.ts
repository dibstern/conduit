// ─── Push Notification Tests (Ticket 4.6) ─────────────────────────────────────
// Tests for PushNotificationManager: VAPID key management, subscription
// lifecycle, push delivery for permission/completion/error events.

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PushNotificationManager,
	type PushSubscriptionData,
	type VapidDetails,
	type WebPushModule,
} from "../../../src/lib/server/push.js";

// ─── Mock web-push module ───────────────────────────────────────────────────

type SendNotificationFn = (
	sub: PushSubscriptionData,
	payload: string,
	options?: { TTL?: number; vapidDetails?: VapidDetails },
) => Promise<{ statusCode: number }>;

type GenerateVAPIDKeysFn = () => { publicKey: string; privateKey: string };

function createMockWebpush() {
	let callCount = 0;
	const generateVAPIDKeys = vi.fn<GenerateVAPIDKeysFn>(() => ({
		publicKey: `test_public_key_${++callCount}`,
		privateKey: `test_private_key_${callCount}`,
	}));

	const sendNotification = vi.fn<SendNotificationFn>(async () => ({
		statusCode: 201,
	}));

	const mock: WebPushModule = { generateVAPIDKeys, sendNotification };

	return { mock, generateVAPIDKeys, sendNotification };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "push-test-"));
}

function makeSub(
	endpoint = "https://push.example.com/sub/abc",
): PushSubscriptionData {
	return {
		endpoint,
		keys: {
			p256dh: "test-p256dh-key",
			auth: "test-auth-key",
		},
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Ticket 4.6 — PushNotificationManager", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	// ─── VAPID key generation ────────────────────────────────────────────

	describe("VAPID key generation", () => {
		it("generates keys on first init", async () => {
			const { mock, generateVAPIDKeys } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			const result = await mgr.init();

			expect(result.publicKey).toBeDefined();
			expect(typeof result.publicKey).toBe("string");
			expect(result.publicKey.length).toBeGreaterThan(0);
			expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
		});

		it("persists keys to vapid.json", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			const keyFile = join(tmpDir, "vapid.json");
			expect(existsSync(keyFile)).toBe(true);

			const stored = JSON.parse(readFileSync(keyFile, "utf8"));
			expect(stored.publicKey).toBeDefined();
			expect(stored.privateKey).toBeDefined();
		});

		it("reuses existing keys from disk", async () => {
			const { mock, generateVAPIDKeys } = createMockWebpush();

			// First init creates keys
			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			const result1 = await mgr1.init();

			// Reset mock call count
			generateVAPIDKeys.mockClear();

			// Second init should load from file
			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			const result2 = await mgr2.init();

			expect(result2.publicKey).toBe(result1.publicKey);
			expect(generateVAPIDKeys).not.toHaveBeenCalled();
		});

		it("uses custom vapidSubject", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				vapidSubject: "mailto:test@example.com",
				_webpush: mock,
			});
			const result = await mgr.init();
			expect(result.publicKey).toBeDefined();
		});
	});

	// ─── getPublicKey ─────────────────────────────────────────────────────

	describe("getPublicKey()", () => {
		it("returns null before init", () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			expect(mgr.getPublicKey()).toBeNull();
		});

		it("returns the public key after init", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			const result = await mgr.init();
			expect(mgr.getPublicKey()).toBe(result.publicKey);
			expect(mgr.getPublicKey()).not.toBeNull();
		});
	});

	// ─── Corrupted / partial vapid.json recovery ─────────────────────────

	describe("Corrupted vapid.json recovery", () => {
		it("regenerates keys when vapid.json contains invalid JSON", async () => {
			const { mock, generateVAPIDKeys } = createMockWebpush();

			// Write invalid JSON to vapid.json
			const keyFile = join(tmpDir, "vapid.json");
			writeFileSync(keyFile, "this is not valid json {{{");

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			const result = await mgr.init();

			// Should have generated new keys (not crashed)
			expect(result.publicKey).toBeDefined();
			expect(result.publicKey.length).toBeGreaterThan(0);
			expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);

			// Verify new keys were persisted
			const stored = JSON.parse(readFileSync(keyFile, "utf8"));
			expect(stored.publicKey).toBe(result.publicKey);
		});

		it("regenerates keys when vapid.json has only publicKey (missing privateKey)", async () => {
			const { mock, generateVAPIDKeys } = createMockWebpush();

			// Write partial keys (missing privateKey)
			const keyFile = join(tmpDir, "vapid.json");
			writeFileSync(keyFile, JSON.stringify({ publicKey: "partial-only" }));

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			const result = await mgr.init();

			// Should have generated new keys since privateKey was missing
			expect(result.publicKey).toBeDefined();
			expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);

			// The new key should NOT be the partial one
			expect(result.publicKey).not.toBe("partial-only");
		});
	});

	// ─── Subscription management ────────────────────────────────────────

	describe("Subscription add/remove/count", () => {
		it("starts with zero subscriptions", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("addSubscription increments count", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			expect(mgr.getSubscriptionCount()).toBe(1);
		});

		it("addSubscription with different clients", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr.addSubscription("client-2", makeSub("https://push.example.com/2"));
			expect(mgr.getSubscriptionCount()).toBe(2);
		});

		it("addSubscription replaces existing client subscription", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub("https://push.example.com/old"));
			mgr.addSubscription("client-1", makeSub("https://push.example.com/new"));
			expect(mgr.getSubscriptionCount()).toBe(1);
		});

		it("removeSubscription decrements count", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			mgr.removeSubscription("client-1");
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("removeSubscription with non-existent client is a no-op", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.removeSubscription("non-existent");
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("ignores subscriptions without an endpoint", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", { endpoint: "" });
			mgr.addSubscription("client-2", null as unknown as PushSubscriptionData);
			expect(mgr.getSubscriptionCount()).toBe(0);
		});
	});

	// ─── Push payload for permission events (AC4) ───────────────────────

	describe("Push payload for permission events (AC4)", () => {
		it("sends permission payload with correct title and body", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			mgr.addSubscription("client-1", makeSub());

			const payload = {
				title: "Approval needed",
				body: "Tool: file_edit requires approval",
				type: "permission_request",
				tag: "perm-req-1",
			};

			await mgr.sendToAll(payload);

			expect(sendNotification).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const sentJson = sendNotification.mock.calls[0]![1];
			const sentPayload = JSON.parse(sentJson);
			expect(sentPayload.title).toBe("Approval needed");
			expect(sentPayload.type).toBe("permission_request");
		});
	});

	// ─── Push payload for completion events (AC5) ───────────────────────

	describe("Push payload for completion events (AC5)", () => {
		it("sends completion payload with session info", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			mgr.addSubscription("client-1", makeSub());

			const payload = {
				title: "Task complete",
				body: "Session 'refactor auth' finished",
				type: "done",
				tag: "opencode-done",
			};

			await mgr.sendToAll(payload);

			expect(sendNotification).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const sentJson = sendNotification.mock.calls[0]![1];
			const sentPayload = JSON.parse(sentJson);
			expect(sentPayload.title).toBe("Task complete");
			expect(sentPayload.body).toContain("refactor auth");
		});
	});

	// ─── Push payload for error events (AC6) ────────────────────────────

	describe("Push payload for error events (AC6)", () => {
		it("sends error payload with error summary", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			mgr.addSubscription("client-1", makeSub());

			const payload = {
				title: "Error",
				body: "Rate limit exceeded (429)",
				type: "error",
				tag: "opencode-error",
			};

			await mgr.sendToAll(payload);

			expect(sendNotification).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const sentJson = sendNotification.mock.calls[0]![1];
			const sentPayload = JSON.parse(sentJson);
			expect(sentPayload.title).toBe("Error");
			expect(sentPayload.body).toContain("429");
		});
	});

	// ─── sendToAll iterates all subscriptions ───────────────────────────

	describe("sendToAll iterates all subscriptions", () => {
		it("sends to every subscribed client", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr.addSubscription("client-2", makeSub("https://push.example.com/2"));
			mgr.addSubscription("client-3", makeSub("https://push.example.com/3"));

			await mgr.sendToAll({
				title: "Test",
				body: "Broadcast message",
			});

			expect(sendNotification).toHaveBeenCalledTimes(3);
		});

		it("sends to zero clients without error", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			await expect(
				mgr.sendToAll({ title: "Test", body: "No clients" }),
			).resolves.toBeUndefined();
			expect(sendNotification).not.toHaveBeenCalled();
		});
	});

	// ─── sendTo specific client ─────────────────────────────────────────

	describe("sendTo specific client", () => {
		it("sends only to the specified client", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr.addSubscription("client-2", makeSub("https://push.example.com/2"));

			await mgr.sendTo("client-1", { title: "Direct", body: "Just for you" });

			expect(sendNotification).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const firstCallSub = sendNotification.mock.calls[0]![0];
			expect(firstCallSub.endpoint).toBe("https://push.example.com/1");
		});

		it("does nothing for non-existent client", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			await mgr.sendTo("non-existent", { title: "Test", body: "None" });
			expect(sendNotification).not.toHaveBeenCalled();
		});
	});

	// ─── Invalid subscription removal ──────────────────────────────────

	describe("Invalid subscription removal", () => {
		it("removes subscription on 410 Gone", async () => {
			const { mock, sendNotification } = createMockWebpush();
			sendNotification.mockRejectedValueOnce({ statusCode: 410 });

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			expect(mgr.getSubscriptionCount()).toBe(1);

			await mgr.sendToAll({ title: "Test", body: "Gone" });
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("removes subscription on 404 Not Found", async () => {
			const { mock, sendNotification } = createMockWebpush();
			sendNotification.mockRejectedValueOnce({ statusCode: 404 });

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			await mgr.sendToAll({ title: "Test", body: "Not Found" });
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("removes subscription on 403 Forbidden", async () => {
			const { mock, sendNotification } = createMockWebpush();
			sendNotification.mockRejectedValueOnce({ statusCode: 403 });

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			await mgr.sendToAll({ title: "Test", body: "Forbidden" });
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("keeps subscription on transient errors (e.g. 500)", async () => {
			const { mock, sendNotification } = createMockWebpush();
			sendNotification.mockRejectedValueOnce({ statusCode: 500 });

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			await mgr.sendToAll({ title: "Test", body: "Server Error" });
			expect(mgr.getSubscriptionCount()).toBe(1);
		});

		it("removes only invalid subscriptions from sendToAll", async () => {
			const { mock, sendNotification } = createMockWebpush();
			sendNotification
				.mockResolvedValueOnce({ statusCode: 201 }) // client-1 ok
				.mockRejectedValueOnce({ statusCode: 410 }) // client-2 gone
				.mockResolvedValueOnce({ statusCode: 201 }); // client-3 ok

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr.addSubscription("client-2", makeSub("https://push.example.com/2"));
			mgr.addSubscription("client-3", makeSub("https://push.example.com/3"));

			await mgr.sendToAll({ title: "Test", body: "Mixed" });
			expect(mgr.getSubscriptionCount()).toBe(2);
		});

		it("removes invalid subscription on sendTo", async () => {
			const { mock, sendNotification } = createMockWebpush();
			sendNotification.mockRejectedValueOnce({ statusCode: 410 });

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			await mgr.sendTo("client-1", { title: "Test", body: "Gone" });
			expect(mgr.getSubscriptionCount()).toBe(0);
		});
	});

	// ─── Error before init ─────────────────────────────────────────────

	describe("Error handling", () => {
		it("throws if sendToAll called before init", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			mgr.addSubscription("client-1", makeSub());

			await expect(
				mgr.sendToAll({ title: "Test", body: "Not init" }),
			).rejects.toThrow(/not initialized/i);
		});

		it("throws if sendTo called before init", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			mgr.addSubscription("client-1", makeSub());

			await expect(
				mgr.sendTo("client-1", { title: "Test", body: "Not init" }),
			).rejects.toThrow(/not initialized/i);
		});
	});

	// ─── VAPID details passed to web-push ──────────────────────────────

	describe("VAPID details", () => {
		it("passes vapidDetails to sendNotification", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				vapidSubject: "mailto:custom@example.com",
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			await mgr.sendToAll({ title: "Test", body: "VAPID check" });

			expect(sendNotification).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const callOptions = sendNotification.mock.calls[0]![2];
			expect(callOptions).toBeDefined();
			expect(callOptions?.vapidDetails).toBeDefined();
			expect(callOptions?.vapidDetails?.subject).toBe(
				"mailto:custom@example.com",
			);
			expect(callOptions?.vapidDetails?.publicKey).toBeDefined();
			expect(callOptions?.vapidDetails?.privateKey).toBeDefined();
		});
	});

	// ─── Subscription persistence (Ticket 8.22) ───────────────────────

	describe("Subscription persistence (Ticket 8.22)", () => {
		it("saves and loads subscriptions across instances (round-trip)", async () => {
			const { mock } = createMockWebpush();

			// First instance: init + add subscriptions
			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr1.init();
			mgr1.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr1.addSubscription("client-2", makeSub("https://push.example.com/2"));
			expect(mgr1.getSubscriptionCount()).toBe(2);

			// Second instance: should load subscriptions from disk
			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr2.init();
			expect(mgr2.getSubscriptionCount()).toBe(2);
		});

		it("clears subscriptions when VAPID key changes", async () => {
			const { mock, generateVAPIDKeys } = createMockWebpush();

			// First instance with key_1
			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr1.init();
			mgr1.addSubscription("client-1", makeSub());
			expect(mgr1.getSubscriptionCount()).toBe(1);

			// Write different VAPID keys to disk (simulating regeneration)
			const keyFile = join(tmpDir, "vapid.json");
			writeFileSync(
				keyFile,
				JSON.stringify({
					publicKey: "different_public_key",
					privateKey: "different_private_key",
				}),
			);
			// Reset mock so it doesn't generate new keys (will load from disk)
			generateVAPIDKeys.mockClear();

			// Second instance loads different VAPID key — subscriptions should be cleared
			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr2.init();
			expect(mgr2.getSubscriptionCount()).toBe(0);
		});

		it("startup purge removes dead subscriptions (404)", async () => {
			const { mock, sendNotification } = createMockWebpush();

			// First instance: add subscriptions
			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr1.init();
			mgr1.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr1.addSubscription("client-2", makeSub("https://push.example.com/2"));
			expect(mgr1.getSubscriptionCount()).toBe(2);

			// Second instance: client-1 is dead (404), client-2 is alive
			sendNotification
				.mockRejectedValueOnce({ statusCode: 404 }) // purge: client-1 dead
				.mockResolvedValueOnce({ statusCode: 201 }); // purge: client-2 ok

			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr2.init();
			expect(mgr2.getSubscriptionCount()).toBe(1);
		});

		it("startup purge removes dead subscriptions (410)", async () => {
			const { mock, sendNotification } = createMockWebpush();

			// First instance: add subscription
			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr1.init();
			mgr1.addSubscription("client-1", makeSub());

			// Second instance: client-1 is gone (410)
			sendNotification.mockRejectedValueOnce({ statusCode: 410 });

			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr2.init();
			expect(mgr2.getSubscriptionCount()).toBe(0);
		});

		it("startup purge sends test payload with TTL: 0", async () => {
			const { mock, sendNotification } = createMockWebpush();

			// First instance: add subscription
			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr1.init();
			mgr1.addSubscription("client-1", makeSub());
			sendNotification.mockClear();

			// Second instance: purge should send test with TTL: 0
			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr2.init();

			expect(sendNotification).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const [, payload, options] = sendNotification.mock.calls[0]!;
			expect(JSON.parse(payload)).toEqual({ type: "test" });
			expect(options?.TTL).toBe(0);
		});

		it("saves subscriptions to push-subs.json on addSubscription", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());

			const subFile = join(tmpDir, "push-subs.json");
			expect(existsSync(subFile)).toBe(true);
			const saved = JSON.parse(readFileSync(subFile, "utf8"));
			expect(saved.subs).toHaveLength(1);
			expect(saved.subs[0].clientId).toBe("client-1");
			expect(saved.vapidKey).toBeDefined();
		});

		it("saves subscriptions to push-subs.json on removeSubscription", async () => {
			const { mock } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();

			mgr.addSubscription("client-1", makeSub());
			mgr.removeSubscription("client-1");

			const subFile = join(tmpDir, "push-subs.json");
			const saved = JSON.parse(readFileSync(subFile, "utf8"));
			expect(saved.subs).toHaveLength(0);
		});

		it("handles missing push-subs.json gracefully", async () => {
			const { mock } = createMockWebpush();
			// No push-subs.json in tmpDir — should not throw
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("handles corrupted push-subs.json gracefully", async () => {
			const { mock } = createMockWebpush();

			// Write corrupted JSON
			const subFile = join(tmpDir, "push-subs.json");
			writeFileSync(subFile, "not valid json {{{");

			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			expect(mgr.getSubscriptionCount()).toBe(0);
		});

		it("saves after sendToAll removes dead subscriptions", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			mgr.addSubscription("client-1", makeSub("https://push.example.com/1"));
			mgr.addSubscription("client-2", makeSub("https://push.example.com/2"));

			// client-1 ok, client-2 gone
			sendNotification
				.mockResolvedValueOnce({ statusCode: 201 })
				.mockRejectedValueOnce({ statusCode: 410 });

			await mgr.sendToAll({ title: "Test", body: "Mixed" });
			expect(mgr.getSubscriptionCount()).toBe(1);

			// Verify persisted state reflects the cleanup
			const subFile = join(tmpDir, "push-subs.json");
			const saved = JSON.parse(readFileSync(subFile, "utf8"));
			expect(saved.subs).toHaveLength(1);
		});

		it("saves after sendTo removes a dead subscription", async () => {
			const { mock, sendNotification } = createMockWebpush();
			const mgr = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr.init();
			mgr.addSubscription("client-1", makeSub());

			sendNotification.mockRejectedValueOnce({ statusCode: 410 });
			await mgr.sendTo("client-1", { title: "Test", body: "Gone" });

			const subFile = join(tmpDir, "push-subs.json");
			const saved = JSON.parse(readFileSync(subFile, "utf8"));
			expect(saved.subs).toHaveLength(0);
		});

		it("preserves subscription keys in round-trip", async () => {
			const { mock } = createMockWebpush();

			const mgr1 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr1.init();
			mgr1.addSubscription("client-1", {
				endpoint: "https://push.example.com/1",
				keys: { p256dh: "key-p256dh", auth: "key-auth" },
			});

			// Second instance should have the keys intact
			const mgr2 = new PushNotificationManager({
				configDir: tmpDir,
				_webpush: mock,
			});
			await mgr2.init();

			// Verify by sending — the subscription data passed to sendNotification should have keys
			const { sendNotification } = mock;
			(sendNotification as ReturnType<typeof vi.fn>).mockClear();
			await mgr2.sendToAll({ title: "Test", body: "Keys check" });
			expect(sendNotification).toHaveBeenCalledTimes(1);
			const sub =
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				(sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
			expect(sub.keys).toEqual({ p256dh: "key-p256dh", auth: "key-auth" });
		});
	});
});
