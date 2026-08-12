import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import { mockSession } from "../../stories/mocks.js";
import SessionContextMenu from "./SessionContextMenu.svelte";

const anchor = {
	getBoundingClientRect: () => ({ bottom: 180, right: 360 }),
} as unknown as HTMLElement;

const meta = {
	title: "Session/SessionContextMenu",
	component: SessionContextMenu,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "340px" } },
	},
	args: {
		session: mockSession,
		anchor,
		onrename: fn(),
		ondelete: fn(),
		oncopyresume: fn(),
		onfork: fn(),
		onclose: fn(),
	},
} satisfies Meta<typeof SessionContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
