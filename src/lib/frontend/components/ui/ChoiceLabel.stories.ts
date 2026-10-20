import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import ChoiceLabelExample from "./__fixtures__/ChoiceLabelExample.svelte";

const meta = {
	title: "UI/ChoiceLabel",
	component: ChoiceLabelExample,
	tags: ["autodocs"],
} satisfies Meta<typeof ChoiceLabelExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { selected: false },
	globals: { theme: "dark" },
};
export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };
export const Selected: Story = {
	args: { selected: true },
	globals: { theme: "dark" },
};
export const SelectedLight: Story = {
	...Selected,
	globals: { theme: "light" },
};
export const Disabled: Story = { args: { selected: true, disabled: true } };
export const Toggle: Story = {
	...Default,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByText("Authentication module"));
		await expect(canvas.getByRole("checkbox")).toBeChecked();
	},
};
