import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	phaseToIdle,
	phaseToProcessing,
} from "../../stores/chat.svelte.js";
import {
	handleAgentList,
	handleModelInfo,
	handleModelList,
	handleVariantInfo,
} from "../../stores/discovery.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import InputArea from "./InputArea.svelte";

const testId = "story-input";

function setHighVariant() {
	handleVariantInfo({
		type: "variant_info",
		variant: "high",
		variants: ["low", "medium", "high"],
	});
}

function setupDiscovery() {
	handleModelList({
		type: "model_list",
		providers: [
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
		],
	});
	handleModelInfo({
		type: "model_info",
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
	});
	setHighVariant();
	handleAgentList({
		type: "agent_list",
		providerScope: { id: "anthropic", name: "Anthropic" },
		agents: [{ id: "code", name: "code", description: "Write and edit code" }],
		activeAgentId: "code",
	});
}

const meta = {
	title: "Input/InputArea",
	component: InputArea,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		sessionState.currentId = testId;
		phaseToIdle(getOrCreateSessionActivity(testId));
		getOrCreateSessionMessages(testId).contextPercent = 0;
		setupDiscovery();
	},
} satisfies Meta<typeof InputArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Processing: Story = {
	beforeEach: () => {
		phaseToProcessing(getOrCreateSessionActivity(testId));
		// Ensure discovery state persists through processing state change
		setHighVariant();
	},
};

export const WithContextBar: Story = {
	beforeEach: () => {
		getOrCreateSessionMessages(testId).contextPercent = 42;
	},
};

export const HighContext: Story = {
	beforeEach: () => {
		getOrCreateSessionMessages(testId).contextPercent = 85;
	},
};

export const CriticalContext: Story = {
	beforeEach: () => {
		getOrCreateSessionMessages(testId).contextPercent = 97;
	},
};
