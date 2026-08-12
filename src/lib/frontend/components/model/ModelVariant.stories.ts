import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { userEvent, within } from "storybook/test";
import { discoveryState } from "../../stores/discovery.svelte.js";
import ModelVariant from "./ModelVariant.svelte";

const meta = {
	title: "Model/ModelVariant",
	component: ModelVariant,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		discoveryState.availableVariants = ["low", "medium", "high", "max"];
		discoveryState.currentVariant = "";
	},
} satisfies Meta<typeof ModelVariant>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const High: Story = {
	beforeEach: () => {
		discoveryState.currentVariant = "high";
	},
};

export const DropdownOpen: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByTestId("variant-badge"));
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
