import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import {
	mockToolSubagent,
	mockToolSubagentCompleted,
	mockToolSubagentError,
	mockToolSubagentPending,
} from "../../stories/mocks.js";
import ToolSubagentCard from "./ToolSubagentCard.svelte";

const meta = {
	title: "Chat/ToolSubagentCard",
	component: ToolSubagentCard,
	tags: ["autodocs"],
} satisfies Meta<typeof ToolSubagentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockToolSubagentCompleted },
};

export const Pending: Story = {
	args: { message: mockToolSubagentPending },
};

export const Running: Story = {
	args: { message: mockToolSubagent },
	play: async ({ canvasElement }) => {
		await expect(
			canvasElement.querySelector('[data-flow-glyph="running"]'),
		).toBeVisible();
	},
};

export const ErrorState: Story = {
	args: { message: mockToolSubagentError },
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

export const Final: Story = {
	args: {
		message: { ...mockToolSubagentCompleted, createdAt: 1000, endedAt: 109000 },
	},
	globals: { theme: "dark" },
	play: async ({ canvasElement }) => {
		const row = canvasElement.querySelector(".subagent-header");
		const verb = canvasElement.querySelector(".tool-name");
		const argument = canvasElement.querySelector(".subagent-link");
		const time = canvasElement.querySelector("time");
		if (!row || !verb || !argument || !time)
			throw new Error("Missing subagent row");
		expect(row.getBoundingClientRect().height).toBe(26);
		expect(getComputedStyle(verb).fontSize).toBe("12.5px");
		expect(getComputedStyle(verb).fontWeight).toBe("400");
		expect(getComputedStyle(argument).fontSize).toBe("11.5px");
		expect(getComputedStyle(time).fontSize).toBe("10.12px");
	},
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };

export const CodexCompleted: Story = {
	args: {
		message: {
			...mockToolSubagentCompleted,
			input: {
				tool: "Task",
				description: "Inspect the patch",
				prompt: "Inspect the patch",
				subagentType: "Codex",
				taskId: "codex-subagent-example",
			},
			metadata: {
				subagentModel: "gpt-6.1-sol",
				subagentResult:
					"The patch handles child approvals and keeps their transcript separate.",
			},
		},
	},
};

export const CodexFailed: Story = {
	args: {
		message: {
			...mockToolSubagentCompleted,
			input: {
				tool: "Task",
				description: "Inspect the patch",
				subagentType: "Codex",
				taskId: "codex-subagent-example",
			},
			metadata: {
				outcome: "failed",
				subagentResult: "Codex child failed: provider disconnected.",
			},
		},
	},
};
