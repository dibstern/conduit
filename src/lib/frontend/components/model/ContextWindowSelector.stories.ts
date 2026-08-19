import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { discoveryState } from "../../stores/discovery.svelte.js";
import ContextWindowSelectorHost from "./__fixtures__/ContextWindowSelectorHost.svelte";

const meta = {
	title: "Model/ContextWindowSelector",
	component: ContextWindowSelectorHost,
	tags: ["autodocs"],
	args: {
		reserveDropUpSpace: false,
	},
	argTypes: {
		reserveDropUpSpace: { control: false },
	},
	beforeEach: () => {
		discoveryState.currentContextWindow = "";
		discoveryState.availableContextWindowOptions = [];
	},
} satisfies Meta<typeof ContextWindowSelectorHost>;

export default meta;
type Story = StoryObj<typeof meta>;

const standardOptions = [
	{ value: "200k", label: "200K", isDefault: true },
	{ value: "1m", label: "1M (beta)" },
];

const premiumOptions = [
	{ value: "200k", label: "200K" },
	{ value: "1m", label: "1M (beta)", isDefault: true },
];

/** Standard default — 200K selected until the user opts into 1M. */
export const StandardDefault: Story = {
	beforeEach: () => {
		discoveryState.availableContextWindowOptions = standardOptions;
		discoveryState.currentContextWindow = "";
	},
};

/** Premium default — 1M selected when no override is stored. */
export const PremiumDefault: Story = {
	beforeEach: () => {
		discoveryState.availableContextWindowOptions = premiumOptions;
		discoveryState.currentContextWindow = "";
	},
};

/** User-selected 1M override. */
export const Selected1M: Story = {
	beforeEach: () => {
		discoveryState.availableContextWindowOptions = standardOptions;
		discoveryState.currentContextWindow = "1m";
	},
};

/** Dropdown open with both options visible. */
export const Open: Story = {
	args: {
		reserveDropUpSpace: true,
	},
	beforeEach: () => {
		discoveryState.availableContextWindowOptions = standardOptions;
		discoveryState.currentContextWindow = "";
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("context-window-badge"));
		await expect(canvas.getByTestId("context-window-dropdown")).toBeVisible();
	},
};

export const Hover: Story = {
	...StandardDefault,
	parameters: { pseudo: { hover: true } },
};
