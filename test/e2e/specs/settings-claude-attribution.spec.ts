import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { dualDriverProviders } from "../fixtures/mockup-state.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

test("Claude Attribution collapses, expands and saves an edited part", async ({
	page,
	relayUrl,
}, testInfo) => {
	const inheritedAttribution = {
		commit: "Inherited commit attribution",
		pr: "Inherited pull request attribution",
		sessionUrl: true,
	};
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetClaudeSettings: () => ({
				projectSlug: "e2e-replay",
				overrides: { cleanupPeriodDays: 45 },
			}),
			ResolveClaudeSettings: () => ({
				projectSlug: "e2e-replay",
				instanceId: "personal",
				resolved: {
					attribution: {
						value: inheritedAttribution,
						source: "user",
						path: "/profiles/personal/settings.json",
					},
					autoCompactEnabled: {},
					autoCompactWindow: {},
					cleanupPeriodDays: {},
					disableAllHooks: {},
					alwaysThinkingEnabled: {},
				},
			}),
			SetClaudeSettings: (payload) => ({
				projectSlug: payload["projectSlug"],
				overrides: payload["overrides"],
			}),
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "Claude Attribution",
						folders: ["/workspace/settings"],
						instanceId: "personal",
					},
				],
				current: "e2e-replay",
			},
			{
				type: "shell_snapshot",
				roots: true,
				sessions: [
					{
						id: "settings-attribution",
						title: "Claude Attribution",
						accountId: "personal",
						status: "idle",
						projectSlug: "e2e-replay",
					},
				],
			},
			{ type: "mock_model_catalog", providers: dualDriverProviders },
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "personal",
				name: "Personal",
				driver: "claude",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_800_000,
			},
		],
	});
	await gotoRelay(
		page,
		new URL("/s/settings-attribution?p=e2e-replay", relayUrl).toString(),
	);
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-claude").click();
	const panel = page.locator("#settings-panel");
	const group = panel.getByTestId("claude-attribution-group");
	const disclosure = group.getByRole("button", {
		name: "Attribution Commit · PR · Session link",
		exact: true,
	});
	const commit = panel.getByTestId("claude-setting-attribution-commit-input");
	const pr = panel.getByTestId("claude-setting-attribution-pr-input");
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(commit).toHaveCount(0);
	await expect(pr).toHaveCount(0);
	await expect(panel.getByTestId("claude-setting-attribution")).toHaveCount(0);
	await expect(
		panel.getByTestId("claude-setting-cleanupPeriodDays-input"),
	).toHaveValue("45");
	await group.scrollIntoViewIfNeeded();
	await page.evaluate(() => document.fonts.ready);
	const artifactDir = resolve("test-results/settings-claude-attribution");
	await mkdir(artifactDir, { recursive: true });
	const collapsedPath = resolve(artifactDir, "collapsed-desktop.png");
	await panel.screenshot({ path: collapsedPath, animations: "disabled" });
	await testInfo.attach("attribution-collapsed-desktop", {
		path: collapsedPath,
		contentType: "image/png",
	});

	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "true");
	await expect(commit).toHaveValue(inheritedAttribution.commit);
	await expect(pr).toHaveValue(inheritedAttribution.pr);
	const attributionRow = panel.getByTestId("claude-setting-attribution");
	await expect(attributionRow.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(
		panel.getByTestId("claude-setting-attribution-provenance"),
	).toContainText("From your user settings");
	const updatedCommit = "Created with Conduit";
	await commit.fill(updatedCommit);
	await commit.blur();
	const saved = await rpc.waitForRequest(
		(request) => request.tag === "SetClaudeSettings",
	);
	expect(saved.payload).toMatchObject({
		projectSlug: "e2e-replay",
		overrides: {
			cleanupPeriodDays: 45,
			attribution: { ...inheritedAttribution, commit: updatedCommit },
		},
	});
	await expect(
		panel.getByTestId("claude-setting-attribution-provenance"),
	).toContainText("Applies to your next session");
	await expect(
		panel.getByTestId("claude-setting-attribution-reset"),
	).toBeVisible();
	await expect(disclosure).toContainText("Commit · PR · Session link");
	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(commit).toHaveCount(0);
	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "true");
	await expect(commit).toHaveValue(updatedCommit);
	await expect(pr).toHaveValue(inheritedAttribution.pr);
	await expect(attributionRow.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await group.scrollIntoViewIfNeeded();
	const expandedPath = resolve(artifactDir, "expanded-desktop.png");
	await panel.screenshot({ path: expandedPath, animations: "disabled" });
	await testInfo.attach("attribution-expanded-desktop", {
		path: expandedPath,
		contentType: "image/png",
	});
});
