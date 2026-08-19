import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { createRawSnippet } from "svelte";
import { sessionState } from "../../stores/session.svelte.js";
import ForkContextBlock from "./ForkContextBlock.svelte";

const inheritedConversation = createRawSnippet(() => ({
	render: () => `
		<div class="space-y-3 py-2 text-sm">
			<div class="rounded-lg bg-bg-surface px-3 py-2 text-text-secondary">
				Add a visual safety gate before migrating the chat components.
			</div>
			<div class="px-3 py-2 text-text-muted">
				I’ll inventory the uncovered states and pin deterministic fixtures.
			</div>
		</div>
	`,
}));

const storySessionId = "sess_story_fork_context";
const storageKey = `fork-collapsed-${storySessionId}`;

const meta = {
	title: "Chat/ForkContextBlock",
	component: ForkContextBlock,
	tags: ["autodocs"],
	args: { children: inheritedConversation },
	argTypes: {
		children: { control: false },
	},
	beforeEach: () => {
		sessionState.currentId = storySessionId;
		sessionStorage.removeItem(storageKey);
	},
} satisfies Meta<typeof ForkContextBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Expanded: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvas.getByText(/Add a visual safety gate/)).toBeVisible();
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
