import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
	clearFileTreeState,
	fileTreeState,
} from "../../stores/file-tree.svelte.js";
import { attachedProjectState } from "../../stores/router.svelte.js";
import { closeFileViewer, openFileViewer } from "../../stores/ui.svelte.js";
import {
	applyGetFileContentResponse,
	fileBrowserListeners,
} from "../../stores/ws-listeners.js";
import { mockFileContent } from "../../stories/mocks.js";
import { connectedSocket } from "../../stories/sockets.js";
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
	parameters: { layout: "fullscreen", a11y: { test: "error" } },
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

export const Loading: Story = {
	beforeEach: () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = fn(async (input: RequestInfo | URL) => {
			if (String(input) !== "/p/storybook/api/status")
				throw new TypeError(`Unexpected story request: ${String(input)}`);
			return Response.json({ status: "ready" });
		});
		const restoreSocket = connectedSocket();
		const previousProject = attachedProjectState.slug;
		attachedProjectState.slug = "storybook";
		clearFileTreeState();
		fileTreeState.scope = "storybook";
		openFileViewer("src/lib/project.ts");
		return () => {
			restoreSocket();
			globalThis.fetch = realFetch;
			attachedProjectState.slug = previousProject;
			closeFileViewer();
			clearFileTreeState();
		};
	},
	play: async ({ canvasElement }) => {
		await waitFor(() =>
			expect(globalThis.fetch).toHaveBeenCalledWith("/p/storybook/api/status"),
		);
		await expect(
			await within(canvasElement).findByText("Loading…"),
		).toBeVisible();
		const glyph = canvasElement.querySelector('[data-flow-glyph="running"]');
		await expect(glyph).toBeVisible();
		await expect(glyph?.getBoundingClientRect().width).toBe(32);
		await expect(glyph?.getBoundingClientRect().height).toBe(32);
	},
};

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

export const BackToFileTree: Story = {
	play: async ({ canvasElement, args }) => {
		await showFile({
			path: "src/lib/project.ts",
			content: mockFileContent,
		});
		await waitFor(() => {
			expect(canvasElement.querySelector("code.hljs")).not.toBeNull();
		});
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: "File browser" }),
		);
		await expect(args["onClose"]).toHaveBeenCalled();
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
		// Wait for fonts first: a late swap grows the content after the scroll and
		// leaves some captures a pixel short of the bottom.
		const scroller = canvasElement.querySelector(".fv-code")?.parentElement;
		expect(scroller).not.toBeNull();
		await document.fonts.ready;
		scroller?.scrollTo({ top: scroller.scrollHeight });
		await waitFor(() => {
			expect(scroller?.scrollTop).toBeGreaterThan(0);
		});
	},
};
