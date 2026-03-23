import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { discoveryState } from "../../stores/discovery.svelte.js";
import ModelSelector from "./ModelSelector.svelte";

const meta = {
	title: "Model/ModelSelector",
	component: ModelSelector,
	tags: ["autodocs"],
	beforeEach: () => {
		// Reset state for each story
		discoveryState.providers = [];
		discoveryState.currentModelId = "";
		discoveryState.currentProviderId = "";
	},
} satisfies Meta<typeof ModelSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Dropdown closed — shows current model name with chevron. */
export const Closed: Story = {
	play: () => {
		discoveryState.providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4-20250514",
						name: "Claude Sonnet 4",
						provider: "anthropic",
						cost: { input: 0.003, output: 0.015 },
					},
					{
						id: "claude-haiku-3.5-20250514",
						name: "Claude Haiku 3.5",
						provider: "anthropic",
						cost: { input: 0.0008, output: 0.004 },
					},
				],
			},
		];
		discoveryState.currentModelId = "claude-sonnet-4-20250514";
		discoveryState.currentProviderId = "anthropic";
	},
};

/** Dropdown opened — user clicked the model button. */
export const Open: Story = {
	play: async ({ canvasElement }) => {
		discoveryState.providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4-20250514",
						name: "Claude Sonnet 4",
						provider: "anthropic",
						cost: { input: 0.003, output: 0.015 },
					},
					{
						id: "claude-haiku-3.5-20250514",
						name: "Claude Haiku 3.5",
						provider: "anthropic",
						cost: { input: 0.0008, output: 0.004 },
					},
				],
			},
		];
		discoveryState.currentModelId = "claude-sonnet-4-20250514";
		discoveryState.currentProviderId = "anthropic";

		// Click the model button to open the dropdown
		await new Promise((r) => setTimeout(r, 50));
		const btn = canvasElement.querySelector(".model-btn") as HTMLElement;
		btn?.click();
	},
};

/** Multiple providers with models grouped — some unconfigured. */
export const WithGroups: Story = {
	play: async ({ canvasElement }) => {
		discoveryState.providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4-20250514",
						name: "Claude Sonnet 4",
						provider: "anthropic",
						cost: { input: 0.003, output: 0.015 },
					},
					{
						id: "claude-haiku-3.5-20250514",
						name: "Claude Haiku 3.5",
						provider: "anthropic",
						cost: { input: 0.0008, output: 0.004 },
					},
				],
			},
			{
				id: "openai",
				name: "OpenAI",
				configured: true,
				models: [
					{
						id: "gpt-4o",
						name: "GPT-4o",
						provider: "openai",
						cost: { input: 0.005, output: 0.015 },
					},
					{
						id: "gpt-4o-mini",
						name: "GPT-4o Mini",
						provider: "openai",
						cost: { input: 0.00015, output: 0.0006 },
					},
				],
			},
			{
				id: "google",
				name: "Google",
				configured: false,
				models: [
					{
						id: "gemini-2.5-pro",
						name: "Gemini 2.5 Pro",
						provider: "google",
					},
				],
			},
		];
		discoveryState.currentModelId = "claude-sonnet-4-20250514";
		discoveryState.currentProviderId = "anthropic";

		// Open dropdown
		await new Promise((r) => setTimeout(r, 50));
		const btn = canvasElement.querySelector(".model-btn") as HTMLElement;
		btn?.click();
	},
};

/** Model with variant/thinking level badge visible. */
export const WithVariants: Story = {
	play: async () => {
		discoveryState.providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4-20250514",
						name: "Claude Sonnet 4",
						provider: "anthropic",
						cost: { input: 0.003, output: 0.015 },
						variants: ["low", "medium", "high"],
					},
				],
			},
		];
		discoveryState.currentModelId = "claude-sonnet-4-20250514";
		discoveryState.currentProviderId = "anthropic";
		discoveryState.availableVariants = ["low", "medium", "high"];
		discoveryState.currentVariant = "high";
	},
};

/** No models or providers — shows placeholder text. */
export const NoModels: Story = {
	play: () => {
		discoveryState.providers = [];
		discoveryState.currentModelId = "";
		discoveryState.currentProviderId = "";
	},
};
