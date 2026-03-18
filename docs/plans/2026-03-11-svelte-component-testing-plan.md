# Svelte Component Testing Setup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the lossy `svelte-runes-mock` vitest plugin with real Svelte compilation, and add full component testing infrastructure using `@testing-library/svelte` + jsdom.

**Architecture:** Replace the custom vitest plugin that strips `$state`/`$derived` runes with `@sveltejs/vite-plugin-svelte` for real compilation. Use `environmentMatchGlobs` to give component tests (in `test/unit/components/`) a jsdom DOM environment while keeping store/server tests in Node. Write a ChatLayout WS reconnect regression test as the first component test.

**Tech Stack:** Svelte 5, `@sveltejs/vite-plugin-svelte` (v5.1.1, already installed), `@testing-library/svelte` (v5.3.1, already installed), `jsdom` (v28.1.0, already installed), Vitest

---

### Task 1: Replace svelte-runes-mock with real Svelte plugin

**Files:**
- Modify: `vitest.config.ts`

**Step 1: Write the new vitest config**

Replace the entire file with:

```ts
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [svelte()],
	test: {
		include: ["test/unit/**/*.test.ts", "test/fixture/**/*.test.ts"],
		environmentMatchGlobs: [["test/unit/components/**", "jsdom"]],
		testTimeout: 10_000,
		hookTimeout: 10_000,
		coverage: {
			provider: "v8",
			include: [
				"src/lib/instance-manager.ts",
				"src/lib/daemon.ts",
				"src/lib/daemon-ipc.ts",
				"src/lib/ipc-protocol.ts",
				"src/lib/client-init.ts",
				"src/lib/config-persistence.ts",
				"src/lib/frontend/stores/instance.svelte.ts",
				"src/bin/cli-utils.ts",
				"src/bin/cli-core.ts",
				"src/lib/shared-types.ts",
			],
			reporter: ["text", "json-summary"],
			thresholds: {
				lines: 70,
				branches: 60,
			},
		},
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
```

Key changes:
- `svelte-runes-mock` plugin → `svelte()` (real Svelte compilation; HMR is already off in vitest's test mode)
- Added `environmentMatchGlobs` so `test/unit/components/**` runs in jsdom

**Step 2: Run existing tests to verify nothing breaks**

Run: `pnpm test:unit`

Expected: All 2939 tests pass. If any fail, the mock was hiding a real reactivity bug — fix those before proceeding.

**Step 3: Commit**

```
git add vitest.config.ts
git commit -m "test: replace svelte-runes-mock with real Svelte compilation in vitest"
```

---

### Task 2: Create mock component helper

**Files:**
- Create: `test/helpers/Empty.svelte`

**Step 1: Create the empty mock component**

```svelte
<!--
  Empty component for mocking child components in component tests.
  Accepts all props silently to avoid Svelte 5 "unknown prop" warnings
  when parent components pass props to mocked children.
-->
<script lang="ts">
	let { ...rest }: Record<string, unknown> = $props();
</script>

<div data-testid="mock"></div>
```

The `$props()` rest pattern is required because ChatLayout passes props to several
children (`TodoOverlay items=`, `FileViewer visible=`, `QrModal visible=`, etc.).
Without it, Svelte 5 emits runtime warnings for every undeclared prop, cluttering
test output and potentially masking real warnings.

**Step 2: Commit**

```
git add test/helpers/Empty.svelte
git commit -m "test: add Empty.svelte mock component for component tests"
```

---

### Task 3: Write the ChatLayout WS reconnect regression test

**Files:**
- Create: `test/unit/components/chat-layout-ws.test.ts`

**Context:** The bug (fixed in ChatLayout.svelte) was that `connect()` internally reads `routerState.path` via `getCurrentSessionId()`. Without `untrack()`, this registered as a dependency of the WS lifecycle `$effect`, causing a spurious disconnect/reconnect whenever the URL path changed (e.g., when `session_switched` triggers `replaceRoute`).

**Step 1: Write the test file**

The test mocks all child components (with Empty.svelte) and all stores except `router.svelte.ts` (which must be real to test reactive dependencies). The `ws.svelte.ts` store is mocked with spies on `connect`/`disconnect`.

**Critical: effect flush strategy.** Svelte 5's `$effect` is scheduled asynchronously
(microtask). `flushSync` processes synchronous reactive batches but may not flush
scheduled effects. We use both `flushSync()` and `await tick()` to ensure effects
run. The "reconnects when slug changes" positive test validates that this flush
strategy actually triggers effect re-runs — if it doesn't, that test would fail
(acting as a canary). If both the positive and negative tests pass, we know the
flush works AND the `untrack` prevents spurious re-runs.

**Mock type safety note:** The `vi.mock` factories return untyped objects. If a
store export is renamed, the mock silently provides the old name and the test
passes while real code breaks. When maintaining these tests, verify mock shapes
against actual store exports. A future improvement would be typed mock helpers.

```ts
// ─── ChatLayout WS Lifecycle Regression Test ─────────────────────────────────
// Verifies that the WebSocket lifecycle $effect in ChatLayout only re-runs
// when the project slug changes — NOT when the session portion of the URL
// changes (e.g., from session_switched → replaceRoute).
//
// Bug: connect() internally reads routerState.path via getCurrentSessionId().
// Without untrack(), this registered routerState.path as a dependency,
// causing a spurious disconnect/reconnect on every path change.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";

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
	"../../../src/lib/frontend/components/layout/InputArea.svelte",
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
	"../../../src/lib/frontend/components/features/TodoOverlay.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/features/TerminalPanel.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/features/PlanMode.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/features/FileViewer.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/features/PermissionNotification.svelte",
	emptyComponent,
);

// ─── Mock stores ────────────────────────────────────────────────────────────
// Mock all stores EXCEPT router.svelte.ts (which must be real to test
// reactive dependencies on routerState.path / slugState.current).

vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", () => ({
	connect: vi.fn(),
	disconnect: vi.fn(),
	onConnect: vi.fn(),
	onPlanMode: vi.fn(() => () => {}),
	onRewind: vi.fn(() => () => {}),
	wsSend: vi.fn(),
	wsState: { status: "", statusText: "" },
}));

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

import {
	routerState,
	slugState,
	syncSlugState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	connect,
	disconnect,
} from "../../../src/lib/frontend/stores/ws.svelte.js";
import ChatLayout from "../../../src/lib/frontend/components/layout/ChatLayout.svelte";

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
```

**Step 2: Run the test to verify it passes**

Run: `pnpm test:unit test/unit/components/chat-layout-ws.test.ts`

Expected: 3 tests pass.

**Step 3: Verify the test catches the original bug (mandatory, not optional)**

This step confirms the test isn't vacuously true. Temporarily break
the fix in `ChatLayout.svelte` — move `connect(slug)` outside the
`untrack()` block:

```diff
  untrack(() => {
      // ... clear calls ...
      onConnect(() => { ... });
-     connect(slug);
  });
+ connect(slug);
```

Run: `pnpm test:unit test/unit/components/chat-layout-ws.test.ts`

Expected: "does not reconnect when routerState.path changes within the same
slug" FAILS (connect called 2 times, expected 1). "reconnects when slug
changes" still passes.

**Immediately restore the fix** after confirming the failure.

If the negative test does NOT fail with the revert, the flush strategy
is wrong (effects aren't running). Debug with `await new Promise(r => setTimeout(r, 50))`
or investigate Svelte 5's effect scheduling in jsdom.

**Step 4: Run the full test suite**

Run: `pnpm test:unit`

Expected: All tests pass (existing + new).

**Step 5: Commit**

```
git add test/unit/components/chat-layout-ws.test.ts
git commit -m "test: add ChatLayout WS reconnect regression test using @testing-library/svelte"
```
