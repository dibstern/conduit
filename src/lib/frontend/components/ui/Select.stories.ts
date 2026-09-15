import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import Select from "./Select.svelte";

const options = () =>
	createRawSnippet(() => ({
		render: () =>
			'<optgroup label="Options"><option value="a">A</option><option value="b">B</option></optgroup>',
	}));

const meta = {
	title: "UI/Select",
	component: Select,
	tags: ["autodocs"],
	args: { "aria-label": "Choice", children: options() },
	argTypes: {
		size: { control: "inline-radio", options: ["sm", "md"] },
		invalid: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
	args: { size: "sm" },
};

export const Invalid: Story = {
	args: { invalid: true },
	play: async ({ canvasElement }) => {
		const select = within(canvasElement).getByRole("combobox");
		await expect(select).toHaveAttribute("aria-invalid", "true");
	},
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const Selection: Story = {
	play: async ({ canvasElement }) => {
		const select = within(canvasElement).getByRole("combobox");
		await userEvent.selectOptions(select, "b");
		await expect((select as HTMLSelectElement).value).toBe("b");
	},
};

// The house focus ring is the only thing that marks the keyboard-focused
// field, and it is a box-shadow painted outside the border box — so without a
// story that forces the state, nothing in the suite would notice it vanishing.
// The visual spec pads the capture root for any story whose id says "focus".
export const FocusVisible: Story = {
	parameters: { pseudo: { focusVisible: true } },
};
