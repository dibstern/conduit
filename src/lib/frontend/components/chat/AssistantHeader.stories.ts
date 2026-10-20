import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { mockAssistantSimple } from "../../stories/mocks.js";
import AssistantHeader from "./AssistantHeader.svelte";

const meta = {
	title: "Chat/AssistantHeader",
	component: AssistantHeader,
	tags: ["autodocs"],
	args: {
		message: {
			...mockAssistantSimple,
			createdAt: Date.UTC(2026, 1, 25, 10, 58),
		},
		model: "Sonnet 5",
		providerId: "claude",
		forkMessageId: "message-before-reply",
	},
} satisfies Meta<typeof AssistantHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const DefaultLight: Story = { globals: { theme: "light" } };
export const OpenCode: Story = {
	args: { providerId: "opencode", model: "GPT-6" },
};
export const Cursor: Story = { args: { providerId: "cursor" } };
export const UnknownProvider: Story = { args: { providerId: undefined } };
export const Working: Story = {
	args: { message: undefined, forkMessageId: undefined },
};
export const WorkingLight: Story = { ...Working, globals: { theme: "light" } };
export const Actions: Story = { tags: ["visual-pointer-hover"] };
export const ActionsLight: Story = {
	...Actions,
	tags: ["visual-pointer-hover"],
	globals: { theme: "light" },
};
export const MoreActions: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", {
				name: "More message actions",
			}),
		);
		const page = within(canvasElement.ownerDocument.body);
		expect(page.getAllByRole("menuitem")).toHaveLength(2);
		expect(page.getByRole("menuitem", { name: "Copy message" })).toBeVisible();
		expect(
			page.getByRole("menuitem", { name: "Fork from here" }),
		).toBeVisible();
	},
};
export const MoreActionsLight: Story = {
	...MoreActions,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
