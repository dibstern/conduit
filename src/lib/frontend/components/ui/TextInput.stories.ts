import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import TextInput from "./TextInput.svelte";

const meta = {
	title: "UI/TextInput",
	component: TextInput,
	tags: ["autodocs"],
	args: { "aria-label": "Text input" },
	argTypes: {
		size: { control: "inline-radio", options: ["sm", "md"] },
		invalid: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof TextInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
	args: { size: "sm" },
};

export const Placeholder: Story = {
	args: { placeholder: "Project name" },
};

export const Invalid: Story = {
	args: { invalid: true },
	play: async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole("textbox");
		await expect(input).toHaveAttribute("aria-invalid", "true");
	},
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const Typing: Story = {
	play: async ({ canvasElement }) => {
		const input = within(canvasElement).getByRole("textbox");
		await userEvent.type(input, "hello");
		await expect((input as HTMLInputElement).value).toBe("hello");
	},
};
