import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import type { ContextData, StatusData, UsageData } from "../../types.js";
import InfoPanels from "./InfoPanels.svelte";

const mockUsage: UsageData = {
	cost: 0.0342,
	inputTokens: 12_450,
	outputTokens: 3_210,
	cacheRead: 8_100,
	cacheWrite: 1_500,
	turns: 7,
};

const mockStatus: StatusData = {
	pid: 42_195,
	uptime: 7260,
	memory: 134_217_728,
	activeSessions: 3,
	processingSessions: 1,
	clients: 2,
	terminals: 1,
};

const mockContext60: ContextData = {
	usedTokens: 120_000,
	windowSize: 200_000,
	maxOutput: 16_384,
	model: "claude-sonnet-4-20250514",
	cost: 0.0182,
	turns: 5,
};

const mockContext90: ContextData = {
	usedTokens: 180_000,
	windowSize: 200_000,
	maxOutput: 16_384,
	model: "claude-sonnet-4-20250514",
	cost: 0.0891,
	turns: 22,
};

const meta = {
	title: "Overlays/InfoPanels",
	component: InfoPanels,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	beforeEach: () => {
		// Reset panels for each story
		uiState.openPanels = new Set();
	},
} satisfies Meta<typeof InfoPanels>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UsagePanel: Story = {
	args: {
		usageData: mockUsage,
	},
	play: () => {
		uiState.openPanels = new Set(["usage-panel"]);
	},
};

export const StatusPanel: Story = {
	args: {
		statusData: mockStatus,
	},
	play: () => {
		uiState.openPanels = new Set(["status-panel"]);
	},
};

export const ContextPanel: Story = {
	args: {
		contextData: mockContext60,
	},
	play: () => {
		uiState.openPanels = new Set(["context-panel"]);
	},
};

export const AllPanels: Story = {
	args: {
		usageData: mockUsage,
		statusData: mockStatus,
		contextData: mockContext60,
	},
	play: () => {
		uiState.openPanels = new Set([
			"usage-panel",
			"status-panel",
			"context-panel",
		]);
	},
};

export const ContextCritical: Story = {
	args: {
		contextData: mockContext90,
	},
	play: () => {
		uiState.openPanels = new Set(["context-panel"]);
	},
};
