import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../stores/discovery.svelte.js";
import { featureFlags } from "../../stores/feature-flags.svelte.js";
import { handleInstanceList } from "../../stores/instance.svelte.js";
import { routerState, syncSlugState } from "../../stores/router.svelte.js";
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
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", {
				name: /Quick Start — Direct API Key/,
			}),
		);
		await expect(canvas.getByText("opencode serve --port 4098")).toBeVisible();
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
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", {
				name: /Local OpenCode/,
			}),
		);
		await expect(canvas.getByRole("button", { name: "Rename" })).toBeVisible();
	},
};

export const Debug: Story = {
	args: { initialTab: "debug" },
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

/**
 * The add/edit instance form. Its Cancel and Save buttons appeared in no
 * baseline of any kind, so the de3.5 swap would have had nothing holding them
 * to zero pixel diff. Captured deliberately BEFORE that migration: a fidelity
 * gate can only prove "nothing moved" against an image of the old markup.
 */
export const InstanceForm: Story = {
	args: { initialTab: "instances" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("add-instance-btn"));
		await expect(canvas.getByTestId("instance-form-save")).toBeVisible();
		// Park focus on the Name field, NOT on Add. Storybook's click ends in a
		// programmatic .focus(), which Chromium treats as keyboard focus, so the
		// baseline would otherwise bake in Add's focus ring — and that ring is
		// exactly what changes when Add moves onto Button. A fidelity baseline
		// has to be blind to the migration it is about to police.
		await userEvent.click(canvas.getByTestId("instance-form-name"));
	},
};

/**
 * Hover on the instances tab. The existing Hover story sits on the Alerts tab,
 * so every hover style in the instances list — Scan Now, Add, and the per-row
 * actions — was uncaptured. That matters more than usual here: the de3.5 swap
 * of this panel needs `!` overrides mostly to hold HOVER colours that differ
 * from the Button variants, and an override no baseline can see is an override
 * no gate can prove.
 */
export const InstancesHover: Story = {
	args: { initialTab: "instances" },
	beforeEach: populateInstances,
	parameters: { pseudo: { hover: true } },
};

/**
 * Hover on an EXPANDED instance row, where Start / Stop / Edit / Rename /
 * Remove live. Those five buttons are the densest cluster of hover colours in
 * the panel, and the de3.5 swap needs `!` overrides to hold them.
 *
 * The hover state is applied by hand instead of through `parameters.pseudo`,
 * and it is applied to `document.body`. Neither is a style preference; both are
 * scars.
 *
 * `parameters.pseudo` cannot be used at all here. The addon's decorator emits
 * UPDATE_GLOBALS on first render, Storybook re-renders the story from scratch,
 * the Svelte component remounts, and `expandedInstanceId` goes back to null.
 * `play` does NOT run again on a globals-driven re-render, so the row silently
 * collapses after `play` expanded it. Writing `play` idempotently does not
 * help: nothing runs it a second time.
 *
 * `document.body` rather than the canvas, because the addon's other effect
 * calls `applyParameter` on `#storybook-root`, and that REMOVES every
 * `pseudo-*` class before adding back the ones the story asked for. It fires
 * after `play` finishes, so a class `play` put on the canvas is stripped by the
 * time the screenshot is taken. Body is outside its reach, and the rewritten
 * rules are descendant selectors, so they match from there just as well.
 *
 * Both mistakes captured a green baseline showing the wrong thing — first a
 * collapsed panel, then an expanded one with no hover. Nothing asserts that a
 * story shows what its name claims, so the only proof is to delete the line and
 * watch the gate go red.
 */
export const InstanceExpandedHover: Story = {
	args: { initialTab: "instances" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: /Local OpenCode/ }),
		);
		await expect(canvas.getByRole("button", { name: "Rename" })).toBeVisible();
		canvasElement.ownerDocument.body.classList.add("pseudo-hover-all");
	},
};
