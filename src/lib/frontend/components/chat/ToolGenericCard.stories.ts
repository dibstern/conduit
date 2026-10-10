import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { PartVersion, ToolCallId } from "../../../contracts/tool-wire.js";
import {
	mockToolBash,
	mockToolCompleted,
	mockToolError,
	mockToolPending,
	mockToolPreview,
	mockToolReadWithOffset,
	mockToolRunning,
} from "../../stories/mocks.js";
import ToolGenericCard from "./ToolGenericCard.svelte";

const meta = {
	title: "Chat/ToolGenericCard",
	component: ToolGenericCard,
	tags: ["autodocs"],
} satisfies Meta<typeof ToolGenericCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockToolCompleted },
};

export const Pending: Story = {
	args: { message: mockToolPending },
};

export const Running: Story = {
	args: { message: mockToolRunning },
};

export const ErrorState: Story = {
	args: { message: mockToolError },
};

export const WithTags: Story = {
	args: { message: mockToolReadWithOffset },
};

export const ExpandedResult: Story = {
	args: { message: mockToolCompleted },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvasElement.querySelector(".tool-result")).toHaveTextContent(
			"authenticate(token: string)",
		);
	},
};

export const ExpandedBashCommand: Story = {
	args: { message: mockToolBash },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvasElement.querySelector(".tool-result")).toHaveTextContent(
			"git rev-parse HEAD",
		);
	},
};

const fullGrepOutput = `${mockToolPreview.result}\n${Array.from(
	{ length: 12 },
	(_, i) =>
		`src/lib/frontend/utils/history-logic.ts:${200 + i}:// TODO: line ${i + 1} of the full output`,
).join("\n")}`;

/** Expanding a previewed tool loads the rest straight away; the preview shows meanwhile. */
export const ExpandedPreviewLoading: Story = {
	args: { message: mockToolPreview, loadDetails: () => new Promise(() => {}) },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(canvas.getByText("Loading full output…")).toBeVisible();
	},
};

/** Once loaded, the whole output replaces the preview with nothing more to click. */
export const ExpandedFullDetail: Story = {
	args: {
		message: mockToolPreview,
		loadDetails: async (toolId: string) => ({
			toolId: ToolCallId.make(toolId),
			version: PartVersion.make(1),
			output: { _tag: "whole", text: fullGrepOutput },
		}),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(
			await canvas.findByText(/line 12 of the full output/),
		).toBeVisible();
	},
};

/** A failed load keeps the preview, says the rest did not load, and offers a retry. */
export const ExpandedLoadFailedRetry: Story = {
	args: {
		message: mockToolPreview,
		loadDetails: () => Promise.reject(new Error("connection lost")),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button"));
		await expect(
			await canvas.findByRole("button", { name: "Retry" }),
		).toBeVisible();
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
