import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { QuestionRequest } from "../../types.js";
import QuestionCard from "./QuestionCard.svelte";

// ─── Mock data ──────────────────────────────────────────────────────────────

const mockSingleSelect: QuestionRequest = {
	toolId: "q-001",
	questions: [
		{
			header: "model selection",
			question: "Which model would you like to use for this task?",
			options: [
				{
					label: "Claude Opus 4",
					description: "Most capable, slower",
				},
				{
					label: "Claude Sonnet 4",
					description: "Balanced performance",
				},
				{
					label: "Claude Haiku 3.5",
					description: "Fastest, lighter tasks",
				},
			],
			multiSelect: false,
			custom: false,
		},
	],
};

const mockMultiSelect: QuestionRequest = {
	toolId: "q-002",
	questions: [
		{
			header: "file selection",
			question: "Which files should be included in the refactor?",
			options: [
				{ label: "src/auth.ts", description: "Authentication module" },
				{ label: "src/db.ts", description: "Database layer" },
				{ label: "src/api.ts", description: "API routes" },
				{ label: "src/utils.ts", description: "Utility functions" },
			],
			multiSelect: true,
			custom: false,
		},
	],
};

const mockWithCustomInput: QuestionRequest = {
	toolId: "q-003",
	questions: [
		{
			header: "deployment target",
			question: "Where should this be deployed?",
			options: [
				{ label: "Production" },
				{ label: "Staging" },
				{ label: "Development" },
			],
			multiSelect: false,
			custom: true,
		},
	],
};

const mockMultiQuestion: QuestionRequest = {
	toolId: "q-004",
	questions: [
		{
			header: "language",
			question: "What programming language?",
			options: [{ label: "TypeScript" }, { label: "Python" }, { label: "Go" }],
			multiSelect: false,
			custom: false,
		},
		{
			header: "features",
			question: "Which features do you need?",
			options: [
				{ label: "Authentication", description: "JWT-based auth" },
				{ label: "Database", description: "PostgreSQL integration" },
				{ label: "Caching", description: "Redis-backed cache" },
			],
			multiSelect: true,
			custom: true,
		},
	],
};

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Chat/QuestionCard",
	component: QuestionCard,
	tags: ["autodocs"],
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Stories ────────────────────────────────────────────────────────────────

export const SingleSelect: Story = {
	args: { request: mockSingleSelect },
};

export const MultiSelect: Story = {
	args: { request: mockMultiSelect },
};

export const WithCustomInput: Story = {
	args: { request: mockWithCustomInput },
};

export const MultipleQuestions: Story = {
	args: { request: mockMultiQuestion },
};
