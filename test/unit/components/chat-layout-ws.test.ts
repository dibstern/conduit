import { cleanup, render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock child components ──────────────────────────────────────────────────
// ChatLayout renders 18 child components. Mock them all with an empty Svelte
// component so we can mount ChatLayout without pulling in the entire UI tree.

const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);
const wsLifecycleHarness = vi.hoisted(() => ({
	onAttachCallbacks: [] as Array<(slug: string) => void>,
}));

// Layout components
vi.mock(
	"../../../src/lib/frontend/components/layout/Header.svelte",
	emptyComponent,
);
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

// Overlay components
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
	"../../../src/lib/frontend/components/chat/PlanMode.svelte",
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

// ─── Mock stores ────────────────────────────────────────────────────────────
// Mock all stores EXCEPT router.svelte.ts (which must be real to test
// reactive dependencies on routerState.path).

vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", async () => {
	// The real connect() calls getCurrentSessionId() which reads
	// routerState.path. Our mock must replicate this read so the
	// $effect registers routerState.path as a dependency when
	// connect() is called outside untrack(). Without this, the
	// mock connect is a no-op that never touches routerState.path,
	// making the regression test vacuously pass.
	const { getCurrentSessionId } = await import(
		"../../../src/lib/frontend/stores/router.svelte.js"
	);
	return {
		connect: vi.fn(() => {
			getCurrentSessionId();
		}),
		disconnect: vi.fn(),
		onProjectAttached: vi.fn((callback: (slug: string) => void) => {
			wsLifecycleHarness.onAttachCallbacks.push(callback);
			return () => {};
		}),
		onNavigateToSession: vi.fn(),
		clearNavigateToSession: vi.fn(),
		initSWNavigationListener: vi.fn(),
		onPlanMode: vi.fn(() => () => {}),
		onRewind: vi.fn(() => () => {}),
		wsSend: vi.fn(),
		wsState: { status: "connected", statusText: "" },
	};
});

vi.mock("../../../src/lib/frontend/stores/chat.svelte.js", () => ({
	chatState: { streaming: false, processing: false, messages: [] },
	clearMessages: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/session.svelte.js", () => ({
	sessionState: {
		currentId: null,
		sessions: [],
		searchQuery: "",
		hasMore: false,
	},
	clearSessionState: vi.fn(),
	loadDaemonSessions: vi.fn(async () => {}),
	applyListSessionsResponse: vi.fn(),
	switchToSession: vi.fn(),
	sessionCreation: { value: { state: "idle" } },
}));

vi.mock("../../../src/lib/frontend/stores/permissions.svelte.js", () => ({
	clearAllPermissions: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/terminal.svelte.js", () => ({
	terminalState: { panelOpen: false },
	destroyAll: vi.fn(),
	applyPtyListResponse: vi.fn(),
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
		fileViewerWidth: 400,
	},
	closeFileViewer: vi.fn(),
	showToast: vi.fn(),
	resetProjectUI: vi.fn(),
	setSidebarWidth: vi.fn(),
	setFileViewerWidth: vi.fn(),
	SIDEBAR_MIN_WIDTH: 200,
	SIDEBAR_MAX_WIDTH: 400,
	FILE_VIEWER_MIN_WIDTH: 200,
	FILE_VIEWER_MAX_WIDTH: 600,
}));

vi.mock("../../../src/lib/frontend/stores/project.svelte.js", () => ({
	applyGetProjectsResponse: vi.fn(),
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
	interruptStream: vi.fn(),
	disposeRuntime: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	viewSessionRpc: vi.fn(async () => {}),
	resolveSessionRpc: vi.fn(async () => ({
		projectSlug: "test-project" as string | null,
	})),
	attachProjectRpc: vi.fn(async () => {}),
	listSessionsRpc: vi.fn(async (input: { roots?: boolean }) => ({
		projectSlug: "test-project",
		roots: input.roots === true,
		sessions: [],
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
	listPtysRpc: vi.fn(async () => ({
		projectSlug: "test-project",
		ptys: [],
	})),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import ChatLayout from "../../../src/lib/frontend/components/layout/ChatLayout.svelte";
import { clearMessages } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	attachedProjectState,
	replaceRoute,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	applyListSessionsResponse,
	clearSessionState,
	loadDaemonSessions,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import { showToast } from "../../../src/lib/frontend/stores/ui.svelte.js";
import {
	connect,
	disconnect,
	onProjectAttached,
} from "../../../src/lib/frontend/stores/ws.svelte.js";
import {
	attachProjectRpc,
	listSessionsRpc,
	resolveSessionRpc,
	viewSessionRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";

function attach(slug: string): void {
	attachedProjectState.slug = slug;
	wsLifecycleHarness.onAttachCallbacks[0]?.(slug);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ChatLayout WS lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		wsLifecycleHarness.onAttachCallbacks = [];
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

	it("connects once on mount", () => {
		render(ChatLayout);

		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith();
	});

	it("does not toast when optional discovery RPCs fail on attach", async () => {
		render(ChatLayout);

		expect(onProjectAttached).toHaveBeenCalledTimes(1);
		attach("test-project");
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

	it("loads both the daemon-wide and the per-project session lists on attach", async () => {
		render(ChatLayout);

		attach("test-project");
		await vi.waitFor(() => {
			expect(applyListSessionsResponse).toHaveBeenCalledTimes(1);
		});

		expect(loadDaemonSessions).toHaveBeenCalledTimes(1);
	});

	it("keeps one connection when resolving a session within the attached project", async () => {
		render(ChatLayout);
		attach("test-project");
		replaceRoute("/s/ses_abc123");
		flushSync();
		await tick();
		expect(connect).toHaveBeenCalledTimes(1);
		expect(disconnect).not.toHaveBeenCalled();
		expect(resolveSessionRpc).toHaveBeenCalledExactlyOnceWith({
			sessionId: "ses_abc123",
		});
		expect(viewSessionRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "test-project",
			sessionId: "ses_abc123",
			originId: "browser-client-1",
		});
	});

	it("switches sessions across projects with ViewSession and resets before hydrating the attach", async () => {
		render(ChatLayout);
		attach("test-project");
		vi.clearAllMocks();
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "other-project",
		});
		replaceRoute("/s/session-b");
		flushSync();
		await tick();
		expect(viewSessionRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "other-project",
			sessionId: "session-b",
			originId: "browser-client-1",
		});
		expect(connect).not.toHaveBeenCalled();
		expect(disconnect).not.toHaveBeenCalled();
		expect(clearMessages).not.toHaveBeenCalled();
		expect(listSessionsRpc).not.toHaveBeenCalled();
		attach("other-project");
		expect(clearMessages).toHaveBeenCalledTimes(1);
		expect(clearSessionState).toHaveBeenCalledTimes(1);
		expect(listSessionsRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "other-project",
			roots: true,
		});
		expect(
			vi.mocked(clearSessionState).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(listSessionsRpc).mock.invocationCallOrder[0] ?? 0);
		flushSync();
		await tick();
		expect(listSessionsRpc).toHaveBeenCalledTimes(1);
	});

	it("resolves a cold session link before viewing it", async () => {
		routerState.path = "/s/cold-session";
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "other-project",
		});
		render(ChatLayout);
		await vi.waitFor(() =>
			expect(viewSessionRpc).toHaveBeenCalledExactlyOnceWith({
				projectSlug: "other-project",
				sessionId: "cold-session",
				originId: "browser-client-1",
			}),
		);
		expect(resolveSessionRpc).toHaveBeenCalledExactlyOnceWith({
			sessionId: "cold-session",
		});
		expect(
			vi.mocked(resolveSessionRpc).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(viewSessionRpc).mock.invocationCallOrder[0] ?? 0);
	});

	it("resolves and views history navigation across projects", async () => {
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
			expect(viewSessionRpc).toHaveBeenLastCalledWith({
				projectSlug: "other-project",
				sessionId: "session-b",
				originId: "browser-client-1",
			}),
		);
		attach("other-project");
		sessionState.currentId = "session-b";
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({
			projectSlug: "test-project",
		});
		window.history.replaceState(null, "", "/s/session-a");
		window.dispatchEvent(new PopStateEvent("popstate"));
		flushSync();
		await vi.waitFor(() =>
			expect(viewSessionRpc).toHaveBeenLastCalledWith({
				projectSlug: "test-project",
				sessionId: "session-a",
				originId: "browser-client-1",
			}),
		);
		expect(resolveSessionRpc).toHaveBeenCalledTimes(2);
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("does not resolve or view a session at the list front door", async () => {
		render(ChatLayout);
		attach("test-project");
		flushSync();
		await tick();
		expect(resolveSessionRpc).not.toHaveBeenCalled();
		expect(viewSessionRpc).not.toHaveBeenCalled();
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
		expect(viewSessionRpc).not.toHaveBeenCalled();
	});

	it("returns an unknown session to the list with a dismissible notice", async () => {
		routerState.path = "/s/missing-session";
		vi.mocked(resolveSessionRpc).mockResolvedValueOnce({ projectSlug: null });
		render(ChatLayout);
		await vi.waitFor(() => expect(routerState.path).toBe("/"));
		expect(routerState.sessionNotFound).toBe(true);
		expect(viewSessionRpc).not.toHaveBeenCalled();
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
		replaceRoute("/s/next-session");
		flushSync();
		await tick();
		resolveMissing?.({ projectSlug: null });
		await tick();
		expect(routerState.path).toBe("/s/next-session");
		expect(routerState.sessionNotFound).toBe(false);
	});

	it("rehydrates once on a reconnect attach to the same project without resetting", () => {
		render(ChatLayout);
		attach("test-project");
		vi.clearAllMocks();
		attach("test-project");
		expect(clearMessages).not.toHaveBeenCalled();
		expect(loadDaemonSessions).toHaveBeenCalledTimes(1);
		expect(listSessionsRpc).toHaveBeenCalledTimes(1);
	});

	it("uses AttachProject for project-only navigation without reconnecting", async () => {
		render(ChatLayout);
		attach("test-project");
		replaceRoute("/?p=other-project");
		flushSync();
		await tick();
		expect(attachProjectRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "other-project",
			originId: "browser-client-1",
		});
		expect(viewSessionRpc).not.toHaveBeenCalled();
		expect(connect).toHaveBeenCalledTimes(1);
		expect(disconnect).not.toHaveBeenCalled();
	});

	it("can select a project before the socket has attached to one", async () => {
		render(ChatLayout);
		expect(attachProjectRpc).not.toHaveBeenCalled();
		replaceRoute("/?p=first-project");
		flushSync();
		await tick();
		expect(attachProjectRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "first-project",
			originId: "browser-client-1",
		});
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending project switch when navigating back to the attached project", async () => {
		render(ChatLayout);
		attach("test-project");
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
		expect(connect).toHaveBeenCalledTimes(1);
	});

	it("discards late hydration from the previous project", async () => {
		let resolveOld:
			| ((value: Awaited<ReturnType<typeof listSessionsRpc>>) => void)
			| undefined;
		vi.mocked(listSessionsRpc).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		render(ChatLayout);
		attach("test-project");
		attach("other-project");
		await vi.waitFor(() =>
			expect(applyListSessionsResponse).toHaveBeenCalledTimes(1),
		);
		resolveOld?.({ projectSlug: "test-project", roots: true, sessions: [] });
		await Promise.resolve();
		expect(applyListSessionsResponse).toHaveBeenCalledTimes(1);
	});

	it("disconnects on unmount", () => {
		const { unmount } = render(ChatLayout);
		unmount();
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledTimes(1);
	});
});
