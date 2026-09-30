import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import SessionVerbItemsDemo from "./__fixtures__/SessionVerbItemsDemo.svelte";

const meta = {
	title: "Session/SessionVerbItems",
	component: SessionVerbItemsDemo,
	tags: ["autodocs", "viewport-capture"],
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionVerbItemsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Menu: Story = {
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session verbs",
		});
		await expect(within(menu).getByTestId("verb-demo-settle")).toBeVisible();
		await expect(within(menu).getByTestId("verb-demo-auto")).toHaveAttribute(
			"role",
			"menuitemcheckbox",
		);
		await expect(within(menu).getByTestId("verb-demo-delete")).toHaveClass(
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
			"verb-demo-settle",
			"verb-demo-auto",
			"verb-demo-snooze",
			"verb-demo-delete",
		]) {
			await expect(within(menu).getByTestId(id)).toHaveClass(/min-h-\[44px\]/);
		}
	},
};
