import { expect } from "@playwright/test";
import type { TitleGenerationSelection } from "../../../src/lib/contracts/title-generation.js";
import type { StepHandler } from "../runtime.js";
import { mockInstances, requireRpcControl } from "./shared.js";

const savedSelection = {
	account: { _tag: "Id", id: "claude-work" },
	providerId: "claude",
	modelId: "claude-sonnet-5",
	effort: "high",
} as const satisfies TitleGenerationSelection;

export const titleGenerationSettingsHandlers: StepHandler[] = [
	{
		name: "seed title generation accounts and catalogs",
		match: /^title generation has a separate Work Claude account$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const instances = [
				...(mockInstances.get(world.page) ?? []),
				{
					id: "claude-work",
					name: "Work Claude",
					driver: "claude",
					isDefault: false,
					usageEligible: true,
					configDir: "/profiles/work-claude",
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
			];
			mockInstances.set(world.page, instances);
			rpc.setDaemonList("SubscribeInstances", { instances });
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			rpc.setStubs({
				GetModels: (payload) => {
					if (
						!("instanceId" in payload) ||
						payload.instanceId !== "claude-work"
					)
						return getModels(payload);
					const providers = [
						{
							id: "claude",
							name: "Anthropic - claude",
							configured: true,
							models: [
								{
									id: "claude-sonnet-5",
									name: "Sonnet 5",
									provider: "claude",
									variants: ["low", "medium", "high"],
								},
							],
						},
					];
					rpc.setProjectSetting({
						_tag: "providerModels",
						accountId: "claude-work",
						providers,
					});
					return {
						projectSlug: "myapp",
						instanceId: "claude-work",
						providers,
					};
				},
			});
		},
	},
	{
		name: "seed saved title generation selection",
		match: /^title generation has the saved Work Claude Sonnet high selection$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setProjectSetting({
				_tag: "titleGeneration",
				selection: savedSelection,
				status: "unverified",
			});
		},
	},
	{
		name: "seed title generation selection for removed account",
		match: /^title generation has a saved selection for a removed account$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			expect(
				mockInstances
					.get(world.page)
					?.some((account) => account["id"] === "claude-work"),
			).not.toBe(true);
			rpc.setProjectSetting({
				_tag: "titleGeneration",
				selection: savedSelection,
				status: "missing",
				problem: "Title generation account does not exist",
			});
		},
	},
	{
		name: "assert removed title generation account notice",
		match: /^title generation shows the removed-account notice$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("settings-title-generation-problem"),
			).toHaveText(
				"The saved account is gone. Titles use the default Claude account until you pick another.",
			);
		},
	},
	{
		name: "open title generation picker",
		match: /^I open the title generation picker$/,
		run: async ({ world }) => {
			await world.page.getByTestId("settings-title-generation-picker").click();
			await expect(
				world.page.getByTestId("title-generation-picker"),
			).toBeVisible();
		},
	},
	{
		name: "assert title generation purpose and built-in default",
		match:
			/^title generation explains session titles and uses the built-in default$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId("settings-title-generation");
			await expect(row).toContainText(/session titles/i);
			await expect(row).toContainText(/opus/i);
			await expect(
				world.page.getByTestId("settings-title-generation-reset"),
			).toHaveCount(0);
			await expect(
				world.page.getByTestId("settings-title-generation-problem"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert title picker supports Claude accounts only",
		match: /^the title generation picker offers only the Claude harness$/,
		run: async ({ world }) => {
			const picker = world.page.getByTestId("title-generation-picker");
			await expect(picker.getByTestId("picker-harness-claude")).toBeVisible();
			await expect(picker.getByTestId("picker-harness-opencode")).toHaveCount(
				0,
			);
			await expect(picker.getByTestId("picker-harness-cursor")).toHaveCount(0);
		},
	},
	{
		name: "select title generation account model and effort",
		match: /^I choose Work Claude, Sonnet 5 and high effort for titles$/,
		run: async ({ world }) => {
			const picker = world.page.getByTestId("title-generation-picker");
			await picker.getByTestId("picker-harness-claude").click();
			await picker.getByTestId("picker-account-claude-work").click();
			await picker.getByTestId("picker-row-model").click();
			await picker.locator('[data-model-id="claude-sonnet-5"]').click();
			await picker.getByTestId("picker-effort-option-high").click();
			await expect(picker).toHaveAttribute("aria-busy", "false");
		},
	},
	{
		name: "assert saved title generation RPC",
		match:
			/^the title generation RPC saves the specific Work Claude Sonnet high selection$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.filter(({ tag }) => tag === "SetTitleGeneration")
						.map(({ payload }) => payload),
				)
				.toContainEqual(
					expect.objectContaining({
						_tag: "SetTitleGeneration",
						projectSlug: "myapp",
						selection: savedSelection,
					}),
				);
		},
	},
	{
		name: "reload title generation settings",
		match: /^I reload title generation settings$/,
		run: async ({ world }) => {
			await world.page.reload();
			await expect(world.page.locator("#layout")).toBeVisible();
		},
	},
	{
		name: "assert saved title generation row",
		match: /^title generation shows Work Claude, Sonnet 5 and high effort$/,
		run: async ({ world }) => {
			const row = world.page.getByTestId("settings-title-generation");
			await expect(row).toContainText("Work Claude");
			await expect(row).toContainText("Sonnet 5");
			await expect(row).toContainText(/high/i);
			await expect(
				world.page.getByTestId("settings-title-generation-reset"),
			).toBeVisible();
			await expect(
				world.page.getByTestId("settings-title-generation-problem"),
			).toHaveCount(0);
		},
	},
	{
		name: "reset title generation",
		match: /^I reset title generation to the built-in default$/,
		run: async ({ world }) => {
			await world.page.getByTestId("settings-title-generation-reset").click();
		},
	},
	{
		name: "assert title generation reset RPC",
		match: /^the title generation RPC clears the saved selection$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "SetTitleGeneration" && payload["selection"] === null,
			);
		},
	},
];
