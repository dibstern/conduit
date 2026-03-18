import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { chatState } from "../../stores/chat.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import InputArea from "./InputArea.svelte";

const meta = {
	title: "Layout/InputArea",
	component: InputArea,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset state for each story
		chatState.processing = false;
		chatState.streaming = false;
		uiState.contextPercent = 0;
	},
} satisfies Meta<typeof InputArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Processing: Story = {
	play: () => {
		chatState.processing = true;
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
