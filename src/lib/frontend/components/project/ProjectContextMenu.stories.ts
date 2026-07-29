import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import { mockProject } from "../../stories/mocks.js";
import ProjectContextMenu from "./ProjectContextMenu.svelte";

const anchor = {
	getBoundingClientRect: () => ({ bottom: 180, right: 320 }),
} as unknown as HTMLElement;

const meta = {
	title: "Project/ProjectContextMenu",
	component: ProjectContextMenu,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "300px" } },
	},
	args: {
		project: mockProject,
		anchor,
		onrename: fn(),
		ondelete: fn(),
		onclose: fn(),
	},
} satisfies Meta<typeof ProjectContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutRename: Story = {
	args: { onrename: undefined },
};
