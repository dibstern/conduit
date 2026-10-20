import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { clearAllPermissions } from "../../stores/permissions.svelte.js";
import {
	mockQuestionAnswered,
	mockQuestionPending,
	mockQuestionRunning,
	mockQuestionSkipped,
} from "../../stories/mocks.js";
import ToolQuestionCard from "./ToolQuestionCard.svelte";

const meta = {
	title: "Chat/ToolQuestionCard",
	component: ToolQuestionCard,
	tags: ["autodocs"],
	beforeEach: () => {
		clearAllPermissions();
	},
} satisfies Meta<typeof ToolQuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockQuestionAnswered },
	play: async ({ canvasElement }) => {
		const chosen = canvasElement.querySelector('[data-chosen="true"]');
		await expect(chosen).not.toBeNull();
		await expect(chosen?.textContent).toContain("Staging");
		await expect(chosen?.textContent).toContain("Chosen");
		await expect(
			canvasElement.querySelector(".question-raw-answer"),
		).toBeNull();
		const capsule = chosen?.querySelector(".question-chosen");
		await expect(capsule).not.toBeNull();
		if (!capsule) return;
		const style = getComputedStyle(capsule);
		await expect(parseFloat(style.borderRadius)).toBeGreaterThanOrEqual(999);
		await expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
		const palette = canvasElement.ownerDocument.createElement("span");
		palette.style.color = "var(--color-accent)";
		canvasElement.append(palette);
		await expect(style.color).toBe(getComputedStyle(palette).color);
		palette.remove();
		for (const option of canvasElement.querySelectorAll(
			".question-tool-option",
		)) {
			await expect(getComputedStyle(option).borderTopWidth).toBe("0px");
		}
	},
};

export const Active: Story = {
	args: { message: mockQuestionRunning },
};

export const WaitingWithoutQuestionData: Story = {
	args: { message: mockQuestionPending },
};

export const Skipped: Story = {
	args: { message: mockQuestionSkipped },
	play: async ({ canvasElement }) => {
		const skipped = within(canvasElement).getByText("Skipped");
		const headerIcon = canvasElement.querySelector(".tool-status-icon");
		await expect(getComputedStyle(skipped).color).toBe(
			headerIcon ? getComputedStyle(headerIcon).color : "missing icon",
		);
		await expect(
			canvasElement.querySelector(".question-tool-header .text-error"),
		).toBeNull();
	},
};

export const ClaudeAnswer: Story = {
	...Default,
	args: {
		message: {
			...mockQuestionAnswered,
			result: JSON.stringify(
				'Your questions have been answered: "Where should this be deployed?"="Staging". You can now continue with these answers in mind.',
			),
		},
	},
};

export const StructuredAnswers: Story = {
	...Default,
	args: {
		message: {
			...mockQuestionAnswered,
			metadata: { answers: { "Where should this be deployed?": "Staging" } },
			result: "Your questions have been answered.",
		},
	},
};

export const FreeTextAnswer: Story = {
	args: {
		message: {
			...mockQuestionAnswered,
			result: JSON.stringify({
				answers: { "0": "An isolated preview environment" },
			}),
		},
	},
	play: async ({ canvasElement }) => {
		const answer = within(canvasElement).getByText(
			"An isolated preview environment",
		);
		await expect(getComputedStyle(answer).fontFamily).not.toContain("Mono");
		await expect(
			canvasElement.querySelector(".question-raw-answer"),
		).toBeNull();
		await expect(
			canvasElement.querySelector('[data-chosen="true"]'),
		).toBeNull();
	},
};

export const UnparsedAnswer: Story = {
	args: {
		message: {
			...mockQuestionAnswered,
			result: "Provider returned an unfamiliar answer format.",
		},
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByText(
				"Provider returned an unfamiliar answer format.",
			),
		).toBeVisible();
		await expect(
			canvasElement.querySelector(".question-raw-answer"),
		).not.toBeNull();
	},
};

export const PartiallyRecognisedAnswer: Story = {
	...UnparsedAnswer,
	args: {
		message: {
			...mockQuestionAnswered,
			result: JSON.stringify({
				answers: {
					"0": "Staging",
					"An unknown question": "Keep this answer visible",
				},
			}),
		},
	},
	play: async ({ canvasElement }) => {
		const fallback = canvasElement.querySelector(".question-raw-answer");
		await expect(fallback?.textContent).toContain("Keep this answer visible");
	},
};

export const Final: Story = {
	...Default,
	args: {
		message: { ...mockQuestionAnswered, createdAt: 1000, endedAt: 45000 },
	},
	globals: { theme: "dark" },
	play: async (context) => {
		await Default.play?.(context);
		const header = context.canvasElement.querySelector(".question-tool-header");
		const verb = header?.querySelector(".question-tool-verb");
		const argument = header?.querySelector(".question-tool-argument");
		const time = header?.querySelector("time");
		await expect(header?.getBoundingClientRect().height).toBe(26);
		if (!verb || !argument || !time)
			throw new Error("Missing question step header");
		await expect(getComputedStyle(verb).fontSize).toBe("12.5px");
		await expect(getComputedStyle(verb).fontWeight).toBe("400");
		await expect(getComputedStyle(argument).fontSize).toBe("11.5px");
		await expect(getComputedStyle(time).fontSize).toBe("10.12px");
	},
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };
export const ActiveLight: Story = { ...Active, globals: { theme: "light" } };
