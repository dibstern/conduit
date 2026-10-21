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
	"../../../src/lib/frontend/components/session/TaskDrawer.svelte",
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

vi.mock("../../../src/lib/frontend/stores/selection.svelte.js", async () => {
	const { getCurrentRoute } = await import(
		"../../../src/lib/frontend/stores/router.svelte.js"
	);
	return {
		watchSelection: vi.fn(() => () => {}),
		selection: {
			open: vi.fn(),
			get shown() {
				const route = getCurrentRoute();
				return route.page === "chat" && route.sessionId
					? { kind: "placing", sessionId: route.sessionId }
					: { kind: "none" };
			},
		},
	};
});

vi.mock("../../../src/lib/frontend/stores/ws-listeners.js", () => ({
	onProjectAttached: vi.fn((callback: (slug: string) => void) => {
		wsLifecycleHarness.onAttachCallbacks.push(callback);
		return () => {};
	}),
}));
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
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
	localSendsIn: () => [],
	registerClearMessagesHook: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/transcript.svelte.js", async () => {
	const { sessionState } = await import(
		"../../../src/lib/frontend/stores/session.svelte.js"
	);
	return {
		viewTranscript: vi.fn(),
		drawSavedTranscript: vi.fn(),
		placeSavedDraw: vi.fn(),
		leaveSavedDraw: vi.fn(),
		placedSessionId: () => sessionState.currentId,
		savedDraw: { sessionId: null },
	};
});

vi.mock("../../../src/lib/frontend/stores/saved-transcripts.js", () => ({
	openSavedTranscript: vi.fn(() => Promise.resolve(undefined)),
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
}));

vi.mock("../../../src/lib/frontend/stores/session-list.svelte.js", () => ({
	attachSessionList: vi.fn(),
	detachSessionList: vi.fn(),
	onShellSynchronized: vi.fn(() => () => {}),
	sessionList: { groups: [], settled: false, status: { _tag: "cold" } },
	currentSearchQuery: vi.fn(() => null),
}));

vi.mock("../../../src/lib/frontend/stores/approvals.js", () => ({
	attachApprovals: vi.fn(),
	detachApprovals: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/permissions.svelte.js", () => ({
	clearAllPermissions: vi.fn(),
}));

// These layout tests set compact state directly. The breakpoint listener has
// its own coverage in session-view-compact.test.ts.
vi.mock(
	"../../../src/lib/frontend/stores/session-view.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/stores/session-view.svelte.js")
		>()),
		watchCompactViewport: vi.fn(() => () => {}),
	}),
);

vi.mock("../../../src/lib/frontend/stores/terminal.svelte.js", () => ({
	terminalState: { panelOpen: false, unreadPtyIds: new Set() },
	destroyAll: vi.fn(),
	viewPtys: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/discovery.svelte.js", () => ({
	clearDiscoveryState: vi.fn(),
	watchCatalogs: vi.fn(() => () => {}),
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
	fileTreeState: { scope: null, loading: false },
}));

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	uiState: {
		openPanels: new Set<string>(),
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
	runTransportEffect: vi.fn(async () => undefined),
}));

const resolveSession = vi.hoisted(() =>
	vi.fn(async (_input: unknown) => ({
		projectSlug: "test-project" as string | null,
	})),
);

const attachProject = vi.hoisted(() =>
	vi.fn((_input: { sessionId?: string }) =>
		Promise.resolve({
			projectSlug: null as string | null,
			sessionSlug: null as string | null,
		}),
	),
);

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: vi.fn((tag: string, input: unknown) => {
		if (tag === "ResolveSession") return resolveSession(input);
		if (tag === "AttachProject")
			return attachProject(input as { sessionId?: string });
		if (tag === "GetProjects")
			return Promise.resolve({
				projectSlug: "test-project",
				projects: [],
				current: "test-project",
			});
		if (tag === "ListDaemonSessions")
			return Promise.resolve({
				sessions: [],
				availability: [],
				hasMore: false,
				nextCursor: null,
			});
		return Promise.resolve({ projectSlug: "test-project", files: [] });
	}),
}));

// Imports (after mocks)

import ChatLayout from "../../../src/lib/frontend/components/layout/ChatLayout.svelte";
import { taskDrawer } from "../../../src/lib/frontend/components/session/background-tasks.svelte.js";
import { clearMessages } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	attachedProjectState,
	replaceRoute,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	attachSessionList,
	detachSessionList,
} from "../../../src/lib/frontend/stores/session-list.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";

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
		openSessionForSetup(null);
		sessionViewState.compact = false;
		vi.mocked(resolveSession).mockResolvedValue({
			projectSlug: "test-project",
		});
		vi.mocked(attachProject).mockImplementation(({ sessionId }) =>
			Promise.resolve({
				projectSlug: "test-project",
				sessionSlug: sessionId ? "test-project" : null,
			}),
		);
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

	it("does not reopen a hidden task drawer after switching back from a phone viewport", () => {
		render(ChatLayout);
		flushSync();
		taskDrawer.task = {
			id: "agent",
			sessionId: "child",
			description: "Review the router",
		};
		flushSync();
		sessionViewState.compact = true;
		flushSync();
		expect(taskDrawer.task).toBeNull();
		sessionViewState.compact = false;
		flushSync();
		expect(taskDrawer.task).toBeNull();
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

	it("keeps the /ws bootstrap that lands before the first attach reply", () => {
		render(ChatLayout);
		attach("test-project");
		expect(clearMessages).not.toHaveBeenCalled();
	});

	it("rehydrates once on a reconnect attach to the same project without resetting", () => {
		render(ChatLayout);
		attach("test-project");
		vi.clearAllMocks();
		attach("test-project");
		expect(clearMessages).not.toHaveBeenCalled();
		expect(attachSessionList).toHaveBeenCalledTimes(1);
	});

	it("detaches the shell feed on unmount", () => {
		const { unmount } = render(ChatLayout);
		unmount();
		expect(detachSessionList).toHaveBeenCalledTimes(1);
	});
});
