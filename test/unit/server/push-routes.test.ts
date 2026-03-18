// ─── Push API Routes — Unit Tests ────────────────────────────────────────────
// Tests the push notification HTTP endpoints on RelayServer:
//   GET  /api/push/vapid-key   → returns public key
//   POST /api/push/subscribe   → registers subscription
//   POST /api/push/unsubscribe → removes subscription

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PushNotificationManager,
	type WebPushModule,
} from "../../../src/lib/server/push.js";
import { RelayServer } from "../../../src/lib/server/server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockWebpush(): WebPushModule {
	let callCount = 0;
	return {
		generateVAPIDKeys: vi.fn(() => ({
			publicKey: `test_public_key_${++callCount}`,
			privateKey: `test_private_key_${callCount}`,
		})),
		sendNotification: vi.fn(async () => ({ statusCode: 201 })),
	};
}

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "push-routes-test-"));
}

async function fetchJson(baseUrl: string, path: string, options?: RequestInit) {
	const res = await fetch(`${baseUrl}${path}`, options);
	const body = await res.json();
	return { status: res.status, body };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Push API routes on RelayServer", () => {
	let tmpDir: string;
	let server: RelayServer;
	let baseUrl: string;
	let pushManager: PushNotificationManager;

	beforeEach(async () => {
		tmpDir = makeTmpDir();
		const mockWp = createMockWebpush();
		pushManager = new PushNotificationManager({
			configDir: tmpDir,
			_webpush: mockWp,
		});
		await pushManager.init();

		server = new RelayServer({
			port: 0, // random available port
			pushManager,
		});
		await server.start();

		const httpServer = server.getHttpServer();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const addr = httpServer!.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await server.stop();
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	// ── GET /api/push/vapid-key ──────────────────────────────────────────

	describe("GET /api/push/vapid-key", () => {
		it("returns 200 with publicKey", async () => {
			const { status, body } = await fetchJson(baseUrl, "/api/push/vapid-key");
			expect(status).toBe(200);
			expect(body.publicKey).toBeDefined();
			expect(typeof body.publicKey).toBe("string");
			expect(body.publicKey.length).toBeGreaterThan(0);
		});
	});

	// ── POST /api/push/subscribe ─────────────────────────────────────────

	describe("POST /api/push/subscribe", () => {
		it("registers a subscription and returns ok", async () => {
			const { status, body } = await fetchJson(baseUrl, "/api/push/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					subscription: {
						endpoint: "https://push.example.com/sub/1",
						keys: { p256dh: "key1", auth: "auth1" },
					},
				}),
			});
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(pushManager.getSubscriptionCount()).toBe(1);
		});

		it("returns 400 for missing endpoint", async () => {
			const { status, body } = await fetchJson(baseUrl, "/api/push/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ subscription: {} }),
			});
			expect(status).toBe(400);
			expect(body.error.code).toBe("BAD_REQUEST");
		});

		it("returns 400 for invalid JSON", async () => {
			const { status, body } = await fetchJson(baseUrl, "/api/push/subscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not-json",
			});
			expect(status).toBe(400);
			expect(body.error.code).toBe("BAD_REQUEST");
		});
	});

	// ── POST /api/push/unsubscribe ───────────────────────────────────────

	describe("POST /api/push/unsubscribe", () => {
		it("removes a subscription and returns ok", async () => {
			// First subscribe
			pushManager.addSubscription("https://push.example.com/sub/1", {
				endpoint: "https://push.example.com/sub/1",
				keys: { p256dh: "key1", auth: "auth1" },
			});
			expect(pushManager.getSubscriptionCount()).toBe(1);

			// Then unsubscribe
			const { status, body } = await fetchJson(
				baseUrl,
				"/api/push/unsubscribe",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ endpoint: "https://push.example.com/sub/1" }),
				},
			);
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(pushManager.getSubscriptionCount()).toBe(0);
		});

		it("returns 400 for missing endpoint", async () => {
			const { status, body } = await fetchJson(
				baseUrl,
				"/api/push/unsubscribe",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({}),
				},
			);
			expect(status).toBe(400);
			expect(body.error.code).toBe("BAD_REQUEST");
		});
	});

	// ── Without push manager ─────────────────────────────────────────────

	describe("Without push manager", () => {
		let noPushServer: RelayServer;
		let noPushBaseUrl: string;

		beforeEach(async () => {
			noPushServer = new RelayServer({ port: 0 });
			await noPushServer.start();
			const httpServer = noPushServer.getHttpServer();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const addr = httpServer!.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			noPushBaseUrl = `http://127.0.0.1:${port}`;
		});

		afterEach(async () => {
			await noPushServer.stop();
		});

		it("returns 404 for vapid-key when no push manager", async () => {
			const { status, body } = await fetchJson(
				noPushBaseUrl,
				"/api/push/vapid-key",
			);
			expect(status).toBe(404);
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});

		it("returns 404 for subscribe when no push manager", async () => {
			const { status, body } = await fetchJson(
				noPushBaseUrl,
				"/api/push/subscribe",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						subscription: { endpoint: "https://push.example.com/sub/1" },
					}),
				},
			);
			expect(status).toBe(404);
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});

		it("returns 404 for unsubscribe when no push manager", async () => {
			const { status, body } = await fetchJson(
				noPushBaseUrl,
				"/api/push/unsubscribe",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ endpoint: "https://push.example.com/sub/1" }),
				},
			);
			expect(status).toBe(404);
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});
	});
});
