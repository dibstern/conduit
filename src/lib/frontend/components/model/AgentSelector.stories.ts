import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
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
	beforeEach: () => {
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
	beforeEach: () => {
		discoveryState.agents = [
			{ id: "code", name: "code", description: "Write and edit code" },
		];
		discoveryState.activeAgentId = "code";
	},
};

/** No agents — selector should be hidden. */
export const NoAgents: Story = {};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

/**
 * The open dropdown, which had no visual coverage at all until
 * conduit-test-p4kj needed it. Every other story renders the trigger pill
 * only, so the panel this component exists to show -- its surface, its rows,
 * its scope heading -- was invisible to the gate, and the swap onto
 * `ui/Surface` would have been blessed by a suite that never saw it.
 *
 * The parent assertion is the portal check, and it is deliberately not
 * `toBeVisible`. The panel is inside `canvasElement` when the portal fails
 * and inside `<body>` when it works, and a body-scoped query finds it either
 * way, so only the parent tells the two apart.
 */
export const Open: Story = {
	...Default,
	// The panel is `position: fixed` in <body>, so it is outside
	// #storybook-root and the harness refuses to shoot it element-scoped.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = canvasElement.ownerDocument.body;
		await userEvent.click(canvas.getByTestId("agent-selector-trigger"));
		const panel = await within(body).findByTestId("agent-dropdown");
		await expect(panel.parentElement).toBe(body);
	},
};
