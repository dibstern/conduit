// ─── Server-Derived Notification Indicators E2E Tests ────────────────────────
// Verifies the full pipeline: the server derives the notification facts onto the
// session row (`pendingQuestions`, `pendingPermissions`, `unseenActivity`) →
// the row reaches the frontend over the WebSocket → sidebar dots and the
// AttentionBanner read them. There is no client-side badge state in between:
// what the sidebar shows is what the server last said about the row.
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
				status: "idle",
				updatedAt: Date.now(),
				messageCount: 2,
			},
			{
				id: SESS_B,
				title: "Session B — other",
				status: "idle",
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
/** A session_list carrying the notification facts the server derived per row. */
function sessionListWith(
	counts: Record<
		string,
		{ questions?: number; permissions?: number; unseen?: boolean }
	>,
): MockMessage {
	return {
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: SESS_A,
				title: "Session A — current",
				status: "idle",
				updatedAt: Date.now(),
				messageCount: 2,
				pendingQuestions: counts[SESS_A]?.questions ?? 0,
				pendingPermissions: counts[SESS_A]?.permissions ?? 0,
				unseenActivity: counts[SESS_A]?.unseen ?? false,
			},
			{
				id: SESS_B,
				title: "Session B — other",
				status: "idle",
				updatedAt: Date.now() - 3600_000,
				messageCount: 5,
				pendingQuestions: counts[SESS_B]?.questions ?? 0,
				pendingPermissions: counts[SESS_B]?.permissions ?? 0,
				unseenActivity: counts[SESS_B]?.unseen ?? false,
			},
		],
	};
}

async function openChat(page: Page, baseURL: string | undefined) {
	const control = await mockRelayWithViewSessionRpc(page, {
		initMessages: twoSessionInit,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

test.describe("server-derived notification indicators", () => {
	test("shows the attention dot when the row says a question is waiting", async ({
		page,
		baseURL,
	}) => {
		const control = await openChat(page, baseURL);

		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(attentionDot(page, SESS_B)).toHaveCount(0);

		control.sendMessage(sessionListWith({ [SESS_B]: { questions: 1 } }));

		await expect(attentionDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });
	});

	test("the session on screen never shows a dot, whatever the row says", async ({
		page,
		baseURL,
	}) => {
		const control = await openChat(page, baseURL);

		control.sendMessage(sessionListWith({ [SESS_B]: { questions: 1 } }));
		await expect(attentionDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });

		await sessionItem(page, SESS_B).click({ timeout: 5_000 });
		await page.waitForFunction(
			(sessId) => window.location.pathname.includes(`/s/${sessId}`),
			SESS_B,
			{ timeout: 5_000 },
		);

		// Which session is on screen is a per-tab fact the server cannot know
		// (ni8.23 C3), so the suppression stays local even though the count does
		// not: the row still says a question is pending, and no dot is drawn.
		await expect(attentionDot(page, SESS_B)).toHaveCount(0);
	});

	test("shows the done-unviewed dot when the row reports unseen activity", async ({
		page,
		baseURL,
	}) => {
		const control = await openChat(page, baseURL);

		await expect(sessionItem(page, SESS_B)).toBeVisible({ timeout: 5_000 });
		await expect(doneUnviewedDot(page, SESS_B)).toHaveCount(0);

		// `unseenActivity` is the server's comparison of last_message_at against
		// last_viewed_at — the client is told the answer, not the inputs.
		control.sendMessage(sessionListWith({ [SESS_B]: { unseen: true } }));

		await expect(doneUnviewedDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });
	});

	test("AttentionBanner appears when another session's row has a question", async ({
		page,
		baseURL,
	}) => {
		const control = await openChat(page, baseURL);

		await expect(attentionBanner(page)).toHaveCount(0);

		control.sendMessage(sessionListWith({ [SESS_B]: { questions: 1 } }));

		await expect(attentionBanner(page)).toBeVisible({ timeout: 5_000 });
		await expect(attentionBanner(page)).toContainText("Session B", {
			timeout: 5_000,
		});
		await expect(attentionBanner(page)).toContainText("attention", {
			timeout: 5_000,
		});
	});

	test("a later row with the count cleared takes the dot away", async ({
		page,
		baseURL,
	}) => {
		const control = await openChat(page, baseURL);

		control.sendMessage(sessionListWith({ [SESS_B]: { questions: 2 } }));
		await expect(attentionDot(page, SESS_B)).toBeVisible({ timeout: 5_000 });

		// Someone else answered the question. The next row the server sends is
		// simply the truth again — there is no local state to reconcile, and no
		// way for this tab to keep a badge the server has stopped reporting.
		control.sendMessage(sessionListWith({}));

		await expect(attentionDot(page, SESS_B)).toHaveCount(0);
	});
});
