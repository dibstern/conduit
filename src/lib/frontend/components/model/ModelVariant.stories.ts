import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { handleVariantInfo } from "../../stores/discovery.svelte.js";
import ModelVariant from "./ModelVariant.svelte";

const meta = {
	title: "Model/ModelVariant",
	component: ModelVariant,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		handleVariantInfo({
			type: "variant_info",
			variant: "",
			variants: ["low", "medium", "high", "max"],
		});
	},
} satisfies Meta<typeof ModelVariant>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const High: Story = {
	beforeEach: () => {
		handleVariantInfo({
			type: "variant_info",
			variant: "high",
			variants: ["low", "medium", "high", "max"],
		});
	},
};

export const DropdownOpen: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The menu portals to <body>, so it is outside canvasElement.
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("variant-badge"));
		await expect(body.getByTestId("variant-dropdown")).toBeVisible();
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
