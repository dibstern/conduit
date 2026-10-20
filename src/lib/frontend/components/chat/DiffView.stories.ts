import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import DiffView from "./DiffView.svelte";

const meta = {
	title: "Chat/DiffView",
	component: DiffView,
	tags: ["autodocs"],
} satisfies Meta<typeof DiffView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AddOnly: Story = {
	args: {
		oldText: "line one\nline two\nline three",
		newText: "line one\nline two\nline inserted\nline three\nline four",
		filename: "src/utils.ts",
	},
};

export const RemoveOnly: Story = {
	args: {
		oldText:
			"function hello() {\n  console.log('hello');\n  console.log('world');\n  return true;\n}",
		newText: "function hello() {\n  return true;\n}",
		filename: "src/hello.ts",
	},
};

export const Mixed: Story = {
	args: {
		oldText:
			"import { foo } from './foo';\nimport { bar } from './bar';\n\nfunction process(data) {\n  const result = foo(data);\n  return bar(result);\n}",
		newText:
			"import { foo } from './foo';\nimport { baz } from './baz';\nimport { qux } from './qux';\n\nfunction process(data) {\n  const intermediate = foo(data);\n  const result = baz(intermediate);\n  return qux(result);\n}",
		filename: "src/process.ts",
	},
};

export const LargeDiff: Story = {
	args: {
		oldText: Array.from(
			{ length: 50 },
			(_, i) => `line ${i + 1}: original content here`,
		).join("\n"),
		newText: Array.from({ length: 50 }, (_, i) => {
			if (i % 7 === 0) return `line ${i + 1}: MODIFIED content`;
			if (i % 13 === 0)
				return `line ${i + 1}: original content here\ninserted line after ${i + 1}`;
			return `line ${i + 1}: original content here`;
		}).join("\n"),
		filename: "src/large-file.ts",
	},
};

export const SplitView: Story = {
	args: {
		oldText:
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal in code sample
			"const name = '<em>world</em>';\n\nfunction greet(who: string) {\n  return `Hello, ${who}!`;\n}\n\nconsole.log(greet(name));",
		newText:
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal in code sample
			"const name = '<strong>universe</strong>';\nconst greeting = 'Hi';\n\nfunction greet(who: string, prefix: string) {\n  return `${prefix}, ${who}!`;\n}\n\nconsole.log(greet(name, greeting));",
		filename: "src/greet.ts",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		expect(canvas.queryByRole("table")).not.toBeInTheDocument();
		expect(
			canvas.getByText("const name = '<em>world</em>';", { exact: true }),
		).toBeVisible();
		expect(
			canvas.getByText("const name = '<strong>universe</strong>';", {
				exact: true,
			}),
		).toBeVisible();
		expect(canvasElement.querySelector("em, strong")).toBeNull();
		await userEvent.click(canvas.getByRole("tab", { name: "Split" }));
		const table = await canvas.findByRole("table");
		const oldLine = within(table).getByText("const name = '<em>world</em>';", {
			exact: true,
		});
		const newLine = within(table).getByText(
			"const name = '<strong>universe</strong>';",
			{ exact: true },
		);
		expect(oldLine).toBeVisible();
		expect(newLine).toBeVisible();
		const row = oldLine.closest("tr");
		expect(newLine.closest("tr")).toBe(row);
		expect(
			Array.from(row?.querySelectorAll(".diff-marker") ?? [], (cell) =>
				cell.textContent?.trim(),
			),
		).toEqual(["-", "+"]);
		expect(
			Array.from(row?.querySelectorAll(".diff-ln") ?? [], (cell) =>
				cell.textContent?.trim(),
			),
		).toEqual(["1", "1"]);
		expect(table.querySelector("em, strong")).toBeNull();
	},
};

export const Hover: Story = {
	...AddOnly,
	parameters: { pseudo: { hover: true } },
};
