// ─── Notification Reducer → Indicator E2E Tests ──────────────────────────────
// Verifies the full pipeline: server sends notification_event via WebSocket →
// frontend receives and dispatches to notification reducer → sidebar dots
// and AttentionBanner update accordingly.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import type { WsMockControl } from "../helpers/ws-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

const PROJECT_SLUG = "test-project";
const PROJECT_URL = `/p/${PROJECT_SLUG}/`;

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
 * Attention dot: a filled circle inside the session item.
 * SessionItem renders: `<span class="... bg-brand-b"></span>` for "attention".
 */
function attentionDot(page: Page, sessionId: string) {
	return sessionItem(page, sessionId).locator("span.bg-brand-b");
}

/**
 * Done-unviewed dot: an outlined circle inside the session item.
 * SessionItem renders: `<span class="... border-brand-b bg-transparent"></span>`.
 */
function doneUnviewedDot(page: Page, sessionId: string) {
	return sessionItem(page, sessionId).locator(
		"span.border-brand-b.bg-transparent",
	);
}

/** The AttentionBanner component with role="status". */
function attentionBanner(page: Page) {
	return page.locator("[role='status']");
}

/** Standard onClientMessage handler that responds to view_session. */
function viewSessionHandler(
	parsed: Record<string, unknown>,
	ctrl: WsMockControl,
) {
	if (
		parsed["type"] === "view_session" &&
		typeof parsed["sessionId"] === "string"
	) {
		ctrl.sendMessage({
			type: "session_switched",
			id: parsed["sessionId"],
		});
		ctrl.sendMessage({
			type: "history_page",
			sessionId: parsed["sessionId"],
			messages: [],
			hasMore: false,
		});
	}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe("notification reducer indicators", () => {
	test("shows attention dot on sidebar session after ask_user notification_event", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
			onClientMessage: viewSessionHandler,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Verify session B is visible in sidebar
		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });

		// No attention dot initially
		await expect(attentionDot(page, SESS_B)).toHaveCount(0);

		// Server sends ask_user notification for session B
		control.sendMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: SESS_B,
		});

		// Attention dot should appear on session B
		await expect(attentionDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });
	});

	test("clears attention dot when navigating to that session (session_viewed)", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
			onClientMessage: viewSessionHandler,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Inject ask_user notification on session B to create attention dot
		control.sendMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: SESS_B,
		});

		// Wait for attention dot to appear
		await expect(attentionDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });

		// Navigate to session B by clicking it in the sidebar
		await sessionItem(page, SESS_B).click({ timeout: 5_000 });

		// Wait for the switch to complete (URL updates to include session B)
		await page.waitForFunction(
			(sessId) => window.location.pathname.includes(`/s/${sessId}`),
			SESS_B,
			{ timeout: 5_000 },
		);

		// Attention dot should be gone — the current session never shows a dot
		// (getSessionIndicator returns null for currentSessionId)
		await expect(attentionDot(page, SESS_B)).toHaveCount(0);
	});

	test("shows done-unviewed dot after done notification_event", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
			onClientMessage: viewSessionHandler,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// Verify session B visible, no done dot initially
		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(doneUnviewedDot(page, SESS_B)).toHaveCount(0);

		// Server sends done notification for session B
		control.sendMessage({
			type: "notification_event",
			eventType: "done",
			sessionId: SESS_B,
		});

		// Done-unviewed dot should appear on session B
		await expect(doneUnviewedDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });
	});

	test("AttentionBanner appears when another session has a question", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
			onClientMessage: viewSessionHandler,
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

	test("reconcile via session_list corrects stale indicator state", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWebSocket(page, {
			initMessages: twoSessionInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
			onClientMessage: viewSessionHandler,
		});

		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		// No attention dot initially (initial session_list has no pendingQuestionCount)
		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(attentionDot(page, SESS_B)).toHaveCount(0);

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

		// Session B should now show an attention dot (reconcile sets questions: 2)
		await expect(attentionDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });
	});
});
