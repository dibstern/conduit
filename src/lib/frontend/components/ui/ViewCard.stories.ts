import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import ViewCardDemo from "./__fixtures__/ViewCardDemo.svelte";

const meta = {
	title: "UI/ViewCard",
	component: ViewCardDemo,
	tags: ["autodocs", "viewport-capture"],
} satisfies Meta<typeof ViewCardDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const card = await body.findByRole("menuitemradio", { name: "Chat" });
		await expect(card).toHaveAttribute("aria-checked", "true");
		await expect(card.getBoundingClientRect().height).toBeGreaterThanOrEqual(
			44,
		);
	},
};
export const CurrentLight: Story = { ...Current, globals: { theme: "light" } };
export const Unavailable: Story = {
	args: { view: "diff", disabled: true },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const card = await body.findByRole("menuitemradio", { name: "Diff" });
		await expect(card).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(card);
		await expect(card).toHaveAttribute("aria-checked", "false");
		await expect(body.getByRole("menu")).toBeVisible();
	},
};
export const UnavailableLight: Story = {
	...Unavailable,
	globals: { theme: "light" },
};
export const WithBadge: Story = {
	args: { view: "terminal", badge: 2 },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const card = await body.findByRole("menuitemradio", { name: "Terminal" });
		await expect(card).toHaveTextContent("2");
		await expect(card).toHaveAccessibleDescription("2 unread view updates");
	},
};
export const CurrentHidesBadge: Story = {
	args: { view: "terminal", badge: 2 },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await body.findByRole("menuitemradio", { name: "Terminal" }),
		);
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await expect(
			within(canvasElement).getByTestId("picked-view"),
		).toHaveTextContent("terminal");
		await userEvent.click(body.getByRole("button", { name: "Open views" }));
		// Now the current view, so its badge is gone.
		const card = await body.findByRole("menuitemradio", { name: "Terminal" });
		await expect(card).not.toHaveTextContent("2");
		await expect(card).not.toHaveAttribute("aria-describedby");
	},
};
export const WithBadgeLight: Story = {
	...WithBadge,
	globals: { theme: "light" },
};
export const Files: Story = { args: { view: "files" } };
export const FilesLight: Story = { ...Files, globals: { theme: "light" } };
