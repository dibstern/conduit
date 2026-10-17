import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import PhoneSheetDemo from "./__fixtures__/PhoneSheetDemo.svelte";

const meta = {
	title: "UI/PhoneSheet",
	component: PhoneSheetDemo,
	tags: ["autodocs", "viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
} satisfies Meta<typeof PhoneSheetDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TileSquare: Story = {};
export const TileSquareLight: Story = { globals: { theme: "light" } };
export const TileWide: Story = { args: { shape: "wide" } };
export const TileWideLight: Story = {
	...TileWide,
	globals: { theme: "light" },
};
export const LabelledGrid: Story = { args: { mode: "grid" } };
export const LabelledGridLight: Story = {
	...LabelledGrid,
	globals: { theme: "light" },
};
export const Held: Story = { args: { mode: "footer", held: true } };
export const HeldLight: Story = { ...Held, globals: { theme: "light" } };

export const SwitchOff: Story = {
	args: { mode: "switch" },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const row = await body.findByRole("menuitemcheckbox", {
			name: /Auto-settle/,
		});
		await expect(row).toHaveAttribute("aria-checked", "false");
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-checked", "true");
		await expect(body.getByRole("menu")).toBeVisible();
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-checked", "false");
	},
};
export const SwitchOffLight: Story = {
	...SwitchOff,
	globals: { theme: "light" },
};
export const SwitchOn: Story = { args: { mode: "switch", checked: true } };
export const SwitchOnLight: Story = {
	...SwitchOn,
	globals: { theme: "light" },
};
export const SwitchSaving: Story = {
	args: { mode: "switch", checked: true, saving: true },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const row = await body.findByRole("menuitemcheckbox", {
			name: /Auto-settle/,
		});
		await expect(row).toHaveAttribute("aria-busy", "true");
		await expect(row).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-checked", "true");
		await expect(body.getByRole("menu")).toBeVisible();
	},
};
export const SwitchSavingLight: Story = {
	...SwitchSaving,
	globals: { theme: "light" },
};

export const PinnedFooterSafeArea: Story = {
	args: { mode: "footer" },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const menu = await body.findByRole("menu", { name: "Session actions" });
		const scroller = menu.querySelector<HTMLElement>("[data-sheet-body]");
		const footer = menu.querySelector<HTMLElement>("[data-sheet-footer]");
		if (!scroller || !footer)
			throw new Error("Sheet body or footer is missing");
		await waitFor(() =>
			expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight),
		);
		await expect(
			Number.parseFloat(getComputedStyle(footer).paddingBottom),
		).toBe(42);
		const top = footer.getBoundingClientRect().top;
		scroller.scrollTop = 300;
		await expect(scroller.scrollTop).toBeGreaterThan(0);
		await expect(footer.getBoundingClientRect().top).toBe(top);
		await expect(body.getByRole("menuitem", { name: "Share" })).toBeVisible();
		scroller.scrollTop = 0;
	},
};
export const PinnedFooterSafeAreaLight: Story = {
	...PinnedFooterSafeArea,
	globals: { theme: "light" },
};

export const KeyboardAndDismissal: Story = {
	args: { mode: "footer", initiallyOpen: false },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", {
			name: "Open session actions",
		});
		await userEvent.click(trigger);
		const menu = await body.findByRole("menu");
		await waitFor(() => expect(menu).toHaveFocus());
		await userEvent.keyboard("{ArrowDown}");
		await waitFor(() =>
			expect(body.getByRole("menuitem", { name: "Settle" })).toHaveFocus(),
		);
		await userEvent.keyboard("s");
		await waitFor(() =>
			expect(body.getByRole("menuitem", { name: /Snooze/ })).toHaveFocus(),
		);
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await expect(trigger).toHaveFocus();
		await userEvent.click(trigger);
		await userEvent.click(await body.findByRole("menuitem", { name: "Share" }));
		await expect(canvas.getByTestId("sheet-picked")).toHaveTextContent("Share");
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
	},
};
