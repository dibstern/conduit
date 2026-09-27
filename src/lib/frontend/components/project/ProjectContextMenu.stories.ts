import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { mockProject } from "../../stories/mocks.js";
import ProjectContextMenuHarness from "./__fixtures__/ProjectContextMenuHarness.svelte";

const meta = {
	title: "Project/ProjectContextMenu",
	component: ProjectContextMenuHarness,
	// viewport-capture: the menu portals to <body>, outside #storybook-root.
	tags: ["autodocs", "viewport-capture"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "340px" } },
	},
	args: { project: mockProject },
} satisfies Meta<typeof ProjectContextMenuHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutRename: Story = {
	args: { withRename: false },
};

// `rootSelector: "body"` is load-bearing: the menu portals out of
// #storybook-root, which is where the pseudo-states addon starts walking, so a
// plain `hover: true` would reach nothing and this frame would come out
// byte-identical to Default.
export const Hover: Story = {
	...Default,
	parameters: { pseudo: { rootSelector: "body", hover: true } },
};
