import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import ModalDemo from "./__fixtures__/ModalDemo.svelte";

const meta = {
	title: "UI/Modal",
	component: ModalDemo,
	tags: ["autodocs", "viewport-capture"],
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
	args: { initiallyOpen: true },
};

export const EscapeRestoresFocus: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open modal" });

		trigger.focus();
		await userEvent.keyboard("{Enter}");

		const dialog = body.getByRole("dialog", { name: "Modal title" });
		await expect(dialog).toBeVisible();
		await waitFor(() => {
			expect(
				dialog.contains(document.activeElement) ||
					dialog === document.activeElement,
			).toBe(true);
		});

		await userEvent.keyboard("{Escape}");

		await waitFor(() => {
			expect(body.queryByRole("dialog")).not.toBeInTheDocument();
		});
		await waitFor(() => {
			expect(canvas.getByRole("button", { name: "Open modal" })).toHaveFocus();
		});
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
		const body = within(canvasElement.ownerDocument.body);
		const dialog = body.getByRole("dialog");
		const description = body.getByText("Supporting details for this action.");

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
		const body = within(canvasElement.ownerDocument.body);

		await expect(
			body.getByRole("dialog", { name: "Quick actions" }),
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
		const body = within(canvasElement.ownerDocument.body);

		await userEvent.keyboard("{Escape}");

		await expect(body.getByRole("dialog")).toBeVisible();
	},
};
