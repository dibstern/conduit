import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { closePanel } from "../../stores/terminal.svelte.js";
import ViewsRail from "./ViewsRail.svelte";

const meta = {
	title: "Layout/ViewsRail",
	component: ViewsRail,
	parameters: { layout: "padded", a11y: { test: "error" } },
	beforeEach: () => {
		sessionViewState.compact = false;
		sessionViewState.filesOpen = false;
		closePanel();
	},
} satisfies Meta<typeof ViewsRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IndependentViews: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const terminal = canvas.getByRole("button", { name: "Terminal" });
		const files = canvas.getByRole("button", { name: "Files" });
		await expect(canvas.getByRole("button", { name: "Diff" })).toBeDisabled();
		await userEvent.click(terminal);
		await userEvent.click(files);
		await expect(terminal).toHaveAttribute("aria-pressed", "true");
		await expect(files).toHaveAttribute("aria-pressed", "true");
		const rail = canvas.getByTestId("views-rail");
		expect(rail.getBoundingClientRect().width).toBe(44);
		expect(getComputedStyle(terminal).borderRadius).toBe("9px");
		expect(
			getComputedStyle(canvas.getByRole("group", { name: "Views" })).gap,
		).toBe("6px");
		expect(
			terminal.getBoundingClientRect().top - rail.getBoundingClientRect().top,
		).toBe(10);
		const expected = new Option().style;
		expected.color = getComputedStyle(rail).getPropertyValue("--color-accent");
		await waitFor(() =>
			expect(getComputedStyle(terminal).color).toBe(expected.color),
		);
		expected.backgroundColor =
			getComputedStyle(rail).getPropertyValue("--color-sidebar-bg");
		expect(getComputedStyle(rail).backgroundColor).toBe(
			expected.backgroundColor,
		);
	},
};

export const IndependentViewsLight: Story = {
	...IndependentViews,
	globals: { theme: "light" },
};
