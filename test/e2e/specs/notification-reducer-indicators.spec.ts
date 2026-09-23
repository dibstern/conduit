// ─── Notification Reducer → Indicator E2E Tests ──────────────────────────────
// Two pipelines meet in the sidebar and this spec covers both.
//
// The row's status word is server-derived: the relay computes one attention
// tier per session and sends it on the session list, so the word follows the
// list and nothing else. It used to be a client-side dot assembled from
// notification events, local phase and read state, which could disagree with
// the server.
//
// The notification reducer still owns the live cross-session signal, whose
// remaining surface is the AttentionBanner: server sends notification_event →
// frontend dispatches to the reducer → banner appears, and clears when you
// open the session or when a session list reconciles the counts away.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import {
	mockRelayWebSocket,
	type WsMockControl,
	type WsMockOptions,
} from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

const PROJECT_SLUG = "test-project";
const PROJECT_URL = "/s/sess-indicator-A";

const SESS_A = "sess-indicator-A";
const SESS_B = "sess-indicator-B";

/** Init messages with two sessions, starting on session A. */
const twoSessionInit: MockMessage[] = [
	{ type: "session_switched", id: SESS_A },
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: SESS_A,
				title: "Session A — current",
				updatedAt: Date.now(),
				messageCount: 2,
			},
			{
				id: SESS_B,
				title: "Session B — other",
				updatedAt: Date.now() - 3600_000,
				messageCount: 5,
			},
		],
	},
	{
		type: "model_list",
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
		type: "agent_list",
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
				directory: "/src/test-project",
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

/**
 * Locator for the sidebar session item by session ID.
 * Matches `<a data-session-id="...">` in SessionItem.svelte.
 */
function sessionItem(page: Page, sessionId: string) {
	return page.locator(`[data-session-id="${sessionId}"]`);
}

/**
 * The row's status word. One per row, or none at all when the session is idle.
 * SessionItem renders: `<span class="session-item-status ...">Approve</span>`.
 */
function statusWord(page: Page, sessionId: string) {
	return sessionItem(page, sessionId).locator(".session-item-status");
}

/** The AttentionBanner component with role="status". */
function attentionBanner(page: Page) {
	return page.locator("[role='status']");
}

async function mockRelayWithViewSessionRpc(
	page: Page,
	options: Omit<WsMockOptions, "onClientMessage">,
): Promise<WsMockControl> {
	let control!: WsMockControl;
	await mockWsRpc(page, {
		handlers: {
			ViewSession: (params) => {
				const sessionId = String(params["sessionId"] ?? "");
				control.sendMessage({
					type: "session_switched",
					id: sessionId,
				});
				control.sendMessage({
					type: "history_page",
					sessionId,
					messages: [],
					hasMore: false,
				});
				return { ok: true };
			},
		},
	});
	control = await mockRelayWebSocket(page, options);
	return control;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe("notification reducer indicators", () => {
	test("shows the status word the session list sends for a session", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWithViewSessionRpc(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// The init list carries no attention, which reads as idle, and an idle
		// row shows no word at all.
		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(statusWord(page, SESS_B)).toHaveCount(0);

		control.sendMessage({
			type: "session_list",
			roots: true,
			sessions: [
				{
					id: SESS_A,
					title: "Session A — current",
					updatedAt: Date.now(),
					messageCount: 2,
					attention: "idle",
				},
				{
					id: SESS_B,
					title: "Session B — other",
					updatedAt: Date.now(),
					messageCount: 5,
					attention: "needs-reply",
				},
			],
		});

		await expect(statusWord(page, SESS_B)).toHaveText("Reply", {
			timeout: 5_000,
		});
		// The word leads the accessible name, so the row announces what it wants
		// before what it is called.
		await expect(sessionItem(page, SESS_B)).toHaveAttribute(
			"aria-label",
			/^Needs reply, Session B/,
			{ timeout: 5_000 },
		);
	});

	test("shows Done for a session the list reports as done and unread", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWithViewSessionRpc(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(statusWord(page, SESS_B)).toHaveCount(0);

		// Read state is durable and server-derived: it reaches the client folded
		// into the attention tier on a re-broadcast session list, never as a
		// notification.
		control.sendMessage({
			type: "session_list",
			roots: true,
			sessions: [
				{
					id: SESS_A,
					title: "Session A — current",
					updatedAt: Date.now(),
					messageCount: 2,
					attention: "idle",
				},
				{
					id: SESS_B,
					title: "Session B — other",
					updatedAt: Date.now(),
					messageCount: 6,
					unread: true,
					attention: "done-unread",
				},
			],
		});

		await expect(statusWord(page, SESS_B)).toHaveText("Done", {
			timeout: 5_000,
		});
	});

	test("clears the attention banner when you open that session (session_viewed)", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWithViewSessionRpc(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		control.sendMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: SESS_B,
		});

		await expect(attentionBanner(page)).toBeVisible({ timeout: 5_000 });

		await sessionItem(page, SESS_B).click({ timeout: 5_000 });

		// Wait for the switch to complete (URL updates to include session B)
		await page.waitForFunction(
			(sessId) => window.location.pathname.includes(`/s/${sessId}`),
			SESS_B,
			{ timeout: 5_000 },
		);

		// The banner never points at the session you are already looking at.
		await expect(attentionBanner(page)).toHaveCount(0);
	});

	test("AttentionBanner appears when another session has a question", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWithViewSessionRpc(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// No attention banner initially
		await expect(attentionBanner(page)).toHaveCount(0);

		// Server sends ask_user notification for session B
		control.sendMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: SESS_B,
		});

		// AttentionBanner should appear with role="status"
		await expect(attentionBanner(page)).toBeVisible({ timeout: 5_000 });

		// Banner should mention session B's title
		await expect(attentionBanner(page)).toContainText("Session B", {
			timeout: 5_000,
		});

		// Banner should indicate something needs attention
		await expect(attentionBanner(page)).toContainText("attention", {
			timeout: 5_000,
		});
	});

	test("reconcile via session_list corrects stale banner state", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWithViewSessionRpc(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// No banner initially (initial session_list has no pendingQuestionCount)
		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(attentionBanner(page)).toHaveCount(0);

		// Server sends a reconciliation session_list with pendingQuestionCount on B.
		// This simulates the periodic session list refresh that corrects stale state.
		// The ws-dispatch.ts handler extracts pendingQuestionCount and dispatches
		// a "reconcile" action to the notification reducer.
		control.sendMessage({
			type: "session_list",
			roots: true,
			sessions: [
				{
					id: SESS_A,
					title: "Session A — current",
					updatedAt: Date.now(),
					messageCount: 2,
					pendingQuestionCount: 0,
				},
				{
					id: SESS_B,
					title: "Session B — other",
					updatedAt: Date.now() - 3600_000,
					messageCount: 5,
					pendingQuestionCount: 2,
				},
			],
		});

		// The banner should now point at session B (reconcile sets questions: 2)
		await expect(attentionBanner(page)).toBeVisible({ timeout: 5_000 });
		await expect(attentionBanner(page)).toContainText("Session B", {
			timeout: 5_000,
		});
	});
});
