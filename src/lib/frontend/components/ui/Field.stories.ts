import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import FieldWithInput from "./__fixtures__/FieldWithInput.svelte";

const meta = {
	title: "UI/Field",
	component: FieldWithInput,
	tags: ["autodocs"],
	args: { label: "Email" },
	argTypes: {
		label: { control: "text" },
		hint: { control: "text" },
		error: { control: "text" },
		required: { control: "boolean" },
	},
} satisfies Meta<typeof FieldWithInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithHint: Story = {
	args: { hint: "Used for account notifications" },
};

export const WithError: Story = {
	args: { error: "Enter a valid email" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = canvas.getByRole("textbox");
		const label = canvas.getByText("Email");
		const error = canvas.getByRole("alert");

		await expect(label).toHaveAttribute("for", input.id);
		await expect(input.getAttribute("aria-invalid")).toBe("true");
		await expect(input.getAttribute("aria-describedby")).toBe(error.id);
		await expect(error).toHaveTextContent("Enter a valid email");
	},
};

export const Required: Story = {
	args: { required: true },
};
