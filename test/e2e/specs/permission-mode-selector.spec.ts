// ─── Permission Mode Selector E2E Tests ─────────────────────────────────────
// Tests the Ask/Edits/Full access approvals pill in the input area via WS mock.
//
// Regression coverage for: selecting "Full access" before any session is bound
// (e.g. PWA cold start before session_switched arrives) was silently dropped —
// the pill showed "Full access" locally but the server never received the switch, so
// the first turn still asked permissions and any re-sync flipped the pill
// back to "Ask".
//
// Uses WS mock — no real relay needed. The RPC mock is stateful (per-session
// mode map) so re-sync paths return what a correct server would.

import { expect, test } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket, type WsMockControl } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;

const PROJECT_URL = "/p/myapp/";
const BASE = "http://localhost:4173";

const sessionList: MockMessage = {
	type: "session_list",
	roots: true,
	sessions: [
		{
			id: "sess-pm-001",
			title: "Existing session",
			updatedAt: Date.now(),
			messageCount: 4,
		},
	],
};

const modelList: MockMessage = {
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

/** Init state WITH a bound session (normal connected flow). */
const boundInit: MockMessage[] = [
	{ type: "session_switched", id: "sess-pm-001" },
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	sessionList,
	modelList,
];

const claudeBoundInit: MockMessage[] = [
	{ type: "session_switched", id: "sess-pm-001" },
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "claude" },
	sessionList,
	modelList,
];

/** Init state WITHOUT a session bind (cold start, session_switched pending). */
const unboundInit: MockMessage[] = [
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	sessionList,
	modelList,
];

interface PermissionModeHarness {
	readonly relay: WsMockControl;
	readonly rpc: RpcMockControl;
	/** Server-side mode store (sessionId → mode), like OverridesState. */
	readonly serverModes: Map<string, string>;
}

async function setup(
	page: Page,
	initMessages: MockMessage[],
): Promise<PermissionModeHarness> {
	const serverModes = new Map<string, string>();
	const relay = await mockRelayWebSocket(page, {
		initMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	const rpc = await mockWsRpc(page, {
		handlers: {
			SwitchPermissionMode: (params) => {
				serverModes.set(String(params["sessionId"]), String(params["mode"]));
				return { projectSlug: "myapp", mode: params["mode"] };
			},
			SendMessage: (params) => ({
				projectSlug: "myapp",
				sessionId: params["sessionId"],
			}),
			ViewSession: (params) => ({
				projectSlug: "myapp",
				sessionId: params["sessionId"],
			}),
			GetAgents: () => ({ projectSlug: "myapp", agents: [] }),
			GetCommands: () => ({ projectSlug: "myapp", commands: [] }),
			GetModels: (params) => ({
				projectSlug: "myapp",
				providers: [],
				variant: { variant: "", variants: [] },
				contextWindow: { contextWindow: "", options: [] },
				permissionMode: serverModes.get(String(params["sessionId"])) ?? "ask",
			}),
			ListSessions: () => ({ projectSlug: "myapp", sessions: [] }),
			GetProjects: () => ({ projects: [] }),
			GetFileTree: () => ({ projectSlug: "myapp", entries: [] }),
			ListPtys: () => ({ projectSlug: "myapp", ptys: [] }),
		},
	});
	await page.goto(`${BASE}${PROJECT_URL}`);
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	return { relay, rpc, serverModes };
}

const pill = (page: Page) =>
	page.locator("[data-testid='permission-mode-badge']");

async function selectFullAccess(page: Page): Promise<void> {
	await pill(page).click();
	await page.locator("[data-testid='permission-mode-option-full']").click();
}

const switchCalls = (rpc: RpcMockControl) =>
	rpc.getRequests().filter((r) => r.tag === "SwitchPermissionMode");

test.describe("Permission mode with a bound session", () => {
	test("shows Auto for Claude", async ({ page }) => {
		await setup(page, claudeBoundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });
		await pill(page).click();
		await expect(
			page.locator("[data-testid='permission-mode-option-auto']"),
		).toBeVisible();
	});

	test("hides Auto for non-Claude providers", async ({ page }) => {
		await setup(page, boundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });
		await pill(page).click();
		await expect(
			page.locator("[data-testid='permission-mode-option-auto']"),
		).toHaveCount(0);
	});

	test("switching an Auto session to an OpenCode model resets it to Ask", async ({
		page,
	}) => {
		const { relay, rpc, serverModes } = await setup(page, claudeBoundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });

		relay.sendMessage({ type: "permission_mode_info", mode: "auto" });
		await expect(pill(page)).toContainText("Auto");

		relay.sendMessage({
			type: "model_info",
			model: "claude-sonnet-4",
			provider: "anthropic",
		});

		await expect(pill(page)).toContainText("Ask");
		await expect
			.poll(() => switchCalls(rpc).at(-1)?.payload)
			.toMatchObject({ sessionId: "sess-pm-001", mode: "ask" });
		expect(serverModes.get("sess-pm-001")).toBe("ask");
	});

	test("selecting Full access sends SwitchPermissionMode for the current session", async ({
		page,
	}) => {
		const { rpc } = await setup(page, boundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });

		await selectFullAccess(page);
		await expect(pill(page)).toContainText("Full access");

		await expect
			.poll(() => switchCalls(rpc).at(-1)?.payload)
			.toMatchObject({ sessionId: "sess-pm-001", mode: "full" });
	});

	test("re-selecting the mode already shown still asserts it to the server", async ({
		page,
	}) => {
		const { rpc } = await setup(page, boundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });

		await selectFullAccess(page);
		await expect.poll(() => switchCalls(rpc).length).toBe(1);

		// The server keeps the mode in memory only, so a daemon restart resets it
		// to "ask" while this client still shows "Full access". If picking the mode the
		// pill already displays short-circuits, the user has no way back to
		// auto-approval without selecting some other mode first.
		await selectFullAccess(page);
		await expect.poll(() => switchCalls(rpc).length).toBe(2);
		await expect
			.poll(() => switchCalls(rpc).at(-1)?.payload)
			.toMatchObject({ sessionId: "sess-pm-001", mode: "full" });
		await expect(pill(page)).toContainText("Full access");
	});

	test("mode survives navigate away and back (server re-sync)", async ({
		page,
	}) => {
		const { rpc } = await setup(page, boundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });
		await selectFullAccess(page);
		await expect.poll(() => switchCalls(rpc).length).toBeGreaterThan(0);

		// Full reload navigation (PWA-style revisit) — re-sync must keep "Full access".
		await page.goto(`${BASE}/p/myapp/s/sess-pm-001`);
		await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
		await expect(pill(page)).toContainText("Full access");
	});
});

test.describe("Permission mode selected before session bind (regression)", () => {
	test("selection made while no session is bound is flushed on session_switched", async ({
		page,
	}) => {
		const { relay, rpc, serverModes } = await setup(page, unboundInit);

		// Cold-start window: no session bound yet. Select "Full access".
		await selectFullAccess(page);
		await expect(pill(page)).toContainText("Full access");
		expect(switchCalls(rpc)).toHaveLength(0);

		// Session binds (server session_switched, e.g. connect completes or the
		// pending New Session resolves).
		relay.sendMessage({ type: "session_switched", id: "sess-pm-001" });

		// The pending selection must be flushed to the server for that session.
		await expect
			.poll(() => switchCalls(rpc).at(-1)?.payload, { timeout: 5000 })
			.toMatchObject({ sessionId: "sess-pm-001", mode: "full" });
		await expect(pill(page)).toContainText("Full access");
		expect(serverModes.get("sess-pm-001")).toBe("full");

		// A later hydration push reflecting the (now stored) server mode must
		// not flip the pill.
		relay.sendMessage({ type: "permission_mode_info", mode: "full" });
		await expect(pill(page)).toContainText("Full access");
	});

	test("re-selecting Ask before bind clears the pending elevated mode", async ({
		page,
	}) => {
		const { relay, rpc } = await setup(page, unboundInit);

		await selectFullAccess(page);
		await pill(page).click();
		await page.locator("[data-testid='permission-mode-option-ask']").click();
		await expect(pill(page)).toContainText("Ask");

		relay.sendMessage({ type: "session_switched", id: "sess-pm-001" });

		// Flushing "ask" (or nothing) is acceptable; flushing "full" is not.
		await page.waitForTimeout(500);
		const flushed = switchCalls(rpc).map((c) => c.payload["mode"]);
		expect(flushed).not.toContain("full");
		await expect(pill(page)).toContainText("Ask");
	});
});
