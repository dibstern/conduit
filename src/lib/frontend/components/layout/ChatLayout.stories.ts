import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
	applyGetModelsResponse,
	clearDiscoveryState,
	handleDefaultModelInfo,
	handleHarnessDefaults,
	handleModelList,
} from "../../stores/discovery.svelte.js";
import {
	clearFileTreeState,
	fileTreeState,
} from "../../stores/file-tree.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../stores/router.svelte.js";
import {
	sessionViewState,
	setFilesOpen,
	setFilesPaneWidth,
} from "../../stores/session-view.svelte.js";
import { setThemeMode } from "../../stores/theme.svelte.js";
import { openFileViewer, uiState } from "../../stores/ui.svelte.js";
import {
	applyGetFileContentResponse,
	applyGetFileListResponse,
} from "../../stores/ws-listeners.js";
import {
	mockClaudeAccount,
	mockFileContent,
	mockFileTree,
} from "../../stories/mocks.js";
import { connectedSocket, failRpc } from "../../stories/sockets.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import { loadHighlighter } from "../../utils/load-highlighter.js";
import ChatLayout from "./ChatLayout.svelte";

const claudeModel = {
	id: "claude-sonnet-5",
	name: "Sonnet 5",
	provider: "claude",
};

const claudeProvider = {
	id: "claude",
	name: "Claude",
	configured: true,
	models: [claudeModel],
};

/**
 * A deliberately fake version string, not the one from package.json. It renders
 * in the sidebar footer, so reading the real version would rebake the version
 * number into every baseline here and break them all on the next release bump.
 */
const STUB_VERSION = "0.0.0-storybook";

/**
 * Connecting is not enough to get off the network: ChatLayout also fetches the
 * relay status and the daemon version. Both are left unstubbed by default, which
 * the network guard rejects — see its message for why a racing request makes a
 * baseline platform-dependent.
 */
function stubProjectFetches(): () => void {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const body = url.endsWith("/info")
			? { version: STUB_VERSION }
			: url.endsWith("/api/status")
				? { status: "ready" }
				: null;
		return body
			? Promise.resolve(
					new Response(JSON.stringify(body), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
			: Promise.reject(new TypeError("Failed to fetch"));
	};
	return () => {
		globalThis.fetch = realFetch;
	};
}

const meta = {
	title: "Layout/ChatLayout",
	component: ChatLayout,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset state for each story
		uiState.sidebarCollapsed = false;
		uiState.rewindActive = false;
		uiState.fileViewerOpen = false;
		uiState.fileViewerPath = null;
		sessionViewState.filesOpen = false;
		sessionViewState.filesPaneExpanded = false;
		sessionViewState.filesPaneWidth = null;
		clearFileTreeState();
		routerState.path = "/";
		routerState.search = "?p=test-project";
		attachedProjectState.slug = null;
		// The fake socket answers no queries, so seed what the server would send:
		// the project list, a loaded account with its models, the model a new
		// session starts on, and an empty, settled session list.
		const projects = projectState.projects;
		const { instances, loaded } = instanceState;
		projectState.projects = [
			{ slug: "test-project", title: "test-project", folders: ["/src/test"] },
		];
		instanceState.instances = [mockClaudeAccount];
		instanceState.loaded = true;
		handleModelList({ providers: [claudeProvider] });
		handleDefaultModelInfo({ model: claudeModel.id, provider: "claude" });
		handleHarnessDefaults({
			_tag: "harnessDefaults",
			claude: {
				status: "ok",
				pick: {
					providerId: "claude",
					modelId: claudeModel.id,
					effort: "",
					contextWindow: "",
				},
			},
		});
		applySessionChange({ _tag: "snapshot", rows: [], sequence: Date.now() });
		applySessionChange({ _tag: "synchronized" });
		// Static Storybook hosting needs a socket that completes its connection.
		const restoreSocket = connectedSocket("test-project");
		const restoreFetch = stubProjectFetches();
		return () => {
			restoreFetch();
			restoreSocket();
			projectState.projects = projects;
			instanceState.instances = instances;
			instanceState.loaded = loaded;
			clearDiscoveryState();
			attachedProjectState.slug = null;
			routerState.search = "";
		};
	},
} satisfies Meta<typeof ChatLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Guards the whole file. The overlay is `fixed inset-0 bg-bg`, so while it is
 * mounted the screenshot shows nothing but the overlay — and a screenshot of the
 * overlay is perfectly stable, which is precisely why this went unnoticed.
 * Asserting its absence is the difference between "the capture succeeded" and
 * "the capture is of this component".
 */
const expectLayoutVisible: NonNullable<Story["play"]> = async ({
	canvasElement,
}) => {
	await waitFor(
		() => {
			expect(
				canvasElement.querySelector("#connect-overlay"),
				"ConnectOverlay never went away — this baseline is a picture of the overlay, not of ChatLayout",
			).toBeNull();
		},
		// The overlay fades for CONNECT_FADEOUT_MS (600ms) after connecting before
		// it unmounts, which is longer than waitFor's default budget.
		{ timeout: 5000 },
	);
	expect(canvasElement.querySelector("#app")).not.toBeNull();
};

/** On a phone, `/` is the session list screen: the list fills the viewport. */
export const Default: Story = {
	play: async (context) => {
		await expectLayoutVisible(context);
		await waitFor(() => {
			expect(context.canvasElement.textContent).toContain(
				"No sessions in test-project",
			);
			// A new session starts on the project's default model.
			expect(context.canvasElement.textContent).not.toContain("Select model");
		});
		if (window.innerWidth >= 768) return;
		const body = within(context.canvasElement.ownerDocument.body);
		const settings = body.getByTestId("list-bar-settings");
		await expect(settings.getBoundingClientRect().width).toBe(44);
		await expect(settings.getBoundingClientRect().height).toBe(44);
		await userEvent.click(settings);
		await expect(body.getByRole("dialog", { name: "Settings" })).toBeVisible();
		await expect(body.getByTestId("avatar-change-root")).toBeVisible();
		await userEvent.click(body.getByTestId("settings-close-btn"));
		await waitFor(() =>
			expect(body.queryByRole("dialog", { name: "Settings" })).toBeNull(),
		);
		(
			context.canvasElement.ownerDocument.activeElement as HTMLElement | null
		)?.blur();
	},
};

/**
 * The stories below open a session, because on a phone both states belong to the
 * session screen; left on `/` they would render the list screen, identical to
 * Default.
 */
const SESSION_PATH = "/s/story-session";

/**
 * Routes to a session whose row names an account the composer knows, with the
 * model the server would report for it; the fake socket opens its transcript
 * empty and settled.
 */
function openStorySession(): void {
	routerState.path = SESSION_PATH;
	applySessionChange({
		_tag: "snapshot",
		sequence: Date.now(),
		rows: [
			{
				id: "story-session",
				accountId: mockClaudeAccount.id,
				title: "Story session",
				status: "idle",
				projectSlug: "test-project",
			},
		],
	});
	applySessionChange({ _tag: "synchronized" });
	applyGetModelsResponse(
		{
			projectSlug: "test-project",
			instanceId: mockClaudeAccount.id,
			providers: [claudeProvider],
			active: { model: claudeModel.id, provider: "claude" },
		},
		"story-session",
	);
}

/**
 * A session that fails to attach redirects to `/` with a toast, which still
 * passes expectLayoutVisible; assert the session's own transcript instead.
 */
const expectSessionVisible: NonNullable<Story["play"]> = async (context) => {
	await expectLayoutVisible(context);
	await waitFor(() => {
		expect(routerState.path).toBe(SESSION_PATH);
		expect(context.canvasElement.textContent).toContain("Beginning of session");
	});
};

export const SidebarCollapsed: Story = {
	beforeEach: () => {
		uiState.sidebarCollapsed = true;
		openStorySession();
	},
	play: expectSessionVisible,
};

export const PhoneTopColour: Story = {
	...SidebarCollapsed,
	beforeEach: () => {
		const compact = sessionViewState.compact;
		uiState.sidebarCollapsed = true;
		openStorySession();
		return () => {
			sessionViewState.compact = compact;
		};
	},
	parameters: { viewport: { defaultViewport: "mobile1" } },
	play: async (context) => {
		await expectSessionVisible(context);
		sessionViewState.compact = true;
		await waitFor(() => {
			const strip = context.canvasElement.querySelector("#compact-top-edge");
			const bar = context.canvasElement.querySelector("#session-bar");
			expect(strip).not.toBeNull();
			expect(bar).not.toBeNull();
			if (!strip || !bar) return;
			for (const theme of ["dark", "light"] as const) {
				setThemeMode(theme);
				const colour = getComputedStyle(strip).backgroundColor;
				expect(getComputedStyle(bar).backgroundColor).toBe(colour);
				const meta = document.querySelector<HTMLMetaElement>(
					'meta[name="theme-color"]',
				);
				const resolved = new Option().style;
				resolved.color = meta?.content ?? "";
				expect(resolved.color).toBe(colour);
			}
		});
		setThemeMode(context.globals["theme"] === "light" ? "light" : "dark");
	},
};

/**
 * Rewind mode is activated AFTER mount, not in `beforeEach`. ChatLayout's connect
 * effect calls `resetProjectUI()`, which sets `rewindActive` back to false, so a
 * value seeded before render is wiped before the first paint — which is why this
 * story's baseline was byte-identical to Default's even after the ConnectOverlay
 * fix. `sidebarCollapsed` survives the same path only because `resetProjectUI()`
 * does not touch it.
 */
export const WithRewindBanner: Story = {
	beforeEach: () => {
		openStorySession();
	},
	play: async (context) => {
		await expectSessionVisible(context);
		// The banner and transcript use web fonts; capture after they settle.
		await document.fonts.ready;
		uiState.rewindActive = true;
		await waitFor(() => {
			expect(
				context.canvasElement.querySelector(".rewind-banner"),
				"rewind banner never rendered — this baseline is indistinguishable from Default",
			).not.toBeNull();
		});
	},
};

async function showFilesTree(
	context: Parameters<NonNullable<Story["play"]>>[0],
): Promise<void> {
	await expectSessionVisible(context);
	// The isolated layout has no selection runtime to establish a file scope.
	fileTreeState.scope = "storybook:test-project";
	setFilesOpen(true);
	// The pane mounts before its lazily imported panel, which is what listens
	// for the listing.
	await waitFor(() => {
		expect(
			context.canvasElement.querySelector("#sidebar-panel-files"),
		).not.toBeNull();
	});
	applyGetFileListResponse({
		projectSlug: "test-project",
		path: ".",
		entries: mockFileTree,
	});
	await waitFor(() => {
		expect(context.canvasElement.textContent).toContain("README.md");
	});
}

export const FilesTree: Story = {
	beforeEach: () => {
		openStorySession();
	},
	play: showFilesTree,
};

export const FilesPreview: Story = {
	beforeEach: () => {
		openStorySession();
	},
	play: async (context) => {
		await loadHighlighter();
		await showFilesTree(context);
		openFileViewer("src/lib/project.ts");
		await waitFor(
			() => {
				expect(
					context.canvasElement.querySelector("#file-viewer"),
					"file preview mounted with its workspace scope",
				).not.toBeNull();
			},
			{ timeout: 5000 },
		);
		applyGetFileContentResponse({
			projectSlug: "test-project",
			path: "src/lib/project.ts",
			content: mockFileContent,
		});
		await waitFor(
			() => {
				expect(
					context.canvasElement.querySelector("#file-viewer code.hljs"),
					"file content was received and highlighted",
				).not.toBeNull();
				expect(
					context.canvasElement
						.querySelector("#files-pane-title + span[title]")
						?.getAttribute("title"),
				).toBe("src/lib/project.ts");
			},
			{ timeout: 5000 },
		);
	},
};

export const FilesPreviewError: Story = {
	beforeEach: () => {
		openStorySession();
	},
	play: async (context) => {
		await showFilesTree(context);
		const restoreRpc = failRpc("GetFileContent");
		try {
			openFileViewer("src/lib/missing.ts");
			await waitFor(
				() => {
					expect(
						context.canvasElement.querySelector('#file-viewer [role="alert"]'),
					).not.toBeNull();
				},
				{ timeout: 5000 },
			);
		} finally {
			restoreRpc();
		}
	},
};

export const FilesExpanded: Story = {
	beforeEach: () => {
		openStorySession();
	},
	play: async (context) => {
		await showFilesTree(context);
		sessionViewState.filesPaneExpanded = true;
		await waitFor(() => {
			expect(
				context.canvasElement
					.querySelector("#files-pane-expand")
					?.getAttribute("aria-pressed"),
			).toBe("true");
		});
	},
};

export const FilesForcedExpanded: Story = {
	beforeEach: () => {
		openStorySession();
	},
	play: async (context) => {
		context.canvasElement.style.width = "800px";
		setFilesPaneWidth(400);
		await showFilesTree(context);
		await waitFor(() => {
			expect(
				context.canvasElement
					.querySelector("#files-pane-expand")
					?.getAttribute("aria-label"),
			).toBe("Not enough room to show chat beside Files");
		});
	},
};
