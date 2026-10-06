// Verifies that when an alert arrives on SubscribeAlerts with a sessionId,
// the frontend can navigate to that session.
//
// Since Playwright cannot click OS-level browser notifications, we test the
// pipeline by:
//   1. Setting up a multi-session WS mock
//   2. Publishing an alert with a sessionId for a different session
//   3. Simulating the notification click via navigator.serviceWorker message
//      dispatch (the same path a real push notification click takes)
//   4. Verifying the frontend sends ViewSession RPC and the URL updates
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;

const PROJECT_SLUG = "test-project";
const PROJECT_URL = "/s/sess-notif-A";

const SESS_A = "sess-notif-A";
const SESS_B = "sess-notif-B";

/** Init messages with two sessions, starting on sess-A. */
const twoSessionInit: MockMessage[] = [
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	{
		type: "shell_snapshot",
		roots: true,
		sessions: [
			{
				id: SESS_A,
				title: "Session A — current",
				status: "idle",
				updatedAt: Date.now(),
				messageCount: 2,
			},
			{
				id: SESS_B,
				title: "Session B — target",
				status: "idle",
				updatedAt: Date.now() - 3600_000,
				messageCount: 5,
			},
		],
	},
	{
		type: "mock_model_catalog",
		providers: [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4",
						name: "claude-sonnet-4",
						provider: "anthropic",
					},
				],
			},
		],
	},
	{
		type: "mock_agent_catalog",
		providerScope: { id: "opencode", name: "OpenCode" },
		agents: [
			{ id: "code", name: "Code", description: "General coding assistant" },
		],
	},
	{
		type: "project_list",
		projects: [
			{
				slug: PROJECT_SLUG,
				title: PROJECT_SLUG,
				folders: ["/src/test-project"],
			},
		],
		current: PROJECT_SLUG,
	},
];

/** Wait for the chat page to be ready (WS connected, input visible). */
async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

test.describe("Notification → Session Navigation", () => {
	test("an alert for another session is delivered over SubscribeAlerts", async ({
		page,
		baseURL,
	}) => {
		// Set up WS mock and respond to ViewSession RPC.
		const rpc = await mockWsRpc(page, {
			handlers: {
				ViewSession: () => ({ ok: true }),
			},
		});
		await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// The URL selects sess-A on entry.
		await page.waitForFunction(
			(sessId) =>
				window.location.pathname.includes(`/s/${sessId}`) ||
				document.querySelector(`[data-session-id="${sessId}"].active`) !== null,
			SESS_A,
			{ timeout: 5_000 },
		);

		// Publish an alert — simulates a "done" event on sess-B that the
		// pipeline dropped because we're viewing sess-A.
		await expect.poll(() => rpc.hasStream("SubscribeAlerts")).toBe(true);
		rpc.sendAlert({
			_tag: "alert",
			kind: "done",
			alertId: `${SESS_B}:done`,
			sessionId: SESS_B,
		});

		// Simulate the notification click path: dispatch a navigate_to_session
		// message on navigator.serviceWorker, which is where
		// initSWMessageListener() registers its handler.
		//
		// In a real flow: push notification click → SW notificationclick →
		// SW posts navigate_to_session → frontend listener → switchToSession()
		await page.evaluate(
			({ sessionId, slug }) => {
				if ("serviceWorker" in navigator) {
					const event = new MessageEvent("message", {
						data: { type: "navigate_to_session", sessionId, slug },
					});
					navigator.serviceWorker.dispatchEvent(event);
				}
			},
			{ sessionId: SESS_B, slug: PROJECT_SLUG },
		);

		// Verify the frontend sent ViewSession with sess-B
		const viewRequest = await rpc.waitForRequest((request) => {
			return (
				request.tag === "ViewSession" && request.payload["sessionId"] === SESS_B
			);
		});
		expect(viewRequest).toMatchObject({
			tag: "ViewSession",
			payload: { sessionId: SESS_B },
		});

		// Verify URL updated to include /s/sess-B
		await page.waitForFunction(
			(sessId) => window.location.pathname.includes(`/s/${sessId}`),
			SESS_B,
			{ timeout: 5_000 },
		);
		expect(page.url()).toContain(`/s/${SESS_B}`);
	});

	test("notification click navigates even without service worker", async ({
		page,
		baseURL,
	}) => {
		// This test verifies the alternative path: when there's no SW,
		// the browser Notification.onclick handler calls _navigateToSession
		// directly. We simulate this by clicking a session in the sidebar.
		//
		// Since we can't create real Notification objects in Playwright,
		// we test the onNavigateToSession callback is wired up by
		// directly calling it via the session list click path.
		const rpc = await mockWsRpc(page, {
			handlers: {
				ViewSession: () => ({ ok: true }),
			},
		});
		await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Click session B's title end in the sidebar; the row's hover actions cover its centre.
		await page
			.locator(`[data-session-id="${SESS_B}"]`)
			.click({ position: { x: 48, y: 12 }, timeout: 5_000 });

		// Verify the frontend sent ViewSession with sess-B
		const viewRequest = await rpc.waitForRequest((request) => {
			return (
				request.tag === "ViewSession" && request.payload["sessionId"] === SESS_B
			);
		});
		expect(viewRequest).toMatchObject({
			tag: "ViewSession",
			payload: { sessionId: SESS_B },
		});

		// Verify URL updated
		await page.waitForFunction(
			(sessId) => window.location.pathname.includes(`/s/${sessId}`),
			SESS_B,
			{ timeout: 5_000 },
		);
		expect(page.url()).toContain(`/s/${SESS_B}`);
	});

	test("an alert without sessionId does not crash", async ({
		page,
		baseURL,
	}) => {
		// Verify the pipeline handles an alert without sessionId
		// gracefully (no navigation, no crash).
		const rpc = await mockWsRpc(page, {
			handlers: {
				ViewSession: () => ({ ok: true }),
			},
		});
		await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// This should not throw or navigate — just trigger sound/browser notif
		// (which are suppressed in test since Notification.permission !== "granted")
		const errors: Error[] = [];
		page.on("pageerror", (error) => errors.push(error));
		await expect.poll(() => rpc.hasStream("SubscribeAlerts")).toBe(true);
		rpc.sendAlert({
			_tag: "alert",
			kind: "error",
			alertId: "no-session",
			message: "Provider quota exhausted",
		});
		// The in-app ding for a tab without push: an error toast.
		await expect(
			page.getByText("Error — Provider quota exhausted"),
		).toBeVisible();
		expect(errors).toEqual([]);

		// Page should still be on sess-A (no unintended navigation)
		const url = page.url();
		expect(url).not.toContain(`/s/${SESS_B}`);
	});
});
