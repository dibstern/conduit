import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import ModalDemo from "./__fixtures__/ModalDemo.svelte";

const meta = {
	title: "UI/Modal",
	component: ModalDemo,
	tags: ["autodocs"],
	argTypes: {
		title: { control: "text" },
		ariaLabel: { control: "text" },
		description: { control: "text" },
		size: { control: "select", options: ["sm", "md", "lg"] },
		dismissible: { control: "boolean" },
		showClose: { control: "boolean" },
		withFooter: { control: "boolean" },
	},
} satisfies Meta<typeof ModalDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const trigger = canvas.getByRole("button", { name: "Open modal" });

		await userEvent.click(trigger);

		const dialog = canvas.getByRole("dialog", { name: "Modal title" });
		await expect(dialog).toBeVisible();
		await expect(
			dialog.contains(document.activeElement) ||
				dialog === document.activeElement,
		).toBe(true);

		await userEvent.keyboard("{Escape}");

		await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
		await expect(trigger).toHaveFocus();
	},
};

export const WithFooter: Story = {
	args: { initiallyOpen: true, withFooter: true },
};

export const Description: Story = {
	args: {
		initiallyOpen: true,
		description: "Supporting details for this action.",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const dialog = canvas.getByRole("dialog");
		const description = canvas.getByText("Supporting details for this action.");

		await expect(dialog).toHaveAttribute("aria-describedby", description.id);
	},
};

export const Small: Story = {
	args: { initiallyOpen: true, size: "sm" },
};

export const Large: Story = {
	args: { initiallyOpen: true, size: "lg" },
};

export const Headerless: Story = {
	args: {
		initiallyOpen: true,
		title: undefined,
		ariaLabel: "Quick actions",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		await expect(
			canvas.getByRole("dialog", { name: "Quick actions" }),
		).toBeVisible();
	},
};

export const NonDismissible: Story = {
	args: {
		initiallyOpen: true,
		dismissible: false,
		showClose: false,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		await userEvent.keyboard("{Escape}");

		await expect(canvas.getByRole("dialog")).toBeVisible();
	},
};
