import type { Meta, StoryObj } from "@storybook/svelte-vite";
import FileTreeNode from "./FileTreeNode.svelte";

const meta = {
	title: "File/FileTreeNode",
	component: FileTreeNode,
	tags: ["autodocs"],
} satisfies Meta<typeof FileTreeNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FileNode: Story = {
	args: {
		entry: { name: "main.ts", type: "file", size: 2048 },
	},
};

export const DirectoryNode: Story = {
	args: {
		entry: {
			name: "src",
			type: "directory",
			children: [
				{ name: "index.ts", type: "file", size: 1024 },
				{ name: "utils.ts", type: "file", size: 512 },
				{
					name: "components",
					type: "directory",
					children: [{ name: "App.svelte", type: "file", size: 3072 }],
				},
			],
		},
	},
};

export const HiddenFile: Story = {
	args: {
		entry: { name: ".env", type: "file", size: 256 },
	},
};

export const CollapsedByDefault: Story = {
	args: {
		entry: {
			name: "node_modules",
			type: "directory",
			children: [{ name: "svelte", type: "directory", children: [] }],
		},
	},
};

export const NestedDepth: Story = {
	args: {
		entry: { name: "deep-file.ts", type: "file", size: 100 },
		depth: 3,
	},
};
