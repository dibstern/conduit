import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { discoveryState } from "../../stores/discovery.svelte.js";
import AgentSelector from "./AgentSelector.svelte";

const meta = {
	title: "Model/AgentSelector",
	component: AgentSelector,
	tags: ["autodocs"],
	beforeEach: () => {
		// Reset state for each story
		discoveryState.agents = [];
		discoveryState.activeAgentId = null;
	},
} satisfies Meta<typeof AgentSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Multiple agents with one active — pills visible. */
export const Default: Story = {
	play: () => {
		discoveryState.agents = [
			{ id: "code", name: "code", description: "Write and edit code" },
			{ id: "plan", name: "plan", description: "Plan tasks" },
			{
				id: "general",
				name: "general",
				description: "General assistant",
			},
		];
		discoveryState.activeAgentId = "code";
	},
};

/** Single agent — selector should be hidden. */
export const SingleAgent: Story = {
	play: () => {
		discoveryState.agents = [
			{ id: "code", name: "code", description: "Write and edit code" },
		];
		discoveryState.activeAgentId = "code";
	},
};

/** No agents — selector should be hidden. */
export const NoAgents: Story = {
	play: () => {
		discoveryState.agents = [];
		discoveryState.activeAgentId = null;
	},
};
