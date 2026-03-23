// ─── ChatLayout WS Lifecycle Regression Test ─────────────────────────────────
// Verifies that the WebSocket lifecycle $effect in ChatLayout only re-runs
// when the project slug changes — NOT when the session portion of the URL
// changes (e.g., from session_switched → replaceRoute).
//
// Bug: connect() internally reads routerState.path via getCurrentSessionId().
// Without untrack(), this registered routerState.path as a dependency,
// causing a spurious disconnect/reconnect on every path change.

import { cleanup, render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock child components ──────────────────────────────────────────────────
// ChatLayout renders 18 child components. Mock them all with an empty Svelte
// component so we can mount ChatLayout without pulling in the entire UI tree.

const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

// Layout components
vi.mock(
	"../../../src/lib/frontend/components/layout/Header.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/layout/Sidebar.svelte",
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
	"../../../src/lib/frontend/components/overlays/Toast.svelte",
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
// reactive dependencies on routerState.path / slugState.current).

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
		onConnect: vi.fn(),
		onNavigateToSession: vi.fn(),
		clearNavigateToSession: vi.fn(),
		initSWNavigationListener: vi.fn(),
		onPlanMode: vi.fn(() => () => {}),
		onRewind: vi.fn(() => () => {}),
		wsSend: vi.fn(),
		wsState: { status: "", statusText: "" },
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
	switchToSession: vi.fn(),
	sessionCreation: { value: { state: "idle" } },
}));

vi.mock("../../../src/lib/frontend/stores/permissions.svelte.js", () => ({
	clearAllPermissions: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/terminal.svelte.js", () => ({
	terminalState: { panelOpen: false },
	destroyAll: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/discovery.svelte.js", () => ({
	clearDiscoveryState: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/todo.svelte.js", () => ({
	todoState: { items: [] },
	clearTodoState: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/file-tree.svelte.js", () => ({
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

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import ChatLayout from "../../../src/lib/frontend/components/layout/ChatLayout.svelte";
import {
	routerState,
	syncSlugState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	connect,
	disconnect,
} from "../../../src/lib/frontend/stores/ws.svelte.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ChatLayout WS lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		routerState.path = "/p/test-project/";
		syncSlugState(routerState.path);
	});

	afterEach(() => {
		cleanup();
		// Reset router state so it doesn't leak between tests
		routerState.path = "/";
		syncSlugState("/");
	});

	it("connects once on mount", () => {
		render(ChatLayout);

		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith("test-project");
	});

	// This is the regression test for the untrack() fix. Without untrack(),
	// connect() reads routerState.path (via getCurrentSessionId), registering
	// it as a dependency. Changing the path within the same slug would then
	// trigger a spurious disconnect + reconnect.
	it("does not reconnect when routerState.path changes within the same slug", async () => {
		render(ChatLayout);
		expect(connect).toHaveBeenCalledTimes(1);

		// Simulate session_switched → replaceRoute updating the path.
		// This changes routerState.path but NOT slugState.current.
		routerState.path = "/p/test-project/s/ses_abc123";
		syncSlugState(routerState.path);

		// Flush reactive updates. Use both flushSync (synchronous batches)
		// and tick (microtask-scheduled effects) to ensure any $effect
		// re-runs complete. The "reconnects when slug changes" test below
		// validates that this flush strategy actually reaches the effect —
		// if it didn't, that test would fail (canary).
		flushSync();
		await tick();

		// connect should NOT have been called again
		expect(connect).toHaveBeenCalledTimes(1);
		// disconnect should NOT have been called
		expect(disconnect).not.toHaveBeenCalled();
	});

	// Positive control: verifies the flush strategy reaches the $effect.
	// If this test passes, we know flushSync + tick IS triggering effect
	// re-runs, which means the negative test above is meaningful (not
	// vacuously true because effects never ran).
	it("reconnects when the slug actually changes", async () => {
		render(ChatLayout);
		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith("test-project");

		// Switch to a different project slug
		routerState.path = "/p/other-project/";
		syncSlugState(routerState.path);

		flushSync();
		await tick();

		// Should disconnect old + connect new
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(connect).toHaveBeenLastCalledWith("other-project");
	});
});
