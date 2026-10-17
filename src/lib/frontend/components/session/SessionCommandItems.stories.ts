import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import SessionCommandItemsDemo from "./__fixtures__/SessionCommandItemsDemo.svelte";

const meta = {
	title: "Session/SessionCommandItems",
	component: SessionCommandItemsDemo,
	tags: ["autodocs", "viewport-capture"],
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionCommandItemsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Menu: Story = {
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session commands",
		});
		await expect(within(menu).getByTestId("command-demo-settle")).toBeVisible();
		await expect(within(menu).getByTestId("command-demo-auto")).toHaveAttribute(
			"role",
			"menuitemcheckbox",
		);
		await expect(within(menu).getByTestId("command-demo-delete")).toHaveClass(
			/text-error/,
		);
	},
};

export const Sheet: Story = {
	args: { presentation: "sheet" },
	parameters: { viewport: { defaultViewport: "mobile1" } },
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session commands",
		});
		for (const id of [
			"command-demo-settle",
			"command-demo-auto",
			"command-demo-snooze",
			"command-demo-delete",
		]) {
			const target = within(menu).getByTestId(id);
			await expect(target).toBeVisible();
			// Phone sheets are touch targets: every command stays at least 44px tall.
			await expect(
				target.getBoundingClientRect().height,
			).toBeGreaterThanOrEqual(44);
		}
		await expect(
			within(menu).getByRole("group", { name: "Triage" }),
		).toBeVisible();
	},
};
