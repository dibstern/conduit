import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { Either } from "effect";
import type { InstanceListResponse } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type AccountChange,
	accountsStateFromInstances,
	apply,
	list,
	resolve as resolveAccount,
} from "../../../src/lib/daemon/account-directory.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { dualDriverProviders } from "../fixtures/mockup-state.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

async function openServerSettings(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	const sessionOverflow = page.getByTestId("session-bar-overflow");
	await expect(
		listOverflow.or(titleMenu).or(sessionOverflow).first(),
	).toBeVisible();
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await sessionOverflow.click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-server").click();
	await expect(page.getByTestId("server-settings")).toBeVisible();
}

test("Claude accounts can be edited and link to Usage with no project open", async ({
	page,
	relayUrl,
}, testInfo) => {
	let instances: InstanceListResponse["instances"] = [
		{
			id: "claude",
			name: "Personal Claude",
			driver: "claude",
			configDir: "",
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 1_772_011_800_000,
			isDefault: true,
			usageEligible: true,
		},
		{
			id: "work-claude",
			name: "Work Claude",
			driver: "claude",
			configDir: "/profiles/work",
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 1_772_011_860_000,
			isDefault: false,
			usageEligible: true,
		},
		{
			id: "opencode",
			name: "Local OpenCode",
			driver: "opencode",
			port: 4096,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: 1_772_011_800_000,
		},
	];
	const rpc = await mockWsRpc(page, {
		handlers: {
			AttachProject: () => ({ projectSlug: null }),
			GetProjects: () => ({ projects: [] }),
			DetectProxy: () => ({ found: false, port: 8317 }),
			UpdateInstance: (payload) => {
				const name = payload["name"];
				if (typeof name !== "string") throw new Error("Missing account name");
				instances = instances.map((instance) =>
					instance.id === payload["instanceId"]
						? { ...instance, name }
						: instance,
				);
				return { instances };
			},
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects: [], current: null },
			{ type: "shell_snapshot", roots: true, sessions: [] },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", { instances });
	await gotoRelay(page, new URL("/", relayUrl).toString());
	await expect(page).toHaveURL(new URL("/", relayUrl).toString());

	await openServerSettings(page);
	const panel = page.locator("#settings-panel");
	const list = panel.locator("#instance-settings-list");
	const defaultRow = list.getByTestId("instance-row-claude");
	const workRow = list.getByTestId("instance-row-work-claude");
	await expect(
		list.getByRole("heading", { name: "Claude accounts" }),
	).toBeVisible();
	await expect(list.locator('[data-driver="claude"]')).toHaveCount(2);
	await expect(defaultRow.getByText("default", { exact: true })).toBeVisible();
	await expect(defaultRow.getByText("env", { exact: true })).toBeVisible();
	await expect(workRow.getByText("default", { exact: true })).toHaveCount(0);
	for (const row of [defaultRow, workRow]) {
		await expect(row.getByTestId("account-dot")).toBeVisible();
		await expect(row.getByText("Claude", { exact: true })).toHaveCount(0);
	}

	await defaultRow.getByRole("button", { expanded: false }).click();
	await expect(defaultRow.getByTestId("edit-instance-btn")).toBeVisible();
	await expect(defaultRow.getByTestId("remove-instance-btn")).toBeVisible();
	await expect(defaultRow.getByTestId("rename-instance-btn")).toHaveCount(0);
	await expect(defaultRow).toContainText(
		"New sessions, unless you pick another account",
	);

	await workRow.getByRole("button", { expanded: false }).click();
	await expect(
		defaultRow.getByRole("button", { expanded: false }),
	).toBeVisible();
	await expect(workRow.getByTestId("remove-instance-btn")).toBeVisible();
	await expect(workRow.getByTestId("rename-instance-btn")).toHaveCount(0);
	await expect(workRow).toContainText(
		"Sessions you move to it, and auto-switch",
	);
	await workRow.getByTestId("edit-instance-btn").click();
	await expect(panel.getByTestId("instance-form-name")).toHaveValue(
		"Work Claude",
	);
	await expect(panel.getByTestId("instance-form-configdir")).toHaveValue(
		"/profiles/work",
	);
	await panel.getByTestId("instance-form-name").fill("Team Claude");
	await panel.getByTestId("instance-form-save").click();
	const updated = await rpc.waitForRequest(
		(request) => request.tag === "UpdateInstance",
	);
	// The schema tag rides along on the wire; only the fields matter here.
	expect(updated.payload).toEqual({
		_tag: "UpdateInstance",
		instanceId: "work-claude",
		name: "Team Claude",
		configDir: "/profiles/work",
	});
	await expect(panel.getByTestId("instance-form")).toBeHidden();
	await expect(workRow.getByText("Team Claude", { exact: true })).toBeVisible();
	await expect(workRow.getByText("Work Claude", { exact: true })).toHaveCount(
		0,
	);
	await workRow.getByRole("button", { expanded: false }).click();

	const usageLink = panel.getByTestId("claude-accounts-usage-link");
	await expect(usageLink).toHaveText("Usage ›");
	await usageLink.scrollIntoViewIfNeeded();
	await page.evaluate(() => document.fonts.ready);
	const artifactDir = resolve("test-results/settings-claude-accounts");
	await mkdir(artifactDir, { recursive: true });
	const accountsPath = resolve(
		artifactDir,
		`${testInfo.project.name}-accounts.png`,
	);
	await panel.getByTestId("claude-accounts-list").screenshot({
		path: accountsPath,
		animations: "disabled",
	});
	await testInfo.attach("claude-accounts", {
		path: accountsPath,
		contentType: "image/png",
	});

	await usageLink.click();
	await expect(panel.getByTestId("usage-settings")).toBeVisible();
	await expect(panel.getByTestId("server-settings")).toHaveCount(0);
	if ((page.viewportSize()?.width ?? 1440) < 768) {
		await expect(panel.locator("#settings-panel-title")).toHaveText("Usage");
		await expect(panel.getByTestId("settings-back-btn")).toBeFocused();
	} else {
		await expect(panel.getByTestId("settings-tab-usage")).toHaveAttribute(
			"aria-selected",
			"true",
		);
	}
});

test("deleting Claude defaults follows usage order and adding an account restores a blocked draft", async ({
	page,
	relayUrl,
}, testInfo) => {
	const usageOrder = ["bravo", "zulu", "alpha", "claude"];
	let state = accountsStateFromInstances(
		[
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				configDir: "/profiles/original",
			},
			{
				id: "zulu",
				name: "Zulu",
				driver: "claude",
				configDir: "/profiles/zulu",
			},
			{
				id: "alpha",
				name: "Alpha",
				driver: "claude",
				configDir: "/profiles/alpha",
			},
			{
				id: "bravo",
				name: "Bravo",
				driver: "claude",
				configDir: "/profiles/bravo",
			},
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				port: 4096,
				managed: false,
			},
		],
		configuredClaudeConfigDir("/profiles/launch"),
		5,
		{ defaultClaudeId: "claude", usageOrder },
	);
	const project = { slug: "myapp", title: "myapp", folders: ["/myapp"] };
	const refreshAccounts = (change?: AccountChange) => {
		if (change)
			state = Either.getOrThrowWith(
				apply(state, change, usageOrder),
				(error) => error,
			);
		const instances = list(state).map(
			(account): InstanceListResponse["instances"][number] => ({
				id: account.id,
				name: account.name,
				driver: account.driver,
				isDefault: account.isDefault,
				usageEligible: account.driver === "claude" && account.usageEligible,
				configDir: account.configuredFolder ?? "",
				port: account.driver === "opencode" ? (account.port ?? 0) : 0,
				managed: account.driver === "opencode" && account.managed === true,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
			}),
		);
		rpc.setDaemonList("SubscribeInstances", { instances });
		rpc.setUsageReadings(
			list(state)
				.filter((account) => account.driver === "claude")
				.map((account) => ({
					accountId: account.id,
					harness: "claude",
					status: "available",
					windows: [{ kind: "five_hour", utilization: 20 }],
					readAt: Date.now(),
					stale: false,
				})),
		);
		return { instances };
	};
	const rpc = await mockWsRpc(page, {
		handlers: {
			AttachProject: () => ({ projectSlug: "myapp" }),
			ResolveSession: () => ({ projectSlug: "myapp" }),
			GetProjects: () => ({ projects: [project], current: "myapp" }),
			DetectProxy: () => ({ found: false, port: 8317 }),
			GetModels: () => ({
				projectSlug: "myapp",
				providers: dualDriverProviders.filter(
					(provider) => provider.id !== "claude",
				),
				active: { model: "claude-sonnet-4-5", provider: "claude" },
			}),
			GetAgents: () => ({ projectSlug: "myapp", agents: [] }),
			GetUsageLimitsSetting: () => ({
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					warnAt: 80,
					order: usageOrder,
				},
			}),
			RemoveInstance: (payload) => {
				const id = payload["instanceId"];
				if (typeof id !== "string") throw new Error("Missing account id");
				return refreshAccounts({ _tag: "Remove", id });
			},
			AddInstance: (payload) => {
				const name = payload["name"];
				if (typeof name !== "string") throw new Error("Missing account name");
				return refreshAccounts({ _tag: "Add", name, driver: "claude" });
			},
			CreateSession: (payload) => {
				const id = payload["instanceId"];
				if (typeof id !== "string") throw new Error("Missing account id");
				const account = Either.getOrThrowWith(
					resolveAccount(state, { _tag: "Id", id }),
					(error) => error,
				);
				rpc.upsertShellRow({
					id: "sess-restored",
					accountId: account.id,
					title: "Restored draft",
					status: "idle",
					projectSlug: "myapp",
					updatedAt: Date.now(),
				});
				return { projectSlug: "myapp", sessionId: "sess-restored" };
			},
			"input.submit": (payload) => ({
				ok: true,
				sessionId: payload["sessionId"],
			}),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{ type: "project_list", projects: [project], current: "myapp" },
			{ type: "shell_snapshot", roots: true, sessions: [] },
		],
		responses: new Map(),
	});
	refreshAccounts();
	rpc.setProjectSetting({
		_tag: "providerModels",
		providers: dualDriverProviders.filter(
			(provider) => provider.id === "claude",
		),
	});
	rpc.setProjectSetting({
		_tag: "defaultModel",
		model: "claude-sonnet-4-5",
		provider: "claude",
		variant: "",
	});
	await gotoRelay(page, new URL("/?p=myapp", relayUrl).toString());
	await openServerSettings(page);
	const removeAccount = async (id: string) => {
		const row = page.getByTestId(`instance-row-${id}`);
		await row.getByRole("button", { expanded: false }).click();
		await row.getByTestId("remove-instance-btn").click();
		await page.getByTestId("confirm-modal-action").click();
		await expect(row).toHaveCount(0);
	};
	const artifactDir = resolve("test-results/settings-claude-accounts");
	await mkdir(artifactDir, { recursive: true });
	const capture = async (name: string) => {
		const path = resolve(artifactDir, `${testInfo.project.name}-${name}.png`);
		await page.screenshot({ path, animations: "disabled" });
		await testInfo.attach(name, { path, contentType: "image/png" });
	};
	await removeAccount("claude");
	const accounts = page.getByTestId("claude-accounts-list");
	await expect(accounts.getByTestId("default-account-marker")).toHaveCount(1);
	await expect(
		page
			.getByTestId("instance-row-bravo")
			.getByTestId("default-account-marker"),
	).toBeVisible();
	await capture("usage-order-promotion-settings");
	await page.getByTestId("settings-close-btn").click();
	await page.locator("#new-session-btn:visible").click();
	await expect(
		page.locator('#input-area [data-testid="harness-logo"]:visible').first(),
	).toHaveAttribute("data-account", "bravo");
	await expect(page.getByTestId("usage-footer-row-bravo")).toHaveAttribute(
		"data-default",
		"true",
	);
	await expect(
		page.locator('[data-testid^="usage-footer-row-"][data-default="true"]'),
	).toHaveCount(1);
	await page
		.getByTestId(
			/^(composer-harness-trigger|model-picker-trigger|composer-word-model)$/,
		)
		.first()
		.click();
	await expect(page.getByTestId("picker-account-bravo")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(page.getByTestId("picker-account-name")).toHaveText([
		"Bravo",
		"Zulu",
		"Alpha",
	]);
	await capture("usage-order-promotion-composer");
	await page.keyboard.press("Escape");
	await openServerSettings(page);
	for (const id of ["zulu", "alpha", "bravo"]) await removeAccount(id);
	const empty = page.getByTestId("claude-empty-state");
	await expect(empty).toContainText(/No.*accounts/);
	await expect(
		empty.getByRole("button", { name: "Add account", exact: true }),
	).toBeVisible();
	await expect(page.getByTestId("instance-row-opencode")).toBeVisible();
	await expect(accounts.getByTestId("default-account-marker")).toHaveCount(0);
	await capture("last-account-removed-settings");
	await page.getByTestId("settings-close-btn").click();
	await expect(page.getByTestId("add-claude-account-btn")).toHaveText(
		"Add account",
	);
	await page
		.getByTestId(
			/^(composer-harness-trigger|model-picker-trigger|composer-word-model)$/,
		)
		.first()
		.click();
	await expect(page.getByTestId("picker-account-name")).toHaveCount(0);
	await expect(page.getByTestId("picker-add-account-btn")).toHaveText(
		"Add account",
	);
	await page.keyboard.press("Escape");
	await page.locator("#input").fill("Keep my Claude draft");
	await page.locator("#send").click();
	await expect(
		page.getByText("Add a Claude account in Settings before sending", {
			exact: false,
		}),
	).toBeVisible();
	await expect(page.locator("#input")).toHaveValue("Keep my Claude draft");
	expect(
		rpc
			.getRequests()
			.filter(
				(request) =>
					request.tag === "CreateSession" || request.tag === "input.submit",
			),
	).toEqual([]);
	await capture("last-account-removed-composer");
	await page.getByTestId("add-claude-account-btn").click();
	await expect(page.getByTestId("server-settings")).toBeVisible();
	await empty.getByRole("button", { name: "Add account", exact: true }).click();
	await expect(page.getByTestId("instance-form-configdir")).toBeVisible();
	await page.getByTestId("instance-form-name").fill("Bravo");
	await page.getByTestId("instance-form-save").click();
	await expect(
		page
			.getByTestId("instance-row-bravo-2")
			.getByTestId("default-account-marker"),
	).toBeVisible();
	await expect(accounts.getByTestId("default-account-marker")).toHaveCount(1);
	await expect(page.getByTestId("instance-row-bravo")).toHaveCount(0);
	await page.getByTestId("settings-close-btn").click();
	await expect(page.getByTestId("add-claude-account-btn")).toHaveCount(0);
	await expect(page.locator("#input")).toHaveValue("Keep my Claude draft");
	await expect(
		page.locator('#input-area [data-testid="harness-logo"]:visible').first(),
	).toHaveAttribute("data-account", "bravo-2");
	await expect(
		page.getByText("Add a Claude account in Settings before sending", {
			exact: false,
		}),
	).toBeHidden();
	await capture("claude-account-restored");
	await page.locator("#send").click();
	const created = await rpc.waitForRequest(
		(request) => request.tag === "CreateSession",
	);
	expect(created.payload["instanceId"]).toBe("bravo-2");
	const sent = await rpc.waitForRequest(
		(request) => request.tag === "input.submit",
	);
	expect(sent.payload).toMatchObject({
		sessionId: "sess-restored",
		text: "Keep my Claude draft",
	});
});
