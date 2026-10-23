import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { attachedProjectState } from "../../stores/router.svelte.js";
import { connectedSocket } from "../../stories/sockets.js";
import SkillDoc from "./SkillDoc.svelte";

const meta = {
	title: "Chat/SkillDoc",
	component: SkillDoc,
	parameters: { layout: "padded" },
	args: { name: "flow-example" },
} satisfies Meta<typeof SkillDoc>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
	beforeEach: () => {
		const restoreSocket = connectedSocket();
		const previousProject = attachedProjectState.slug;
		attachedProjectState.slug = "storybook";
		return () => {
			restoreSocket();
			attachedProjectState.slug = previousProject;
		};
	},
	play: async ({ canvasElement }) => {
		await expect(
			await within(canvasElement).findByText("Loading skill…"),
		).toBeVisible();
		await expect(
			canvasElement.querySelector('[data-flow-glyph="running"]'),
		).toBeVisible();
	},
};
