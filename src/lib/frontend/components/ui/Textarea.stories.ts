import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import Textarea from "./Textarea.svelte";

const meta = {
	title: "UI/Textarea",
	component: Textarea,
	tags: ["autodocs"],
	args: { "aria-label": "Text area", rows: 4 },
	argTypes: {
		size: { control: "inline-radio", options: ["sm", "md"] },
		invalid: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
	args: { size: "sm" },
};

export const Invalid: Story = {
	args: { invalid: true },
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole("textbox");
		await expect(textarea).toHaveAttribute("aria-invalid", "true");
	},
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const Typing: Story = {
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole("textbox");
		await userEvent.type(textarea, "First line{enter}Second line");
		await expect((textarea as HTMLTextAreaElement).value).toBe(
			"First line\nSecond line",
		);
	},
};
