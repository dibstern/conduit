import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import SettingsGroupStoryGallery from "./__fixtures__/SettingsGroupStoryGallery.svelte";

const meta = {
	title: "UI/SettingsGroup",
	component: SettingsGroupStoryGallery,
	parameters: { layout: "padded" },
} satisfies Meta<typeof SettingsGroupStoryGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Plain groups (title, caption, toggle, control and text rows) and collapsible groups, open and closed. */
export const Gallery: Story = {};

/** Header actions sit outside the disclosure button, so pressing one must not expand the group. */
export const ActionsDoNotToggle: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const header = canvas.getByRole("button", { name: /OpenAI/ });
		await expect(header).toHaveAttribute("aria-expanded", "false");
		const hideOpenAi = within(canvas.getByTestId("openai-group")).getByRole(
			"button",
			{
				name: "Hide all",
			},
		);
		await userEvent.click(hideOpenAi);
		await expect(header).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(header);
		await expect(header).toHaveAttribute("aria-expanded", "true");
	},
};
