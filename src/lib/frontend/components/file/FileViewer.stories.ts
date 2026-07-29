import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, waitFor } from "storybook/test";
import { fileBrowserListeners } from "../../stores/ws.svelte.js";
import { applyGetFileContentResponse } from "../../stores/ws-dispatch.js";
import { mockFileContent } from "../../stories/mocks.js";
import FileViewerHost from "./__fixtures__/FileViewerHost.svelte";

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
	component: FileViewerHost,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	args: {
		visible: true,
		onClose: fn(),
	},
	beforeEach: () => {
		localStorage.removeItem("file-viewer-font-size");
	},
} satisfies Meta<typeof FileViewerHost>;

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

		// The notice is the last child of the scroll region, so at rest it sits ~25k
		// pixels below the fold and the baseline would depict an ordinary file.
		// Scroll to it: the truncated state is the only thing this story exists for.
		const scroller = canvasElement.querySelector(".fv-code")?.parentElement;
		expect(scroller).not.toBeNull();
		scroller?.scrollTo({ top: scroller.scrollHeight });
		await waitFor(() => {
			expect(scroller?.scrollTop).toBeGreaterThan(0);
		});
	},
};
