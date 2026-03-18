# WebSocket Connection Lifecycle Observability — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make connection issues self-diagnosing by logging every WS state transition, adding a typed feature flag system, and providing a debug panel that can be activated even when the UI is stuck.

**Architecture:** A `feature-flags` store provides a typed, extensible flag system with three activation paths (URL `?feats=debug`, localStorage, Settings UI). A `ws-debug` store maintains a ring buffer of timestamped lifecycle events and exposes `window.__wsDebug()`. The existing `ws.svelte.ts` calls `wsDebugLog()` at every lifecycle point. A floating `DebugPanel` component shows live state and transition history.

**Tech Stack:** Svelte 5 ($state/$derived/$effect), TypeScript, Tailwind CSS

---

### Task 1: Feature Flags Store

**Files:**
- Create: `src/lib/frontend/stores/feature-flags.svelte.ts`
- Test: `test/unit/frontend/feature-flags.test.ts`

**Step 1: Write the failing test**

```ts
// test/unit/frontend/feature-flags.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// We test the pure logic — URL parsing and localStorage read/write.
// The Svelte $state reactivity is tested indirectly via the exported state.

describe("feature-flags", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("parseFeatsParam parses comma-separated flags and ignores unknown", () => {
		// parseFeatsParam("debug,unknown,debug") → ["debug"]
	});

	it("initFeatureFlags reads from localStorage", () => {
		localStorage.setItem("feature-flags", JSON.stringify(["debug"]));
		// After init, featureFlags.debug should be true
	});

	it("enableFeature persists to localStorage", () => {
		// After enableFeature("debug"), localStorage should contain ["debug"]
	});

	it("disableFeature removes from localStorage", () => {
		localStorage.setItem("feature-flags", JSON.stringify(["debug"]));
		// After disableFeature("debug"), localStorage should contain []
	});

	it("toggleFeature flips the flag", () => {
		// toggle on → true, toggle again → false
	});

	it("getEnabledFeatures returns only enabled flags", () => {
		// enable debug → getEnabledFeatures() → ["debug"]
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/frontend/feature-flags.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/lib/frontend/stores/feature-flags.svelte.ts

/** All known feature flags. Add new ones here and in the featureFlags $state. */
export type FeatureFlag = "debug";

/** All valid flag names for runtime validation. */
const VALID_FLAGS: readonly FeatureFlag[] = ["debug"] as const;

const STORAGE_KEY = "feature-flags";

// ─── State ──────────────────────────────────────────────────────────────────

export const featureFlags = $state({
	debug: false,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse ?feats=debug,foo URL param. Returns only valid FeatureFlag values. */
export function parseFeatsParam(value: string): FeatureFlag[] {
	return value
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s): s is FeatureFlag =>
			VALID_FLAGS.includes(s as FeatureFlag),
		)
		.filter((v, i, a) => a.indexOf(v) === i); // dedupe
}

/** Read enabled flags from localStorage. */
function readStorage(): FeatureFlag[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((s: unknown): s is FeatureFlag =>
			typeof s === "string" && VALID_FLAGS.includes(s as FeatureFlag),
		);
	} catch {
		return [];
	}
}

/** Write enabled flags to localStorage. */
function writeStorage(flags: FeatureFlag[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
	} catch {
		/* ignore */
	}
}

/** Apply a list of flags to the reactive state. */
function applyFlags(flags: FeatureFlag[]): void {
	for (const flag of VALID_FLAGS) {
		featureFlags[flag] = flags.includes(flag);
	}
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize feature flags from URL params and localStorage.
 * URL params take precedence and are persisted to localStorage.
 * Call once on app mount.
 */
export function initFeatureFlags(): void {
	const stored = readStorage();
	applyFlags(stored);

	// Check URL — ?feats=debug,foo
	try {
		const url = new URL(window.location.href);
		const featsParam = url.searchParams.get("feats");
		if (featsParam) {
			const fromUrl = parseFeatsParam(featsParam);
			// Merge: URL flags enable, don't disable stored ones
			const merged = [...new Set([...stored, ...fromUrl])];
			applyFlags(merged);
			writeStorage(merged);
		}
	} catch {
		/* ignore — SSR or test environment */
	}
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
	return featureFlags[flag];
}

export function enableFeature(flag: FeatureFlag): void {
	featureFlags[flag] = true;
	const current = readStorage();
	if (!current.includes(flag)) {
		writeStorage([...current, flag]);
	}
}

export function disableFeature(flag: FeatureFlag): void {
	featureFlags[flag] = false;
	const current = readStorage();
	writeStorage(current.filter((f) => f !== flag));
}

export function toggleFeature(flag: FeatureFlag): void {
	if (featureFlags[flag]) {
		disableFeature(flag);
	} else {
		enableFeature(flag);
	}
}

export function getEnabledFeatures(): FeatureFlag[] {
	return VALID_FLAGS.filter((f) => featureFlags[f]);
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/frontend/feature-flags.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add typed feature flags store with URL and localStorage support
```

---

### Task 2: WebSocket Debug Store

**Files:**
- Create: `src/lib/frontend/stores/ws-debug.svelte.ts`
- Test: `test/unit/frontend/ws-debug.test.ts`

**Step 1: Write the failing test**

```ts
// test/unit/frontend/ws-debug.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("ws-debug", () => {
	it("wsDebugLog pushes events to the ring buffer", () => {});
	it("ring buffer caps at MAX_EVENTS (50)", () => {});
	it("wsDebugLog calls console.debug when debug flag is enabled", () => {});
	it("wsDebugLog does NOT call console.debug when debug flag is disabled", () => {});
	it("getDebugSnapshot returns serializable state", () => {});
	it("clearDebugLog empties the buffer", () => {});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/frontend/ws-debug.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/lib/frontend/stores/ws-debug.svelte.ts
// WebSocket connection lifecycle debug store.
// Maintains a ring buffer of timestamped events for diagnostics.

import type { ConnectionStatus } from "../types.js";
import { featureFlags } from "./feature-flags.svelte.js";
import { wsState } from "./ws.svelte.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WsDebugEvent {
	time: number;
	event: string;
	detail?: string;
	state: ConnectionStatus;
}

export interface WsDebugSnapshot {
	status: ConnectionStatus;
	statusText: string;
	attempts: number;
	relayStatus: string | undefined;
	relayError: string | undefined;
	timeInState: number;
	events: WsDebugEvent[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_EVENTS = 50;

// ─── State ──────────────────────────────────────────────────────────────────

let _events: WsDebugEvent[] = [];
let _lastTransitionTime = Date.now();
let _messageCount = 0;

export const wsDebugState = $state({
	/** Number of events in the buffer — triggers reactivity for the panel. */
	eventCount: 0,
	/** Timestamp of last state transition. */
	lastTransitionTime: Date.now(),
});

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Log a WebSocket lifecycle event.
 * Always pushes to the ring buffer.
 * When featureFlags.debug is true, also logs to console.
 */
export function wsDebugLog(event: string, detail?: string): void {
	const entry: WsDebugEvent = {
		time: Date.now(),
		event,
		detail,
		state: wsState.status,
	};

	_events.push(entry);
	if (_events.length > MAX_EVENTS) {
		_events = _events.slice(-MAX_EVENTS);
	}

	wsDebugState.eventCount = _events.length;

	// Track state transitions for time-in-state calculation
	if (event === "connect" || event === "ws:open" || event === "ws:close" ||
		event === "disconnect" || event === "timeout" || event === "self-heal") {
		_lastTransitionTime = entry.time;
		wsDebugState.lastTransitionTime = entry.time;
	}

	// Console output when debug is enabled
	if (featureFlags.debug) {
		const prefix = `[ws] ${event}`;
		if (detail) {
			console.debug(prefix, detail);
		} else {
			console.debug(prefix);
		}
	}
}

/**
 * Log ws:message events with throttling (first + every 100th).
 */
export function wsDebugLogMessage(): void {
	_messageCount++;
	if (_messageCount === 1 || _messageCount % 100 === 0) {
		wsDebugLog("ws:message", `#${_messageCount}`);
	}
}

/** Reset the message counter (call on new connection). */
export function wsDebugResetMessageCount(): void {
	_messageCount = 0;
}

/** Get a JSON-serializable snapshot of the current debug state. */
export function getDebugSnapshot(): WsDebugSnapshot {
	return {
		status: wsState.status,
		statusText: wsState.statusText,
		attempts: wsState.attempts,
		relayStatus: wsState.relayStatus,
		relayError: wsState.relayError,
		timeInState: Date.now() - _lastTransitionTime,
		events: [..._events],
	};
}

/** Get the raw events array (for the debug panel). */
export function getDebugEvents(): readonly WsDebugEvent[] {
	return _events;
}

/** Clear the event buffer. */
export function clearDebugLog(): void {
	_events = [];
	_messageCount = 0;
	wsDebugState.eventCount = 0;
}

// ─── Global debug function ──────────────────────────────────────────────────
// Always available, even when debug UI is off.

if (typeof window !== "undefined") {
	(window as Record<string, unknown>).__wsDebug = () => {
		const snap = getDebugSnapshot();
		console.table(snap.events);
		return snap;
	};
}
```

**Note:** This file imports from `ws.svelte.ts` (for `wsState`). To avoid circular imports, `ws.svelte.ts` will import from `ws-debug.svelte.ts` (not the other way around for the core state). The `wsDebugLog` function reads `wsState.status` which is fine as a read-only dependency.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/frontend/ws-debug.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add WS debug store with ring buffer and window.__wsDebug()
```

---

### Task 3: Wire Breadcrumbs into ws.svelte.ts

**Files:**
- Modify: `src/lib/frontend/stores/ws.svelte.ts`
- Test: `test/unit/frontend/ws-debug.test.ts` (extend with integration assertions)

**Step 1: Add imports and breadcrumb calls**

Add to `ws.svelte.ts`:
```ts
import { wsDebugLog, wsDebugLogMessage, wsDebugResetMessageCount } from "./ws-debug.svelte.js";
```

Insert `wsDebugLog()` calls at these 12 points in the existing code:

| Call site | Event name | Detail |
|-----------|-----------|--------|
| `connect()` entry, after `wsState.attempts++` | `"connect"` | `slug=${slug}, attempt=${wsState.attempts}` |
| `doConnect()` after `new WebSocket(url)` | `"ws:create"` | the URL |
| `open` listener, after guard | `"ws:open"` | — |
| `close` listener, after guard | `"ws:close"` | — |
| `error` listener, after guard | `"ws:error"` | — |
| `message` listener, after parse | replace with `wsDebugLogMessage()` | — |
| connect timeout fires | `"timeout"` | — |
| `scheduleReconnect()` entry | `"reconnect:schedule"` | `delay=${_reconnectDelay}ms` |
| reconnect timer callback (before calling `connect()`) | `"reconnect:fire"` | — |
| `disconnect()` entry | `"disconnect"` | — |
| `fetchRelayStatus()` success | `"relay:status"` | `status=${data.status}` |
| self-healing onmessage path | `"self-heal"` | — |

Also call `wsDebugResetMessageCount()` in the `open` listener (new connection = reset counter).

**Step 2: Run tests**

Run: `pnpm vitest run test/unit/frontend/`
Expected: All PASS

**Step 3: Commit**

```
feat: wire WS lifecycle breadcrumbs into debug store
```

---

### Task 4: Debug Panel Component

**Files:**
- Create: `src/lib/frontend/components/debug/DebugPanel.svelte`

**Step 1: Build the component**

A small floating panel, bottom-right, showing:
- Current state: status, statusText, time-in-state (live), attempts, relayStatus
- Scrollable event log with relative timestamps
- Close button (hides panel, keeps debug mode on)

Key implementation details:
- Read `wsDebugState.eventCount` for reactivity (triggers re-render when events are added)
- Call `getDebugEvents()` to get the event list
- Use a 1-second interval to update "time in state" display
- `position: fixed; bottom: 1rem; right: 1rem; z-index: 9999`
- `max-height: 280px; width: 320px; overflow-y: auto`
- Monospace font, small text (text-[11px])
- Semi-transparent dark background: `bg-black/90 text-green-400` (terminal aesthetic)
- Show relative time for each event: `+{ms}ms {event} {detail}`

Props: `visible: boolean`, `onClose: () => void`

```svelte
<script lang="ts">
  import { wsState } from "../../stores/ws.svelte.js";
  import { wsDebugState, getDebugEvents, clearDebugLog } from "../../stores/ws-debug.svelte.js";

  let { visible = false, onClose }: { visible: boolean; onClose?: () => void } = $props();

  // Force re-read when events change
  const eventCount = $derived(wsDebugState.eventCount);
  const events = $derived.by(() => {
    // Touch eventCount to trigger reactivity
    void eventCount;
    return getDebugEvents();
  });

  // Live "time in state" counter
  let now = $state(Date.now());
  $effect(() => {
    if (!visible) return;
    const interval = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(interval);
  });

  const timeInState = $derived(
    Math.round((now - wsDebugState.lastTransitionTime) / 1000)
  );

  // Format relative time from first event
  function relTime(time: number, base: number): string {
    const ms = time - base;
    if (ms < 1000) return `+${ms}ms`;
    return `+${(ms / 1000).toFixed(1)}s`;
  }

  // Auto-scroll to bottom
  let logEl: HTMLDivElement;
  $effect(() => {
    void eventCount;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });
</script>
```

**Step 2: Commit**

```
feat: add floating DebugPanel component for WS lifecycle
```

---

### Task 5: Mount DebugPanel in ChatLayout + Keyboard Shortcut

**Files:**
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte`

**Step 1: Add imports and state**

```ts
import DebugPanel from "../debug/DebugPanel.svelte";
import { featureFlags, initFeatureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
```

Add local state:
```ts
let debugPanelVisible = $state(false);
```

**Step 2: Init feature flags on mount**

In the existing `onMount` or an `$effect`:
```ts
$effect(() => {
  initFeatureFlags();
});
```

**Step 3: Add keyboard shortcut**

```ts
$effect(() => {
  function handleKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
      e.preventDefault();
      toggleFeature("debug");
    }
  }
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
});
```

**Step 4: Derive panel visibility**

```ts
// Panel shows when debug flag is on AND panel hasn't been manually closed
$effect(() => {
  if (featureFlags.debug) {
    debugPanelVisible = true;
  }
});
```

**Step 5: Mount the component**

After the SettingsPanel near line 446, add:
```svelte
{#if featureFlags.debug}
  <DebugPanel visible={debugPanelVisible} onClose={() => (debugPanelVisible = false)} />
{/if}
```

**Step 6: Verify**

Run: `pnpm check && pnpm test:unit`
Expected: All PASS

**Step 7: Commit**

```
feat: mount DebugPanel in ChatLayout with keyboard shortcut and feature flag init
```

---

### Task 6: Settings Panel Debug Tab

**Files:**
- Modify: `src/lib/frontend/components/overlays/SettingsPanel.svelte`

**Step 1: Add import**

```ts
import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
```

**Step 2: Add "Debug" tab button**

After the "Instances" tab button (line ~227), add:
```svelte
<button
  class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer {activeTab === 'debug'
    ? 'border-accent text-text'
    : 'border-transparent text-text-muted hover:text-text'}"
  onclick={() => (activeTab = "debug")}
>
  Debug
</button>
```

**Step 3: Add tab content**

After the `{#if activeTab === "instances"}` block closes (before `</div>` of tab content), add:
```svelte
{:else if activeTab === "debug"}
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-text">Connection debug panel</div>
        <div class="text-xs text-text-muted mt-0.5">
          Shows WS state transitions, timing, and connection lifecycle events.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={featureFlags.debug}
        class="relative w-9 h-5 rounded-full transition-colors cursor-pointer {featureFlags.debug ? 'bg-accent' : 'bg-border'}"
        onclick={() => toggleFeature("debug")}
      >
        <span
          class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {featureFlags.debug ? 'translate-x-4' : ''}"
        ></span>
      </button>
    </div>
    <div class="text-xs text-text-dimmer">
      Also available via URL param <code class="px-1 py-0.5 bg-black/[0.05] dark:bg-white/[0.08] rounded">?feats=debug</code>
      or keyboard shortcut <kbd class="px-1 py-0.5 bg-black/[0.05] dark:bg-white/[0.08] rounded">Ctrl+Shift+D</kbd>
    </div>
  </div>
```

**Step 4: Verify**

Run: `pnpm check && pnpm test:unit`
Expected: All PASS

**Step 5: Commit**

```
feat: add Debug tab to Settings panel with feature flag toggle
```

---

### Task 7: Activate Header Debug Button

**Files:**
- Modify: `src/lib/frontend/components/layout/Header.svelte`

**Step 1: Add import**

```ts
import { featureFlags } from "../../stores/feature-flags.svelte.js";
```

**Step 2: Show debug button when flag is on**

Change the `#debug-menu-wrap` div (line ~184):

Before:
```svelte
<div id="debug-menu-wrap" class="hidden">
  <button id="debug-btn" class="header-icon-btn" title="Debug">
    <Icon name="bug" size={15} />
  </button>
</div>
```

After:
```svelte
{#if featureFlags.debug}
  <div id="debug-menu-wrap">
    <button
      id="debug-btn"
      class="header-icon-btn"
      title="Toggle debug panel"
      onclick={() => window.dispatchEvent(new CustomEvent("debug:toggle"))}
    >
      <Icon name="bug" size={15} />
    </button>
  </div>
{/if}
```

**Step 3: Handle the event in ChatLayout**

In ChatLayout.svelte, add an effect to listen for `debug:toggle`:
```ts
$effect(() => {
  function onDebugToggle() {
    debugPanelVisible = !debugPanelVisible;
  }
  window.addEventListener("debug:toggle", onDebugToggle);
  return () => window.removeEventListener("debug:toggle", onDebugToggle);
});
```

**Step 4: Verify**

Run: `pnpm check && pnpm test:unit`
Expected: All PASS

**Step 5: Commit**

```
feat: activate header debug button to toggle debug panel
```

---

### Task 8: Final Verification and Cleanup

**Step 1: Run full verification suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 2: Manual smoke test checklist**

1. Open app, Ctrl+Shift+D → debug panel appears with events
2. Close panel → panel hides, debug mode still on (bug icon visible in header)
3. Click bug icon → panel reappears
4. Settings → Debug tab → toggle off → panel and bug icon disappear
5. Add `?feats=debug` to URL → debug panel appears
6. Open browser console, type `__wsDebug()` → returns snapshot object
7. Disconnect WS (e.g. stop server) → events log disconnect, reconnect attempts with timing
8. Verify on mobile viewport (responsive layout of debug panel)

**Step 3: Commit**

```
chore: final verification pass for WS debug observability
```
