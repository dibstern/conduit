import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, waitFor } from "storybook/test";
import { fileBrowserListeners } from "../../stores/ws.svelte.js";
import { applyGetFileContentResponse } from "../../stores/ws-dispatch.js";
import { mockFileContent } from "../../stories/mocks.js";
import FileViewer from "./FileViewer.svelte";

const truncatedFileContent = "export const migrationBaseline = true;\n".repeat(
	1_500,
);

async function showFile(response: {
	path: string;
	content: string;
	binary?: boolean;
}): Promise<void> {
	await waitFor(() => {
		expect(fileBrowserListeners.size).toBeGreaterThan(0);
	});
	applyGetFileContentResponse({
		projectSlug: "storybook",
		...response,
	});
}

const meta = {
	title: "File/FileViewer",
	component: FileViewer,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	args: {
		visible: true,
		onClose: fn(),
	},
	beforeEach: () => {
		localStorage.removeItem("file-viewer-font-size");
	},
} satisfies Meta<typeof FileViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await showFile({
			path: "src/lib/project.ts",
			content: mockFileContent,
		});
		await waitFor(() => {
			expect(canvasElement.querySelector("code.hljs")).not.toBeNull();
		});
	},
};

export const BinaryFile: Story = {
	play: async ({ canvasElement }) => {
		await showFile({
			path: "assets/conduit-icon.png",
			content: "",
			binary: true,
		});
		await waitFor(() => {
			expect(canvasElement.querySelector("#file-viewer")).not.toBeNull();
		});
	},
};

export const TruncatedFile: Story = {
	play: async ({ canvasElement }) => {
		await showFile({
			path: "logs/daemon.ts",
			content: truncatedFileContent,
		});
		await waitFor(() => {
			expect(canvasElement.querySelector("code.hljs")).not.toBeNull();
			expect(canvasElement.textContent).toContain(
				"File truncated — showing first 50 KB",
			);
		});
	},
};
