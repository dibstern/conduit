import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import MenuDemo from "./__fixtures__/MenuDemo.svelte";

const meta = {
	title: "UI/Menu",
	component: MenuDemo,
	tags: ["autodocs", "viewport-capture"],
	args: { open: true, selected: "compact" },
	argTypes: {
		open: { control: "boolean" },
		selected: {
			control: "inline-radio",
			options: ["compact", "comfortable"],
		},
	},
} satisfies Meta<typeof MenuDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ArrowKeyNavigation: Story = {
	args: { open: false },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open menu" });

		await userEvent.click(trigger);

		await waitFor(() => {
			expect(body.getByRole("menu", { name: "File actions" })).toHaveFocus();
		});
		await userEvent.keyboard("{ArrowDown}");
		await waitFor(() => {
			expect(body.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
		});

		await userEvent.keyboard("{ArrowDown}");
		await waitFor(() => {
			expect(body.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
		});
	},
};

export const EscapeRestoresFocus: Story = {
	args: { open: false },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open menu" });

		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");

		await waitFor(() => {
			expect(body.queryByRole("menu")).not.toBeInTheDocument();
		});
		await waitFor(() => {
			expect(canvas.getByRole("button", { name: "Open menu" })).toHaveFocus();
		});

		await userEvent.click(trigger);
		await expect(
			body.getByRole("menu", { name: "File actions" }),
		).toBeVisible();
	},
};

export const SelectingItemRestoresFocus: Story = {
	args: { open: false },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open menu" });

		await userEvent.click(trigger);
		await userEvent.click(body.getByRole("menuitem", { name: "Archive" }));

		await waitFor(() => {
			expect(body.queryByRole("menu")).not.toBeInTheDocument();
		});
		await waitFor(() => {
			expect(canvas.getByRole("button", { name: "Open menu" })).toHaveFocus();
		});

		await userEvent.click(trigger);
		await expect(
			body.getByRole("menu", { name: "File actions" }),
		).toBeVisible();
	},
};

export const RadioSelection: Story = {
	args: { open: false, selected: "compact" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open menu" });

		await userEvent.click(trigger);
		await expect(
			body.getByRole("menuitemradio", { name: "Compact" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(canvas.getByTestId("selected-value")).toHaveTextContent(
			"compact",
		);
		await userEvent.click(
			body.getByRole("menuitemradio", { name: "Comfortable" }),
		);
		await expect(canvas.getByTestId("selected-value")).toHaveTextContent(
			"comfortable",
		);
		await waitFor(() => {
			expect(canvas.getByRole("button", { name: "Open menu" })).toHaveFocus();
		});

		await userEvent.click(trigger);
		await expect(
			body.getByRole("menuitemradio", { name: "Compact" }),
		).toHaveAttribute("aria-checked", "false");
		await expect(
			body.getByRole("menuitemradio", { name: "Comfortable" }),
		).toHaveAttribute("aria-checked", "true");
	},
};
