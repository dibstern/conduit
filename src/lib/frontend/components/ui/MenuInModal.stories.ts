import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import MenuInModalDemo from "./__fixtures__/MenuInModalDemo.svelte";

const meta = {
	title: "UI/Menu in Modal",
	component: MenuInModalDemo,
} satisfies Meta<typeof MenuInModalDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KeyboardAndPointerSelection: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const dialog = body.getByRole("dialog", { name: "Modal with menu" });
		const trigger = within(dialog).getByRole("button", {
			name: "Open modal actions",
		});
		trigger.focus();
		await userEvent.keyboard("{Enter}");
		const menu = within(dialog).getByRole("menu", { name: "Modal actions" });
		await expect(menu).toBeVisible();
		const anchor = trigger.getBoundingClientRect();
		const panel = menu.getBoundingClientRect();
		await expect(panel.top).toBeGreaterThanOrEqual(anchor.bottom);
		await expect(panel.top - anchor.bottom).toBeLessThan(20);
		await expect(panel.left).toBeLessThan(anchor.right);
		await expect(panel.right).toBeGreaterThan(anchor.left);
		await userEvent.keyboard("{Home}");
		await expect(
			within(dialog).getByRole("menuitem", { name: "Choose by keyboard" }),
		).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(
			within(dialog).getByTestId("modal-selection"),
		).toHaveTextContent("keyboard");
		await userEvent.click(trigger);
		await userEvent.click(
			within(dialog).getByRole("menuitem", { name: "Choose by pointer" }),
		);
		await expect(
			within(dialog).getByTestId("modal-selection"),
		).toHaveTextContent("pointer");
		const popoverTrigger = within(dialog).getByRole("button", {
			name: "Open modal popover",
		});
		await userEvent.click(popoverTrigger);
		const popover = within(dialog).getByRole("dialog", {
			name: "Modal popover",
		});
		await expect(popover).toBeVisible();
		await expect(popover.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			popoverTrigger.getBoundingClientRect().bottom,
		);
		await userEvent.click(popoverTrigger);
		const tooltipTrigger = within(dialog).getByRole("button", {
			name: "Show modal tip",
		});
		await userEvent.hover(tooltipTrigger);
		const tooltip = within(dialog).getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		await expect(tooltip.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			tooltipTrigger.getBoundingClientRect().top,
		);
	},
};
