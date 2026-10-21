import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import {
	applyApprovalEnvelope,
	clearAllPermissions,
} from "../../stores/permissions.svelte.js";
import {
	mockQuestionAnswered,
	mockQuestionPending,
	mockQuestionRunning,
	mockQuestionSkipped,
} from "../../stories/mocks.js";
import type { AskUserQuestion, ToolMessage } from "../../types.js";
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
};

export const Active: Story = {
	args: { message: mockQuestionRunning },
};

export const WaitingWithoutQuestionData: Story = {
	args: { message: mockQuestionPending },
};

export const Skipped: Story = {
	args: { message: mockQuestionSkipped },
};

export const SecretAnswer: Story = {
	args: {
		message: {
			...mockQuestionAnswered,
			input: {
				tool: "AskUserQuestion",
				questions: [
					{
						header: "API token",
						question: "Which API token should be used?",
						options: [],
						isSecret: true,
						isOther: false,
					},
				],
			},
			result: "private-token-must-stay-hidden",
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Secret answer hidden")).toBeVisible();
		await expect(canvasElement).not.toHaveTextContent(
			"private-token-must-stay-hidden",
		);
	},
};

export const Final: Story = {
	args: {
		message: { ...mockQuestionAnswered, createdAt: 1000, endedAt: 45000 },
	},
	globals: { theme: "dark" },
};
export const FinalLight: Story = { ...Final, globals: { theme: "light" } };
export const ActiveLight: Story = { ...Active, globals: { theme: "light" } };

const asyncQuestions: AskUserQuestion[] = [
	{
		header: "",
		question: "Which database should I use?",
		options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
		multiSelect: false,
		custom: true,
	},
];
const asyncMessage: ToolMessage = {
	...mockQuestionAnswered,
	id: "codex-async-question",
	input: { delivery: "async", questions: asyncQuestions },
	result: "null",
};

export const AsyncOptions: Story = {
	args: { message: asyncMessage },
	beforeEach: () => {
		applyApprovalEnvelope({
			_tag: "upsert",
			sequence: 1,
			item: {
				_tag: "question",
				toolId: asyncMessage.id,
				toolUseId: asyncMessage.id,
				sessionId: "test-session",
				providerId: "codex",
				delivery: "async",
				questions: asyncQuestions,
			},
		});
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Answer anytime")).toBeVisible();
		await expect(
			canvas.getByRole("button", { name: "Dismiss question" }),
		).toBeVisible();
	},
};

const asyncFreeTextQuestions: AskUserQuestion[] = [
	{
		header: "",
		question: "What else should I consider?",
		options: [],
		multiSelect: false,
		custom: true,
	},
];

export const AsyncFreeText: Story = {
	...AsyncOptions,
	args: {
		message: {
			...asyncMessage,
			input: { delivery: "async", questions: asyncFreeTextQuestions },
		},
	},
	beforeEach: () => {
		applyApprovalEnvelope({
			_tag: "upsert",
			sequence: 1,
			item: {
				_tag: "question",
				toolId: asyncMessage.id,
				toolUseId: asyncMessage.id,
				sessionId: "test-session",
				providerId: "codex",
				delivery: "async",
				questions: asyncFreeTextQuestions,
			},
		});
	},
};

export const AsyncAnswered: Story = {
	args: {
		message: {
			...asyncMessage,
			result: "Which database should I use?\nPostgreSQL",
		},
	},
};

export const AsyncDismissed: Story = {
	args: { message: asyncMessage },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText("Dismissed")).toBeVisible();
		await expect(
			canvas.queryByRole("button", { name: "Dismiss question" }),
		).not.toBeInTheDocument();
	},
};
