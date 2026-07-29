import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn, userEvent, within } from "storybook/test";
import conduitTheme from "../../../themes/conduit.json";
import opencodeLightTheme from "../../../themes/opencode-light.json";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../stores/discovery.svelte.js";
import { featureFlags } from "../../stores/feature-flags.svelte.js";
import { handleInstanceList } from "../../stores/instance.svelte.js";
import { routerState, syncSlugState } from "../../stores/router.svelte.js";
import { DEFAULT_THEME_ID, themeState } from "../../stores/theme.svelte.js";
import type { Base16Theme } from "../../stores/theme-compute.js";
import SettingsPanel from "./SettingsPanel.svelte";

function resetState() {
	routerState.path = "/";
	syncSlugState("/");
	clearDiscoveryState();
	handleInstanceList({ type: "instance_list", instances: [] });
	featureFlags.debug = false;
	localStorage.setItem(
		"notif-settings",
		JSON.stringify({ push: false, browser: true, sound: false }),
	);
	themeState.currentThemeId = DEFAULT_THEME_ID;
	themeState.themes = {
		conduit: conduitTheme as Base16Theme,
		"opencode-light": opencodeLightTheme as Base16Theme,
	};
	themeState.customThemeIds = [];
}

function populateInstances() {
	handleInstanceList({
		type: "instance_list",
		instances: [
			{
				id: "instance-local",
				name: "Local OpenCode",
				port: 4096,
				managed: true,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_800_000,
			},
			{
				id: "instance-discovered",
				name: "Team sandbox",
				port: 4102,
				managed: false,
				status: "stopped",
				restartCount: 0,
				createdAt: 1_772_011_860_000,
			},
		],
	});
}

const meta = {
	title: "Overlays/SettingsPanel",
	component: SettingsPanel,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "720px" } },
	},
	args: {
		visible: true,
		initialTab: "notifications",
		onClose: fn(),
	},
	beforeEach: resetState,
} satisfies Meta<typeof SettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NotificationsEnabled: Story = {
	beforeEach: () => {
		localStorage.setItem(
			"notif-settings",
			JSON.stringify({ push: true, browser: true, sound: true }),
		);
	},
};

export const Appearance: Story = {
	args: { initialTab: "appearance" },
};

export const VisibilityEmpty: Story = {
	args: { initialTab: "visibility" },
};

export const VisibilityPopulated: Story = {
	args: { initialTab: "visibility" },
	beforeEach: () => {
		discoveryState.providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4",
						name: "Claude Sonnet 4",
						provider: "anthropic",
					},
					{
						id: "claude-haiku-3-5",
						name: "Claude Haiku 3.5",
						provider: "anthropic",
					},
				],
			},
		];
		discoveryState.hiddenModels = ["anthropic/claude-haiku-3-5"];
		discoveryState.agentProviderScope = {
			id: "anthropic",
			name: "Anthropic",
		};
		discoveryState.agents = [
			{
				id: "code",
				name: "Code",
				description: "Write and edit code",
			},
			{
				id: "review",
				name: "Review",
				description: "Review changes without editing",
			},
		];
		discoveryState.hiddenAgents = ["anthropic/review"];
	},
};

export const InstancesEmpty: Story = {
	args: { initialTab: "instances" },
};

export const QuickStartExpanded: Story = {
	args: { initialTab: "instances" },
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: /Quick Start — Direct API Key/,
			}),
		);
	},
};

export const InstancesPopulated: Story = {
	args: { initialTab: "instances" },
	beforeEach: populateInstances,
};

export const InstanceExpanded: Story = {
	args: { initialTab: "instances" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: /Local OpenCode/,
			}),
		);
	},
};

export const Debug: Story = {
	args: { initialTab: "debug" },
};
