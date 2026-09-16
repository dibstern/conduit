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

// `rootSelector: "body"` is load-bearing. Since conduit-test-de3.35.4 the menu
// portals out of #storybook-root, which is where the pseudo-states addon starts
// walking -- so a plain `hover: true` reached nothing and this story rendered a
// frame byte-identical to Default for several commits.
export const Hover: Story = {
	...Default,
	parameters: { pseudo: { rootSelector: "body", hover: true } },
};
