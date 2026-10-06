import { cleanup, render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ChatLayout renders 18 child components. Mock them all with an empty Svelte
// component so we can mount ChatLayout without pulling in the entire UI tree.

const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);
const wsLifecycleHarness = vi.hoisted(() => ({
	onAttachCallbacks: [] as Array<(slug: string) => void>,
	attachedSlugs: [] as string[],
	onSynchronizedCallbacks: [] as Array<(slug: string) => void>,
}));

// Layout components
vi.mock(
	"../../../src/lib/frontend/components/layout/Sidebar.svelte",
	() => import("../../helpers/SidebarStub.svelte"),
);
vi.mock(
	"../../../src/lib/frontend/components/layout/SessionBar.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/input/InputArea.svelte",
	emptyComponent,
);

// Chat components
vi.mock(
	"../../../src/lib/frontend/components/chat/MessageList.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/session/DeepSearch.svelte",
	emptyComponent,
);

// Overlay components
vi.mock(
	"../../../src/lib/frontend/components/ui/Dialog.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/ConnectOverlay.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/Banners.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/NotificationStack.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/ConfirmModal.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/ImageLightbox.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/QrModal.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/SettingsPanel.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/InfoPanels.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/overlays/RewindBanner.svelte",
	emptyComponent,
);

// Feature components
vi.mock(
	"../../../src/lib/frontend/components/todo/TodoOverlay.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/terminal/TerminalPanel.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/file/FileViewer.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/permissions/PermissionNotification.svelte",
	emptyComponent,
);

// Mock all stores EXCEPT router.svelte.ts (which must be real to test
// reactive dependencies on routerState.path).

vi.mock("../../../src/lib/frontend/stores/ws-listeners.js", () => ({
	onProjectAttached: vi.fn((callback: (slug: string) => void) => {
		wsLifecycleHarness.onAttachCallbacks.push(callback);
		return () => {};
	}),
}));
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	onNavigateToSession: vi.fn(),
	clearNavigateToSession: vi.fn(),
	initSWMessageListener: vi.fn(),
	reconcilePushActive: vi.fn(async () => {}),
}));

vi.mock(
	"../../../src/lib/frontend/transport/connection-status.svelte.js",
	() => ({
		getIsConnected: () => true,
		connectionState: { status: "connected", statusText: "" },
	}),
);

vi.mock("../../../src/lib/frontend/stores/chat.svelte.js", () => ({
	chatState: { streaming: false, processing: false, messages: [] },
	clearMessages: vi.fn(),
	registerClearMessagesHook: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/transcript.svelte.js", () => ({
	viewTranscript: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/project-settings.js", () => ({
	viewProjectSettings: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/stores/alerts.js", () => ({
	viewAlerts: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/stores/input-draft.js", () => ({
	viewInputDraft: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/session.svelte.js", () => ({
	setAttachedProject: vi.fn((slug: string) => {
		wsLifecycleHarness.attachedSlugs.push(slug);
	}),
	sessionState: {
		currentId: null,
		sessions: [],
		searchQuery: "",
		hasMore: false,
	},
	clearSessionState: vi.fn(),
	findSession: vi.fn(),
	loadDaemonSessions: vi.fn(async () => {}),
	switchToSession: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/session-list.svelte.js", () => ({
	attachSessionList: vi.fn(),
	detachSessionList: vi.fn(),
	onShellSynchronized: vi.fn((callback: (slug: string) => void) => {
		wsLifecycleHarness.onSynchronizedCallbacks.push(callback);
		return () => {};
	}),
	sessionList: { groups: [], settled: false, status: { _tag: "cold" } },
	currentSearchQuery: vi.fn(() => null),
	refreshSessionList: vi.fn(async () => {}),
}));

vi.mock("../../../src/lib/frontend/stores/approvals.js", () => ({
	attachApprovals: vi.fn(),
	detachApprovals: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/permissions.svelte.js", () => ({
	clearAllPermissions: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/terminal.svelte.js", () => ({
	terminalState: { panelOpen: false, unreadPtyIds: new Set() },
	destroyAll: vi.fn(),
	viewPtys: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/discovery.svelte.js", () => ({
	clearDiscoveryState: vi.fn(),
	applyGetAgentsResponse: vi.fn(),
	applyGetCommandsResponse: vi.fn(),
	applyGetModelsResponse: vi.fn(),
	discoveryState: { selectedInstanceId: null },
}));

vi.mock("../../../src/lib/frontend/stores/todo.svelte.js", () => ({
	todoState: { items: [] },
	clearTodoState: vi.fn(),
	viewTodos: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/session-family-feed.js", () => ({
	viewFamily: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/file-tree.svelte.js", () => ({
	applyGetFileTreeResponse: vi.fn(),
	requestFileTree: vi.fn(),
	clearFileTreeState: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	uiState: {
		sidebarCollapsed: false,
		sidebarWidth: 256,
		rewindActive: false,
		fileViewerOpen: false,
	},
	closeFileViewer: vi.fn(),
	showToast: vi.fn(),
	resetProjectUI: vi.fn(),
	setSidebarWidth: vi.fn(),
	SIDEBAR_MIN_WIDTH: 200,
	SIDEBAR_MAX_WIDTH: 400,
}));

vi.mock("../../../src/lib/frontend/stores/project.svelte.js", () => ({
	applyProjectList: vi.fn(),
	followDaemonLists: vi.fn(),
	getDraftProject: () => null,
	projectState: { projects: [] },
}));

vi.mock("../../../src/lib/frontend/stores/version.svelte.js", () => ({
	fetchCurrentVersion: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/feature-flags.svelte.js", () => ({
	featureFlags: {},
	initFeatureFlags: vi.fn(),
	toggleFeature: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/client-identity.js", () => ({
	getBrowserClientId: vi.fn(() => "browser-client-1"),
}));

vi.mock("../../../src/lib/frontend/transport/runtime.js", () => ({
	disposeRuntime: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	resolveSessionRpc: vi.fn(async () => ({
		projectSlug: "test-project" as string | null,
	})),
	attachProjectRpc: vi.fn(async () => ({
		projectSlug: null as string | null,
	})),
	listDaemonSessionsRpc: vi.fn(async () => ({
		sessions: [],
		availability: [],
		hasMore: false,
		nextCursor: null,
	})),
	getAgentsRpc: vi.fn(async () => {
		throw new Error("agents temporarily unavailable");
	}),
	getModelsRpc: vi.fn(async () => {
		throw new Error("models temporarily unavailable");
	}),
	getCommandsRpc: vi.fn(async () => {
		throw new Error("commands temporarily unavailable");
	}),
	getProjectsRpc: vi.fn(async () => ({
		projectSlug: "test-project",
		projects: [],
		current: "test-project",
	})),
	getFileTreeRpc: vi.fn(async () => ({
		projectSlug: "test-project",
		files: [],
	})),
}));

// Imports (after mocks)

import ChatLayout from "../../../src/lib/frontend/components/layout/ChatLayout.svelte";
import { clearMessages } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	attachedProjectState,
	replaceRoute,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	attachSessionList,
	detachSessionList,
} from "../../../src/lib/frontend/stores/session-list.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import { showToast } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { onProjectAttached } from "../../../src/lib/frontend/stores/ws-listeners.js";
import {
	attachProjectRpc,
	resolveSessionRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";

function attach(slug: string): void {
	attachedProjectState.slug = slug;
	wsLifecycleHarness.onAttachCallbacks[0]?.(slug);
}

describe("ChatLayout RPC lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		wsLifecycleHarness.onAttachCallbacks = [];
		wsLifecycleHarness.attachedSlugs = [];
		wsLifecycleHarness.onSynchronizedCallbacks = [];
		// Stub localStorage — the component reads terminal panel height from it
		// on mount, but the test environment may not provide a full Storage impl.
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => null),
			setItem: vi.fn(),
			removeItem: vi.fn(),
			clear: vi.fn(),
			length: 0,
			key: vi.fn(() => null),
		});
		routerState.path = "/";
		routerState.search = "";
		routerState.sessionNotFound = false;
		sessionState.currentId = null;
		sessionViewState.compact = false;
		vi.mocked(resolveSessionRpc).mockResolvedValue({
			projectSlug: "test-project",
		});
		attachedProjectState.slug = null;
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		// Reset router state so it doesn't leak between tests
		routerState.path = "/";
		attachedProjectState.slug = null;
		sessionViewState.compact = false;
	});

	it("does not toast when optional discovery RPCs fail after shell synchronization", async () => {
		render(ChatLayout);

		expect(onProjectAttached).toHaveBeenCalledTimes(1);
		attach("test-project");
		wsLifecycleHarness.onSynchronizedCallbacks[0]?.("test-project");
		await Promise.resolve();
		await Promise.resolve();

		expect(showToast).not.toHaveBeenCalledWith("Failed to load agents", {
			variant: "error",
		});
		expect(showToast).not.toHaveBeenCalledWith("Failed to load models", {
			variant: "error",
		});
		expect(showToast).not.toHaveBeenCalledWith("Failed to load commands", {
			variant: "error",
		});
	});

	it("attaches the shell feed on project attach", async () => {
		render(ChatLayout);

		attach("test-project");
		expect(attachSessionList).toHaveBeenCalledExactlyOnceWith("test-project");
	});

	it("resolves a session within the attached project", async () => {
		render(ChatLayout);
		attach("test-project");
		replaceRoute("/s/ses_abc123");
		flushSync();
		await tick();
		expect(resolveSessionRpc).toHaveBeenCalledExactlyOnceWith({
			sessionId: "ses_abc123",
			projectSlug: "test-project",
		});
		expect(switchToSession).toHaveBeenCalledExactlyOnceWith(
			"ses_abc123",
			"test-project",
		);
	});

	it("switches sessions across projects and resets before hydrating the attach", async () => {
		render(ChatLayout);
		attach("test-project");
		vi.clearAllMocks();
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "other-project",
		});
		replaceRoute("/s/session-b");
		flushSync();
		await tick();
		expect(switchToSession).toHaveBeenCalledExactlyOnceWith(
			"session-b",
			"other-project",
		);
		expect(clearMessages).not.toHaveBeenCalled();
		expect(attachSessionList).not.toHaveBeenCalled();
		attach("other-project");
		expect(clearMessages).toHaveBeenCalledTimes(1);
		expect(clearSessionState).toHaveBeenCalledTimes(1);
		expect(attachSessionList).toHaveBeenCalledExactlyOnceWith("other-project");
		expect(
			vi.mocked(clearSessionState).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(attachSessionList).mock.invocationCallOrder[0] ?? 0,
		);
		flushSync();
		await tick();
		expect(attachSessionList).toHaveBeenCalledTimes(1);
	});

	it("resolves a cold session link before selecting it", async () => {
		routerState.path = "/s/cold-session";
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "other-project",
		});
		render(ChatLayout);
		attach("test-project");
		await vi.waitFor(() =>
			expect(switchToSession).toHaveBeenCalledExactlyOnceWith(
				"cold-session",
				"other-project",
			),
		);
		expect(resolveSessionRpc).toHaveBeenCalledExactlyOnceWith({
			sessionId: "cold-session",
			projectSlug: "test-project",
		});
		expect(
			vi.mocked(resolveSessionRpc).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(switchToSession).mock.invocationCallOrder[0] ?? 0);
	});

	it("resolves and selects history navigation across projects", async () => {
		render(ChatLayout);
		attach("test-project");
		sessionState.currentId = "session-a";
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "other-project",
		});
		window.history.pushState(null, "", "/s/session-b");
		window.dispatchEvent(new PopStateEvent("popstate"));
		flushSync();
		await vi.waitFor(() =>
			expect(switchToSession).toHaveBeenLastCalledWith(
				"session-b",
				"other-project",
			),
		);
		sessionState.currentId = "session-b";
		attach("other-project");
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "test-project",
		});
		window.history.replaceState(null, "", "/s/session-a");
		window.dispatchEvent(new PopStateEvent("popstate"));
		flushSync();
		await vi.waitFor(() =>
			expect(switchToSession).toHaveBeenLastCalledWith(
				"session-a",
				"test-project",
			),
		);
		expect(resolveSessionRpc).toHaveBeenCalledTimes(2);
	});

	it("does not resolve or select a session at the list front door", async () => {
		render(ChatLayout);
		attach("test-project");
		flushSync();
		await tick();
		expect(resolveSessionRpc).not.toHaveBeenCalled();
		expect(switchToSession).not.toHaveBeenCalled();
		expect(sessionState.currentId).toBeNull();
	});

	it("uses the route-driven full-screen list layout on compact viewports", () => {
		sessionViewState.compact = true;
		const { container } = render(ChatLayout);

		const layout = container.querySelector("#layout");
		expect(layout?.classList.contains("layout-compact")).toBe(true);
		expect(layout?.classList.contains("phone-list-screen")).toBe(true);
		expect(container.querySelector("#sidebar")).not.toBeNull();

		replaceRoute("/s/session-a");
		flushSync();
		expect(layout?.classList.contains("layout-compact")).toBe(true);
		expect(layout?.classList.contains("phone-list-screen")).toBe(false);
		expect(container.querySelector("#sidebar")).not.toBeNull();
	});

	it("restores the compact session list scroll position after returning", async () => {
		sessionViewState.compact = true;
		const { container } = render(ChatLayout);
		const scroller = container.querySelector<HTMLElement>(
			"#session-list-scroller",
		);
		expect(scroller).not.toBeNull();
		if (!scroller) return;

		scroller.scrollTop = 84;
		replaceRoute("/s/session-a");
		flushSync();
		await tick();
		scroller.scrollTop = 0;

		replaceRoute("/");
		flushSync();
		await tick();
		expect(scroller.scrollTop).toBe(84);
	});

	it("clears the selected session when returning to the list", async () => {
		sessionState.currentId = "session-a";
		routerState.path = "/s/session-a";
		render(ChatLayout);
		replaceRoute("/");
		flushSync();
		await tick();
		expect(sessionState.currentId).toBeNull();
		expect(switchToSession).not.toHaveBeenCalled();
	});

	it("returns an unknown session to the list with a dismissible notice", async () => {
		routerState.path = "/s/missing-session";
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({ projectSlug: null });
		render(ChatLayout);
		attach("test-project");
		await vi.waitFor(() => expect(routerState.path).toBe("/"));
		expect(routerState.sessionNotFound).toBe(true);
		expect(switchToSession).not.toHaveBeenCalled();
		expect(sessionState.currentId).toBeNull();
	});

	it("ignores a late missing-session result after navigation elsewhere", async () => {
		let resolveMissing:
			| ((value: { projectSlug: string | null }) => void)
			| undefined;
		vi.mocked(resolveSessionRpc).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveMissing = resolve;
				}),
		);
		routerState.path = "/s/missing-session";
		render(ChatLayout);
		attach("test-project");
		flushSync();
		await vi.waitFor(() => expect(resolveMissing).toBeDefined());
		replaceRoute("/s/next-session");
		flushSync();
		await tick();
		resolveMissing?.({ projectSlug: null });
		await tick();
		expect(routerState.path).toBe("/s/next-session");
		expect(routerState.sessionNotFound).toBe(false);
	});

	it("keeps the /ws bootstrap that lands before the first attach reply", () => {
		render(ChatLayout);
		attach("test-project");
		expect(clearMessages).not.toHaveBeenCalled();
		expect(attachSessionList).toHaveBeenCalledExactlyOnceWith("test-project");
	});

	it("attaches again after a remount, which keeps the previous slug", async () => {
		render(ChatLayout).unmount();
		attachedProjectState.slug = "test-project";
		vi.clearAllMocks();
		vi.mocked(attachProjectRpc).mockResolvedValueOnce({
			projectSlug: "test-project",
		});
		render(ChatLayout);
		await tick();
		expect(attachProjectRpc).toHaveBeenCalledExactlyOnceWith({
			originId: "browser-client-1",
		});
		expect(wsLifecycleHarness.attachedSlugs.at(-1)).toBe("test-project");
	});

	it("rehydrates once on a reconnect attach to the same project without resetting", () => {
		render(ChatLayout);
		attach("test-project");
		vi.clearAllMocks();
		attach("test-project");
		expect(clearMessages).not.toHaveBeenCalled();
		expect(attachSessionList).toHaveBeenCalledTimes(1);
	});

	it("uses AttachProject for project-only navigation without reconnecting", async () => {
		render(ChatLayout);
		attach("test-project");
		vi.mocked(attachProjectRpc).mockClear();
		replaceRoute("/?p=other-project");
		flushSync();
		await tick();
		expect(attachProjectRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "other-project",
			originId: "browser-client-1",
		});
		expect(switchToSession).not.toHaveBeenCalled();
	});

	it("attaches the cold-load project from the AttachProject reply", async () => {
		vi.mocked(attachProjectRpc).mockResolvedValueOnce({
			projectSlug: "daemon-default",
		});
		render(ChatLayout);
		await tick();
		expect(attachProjectRpc).toHaveBeenCalledExactlyOnceWith({
			originId: "browser-client-1",
		});
		expect(wsLifecycleHarness.attachedSlugs).toEqual(["daemon-default"]);
	});

	it("can select a project before the socket has attached to one", async () => {
		render(ChatLayout);
		replaceRoute("/?p=first-project");
		flushSync();
		await tick();
		expect(attachProjectRpc).toHaveBeenLastCalledWith({
			projectSlug: "first-project",
			originId: "browser-client-1",
		});
	});

	it("cancels a pending project switch when navigating back to the attached project", async () => {
		render(ChatLayout);
		attach("test-project");
		vi.mocked(attachProjectRpc).mockClear();
		vi.mocked(attachProjectRpc).mockReturnValueOnce(new Promise(() => {}));
		replaceRoute("/?p=other-project");
		flushSync();
		await tick();
		replaceRoute("/?p=test-project");
		flushSync();
		await tick();
		expect(attachProjectRpc).toHaveBeenLastCalledWith({
			projectSlug: "test-project",
			originId: "browser-client-1",
		});
	});

	it("detaches the shell feed on unmount", () => {
		const { unmount } = render(ChatLayout);
		unmount();
		expect(detachSessionList).toHaveBeenCalledTimes(1);
	});
});
