import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import Checkbox from "./Checkbox.svelte";

const meta = {
	title: "UI/Checkbox",
	component: Checkbox,
	tags: ["autodocs"],
	args: { "aria-label": "Enable thing" },
	argTypes: {
		checked: { control: "boolean" },
		invalid: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
	args: { checked: true },
};

export const Disabled: Story = {
	args: { checked: true, disabled: true },
};

export const Invalid: Story = {
	args: { invalid: true },
	play: async ({ canvasElement }) => {
		const box = within(canvasElement).getByRole("checkbox");
		await expect(box).toHaveAttribute("aria-invalid", "true");
	},
};

export const Toggling: Story = {
	play: async ({ canvasElement }) => {
		const box = within(canvasElement).getByRole("checkbox");
		await expect(box).not.toBeChecked();
		await userEvent.click(box);
		await expect(box).toBeChecked();
	},
};

// The house focus ring is a box-shadow painted outside the border box, so
// without a story that forces the state nothing would notice it vanishing.
export const FocusVisible: Story = {
	args: { checked: true },
	parameters: { pseudo: { focusVisible: true } },
};

// Both states at once, because they fight over `outline`. Tailwind v4 routes
// `outline-2`'s style through a custom property that `outline-hidden` zeroes,
// so the error outline is one careless edit away from disappearing exactly
// when the user is interacting with the field.
export const InvalidFocused: Story = {
	args: { invalid: true },
	parameters: { pseudo: { focusVisible: true } },
};
