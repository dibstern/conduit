// ─── Subagent Session E2E Tests ──────────────────────────────────────────
// Tests the subagent session toggle (hide/show in sidebar) and
// navigation between parent and child sessions.
//
// Uses WS mock with fixture data captured from a real OpenCode instance.
// No real OpenCode or relay needed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import {
	createMockRelayProtocolContext,
	mockRelayWebSocket,
	normalizeMockRelayMessage,
} from "../helpers/ws-mock.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

// ─── Load snapshot fixture ──────────────────────────────────────────────

const snapshotPath = resolve(
	import.meta.dirname ?? __dirname,
	"../fixtures/subagent-snapshot.json",
);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
	parentSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
	};
	childSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
		parentID: string;
	};
	parentHistory: {
		messages: unknown[];
		hasMore: boolean;
		total: number;
	};
	childHistory: {
		messages: unknown[];
		hasMore: boolean;
		total: number;
	};
};

// ─── Build mock messages from snapshot ───────────────────────────────────

const allSessions = [
	snapshot.parentSession,
	snapshot.childSession,
	// Add a couple more non-subagent sessions for realism
	{
		id: "ses_other001",
		title: "Unrelated session",
		updatedAt: snapshot.parentSession.updatedAt - 3600_000,
		messageCount: 5,
	},
];

/** Root-only session list (excludes child/subagent sessions). */
const rootSessionListMsg: MockMessage = {
	type: "session_list",
	roots: true,
	sessions: allSessions.filter((s) => !("parentID" in s && s["parentID"])),
};

/** Full session list (includes subagent sessions). */
const allSessionListMsg: MockMessage = {
	type: "session_list",
	roots: false,
	sessions: allSessions,
};

const modelListMsg: MockMessage = {
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
};

const agentListMsg: MockMessage = {
	type: "agent_list",
	agents: [
		{ id: "code", name: "Code", description: "General coding assistant" },
	],
};

/** Init messages: parent session active, idle, with full history */
const initMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: snapshot.parentSession.id,
		history: snapshot.parentHistory,
	},
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	rootSessionListMsg,
	allSessionListMsg,
	modelListMsg,
	agentListMsg,
];

/** Messages to send when switching to child session */
const childSwitchMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: snapshot.childSession.id,
		history: snapshot.childHistory,
	},
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	rootSessionListMsg, // re-send so client has parentID metadata
	allSessionListMsg,
];

/** Messages to send when switching back to parent session */
const parentSwitchMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: snapshot.parentSession.id,
		history: snapshot.parentHistory,
	},
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	rootSessionListMsg,
	allSessionListMsg,
];

// ─── Helper ─────────────────────────────────────────────────────────────

async function waitForChatReady(page: import("@playwright/test").Page) {
	// Wait for the input to be visible and connect overlay to be gone
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	// Give the session list time to render
	await page.waitForTimeout(500);
}

// ─── Tests ──────────────────────────────────────────────────────────────

test.describe("Subagent session toggle", () => {
	test("hides subagent sessions by default", async ({ page, baseURL }) => {
		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);
		const sessionCount = await sidebar.getSessionCount();

		// Should show parent + "Unrelated session" but NOT the child
		expect(sessionCount).toBe(2);

		// Child session title should not be visible
		const childItem = sidebar.sessionList.locator(
			`[data-session-id="${snapshot.childSession.id}"]`,
		);
		await expect(childItem).not.toBeVisible();
	});

	test("toggle shows subagent sessions", async ({ page, baseURL }) => {
		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);

		// Click the toggle
		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);

		// Now all 3 sessions should be visible
		const sessionCount = await sidebar.getSessionCount();
		expect(sessionCount).toBe(3);

		// Child session should be visible
		const childItem = sidebar.sessionList.locator(
			`[data-session-id="${snapshot.childSession.id}"]`,
		);
		await expect(childItem).toBeVisible();
	});

	test("toggle hides subagent sessions again", async ({ page, baseURL }) => {
		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);

		// Show then hide
		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);
		expect(await sidebar.getSessionCount()).toBe(3);

		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);
		expect(await sidebar.getSessionCount()).toBe(2);
	});

	test("toggle state persists across page reload", async ({
		page,
		baseURL,
	}) => {
		const mockOpts = {
			initMessages,
			responses: new Map<string, MockMessage[]>(),
		};

		await mockRelayWebSocket(page, mockOpts);
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);

		// Toggle to show subagent sessions
		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);
		expect(await sidebar.getSessionCount()).toBe(3);

		// Reload page (re-establish mock first)
		await mockRelayWebSocket(page, mockOpts);
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		// Should still show 3 sessions (localStorage persisted)
		expect(await sidebar.getSessionCount()).toBe(3);
	});
});

test.describe("Subagent navigation", () => {
	test("navigates to child session via subagent link", async ({
		page,
		baseURL,
	}) => {
		// Use a low-level routeWebSocket handler that is session-aware.
		// The app reconnects the WS whenever session_switched fires (URL changes),
		// so we must send the correct init messages based on the ?session= param.
		const childInitMessages: MockMessage[] = [
			{
				type: "session_switched",
				id: snapshot.childSession.id,
				history: snapshot.childHistory,
			},
			{ type: "status", status: "idle" },
			{
				type: "model_info",
				model: "claude-sonnet-4",
				provider: "anthropic",
			},
			{ type: "client_count", count: 1 },
			rootSessionListMsg,
			allSessionListMsg,
			modelListMsg,
			agentListMsg,
		];

		let sendMockRelayMessage: ((msg: MockMessage) => void) | undefined;
		const rpc = await mockWsRpc(page, {
			handlers: {
				ViewSession: (params) => {
					if (params["sessionId"] === snapshot.childSession.id) {
						for (const msg of childSwitchMessages) {
							sendMockRelayMessage?.(msg);
						}
					}
					return { ok: true };
				},
			},
		});

		await page.routeWebSocket(/\/ws/, (ws) => {
			const protocolContext = createMockRelayProtocolContext();
			sendMockRelayMessage = (msg: MockMessage) => {
				ws.send(
					JSON.stringify(normalizeMockRelayMessage(msg, protocolContext)),
				);
			};
			const url = ws.url();
			const sessionParam = new URL(url).searchParams.get("session");

			// Pick init messages based on the session query param
			const msgs =
				sessionParam === snapshot.childSession.id
					? childInitMessages
					: initMessages;
			for (const msg of msgs) {
				sendMockRelayMessage(msg);
			}

			ws.onMessage((data) => {
				try {
					const parsed = JSON.parse(String(data));

					if (parsed.type === "get_agents") {
						const al = initMessages.find((m) => m.type === "agent_list");
						if (al) sendMockRelayMessage?.(al);
					}
				} catch {
					// ignore
				}
			});
		});

		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const chat = new ChatPage(page);

		// Click the subagent link in the task tool card
		const subagentLink = chat.subagentLinks.first();
		await expect(subagentLink).toBeVisible({ timeout: 5_000 });
		await subagentLink.click();

		const viewRequest = await rpc.waitForRequest(
			(request) =>
				request.tag === "ViewSession" &&
				request.payload["sessionId"] === snapshot.childSession.id,
		);
		expect(viewRequest).toMatchObject({
			tag: "ViewSession",
			payload: { sessionId: snapshot.childSession.id },
		});

		// SubagentBackBar should appear
		await expect(chat.subagentBackBar).toBeVisible({ timeout: 5_000 });
	});

	test("SubagentBackBar shows parent title", async ({ page, baseURL }) => {
		// Start directly in child session
		const childInitMessages: MockMessage[] = [
			{
				type: "session_switched",
				id: snapshot.childSession.id,
				history: snapshot.childHistory,
			},
			{ type: "status", status: "idle" },
			{
				type: "model_info",
				model: "claude-sonnet-4",
				provider: "anthropic",
			},
			{ type: "client_count", count: 1 },
			rootSessionListMsg, // roots (parent + other, no child)
			allSessionListMsg, // all sessions including child with parentID
			modelListMsg,
			agentListMsg,
		];

		await mockRelayWebSocket(page, {
			initMessages: childInitMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const chat = new ChatPage(page);

		// Back bar should be visible with parent title
		await expect(chat.subagentBackBar).toBeVisible({ timeout: 5_000 });
		const backBarText = await chat.subagentBackBar.innerText();
		expect(backBarText).toContain(snapshot.parentSession.title);
	});

	test("navigates back to parent via SubagentBackBar", async ({
		page,
		baseURL,
	}) => {
		// Start in child session
		const childInitMessages: MockMessage[] = [
			{
				type: "session_switched",
				id: snapshot.childSession.id,
				history: snapshot.childHistory,
			},
			{ type: "status", status: "idle" },
			{
				type: "model_info",
				model: "claude-sonnet-4",
				provider: "anthropic",
			},
			{ type: "client_count", count: 1 },
			rootSessionListMsg,
			allSessionListMsg,
			modelListMsg,
			agentListMsg,
		];

		let control!: Awaited<ReturnType<typeof mockRelayWebSocket>>;
		const rpc = await mockWsRpc(page, {
			handlers: {
				ViewSession: (params) => {
					if (params["sessionId"] === snapshot.parentSession.id) {
						void control.sendMessages(parentSwitchMessages);
					}
					return { ok: true };
				},
			},
		});
		control = await mockRelayWebSocket(page, {
			initMessages: childInitMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const chat = new ChatPage(page);

		// Click the back bar
		await expect(chat.subagentBackBar).toBeVisible({ timeout: 5_000 });
		await chat.subagentBackBtn.click();

		const viewRequest = await rpc.waitForRequest(
			(request) =>
				request.tag === "ViewSession" &&
				request.payload["sessionId"] === snapshot.parentSession.id,
		);
		expect(viewRequest).toMatchObject({
			tag: "ViewSession",
			payload: { sessionId: snapshot.parentSession.id },
		});

		// SubagentBackBar should disappear (parent has no parentID)
		await expect(chat.subagentBackBar).not.toBeVisible({ timeout: 5_000 });
	});
});
