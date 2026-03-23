import type { Meta, StoryObj } from "@storybook/svelte-vite";
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
			"const name = 'world';\n\nfunction greet(who: string) {\n  return `Hello, ${who}!`;\n}\n\nconsole.log(greet(name));",
		newText:
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal in code sample
			"const name = 'universe';\nconst greeting = 'Hi';\n\nfunction greet(who: string, prefix: string) {\n  return `${prefix}, ${who}!`;\n}\n\nconsole.log(greet(name, greeting));",
		filename: "src/greet.ts",
	},
};
