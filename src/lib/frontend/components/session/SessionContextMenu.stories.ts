import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { mockSession } from "../../stories/mocks.js";
import SessionContextMenuHarness from "./__fixtures__/SessionContextMenuHarness.svelte";

const meta = {
	title: "Session/SessionContextMenu",
	component: SessionContextMenuHarness,
	// viewport-capture: the menu portals to <body>, outside #storybook-root.
	tags: ["autodocs", "viewport-capture"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "340px" } },
	},
	args: { session: mockSession },
} satisfies Meta<typeof SessionContextMenuHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
