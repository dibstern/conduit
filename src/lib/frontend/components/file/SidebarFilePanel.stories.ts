import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
	applyGetFileTreeResponse,
	clearFileTreeState,
} from "../../stores/file-tree.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import {
	applyGetFileListResponse,
	fileBrowserListeners,
} from "../../stores/ws-listeners.js";
import { mockFileTree } from "../../stories/mocks.js";
import SidebarFilePanel from "./SidebarFilePanel.svelte";

async function showDirectory(
	path: string,
	entries: ReadonlyArray<{
		name: string;
		type: "file" | "directory";
		size?: number;
	}>,
	root?: string,
): Promise<void> {
	await waitFor(() => {
		expect(fileBrowserListeners.size).toBeGreaterThan(0);
	});
	applyGetFileListResponse({
		projectSlug: "storybook",
		path,
		entries,
		...(root ? { root } : {}),
	});
}

const meta = {
	title: "File/SidebarFilePanel",
	component: SidebarFilePanel,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		routerState.path = "/";
		clearFileTreeState();
	},
} satisfies Meta<typeof SidebarFilePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Populated: Story = {
	play: async ({ canvasElement }) => {
		await showDirectory(".", mockFileTree);
		await within(canvasElement).findByText("README.md");
	},
};

export const WorktreeFiles: Story = {
	play: async ({ canvasElement }) => {
		await showDirectory(".", [
			{ name: ".gitignore", type: "file" },
			{ name: "worktree-only.txt", type: "file", size: 42 },
		]);
		await within(canvasElement).findByText("worktree-only.txt");
		expect(within(canvasElement).queryByText("main-only.txt")).toBeNull();
	},
};

export const LabelledFolders: Story = {
	play: async ({ canvasElement }) => {
		applyGetFileTreeResponse({
			projectSlug: "storybook",
			entries: [],
			roots: [
				{ root: "/workspace/web", label: "web" },
				{ root: "/workspace/api", label: "api" },
			],
		});
		await showDirectory(
			".",
			[
				{ name: "src", type: "directory" },
				{ name: "README.md", type: "file" },
			],
			"/workspace/web",
		);
		await showDirectory(
			".",
			[
				{ name: "server.ts", type: "file" },
				{ name: "package.json", type: "file" },
			],
			"/workspace/api",
		);
		const canvas = within(canvasElement);
		for (const name of ["web", "api"]) {
			const button = await canvas.findByRole("button", { name });
			const chevron = button.querySelector<SVGElement>(".fb-chevron");
			if (chevron) chevron.style.transition = "none";
			await userEvent.click(button);
		}
		await expect(canvas.getByText("README.md")).toBeVisible();
		await expect(canvas.getByText("server.ts")).toBeVisible();
	},
};

export const ExpandedDirectory: Story = {
	play: async ({ canvasElement }) => {
		await showDirectory(".", mockFileTree);
		await showDirectory("src", [
			{ name: "components", type: "directory" },
			{ name: "main.ts", type: "file", size: 2_418 },
			{ name: "utils.ts", type: "file", size: 1_024 },
		]);
		const srcButton = await within(canvasElement).findByRole("button", {
			name: "src",
		});
		const chevron = srcButton.querySelector<SVGElement>(".fb-chevron");
		if (chevron) chevron.style.transition = "none";
		await userEvent.click(srcButton);
		await within(canvasElement).findByText("main.ts");
	},
};

export const ExpandedDirectoryLoading: Story = {
	play: async ({ canvasElement }) => {
		await showDirectory(".", mockFileTree);
		const srcButton = await within(canvasElement).findByRole("button", {
			name: "src",
		});
		const chevron = srcButton.querySelector<SVGElement>(".fb-chevron");
		if (chevron) chevron.style.transition = "none";
		await userEvent.click(srcButton);
		await within(canvasElement).findByText("Loading…");
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
