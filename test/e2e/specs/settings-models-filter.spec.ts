import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { ProviderInfo } from "../../../src/lib/frontend/types.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const providers: ProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		configured: true,
		models: [
			{ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
			{
				id: "claude-haiku-3-5",
				name: "Claude Haiku 3.5",
				provider: "anthropic",
			},
		],
	},
	{
		id: "openai",
		name: "OpenAI",
		configured: true,
		models: [
			{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
			{ id: "gpt-5", name: "GPT-5", provider: "openai" },
		],
	},
];

async function openModels(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else {
		const titleMenu = page.getByTestId("session-bar-title-menu");
		if (await titleMenu.isVisible()) {
			await titleMenu.click();
			await page.getByTestId("session-title-settings").click();
		} else {
			await page.getByTestId("session-bar-overflow").click();
			await page.getByTestId("overflow-settings").click();
		}
	}
	await page.getByTestId("settings-tab-models").click();
}

test.use({ recording: "chat-simple", viewport: { width: 1440, height: 900 } });

test("filters models and agents, clears no matches and resets groups on reopen", async ({
	page,
	relayUrl,
}, testInfo) => {
	let hiddenModels = ["anthropic/claude-haiku-3-5"];
	let hiddenAgents = ["claude/review"];
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetModels: () => ({
				defaultOpenCodeInstanceId: "opencode",
				projectSlug: "e2e-replay",
				providers,
				hiddenModels,
			}),
			GetAgents: () => ({
				projectSlug: "e2e-replay",
				providerScope: { id: "claude", name: "Claude" },
				agents: [
					{ id: "code", name: "Code", description: "Write and edit code" },
					{ id: "review", name: "Review", description: "Review changes" },
				],
				hiddenAgents,
			}),
			GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
			SetHiddenEntries: (params) => {
				if (params.hiddenModels) hiddenModels = [...params.hiddenModels];
				if (params.hiddenAgents) hiddenAgents = [...params.hiddenAgents];
				return { projectSlug: "e2e-replay", hiddenModels, hiddenAgents };
			},
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: "e2e-replay",
						title: "Model visibility",
						folders: ["/workspace/settings"],
					},
				],
				current: "e2e-replay",
			},
			{
				type: "shell_snapshot",
				roots: true,
				sessions: [
					{
						id: "settings-models",
						title: "Model visibility",
						status: "idle",
						projectSlug: "e2e-replay",
					},
				],
			},
		],
		responses: new Map(),
	});
	await gotoRelay(
		page,
		new URL("/s/settings-models?p=e2e-replay", relayUrl).toString(),
	);
	await openModels(page);

	const panel = page.locator("#settings-panel");
	const filter = panel.getByTestId("settings-models-filter");
	const anthropic = panel.getByTestId("settings-models-group-anthropic");
	const openai = panel.getByTestId("settings-models-group-openai");
	const agents = panel.getByTestId("settings-agents-group");
	const groups = [anthropic, openai, agents];
	await expect(filter).toHaveAttribute("placeholder", "Filter 4 models");
	await expect(panel.getByTestId("settings-models-summary")).toHaveText(
		"3 of 4 shown",
	);
	for (const group of groups)
		await expect(group.locator("[aria-expanded]")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	await expect(anthropic).toContainText("1 of 2 shown");
	await expect(openai).toContainText("2 of 2 shown");
	await expect(agents).toContainText("1 of 2 shown");
	await expect(panel.getByRole("switch")).toHaveCount(0);
	await anthropic.locator("[aria-expanded]").click();
	await expect(anthropic.getByRole("switch")).toHaveCount(2);
	await anthropic.locator("[aria-expanded]").click();

	await filter.fill(" 4 ");
	for (const group of [anthropic, openai])
		await expect(group.locator("[aria-expanded]")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	await expect(anthropic.getByRole("switch")).toHaveAccessibleName(
		"Toggle claude sonnet 4",
	);
	await expect(openai.getByRole("switch")).toHaveAccessibleName(
		"Toggle gpt-4.1",
	);
	await expect(agents).toHaveCount(0);
	await expect(panel.getByTestId("settings-models-summary")).toHaveText(
		"3 of 4 shown",
	);
	const artifactDir = resolve("test-results/settings-models-filter");
	await mkdir(artifactDir, { recursive: true });
	await page.evaluate(() => document.fonts.ready);
	const filteredPath = resolve(artifactDir, "filtered-desktop.png");
	await page.screenshot({ path: filteredPath, animations: "disabled" });
	await testInfo.attach("filtered desktop", {
		path: filteredPath,
		contentType: "image/png",
	});

	await filter.fill("CLAUDE-SONNET");
	await expect(anthropic.getByRole("switch")).toHaveAccessibleName(
		"Toggle claude sonnet 4",
	);
	await expect(openai).toHaveCount(0);
	await filter.fill("REVIEW");
	await expect(agents.locator("[aria-expanded]")).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await expect(agents.getByRole("switch")).toHaveAccessibleName(
		"Toggle review",
	);
	await expect(agents.getByRole("switch")).toHaveAttribute(
		"aria-checked",
		"false",
	);

	await filter.fill("no-such-model");
	await expect(
		panel.getByTestId("settings-models-no-match").locator("span"),
	).toHaveText("No models match ‘no-such-model’.");
	await expect(
		panel.getByRole("button", { name: "Clear", exact: true }),
	).toBeVisible();
	// No group survives; the default-model pickers above keep their own toggles.
	await expect(
		panel.locator(
			'[data-testid^="settings-models-group-"], [data-testid="settings-agents-group"]',
		),
	).toHaveCount(0);
	const noMatchPath = resolve(artifactDir, "no-match-desktop.png");
	await page.screenshot({ path: noMatchPath, animations: "disabled" });
	await testInfo.attach("no matches desktop", {
		path: noMatchPath,
		contentType: "image/png",
	});
	await panel.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(filter).toHaveValue("");
	for (const group of groups)
		await expect(group.locator("[aria-expanded]")).toHaveAttribute(
			"aria-expanded",
			"false",
		);

	await openai.getByRole("button", { name: "Hide all", exact: true }).click();
	await expect
		.poll(
			() =>
				rpc.getRequests().find(({ tag }) => tag === "SetHiddenEntries")
					?.payload,
		)
		.toMatchObject({
			projectSlug: "e2e-replay",
			hiddenModels: [
				"anthropic/claude-haiku-3-5",
				"openai/gpt-4.1",
				"openai/gpt-5",
			],
		});
	await expect(openai).toContainText("0 of 2 shown");
	await expect(openai.locator("[aria-expanded]")).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(agents).toContainText("1 of 2 shown");
	await agents.getByRole("button", { name: "Show all", exact: true }).click();
	await expect(agents).toContainText("2 of 2 shown");
	await expect
		.poll(
			() =>
				rpc.getRequests().filter(({ tag }) => tag === "SetHiddenEntries")[1]
					?.payload,
		)
		.toMatchObject({ projectSlug: "e2e-replay", hiddenAgents: [] });
	await expect(agents.locator("[aria-expanded]")).toHaveAttribute(
		"aria-expanded",
		"false",
	);

	await filter.fill("4");
	await expect(openai.locator("[aria-expanded]")).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	await page.getByTestId("settings-close-btn").click();
	await expect(panel).toHaveCount(0);
	await openModels(page);
	await expect(filter).toHaveValue("");
	for (const group of groups)
		await expect(group.locator("[aria-expanded]")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	await expect(openai).toContainText("0 of 2 shown");
	await expect(panel.getByTestId("settings-models-summary")).toHaveText(
		"1 of 4 shown",
	);
});
