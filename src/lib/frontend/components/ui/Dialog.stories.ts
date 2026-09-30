import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import DialogDemo from "./__fixtures__/DialogDemo.svelte";

const meta = {
	title: "UI/Dialog",
	component: DialogDemo,
	tags: ["autodocs", "viewport-capture"],
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DialogDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

function assertBackdrop(token: string) {
	return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole(
			"dialog",
			{ name: "Dialog preview" },
		);
		await expect(dialog).toBeVisible();
		expect(dialog.matches(":modal")).toBe(true);
		const sample = document.createElement("div");
		sample.style.backgroundColor = `var(${token})`;
		document.body.append(sample);
		const expected = getComputedStyle(sample).backgroundColor;
		sample.remove();
		expect(getComputedStyle(dialog, "::backdrop").backgroundColor).toBe(
			expected,
		);
	};
}

export const Default: Story = { play: assertBackdrop("--color-backdrop") };
export const DarkBackdrop: Story = {
	args: { backdrop: "dark" },
	play: assertBackdrop("--color-backdrop-dark"),
};
export const SubtleBackdrop: Story = {
	args: { backdrop: "subtle" },
	play: assertBackdrop("--color-backdrop-subtle"),
};
