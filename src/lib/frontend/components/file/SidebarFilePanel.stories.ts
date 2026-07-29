import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { routerState, syncSlugState } from "../../stores/router.svelte.js";
import { fileBrowserListeners } from "../../stores/ws.svelte.js";
import { applyGetFileListResponse } from "../../stores/ws-dispatch.js";
import { mockFileTree } from "../../stories/mocks.js";
import SidebarFilePanel from "./SidebarFilePanel.svelte";

async function showDirectory(
	path: string,
	entries: ReadonlyArray<{
		name: string;
		type: "file" | "directory";
		size?: number;
	}>,
): Promise<void> {
	await waitFor(() => {
		expect(fileBrowserListeners.size).toBeGreaterThan(0);
	});
	applyGetFileListResponse({
		projectSlug: "storybook",
		path,
		entries,
	});
}

const meta = {
	title: "File/SidebarFilePanel",
	component: SidebarFilePanel,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		routerState.path = "/";
		syncSlugState("/");
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
