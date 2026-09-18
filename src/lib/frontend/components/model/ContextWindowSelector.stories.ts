import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	clearDiscoveryState,
	handleContextWindowInfo,
} from "../../stores/discovery.svelte.js";
import ContextWindowSelector from "./ContextWindowSelector.svelte";

const meta = {
	title: "Model/ContextWindowSelector",
	component: ContextWindowSelector,
	tags: ["autodocs"],
	beforeEach: () => {
		clearDiscoveryState();
	},
} satisfies Meta<typeof ContextWindowSelector>;

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
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "",
			options: standardOptions,
		});
	},
};

/** Premium default — 1M selected when no override is stored. */
export const PremiumDefault: Story = {
	beforeEach: () => {
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "",
			options: premiumOptions,
		});
	},
};

/** User-selected 1M override. */
export const Selected1M: Story = {
	beforeEach: () => {
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "1m",
			options: standardOptions,
		});
	},
};

/** Dropdown open with both options visible. */
export const Open: Story = {
	beforeEach: () => {
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "",
			options: standardOptions,
		});
	},
	play: async ({ canvasElement }) => {
		await new Promise((r) => setTimeout(r, 50));
		const btn = canvasElement.querySelector(
			"[data-testid='context-window-badge']",
		) as HTMLElement;
		btn?.click();
	},
};
