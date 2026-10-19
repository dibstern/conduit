// Tests the Ask/Edits/Full access approvals pill in the input area via WS mock.
//
// Regression coverage for: selecting "Full access" before any session is bound
// (e.g. PWA cold start before a session is selected) was silently dropped —
// the pill showed "Full access" locally but the server never received the switch, so
// the first turn still asked permissions and any re-sync flipped the pill
// back to "Ask".
//
// Uses WS mock — no real relay needed. The RPC mock is stateful (per-session
// mode map) so re-sync paths return what a correct server would.

import { expect, test } from "@playwright/test";
import type { GetModelsResponse } from "../../../src/lib/contracts/ws-rpc.js";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket, type WsMockControl } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;

const PROJECT_URL = "/s/sess-pm-001";

const existingSession = {
	id: "sess-pm-001",
	projectSlug: "myapp",
	title: "Existing session",
	status: "idle",
	updatedAt: Date.now(),
	messageCount: 4,
};

type Account = "claude" | "opencode";

/** The shell row names the session's account, which fixes its driver. */
const sessionList = (accountId: Account): MockMessage => ({
	type: "shell_snapshot",
	roots: true,
	sessions: [{ ...existingSession, accountId }],
});

/** The server reports the session's account and mode on its shell row. */
const reportMode = (
	rpc: RpcMockControl,
	mode: string,
	accountId: Account,
): void =>
	rpc.setShellRows([{ ...existingSession, accountId, permissionMode: mode }]);

const modelList: MockMessage = {
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
};

/** A session's driver, and so its approval modes, comes from its instance. */
const instanceList: MockMessage = {
	type: "instance_list",
	instances: (["claude", "opencode"] as const).map((driver) => ({
		id: driver,
		name: driver,
		driver,
		isDefault: true,
		port: 0,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: 1,
	})),
};

const projectList: MockMessage = {
	type: "project_list",
	projects: [{ slug: "myapp", title: "myapp", folders: ["/tmp/myapp"] }],
	current: "myapp",
};

/** Init state WITH a bound session (normal connected flow). */
const boundInit: MockMessage[] = [
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	sessionList("opencode"),
	modelList,
	instanceList,
	projectList,
];

const claudeBoundInit: MockMessage[] = [
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "claude" },
	sessionList("claude"),
	modelList,
	instanceList,
	projectList,
];

/** Init state without a selected session. */
const unboundInit: MockMessage[] = [
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	sessionList("opencode"),
	modelList,
	instanceList,
	projectList,
];

interface PermissionModeHarness {
	readonly relay: WsMockControl;
	readonly rpc: RpcMockControl;
	/** Server-side mode store (sessionId → mode), like OverridesState. */
	readonly serverModes: Map<
		string,
		NonNullable<GetModelsResponse["permissionMode"]>
	>;
}

async function setup(
	page: Page,
	initMessages: MockMessage[],
): Promise<PermissionModeHarness> {
	const serverModes = new Map<
		string,
		NonNullable<GetModelsResponse["permissionMode"]>
	>();
	const relay = await mockRelayWebSocket(page, {
		initMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetFileTree: () => ({ projectSlug: "myapp", entries: [] }),
			"input.submit": ({ sessionId }) => ({
				ok: true,
				sessionId,
				handedOff: true,
			}),
			ViewSession: () => ({ ok: true }),
			SwitchPermissionMode: (params) => {
				serverModes.set(params["sessionId"], params["mode"]);
				return { projectSlug: "myapp", mode: params["mode"] };
			},
			GetAgents: () => ({
				projectSlug: "myapp",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [],
			}),
			GetCommands: () => ({ projectSlug: "myapp", commands: [] }),
			GetProjects: () => ({
				projects: [{ slug: "myapp", title: "myapp", folders: ["/tmp/myapp"] }],
				current: "myapp",
			}),
		},
	});
	// The mock catalog reports the active model; the server owns the mode.
	const { GetModels } = rpc.catalogStubs();
	rpc.setStubs({
		GetModels: async (params) => ({
			...(await GetModels(params)),
			permissionMode:
				serverModes.get(
					String("sessionId" in params ? params.sessionId : undefined),
				) ?? "ask",
		}),
	});
	const bound = initMessages !== unboundInit;
	await page.goto(bound ? PROJECT_URL : "/");
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	if (bound) {
		await rpc.waitForRequest((request) => request.tag === "ViewSession");
		const modelInfo = initMessages.find(
			(message) => message.type === "model_info",
		);
		if (modelInfo)
			relay.sendMessage({ ...modelInfo, sessionId: "sess-pm-001" });
	}
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

	test("offers Plan for Claude", async ({ page }) => {
		await setup(page, claudeBoundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });
		await pill(page).click();
		await expect(
			page.locator("[data-testid='permission-mode-option-plan']"),
		).toBeVisible();
	});

	test("an approved plan drops the pill back off Plan", async ({ page }) => {
		const { rpc } = await setup(page, claudeBoundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });

		reportMode(rpc, "plan", "claude");
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Plan. Open options",
		);

		// Approving ExitPlanMode makes the SDK leave plan mode, which conduit
		// learns from the SDK's own report rather than from its stored request.
		// A pill still reading "Plan" after that is the difference between "read
		// only" on screen and a session that is now editing files.
		reportMode(rpc, "ask", "claude");
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Ask before edits. Open options",
		);
	});

	test("switching an Auto session to an OpenCode model resets it to Ask", async ({
		page,
	}) => {
		const { rpc, serverModes } = await setup(page, claudeBoundInit);
		await page
			.locator(".connect-overlay")
			.waitFor({ state: "hidden", timeout: 10_000 });

		serverModes.set("sess-pm-001", "auto");
		reportMode(rpc, "auto", "claude");
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Auto. Open options",
		);

		// The session moves to an OpenCode account, which has no Auto mode.
		reportMode(rpc, "auto", "opencode");

		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Ask before edits. Open options",
		);
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
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Full access. Open options",
		);

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
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Full access. Open options",
		);
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
		await page.goto("/s/sess-pm-001");
		await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Full access. Open options",
		);
	});
});

test.describe("Permission mode selected before session bind (regression)", () => {
	test("selection made while no session is bound is not flushed onto a viewed session", async ({
		page,
	}) => {
		const { rpc } = await setup(page, unboundInit);

		await selectFullAccess(page);
		await page
			.locator('[data-session-id="sess-pm-001"]')
			.getByText("Existing session")
			.click();

		// Viewing a session consumes the draft; the pill shows that session's mode.
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Ask before edits. Open options",
		);
		await page.waitForTimeout(500);
		expect(switchCalls(rpc)).toHaveLength(0);

		reportMode(rpc, "full", "opencode");
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Full access. Open options",
		);
	});

	test("re-selecting Ask before bind clears the pending elevated mode", async ({
		page,
	}) => {
		const { rpc } = await setup(page, unboundInit);

		await selectFullAccess(page);
		await pill(page).click();
		await page.locator("[data-testid='permission-mode-option-ask']").click();
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Ask before edits. Open options",
		);

		await page
			.locator('[data-session-id="sess-pm-001"]')
			.getByText("Existing session")
			.click();

		// Flushing "ask" (or nothing) is acceptable; flushing "full" is not.
		// No elevated mode may be flushed during this observation window.
		await page.waitForTimeout(500);
		const flushed = switchCalls(rpc).map((c) => c.payload["mode"]);
		expect(flushed).not.toContain("full");
		await expect(pill(page)).toHaveAccessibleName(
			"Approvals: Ask before edits. Open options",
		);
	});
});
