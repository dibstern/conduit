import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { tick } from "svelte";
import {
	applyResolvedClaudeSettingsResponse,
	beginClaudeSettingsResolution,
	clearClaudeSettingsState,
} from "../../stores/claude-settings.svelte.js";
import { clearDiscoveryState } from "../../stores/discovery.svelte.js";
import { applyInstanceListResponse } from "../../stores/instance.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import ClaudeSettingsTab from "./ClaudeSettingsTab.svelte";

const meta = {
	title: "Overlays/ClaudeSettingsTab",
	component: ClaudeSettingsTab,
	parameters: { layout: "padded" },
	beforeEach: () => {
		clearClaudeSettingsState();
		clearDiscoveryState();
		applyInstanceListResponse({ instances: [] });
		attachedProjectState.slug = "storybook-project";
		routerState.path = "/";
	},
} satisfies Meta<typeof ClaudeSettingsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

function inheritedSettings(
	directory: string,
	thinking: boolean,
): NonNullable<Story["play"]> {
	return async ({ canvasElement }) => {
		beginClaudeSettingsResolution("storybook-project");
		applyResolvedClaudeSettingsResponse({
			projectSlug: "storybook-project",
			instanceId: "claude",
			resolved: {
				attribution: {},
				autoCompactEnabled: {},
				autoCompactWindow: {},
				cleanupPeriodDays: {},
				disableAllHooks: {},
				alwaysThinkingEnabled: {
					value: thinking,
					source: "project",
					path: `${directory}/.claude/settings.json`,
				},
			},
		});
		await tick();
		await expect(
			within(canvasElement).queryByTestId("claude-setting-defaultModel-select"),
		).toBeNull();
		const row = within(canvasElement).getByTestId(
			"claude-setting-alwaysThinkingEnabled",
		);
		await expect(within(row).getByRole("switch")).toHaveAttribute(
			"aria-checked",
			String(thinking),
		);
		await expect(
			row.querySelector(`[title="${directory}/.claude/settings.json"]`),
		).not.toBeNull();
	};
}

export const PrimaryFolder: Story = {
	play: inheritedSettings("/workspace/main", false),
};
export const Worktree: Story = {
	play: inheritedSettings("/workspace/worktree", true),
};
