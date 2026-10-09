import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import SortableListDemo from "./__fixtures__/SortableListDemo.svelte";

const meta = {
	title: "UI/SortableList",
	component: SortableListDemo,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { disabled: false },
	argTypes: { disabled: { control: "boolean" } },
} satisfies Meta<typeof SortableListDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Space picks a row up, the arrows move it, space drops it; each step is announced. */
export const Default: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const order = canvas.getByTestId("sortable-order");
		const announcement = canvas.getByTestId("sortable-announcement");
		canvas.getByRole("button", { name: "Reorder team" }).focus();
		await userEvent.keyboard(" ");
		await expect(announcement).toHaveTextContent(
			"Picked up team, position 3 of 3.",
		);
		await userEvent.keyboard("{ArrowUp}{ArrowUp}");
		await expect(announcement).toHaveTextContent(
			"team moved to position 1 of 3.",
		);
		await expect(order).toHaveTextContent("work,personal,team");
		await userEvent.keyboard(" ");
		await expect(order).toHaveTextContent("team,work,personal");
		await expect(announcement).toHaveTextContent(
			"Dropped team at position 1 of 3.",
		);
		await expect(
			canvas.getByRole("button", { name: "Reorder team" }),
		).toHaveFocus();

		await userEvent.keyboard(" {ArrowDown}{Escape}");
		await expect(order).toHaveTextContent("team,work,personal");
		await expect(announcement).toHaveTextContent(
			"Reorder cancelled. team is back at position 1 of 3.",
		);
	},
};

/** Disabled handles cannot pick a row up. */
export const Disabled: Story = {
	args: { disabled: true },
	play: async ({ canvasElement }) => {
		const handles = within(canvasElement).getAllByRole("button");
		for (const handle of handles) await expect(handle).toBeDisabled();
	},
};
