import type { Meta, StoryObj } from "@storybook/svelte-vite";
import CodeBlockHeader from "./CodeBlockHeader.svelte";

const meta = {
	title: "UI/CodeBlockHeader",
	component: CodeBlockHeader,
	tags: ["autodocs"],
	args: {
		filename: "src/lib/frontend/stores/unread.ts",
		additions: 9,
		deletions: 2,
		code: "export const unread = new Map<string, number>();",
	},
} satisfies Meta<typeof CodeBlockHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FileChanges: Story = {};
export const FileChangesLight: Story = { globals: { theme: "light" } };
export const LanguageOnly: Story = {
	args: {
		filename: undefined,
		additions: undefined,
		deletions: undefined,
		label: "typescript",
	},
};
export const LanguageOnlyLight: Story = {
	...LanguageOnly,
	globals: { theme: "light" },
};
