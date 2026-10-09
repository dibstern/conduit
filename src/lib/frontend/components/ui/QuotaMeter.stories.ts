import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import QuotaMeterStoryGallery from "./__fixtures__/QuotaMeterStoryGallery.svelte";
import QuotaMeter from "./QuotaMeter.svelte";

const meta = {
	title: "UI/QuotaMeter",
	component: QuotaMeter,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { used: 23, size: "md" },
	argTypes: {
		size: { control: "inline-radio", options: ["sm", "md", "lg"] },
	},
} satisfies Meta<typeof QuotaMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every fill threshold, both numberless states and all three track widths. */
export const States: Story = {
	render: () => ({ Component: QuotaMeterStoryGallery }),
};

/** The fill is the share used; amber from 80%, red and "limited" at 100%. */
export const Thresholds: Story = {
	args: { used: 96 },
	play: async ({ canvasElement }) => {
		const meter = within(canvasElement).getByTestId("quota-meter");
		await expect(meter).toHaveAttribute("data-state", "high");
		await expect(
			within(meter).getByTestId("quota-meter-caption"),
		).toHaveTextContent("4% left");
	},
};
