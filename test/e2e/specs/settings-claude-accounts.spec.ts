import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { InstanceListResponse } from "../../../src/lib/contracts/ws-rpc.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

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
	await expect(defaultRow.getByTestId("remove-instance-btn")).toHaveCount(0);
	await expect(defaultRow.getByTestId("rename-instance-btn")).toHaveCount(0);
	await expect(
		defaultRow.getByText("The default account can't be removed", {
			exact: true,
		}),
	).toBeVisible();
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
