import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import TooltipDemo from "./__fixtures__/TooltipDemo.svelte";

const SHORT_TOOLTIP_TEXT = "Verbose logging · Ctrl+L";

const meta = {
	title: "UI/Tooltip",
	component: TooltipDemo,
	tags: ["autodocs", "viewport-capture"],
	args: { open: true, delayDuration: 700, longText: false },
	argTypes: {
		open: { control: "boolean" },
		delayDuration: { control: { type: "number", min: 0 } },
		longText: { control: "boolean" },
	},
} satisfies Meta<typeof TooltipDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	parameters: { a11y: { context: "body" } },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = body.getByRole("button", { name: "Show details" });
		const tooltip = body.getByRole("tooltip");

		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveTextContent(SHORT_TOOLTIP_TEXT);
		await expect(trigger).toHaveAccessibleDescription(SHORT_TOOLTIP_TEXT);
	},
};

export const HoverOpens: Story = {
	args: { open: false, delayDuration: 0 },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = body.getByRole("button", { name: "Show details" });

		await userEvent.hover(trigger);
		await waitFor(() => {
			expect(body.getByRole("tooltip")).toHaveTextContent(SHORT_TOOLTIP_TEXT);
		});

		await userEvent.unhover(trigger);
		await waitFor(() => {
			expect(body.queryByRole("tooltip")).toBeNull();
		});
	},
};

export const FocusOpensImmediately: Story = {
	args: { open: false },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = body.getByRole("button", { name: "Show details" });

		await userEvent.tab();

		await expect(trigger).toHaveFocus();
		await expect(body.getByRole("tooltip")).toHaveTextContent(
			SHORT_TOOLTIP_TEXT,
		);
	},
};

export const EscapeCloses: Story = {
	args: { open: false, delayDuration: 0 },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = body.getByRole("button", { name: "Show details" });

		await userEvent.tab();
		await expect(body.getByRole("tooltip")).toBeVisible();
		await userEvent.keyboard("{Escape}");

		await waitFor(() => {
			expect(body.queryByRole("tooltip")).toBeNull();
		});
		await expect(trigger).toHaveFocus();
	},
};

export const LongContent: Story = {
	args: { open: true, longText: true },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const tooltip = body.getByRole("tooltip");

		await expect(tooltip).toBeVisible();
		// Both bounds matter: the upper proves max-w-xs constrains the long text, the
		// lower proves the tip actually laid out. `<= 320` alone also passes at width 0,
		// so on its own it would hold for a tooltip that never rendered at all.
		expect(tooltip.clientWidth).toBeLessThanOrEqual(320);
		expect(tooltip.clientWidth).toBeGreaterThan(200);
	},
};
