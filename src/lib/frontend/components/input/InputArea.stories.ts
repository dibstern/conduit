import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { chatState } from "../../stores/chat.svelte.js";
import { discoveryState } from "../../stores/discovery.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import InputArea from "./InputArea.svelte";

function setupDiscovery() {
	discoveryState.providers = [
		{
			id: "anthropic",
			name: "Anthropic",
			models: [
				{
					id: "claude-sonnet-4-20250514",
					name: "Claude Sonnet 4",
					provider: "anthropic",
					variants: ["low", "medium", "high"],
				},
			],
			configured: true,
		},
	];
	discoveryState.currentModelId = "claude-sonnet-4-20250514";
	discoveryState.currentProviderId = "anthropic";
	discoveryState.currentVariant = "high";
	discoveryState.availableVariants = ["low", "medium", "high"];
	discoveryState.agents = [
		{ id: "code", name: "code", description: "Write and edit code" },
	];
	discoveryState.activeAgentId = "code";
}

const meta = {
	title: "Input/InputArea",
	component: InputArea,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		chatState.processing = false;
		chatState.streaming = false;
		uiState.contextPercent = 0;
		setupDiscovery();
	},
} satisfies Meta<typeof InputArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Processing: Story = {
	play: () => {
		chatState.processing = true;
		// Ensure discovery state persists through processing state change
		discoveryState.currentVariant = "high";
	},
};

export const WithContextBar: Story = {
	play: () => {
		uiState.contextPercent = 42;
	},
};

export const HighContext: Story = {
	play: () => {
		uiState.contextPercent = 85;
	},
};

export const CriticalContext: Story = {
	play: () => {
		uiState.contextPercent = 97;
	},
};
