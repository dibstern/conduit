import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import type { QuestionRequest } from "../../types.js";
import QuestionCard from "./QuestionCard.svelte";

const mockSingleSelect: QuestionRequest = {
	toolId: "q-001",
	sessionId: "test-session",
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
	sessionId: "test-session",
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
	sessionId: "test-session",
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
	sessionId: "test-session",
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

const meta = {
	title: "Chat/QuestionCard",
	component: QuestionCard,
	tags: ["autodocs"],
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectOptionGeometry(canvasElement: HTMLElement) {
	await canvasElement.ownerDocument.fonts.ready;
	for (const option of canvasElement.querySelectorAll(".question-option")) {
		const control = option.querySelector("input");
		const content = option.querySelector(".question-option-content");
		const label = option.querySelector(".question-option-label");
		if (!control || !content || !label)
			throw new Error("Missing question option");
		const font = getComputedStyle(label);
		const context = canvasElement.ownerDocument
			.createElement("canvas")
			.getContext("2d");
		if (!context) throw new Error("Missing text measurement context");
		context.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
		const x = context.measureText("x");
		const baseline = canvasElement.ownerDocument.createElement("span");
		baseline.style.cssText =
			"display:inline-block;width:0;height:0;vertical-align:baseline";
		label.prepend(baseline);
		const xCenter =
			baseline.getBoundingClientRect().top -
			(x.actualBoundingBoxAscent - x.actualBoundingBoxDescent) / 2;
		baseline.remove();
		const controlRect = control.getBoundingClientRect();
		await expect(
			Math.abs(controlRect.top + controlRect.height / 2 - xCenter),
		).toBeLessThanOrEqual(0.5);
		const row = option.getBoundingClientRect();
		const style = getComputedStyle(option);
		const contentRect = content.getBoundingClientRect();
		const expectedHeight = Math.max(
			window.matchMedia("(pointer: coarse)").matches ? 44 : 0,
			contentRect.height +
				parseFloat(style.paddingTop) +
				parseFloat(style.paddingBottom),
		);
		await expect(Math.abs(row.height - expectedHeight)).toBeLessThanOrEqual(
			0.5,
		);
		await expect(
			Math.abs(
				contentRect.top + contentRect.height / 2 - row.top - row.height / 2,
			),
		).toBeLessThanOrEqual(0.5);
	}
}

export const SingleSelect: Story = {
	args: { request: mockSingleSelect },
};

export const MultiSelect: Story = {
	args: { request: mockMultiSelect },
	play: async ({ canvasElement }) => {
		await expectOptionGeometry(canvasElement);
		const checkbox = within(canvasElement).getAllByRole("checkbox")[0];
		if (!checkbox) throw new Error("Missing question checkbox");
		await expect(getComputedStyle(checkbox).appearance).toBe("none");
		await userEvent.click(checkbox);
		await expect(checkbox).toBeChecked();
		await expect(getComputedStyle(checkbox).backgroundColor).not.toBe(
			"rgba(0, 0, 0, 0)",
		);
	},
};

export const WithCustomInput: Story = {
	args: { request: mockWithCustomInput },
	play: async ({ canvasElement }) => {
		await expectOptionGeometry(canvasElement);
		const canvas = within(canvasElement);
		for (const button of [
			canvas.getByRole("button", { name: "Submit" }),
			canvas.getByRole("button", { name: "Skip" }),
		]) {
			const style = getComputedStyle(button);
			await expect(button.getBoundingClientRect().height).toBe(28);
			await expect(parseFloat(style.borderRadius)).toBeGreaterThanOrEqual(999);
			await expect(style.borderTopWidth).toBe("0px");
			const tap = getComputedStyle(button, "::before");
			await expect(parseFloat(tap.minHeight)).toBeGreaterThanOrEqual(44);
		}
		const radio = canvas.getByRole("radio", { name: "Staging" });
		await expect(getComputedStyle(radio).appearance).toBe("none");
		for (const option of canvasElement.querySelectorAll(".question-option")) {
			await expect(getComputedStyle(option).borderTopWidth).toBe("0px");
		}
	},
};

export const RadioSelection: Story = {
	...WithCustomInput,
	play: async (context) => {
		await WithCustomInput.play?.(context);
		const canvas = within(context.canvasElement);
		const radio = canvas.getByRole("radio", { name: "Staging" });
		await userEvent.click(radio);
		await expect(radio).toBeChecked();
		await expect(canvas.getByRole("button", { name: "Submit" })).toBeEnabled();
	},
};

export const MultipleQuestions: Story = {
	args: { request: mockMultiQuestion },
};

export const Hover: Story = {
	...SingleSelect,
	parameters: { pseudo: { hover: true } },
};

export const WithCustomInputLight: Story = {
	...WithCustomInput,
	globals: { theme: "light" },
};
