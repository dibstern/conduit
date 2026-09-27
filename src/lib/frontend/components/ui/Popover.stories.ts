import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import PopoverDemo from "./__fixtures__/PopoverDemo.svelte";

const meta = {
	title: "UI/Popover",
	component: PopoverDemo,
	tags: ["autodocs", "viewport-capture"],
	args: { open: true, headerless: false },
	argTypes: {
		open: { control: "boolean" },
		headerless: { control: "boolean" },
	},
} satisfies Meta<typeof PopoverDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);

		await expect(body.getByRole("dialog", { name: "Details" })).toBeVisible();
	},
};

export const Headerless: Story = {
	args: { headerless: true },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);

		await expect(
			body.getByRole("dialog", { name: "Quick details" }),
		).toBeVisible();
	},
};

export const EscapeRestoresFocus: Story = {
	args: { open: false },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open popover" });

		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");

		await waitFor(() => {
			expect(body.queryByRole("dialog")).not.toBeInTheDocument();
		});
		await waitFor(() => {
			expect(
				canvas.getByRole("button", { name: "Open popover" }),
			).toHaveFocus();
		});

		await userEvent.click(trigger);
		await expect(body.getByRole("dialog", { name: "Details" })).toBeVisible();
	},
};
