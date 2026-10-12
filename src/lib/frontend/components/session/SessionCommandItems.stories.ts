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
			name: "Session verbs",
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
			name: "Session verbs",
		});
		for (const id of [
			"command-demo-settle",
			"command-demo-auto",
			"command-demo-snooze",
			"command-demo-delete",
		]) {
			await expect(within(menu).getByTestId(id)).toHaveClass(/min-h-\[44px\]/);
		}
	},
};
