# Subagent Session E2E Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add Playwright E2E tests for the subagent session toggle and navigation features, using snapshot-captured fixtures from a real OpenCode instance.

**Architecture:** Two-phase approach — a Vitest contract test captures real OpenCode session data (with normalization) and writes it as a JSON snapshot fixture. A Playwright E2E spec imports the snapshot and uses `mockRelayWebSocket()` (no real OpenCode needed at E2E time). The ws-mock is extended with an `onClientMessage` callback to handle `switch_session` messages.

**Tech Stack:** Playwright, Vitest, `toMatchFileSnapshot`, WS mock, TypeScript

---

## Task 1: Add `data-testid` to toggle button and extend ws-mock

**Files:**
- Modify: `src/lib/public/components/features/SessionList.svelte`
- Modify: `test/e2e/helpers/ws-mock.ts`

### Step 1: Add `data-testid` to the git-fork toggle button

In `SessionList.svelte`, the toggle button (around line 287-294) currently has no test ID. Add `data-testid="subagent-toggle"`:

Old (line 288):
```svelte
						type="button"
```

New:
```svelte
						type="button"
						data-testid="subagent-toggle"
```

### Step 2: Extend `WsMockOptions` with `onClientMessage`

In `test/e2e/helpers/ws-mock.ts`, add the new option to the `WsMockOptions` interface (after the `messageDelay` field, line 24):

```typescript
	/**
	 * Optional callback invoked for every client message.
	 * Use this to respond to messages like switch_session, view_session, etc.
	 * The control object can be used to send responses back to the client.
	 */
	onClientMessage?: (
		parsed: Record<string, unknown>,
		control: WsMockControl,
	) => void;
```

### Step 3: Wire the callback into the onMessage handler

In the `ws.onMessage` handler (inside `mockRelayWebSocket`, around line 49-94), add the callback invocation right after the `control._onClientMessage` call and before the existing type checks. Insert after line 53 (`if (!parsed) return;`):

```typescript
				// Invoke custom handler if provided
				if (options.onClientMessage) {
					options.onClientMessage(
						parsed as Record<string, unknown>,
						control,
					);
				}
```

### Step 4: Run unit tests

```bash
pnpm test:unit
```
Expected: all pass (no behavioral change to existing tests).

### Step 5: Commit

```bash
git add src/lib/public/components/features/SessionList.svelte test/e2e/helpers/ws-mock.ts
git commit -m "feat: add data-testid to subagent toggle and onClientMessage callback to ws-mock"
```

---

## Task 2: Write the contract test for fixture capture

**Files:**
- Create: `test/contract/subagent-fixture-capture.contract.ts`
- Generated: `test/e2e/fixtures/subagent-snapshot.json` (created by the test)

### Step 1: Create the contract test

Create `test/contract/subagent-fixture-capture.contract.ts`:

```typescript
// ─── Subagent Fixture Capture ─────────────────────────────────────────────
// Captures real OpenCode session data for subagent E2E tests.
// Connects to a running OpenCode instance, finds a parent/child session pair,
// normalizes the data (stable IDs/timestamps), and writes a snapshot fixture
// that Playwright E2E tests import as mock data.
//
// Run:  pnpm test:contract -- subagent-fixture
// Update snapshot:  pnpm test:contract -- subagent-fixture --update

import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, checkServerHealth } from "./helpers/server-connection.js";
import { getSessionMessages } from "./helpers/session-helpers.js";

// ─── Types (mirrors OpenCode REST shapes) ────────────────────────────────

interface OpenCodeSession {
	id: string;
	title?: string;
	parentID?: string;
	time?: { created?: number; updated?: number };
	[key: string]: unknown;
}

interface OpenCodeMessage {
	id?: string;
	role?: string;
	sessionID?: string;
	parts?: OpenCodePart[];
	cost?: number;
	tokens?: Record<string, unknown>;
	time?: Record<string, unknown>;
	// OpenCode may wrap as { info: ..., parts: ... }
	info?: Record<string, unknown>;
	[key: string]: unknown;
}

interface OpenCodePart {
	id?: string;
	type?: string;
	tool?: string;
	callID?: string;
	state?: {
		status?: string;
		input?: Record<string, unknown>;
		output?: string;
		metadata?: Record<string, unknown>;
		time?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

// ─── Normalization ───────────────────────────────────────────────────────

const BASE_TS = 1710000000000; // stable base timestamp
const TS_STEP = 1000; // 1 second between events

/**
 * Normalize a raw OpenCode message into the relay HistoryMessage shape
 * with stable IDs and timestamps.
 */
function normalizeMessage(
	raw: OpenCodeMessage,
	index: number,
	idMap: Map<string, string>,
	prefix: string,
): Record<string, unknown> {
	// Handle wrapped { info, parts } format
	const info = raw.info ?? raw;
	const parts = raw.parts ?? (raw.info ? (raw as unknown as { parts: unknown[] }).parts : undefined);

	const role = (info["role"] as string) ?? "user";
	const stableId = `${prefix}-msg-${role}-${index + 1}`;
	const origId = (info["id"] as string) ?? stableId;
	idMap.set(origId, stableId);

	const result: Record<string, unknown> = {
		id: stableId,
		role,
		time: { created: BASE_TS / 1000 + index * TS_STEP },
	};

	if (role === "assistant") {
		result["time"] = {
			created: BASE_TS / 1000 + index * TS_STEP,
			completed: BASE_TS / 1000 + (index + 1) * TS_STEP,
		};
		if (info["cost"] != null) result["cost"] = info["cost"];
		if (info["tokens"] != null) result["tokens"] = info["tokens"];
	}

	if (Array.isArray(parts) && parts.length > 0) {
		result["parts"] = parts.map((p: OpenCodePart, pi: number) =>
			normalizePart(p, `${stableId}-part-${pi + 1}`, idMap),
		);
	}

	return result;
}

function normalizePart(
	raw: OpenCodePart,
	stableId: string,
	idMap: Map<string, string>,
): Record<string, unknown> {
	const part: Record<string, unknown> = {
		id: stableId,
		type: raw.type ?? "text",
	};

	if (raw.type === "text" || (!raw.type && raw["text"])) {
		// Text part — include content
		const text = (raw["text"] as string) ?? (raw["content"] as string) ?? "";
		part["text"] = text.length > 500 ? text.slice(0, 500) + "…" : text;
	}

	if (raw.type === "tool" && raw.state) {
		part["tool"] = raw.tool ?? "unknown";
		part["callID"] = raw.callID ?? stableId;

		const state: Record<string, unknown> = {
			status: raw.state.status ?? "completed",
		};

		if (raw.state.input) {
			state["input"] = raw.state.input;
		}

		if (raw.state.output != null) {
			let output = raw.state.output;
			// Remap session IDs in task output (task_id: ses_xxx → sess-child-001)
			for (const [orig, stable] of idMap) {
				output = output.replaceAll(orig, stable);
			}
			state["output"] =
				output.length > 500 ? output.slice(0, 500) + "…" : output;
		}

		if (raw.state.metadata) {
			const meta = { ...raw.state.metadata };
			// Remap sessionId in metadata
			if (typeof meta["sessionId"] === "string" && idMap.has(meta["sessionId"])) {
				meta["sessionId"] = idMap.get(meta["sessionId"]);
			}
			state["metadata"] = meta;
		}

		if (raw.state.time) {
			state["time"] = raw.state.time;
		}

		part["state"] = state;
	}

	return part;
}

// ─── Snapshot structure ──────────────────────────────────────────────────

interface SubagentSnapshot {
	parentSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
	};
	childSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
		parentID: string;
	};
	parentHistory: {
		messages: Record<string, unknown>[];
		hasMore: boolean;
		total: number;
	};
	childHistory: {
		messages: Record<string, unknown>[];
		hasMore: boolean;
		total: number;
	};
}

// ─── Test ────────────────────────────────────────────────────────────────

const SNAPSHOT_PATH = resolve(
	import.meta.dirname ?? __dirname,
	"../e2e/fixtures/subagent-snapshot.json",
);

let serverAvailable = false;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn(
			"⚠️  OpenCode server not running — subagent fixture capture skipped",
		);
	}
});

describe("Subagent fixture capture", () => {
	it("captures and normalizes a parent/child session pair", async () => {
		if (!serverAvailable) {
			console.warn("SKIP: No OpenCode server — snapshot not updated");
			return;
		}

		// 1. List all sessions
		const allSessions = await apiGet<OpenCodeSession[]>("/session");
		const sessions = Array.isArray(allSessions)
			? allSessions
			: Object.values(allSessions as Record<string, OpenCodeSession>);

		// 2. Find a session with parentID (subagent/child session)
		const childRaw = sessions.find((s) => s.parentID);
		if (!childRaw) {
			console.warn(
				"SKIP: No subagent sessions found in OpenCode. " +
					"Create one by using the Task tool, then re-run.",
			);
			return;
		}

		const parentRaw = sessions.find((s) => s.id === childRaw.parentID);
		expect(parentRaw).toBeDefined();
		if (!parentRaw) return; // for TS narrowing

		// 3. Build stable ID map
		const idMap = new Map<string, string>();
		idMap.set(parentRaw.id, "sess-parent-001");
		idMap.set(childRaw.id, "sess-child-001");

		// 4. Fetch histories
		const parentMsgs = (await getSessionMessages(
			parentRaw.id,
		)) as OpenCodeMessage[];
		const childMsgs = (await getSessionMessages(
			childRaw.id,
		)) as OpenCodeMessage[];

		// 5. Normalize
		const parentHistory = parentMsgs.map((m, i) =>
			normalizeMessage(m, i, idMap, "parent"),
		);
		const childHistory = childMsgs.map((m, i) =>
			normalizeMessage(m, i, idMap, "child"),
		);

		// 6. Build snapshot
		const snapshot: SubagentSnapshot = {
			parentSession: {
				id: "sess-parent-001",
				title: parentRaw.title ?? "Parent Session",
				updatedAt: BASE_TS,
				messageCount: parentMsgs.length,
			},
			childSession: {
				id: "sess-child-001",
				title: childRaw.title ?? "Subagent Session",
				updatedAt: BASE_TS + 60_000,
				messageCount: childMsgs.length,
				parentID: "sess-parent-001",
			},
			parentHistory: {
				messages: parentHistory,
				hasMore: false,
				total: parentMsgs.length,
			},
			childHistory: {
				messages: childHistory,
				hasMore: false,
				total: childMsgs.length,
			},
		};

		// 7. Write snapshot (Vitest file snapshot)
		await expect(JSON.stringify(snapshot, null, "\t")).toMatchFileSnapshot(
			SNAPSHOT_PATH,
		);
	});
});
```

### Step 2: Run the contract test

```bash
pnpm test:contract -- subagent-fixture
```

Expected: If OpenCode is running and has a subagent session, the test creates `test/e2e/fixtures/subagent-snapshot.json`. If no subagent sessions exist, it prints a SKIP message.

If no subagent sessions exist, you need to create one first by using the Task tool in an OpenCode session, then re-run.

### Step 3: Verify the snapshot file

```bash
ls -la test/e2e/fixtures/subagent-snapshot.json
cat test/e2e/fixtures/subagent-snapshot.json | head -30
```

Expected: JSON file with `parentSession`, `childSession`, `parentHistory`, `childHistory` keys. Parent history should contain at least one message with a `tool` part where `tool === "Task"` or `tool === "task"`.

### Step 4: Commit

```bash
git add test/contract/subagent-fixture-capture.contract.ts test/e2e/fixtures/subagent-snapshot.json
git commit -m "feat: add contract test to capture subagent session fixtures from real OpenCode"
```

---

## Task 3: Add E2E infrastructure (page objects, playwright config, pnpm script)

**Files:**
- Modify: `test/e2e/page-objects/sidebar.page.ts`
- Modify: `test/e2e/page-objects/chat.page.ts`
- Create: `test/e2e/playwright-subagent.config.ts`
- Modify: `package.json`

### Step 1: Add `subagentToggleBtn` to `SidebarPage`

In `test/e2e/page-objects/sidebar.page.ts`, add a new property after `filesPanel` (line 16):

```typescript
	readonly subagentToggleBtn: Locator;
```

And in the constructor (after line 31):
```typescript
		this.subagentToggleBtn = page.locator('[data-testid="subagent-toggle"]');
```

### Step 2: Add subagent locators to `ChatPage`

In `test/e2e/page-objects/chat.page.ts`, add new properties after `stopBtn` (line 13):

```typescript
	readonly subagentBackBar: Locator;
	readonly subagentLinks: Locator;
	readonly subagentCards: Locator;
```

And in the constructor (after line 25):
```typescript
		this.subagentBackBar = page.locator(".subagent-back-bar");
		this.subagentLinks = page.locator(".subagent-link");
		this.subagentCards = page.locator(".subagent-header");
```

### Step 3: Create Playwright config

Create `test/e2e/playwright-subagent.config.ts`:

```typescript
// ─── Playwright Config: Subagent Session Tests ───────────────────────────
// Tests subagent session toggle and navigation via WS mock.
// No real OpenCode or relay needed — serves built frontend via Vite preview.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "subagent-sessions.spec.ts",
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: process.env["CI"] ? 1 : 0,
	workers: 1,
	reporter: process.env["CI"]
		? [["github"], ["html", { open: "never" }]]
		: "list",

	timeout: 30_000,
	expect: { timeout: 10_000 },

	use: {
		baseURL: "http://localhost:4173",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},

	projects: [
		{
			name: "desktop",
			use: {
				viewport: { width: 1440, height: 900 },
				isMobile: false,
			},
		},
	],

	webServer: {
		command: "npx vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		reuseExistingServer: !process.env["CI"],
		timeout: 15_000,
	},
});
```

Note: Desktop-only — subagent navigation tests don't need mobile viewports (sidebar is always visible on desktop).

### Step 4: Add pnpm script

In `package.json`, add after the `test:multi-instance` line (line 35):

```json
		"test:subagent-e2e": "pnpm build:frontend && npx playwright test --config test/e2e/playwright-subagent.config.ts",
```

### Step 5: Run unit tests

```bash
pnpm test:unit
```
Expected: all pass (no behavioral changes).

### Step 6: Commit

```bash
git add test/e2e/page-objects/sidebar.page.ts test/e2e/page-objects/chat.page.ts test/e2e/playwright-subagent.config.ts package.json
git commit -m "feat: add E2E infrastructure for subagent session tests"
```

---

## Task 4: Write the E2E spec

**Files:**
- Create: `test/e2e/specs/subagent-sessions.spec.ts`

### Step 1: Create the spec

Create `test/e2e/specs/subagent-sessions.spec.ts`:

```typescript
// ─── Subagent Session E2E Tests ──────────────────────────────────────────
// Tests the subagent session toggle (hide/show in sidebar) and
// navigation between parent and child sessions.
//
// Uses WS mock with fixture data captured from a real OpenCode instance.
// No real OpenCode or relay needed.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChatPage } from "../page-objects/chat.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// ─── Load snapshot fixture ──────────────────────────────────────────────

const snapshotPath = resolve(
	import.meta.dirname ?? __dirname,
	"../fixtures/subagent-snapshot.json",
);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
	parentSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
	};
	childSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
		parentID: string;
	};
	parentHistory: {
		messages: unknown[];
		hasMore: boolean;
		total: number;
	};
	childHistory: {
		messages: unknown[];
		hasMore: boolean;
		total: number;
	};
};

// ─── Build mock messages from snapshot ───────────────────────────────────

const allSessions = [
	snapshot.parentSession,
	snapshot.childSession,
	// Add a couple more non-subagent sessions for realism
	{
		id: "sess-other-001",
		title: "Unrelated session",
		updatedAt: snapshot.parentSession.updatedAt - 3600_000,
		messageCount: 5,
	},
];

const sessionListMsg: MockMessage = {
	type: "session_list",
	sessions: allSessions,
};

const modelListMsg: MockMessage = {
	type: "model_list",
	providers: [
		{
			id: "anthropic",
			name: "Anthropic",
			configured: true,
			models: [
				{
					id: "claude-sonnet-4",
					name: "claude-sonnet-4",
					provider: "anthropic",
				},
			],
		},
	],
};

const agentListMsg: MockMessage = {
	type: "agent_list",
	agents: [
		{ id: "code", name: "Code", description: "General coding assistant" },
	],
};

/** Init messages: parent session active, idle, with full history */
const initMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: snapshot.parentSession.id,
		history: snapshot.parentHistory,
	},
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	sessionListMsg,
	modelListMsg,
	agentListMsg,
];

/** Messages to send when switching to child session */
const childSwitchMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: snapshot.childSession.id,
		history: snapshot.childHistory,
	},
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	sessionListMsg, // re-send so client has parentID metadata
];

/** Messages to send when switching back to parent session */
const parentSwitchMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: snapshot.parentSession.id,
		history: snapshot.parentHistory,
	},
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	sessionListMsg,
];

// ─── Helper ─────────────────────────────────────────────────────────────

async function waitForChatReady(page: import("@playwright/test").Page) {
	// Wait for the input to be visible and connect overlay to be gone
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	// Give the session list time to render
	await page.waitForTimeout(500);
}

// ─── Tests ──────────────────────────────────────────────────────────────

test.describe("Subagent session toggle", () => {
	test("hides subagent sessions by default", async ({ page, baseURL }) => {
		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);
		const sessionCount = await sidebar.getSessionCount();

		// Should show parent + "Unrelated session" but NOT the child
		expect(sessionCount).toBe(2);

		// Child session title should not be visible
		const childItem = sidebar.sessionList.locator(
			`[data-session-id="${snapshot.childSession.id}"]`,
		);
		await expect(childItem).not.toBeVisible();
	});

	test("toggle shows subagent sessions", async ({ page, baseURL }) => {
		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);

		// Click the toggle
		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);

		// Now all 3 sessions should be visible
		const sessionCount = await sidebar.getSessionCount();
		expect(sessionCount).toBe(3);

		// Child session should be visible
		const childItem = sidebar.sessionList.locator(
			`[data-session-id="${snapshot.childSession.id}"]`,
		);
		await expect(childItem).toBeVisible();
	});

	test("toggle hides subagent sessions again", async ({ page, baseURL }) => {
		await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);

		// Show then hide
		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);
		expect(await sidebar.getSessionCount()).toBe(3);

		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);
		expect(await sidebar.getSessionCount()).toBe(2);
	});

	test("toggle state persists across page reload", async ({
		page,
		baseURL,
	}) => {
		const mockOpts = { initMessages, responses: new Map<string, MockMessage[]>() };

		await mockRelayWebSocket(page, mockOpts);
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const sidebar = new SidebarPage(page);

		// Toggle to show subagent sessions
		await sidebar.subagentToggleBtn.click();
		await page.waitForTimeout(300);
		expect(await sidebar.getSessionCount()).toBe(3);

		// Reload page (re-establish mock first)
		await mockRelayWebSocket(page, mockOpts);
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		// Should still show 3 sessions (localStorage persisted)
		expect(await sidebar.getSessionCount()).toBe(3);
	});
});

test.describe("Subagent navigation", () => {
	test("navigates to child session via subagent link", async ({
		page,
		baseURL,
	}) => {
		const control = await mockRelayWebSocket(page, {
			initMessages,
			responses: new Map(),
			onClientMessage(msg, ctrl) {
				if (
					msg.type === "switch_session" &&
					msg.sessionId === snapshot.childSession.id
				) {
					void ctrl.sendMessages(childSwitchMessages);
				}
			},
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const chat = new ChatPage(page);

		// Click the subagent link in the task tool card
		const subagentLink = chat.subagentLinks.first();
		await expect(subagentLink).toBeVisible({ timeout: 5_000 });
		await subagentLink.click();

		// Verify switch_session was sent
		const switchMsg = await control.waitForClientMessage(
			(m) =>
				(m as Record<string, unknown>).type === "switch_session" &&
				(m as Record<string, unknown>).sessionId ===
					snapshot.childSession.id,
		);
		expect(switchMsg).toBeDefined();

		// SubagentBackBar should appear
		await expect(chat.subagentBackBar).toBeVisible({ timeout: 5_000 });
	});

	test("SubagentBackBar shows parent title", async ({ page, baseURL }) => {
		// Start directly in child session
		const childInitMessages: MockMessage[] = [
			{
				type: "session_switched",
				id: snapshot.childSession.id,
				history: snapshot.childHistory,
			},
			{ type: "status", status: "idle" },
			{
				type: "model_info",
				model: "claude-sonnet-4",
				provider: "anthropic",
			},
			{ type: "client_count", count: 1 },
			sessionListMsg, // includes both parent and child with parentID
			modelListMsg,
			agentListMsg,
		];

		await mockRelayWebSocket(page, {
			initMessages: childInitMessages,
			responses: new Map(),
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const chat = new ChatPage(page);

		// Back bar should be visible with parent title
		await expect(chat.subagentBackBar).toBeVisible({ timeout: 5_000 });
		const backBarText = await chat.subagentBackBar.innerText();
		expect(backBarText).toContain(snapshot.parentSession.title);
	});

	test("navigates back to parent via SubagentBackBar", async ({
		page,
		baseURL,
	}) => {
		// Start in child session
		const childInitMessages: MockMessage[] = [
			{
				type: "session_switched",
				id: snapshot.childSession.id,
				history: snapshot.childHistory,
			},
			{ type: "status", status: "idle" },
			{
				type: "model_info",
				model: "claude-sonnet-4",
				provider: "anthropic",
			},
			{ type: "client_count", count: 1 },
			sessionListMsg,
			modelListMsg,
			agentListMsg,
		];

		const control = await mockRelayWebSocket(page, {
			initMessages: childInitMessages,
			responses: new Map(),
			onClientMessage(msg, ctrl) {
				if (
					msg.type === "switch_session" &&
					msg.sessionId === snapshot.parentSession.id
				) {
					void ctrl.sendMessages(parentSwitchMessages);
				}
			},
		});
		await page.goto(`${baseURL}/p/myapp/`);
		await waitForChatReady(page);

		const chat = new ChatPage(page);

		// Click the back bar
		await expect(chat.subagentBackBar).toBeVisible({ timeout: 5_000 });
		await chat.subagentBackBar.click();

		// Verify switch_session was sent for parent
		const switchMsg = await control.waitForClientMessage(
			(m) =>
				(m as Record<string, unknown>).type === "switch_session" &&
				(m as Record<string, unknown>).sessionId ===
					snapshot.parentSession.id,
		);
		expect(switchMsg).toBeDefined();

		// SubagentBackBar should disappear (parent has no parentID)
		await expect(chat.subagentBackBar).not.toBeVisible({ timeout: 5_000 });
	});
});
```

### Step 2: Build frontend and run E2E tests

```bash
pnpm test:subagent-e2e
```

Expected: all 6 tests pass. If any fail, diagnose and fix before proceeding.

### Step 3: Commit

```bash
git add test/e2e/specs/subagent-sessions.spec.ts
git commit -m "feat: add E2E tests for subagent session toggle and navigation"
```

---

## Task 5: Run full test suite and verify

### Step 1: Run unit tests

```bash
pnpm test
```
Expected: all pass.

### Step 2: Run subagent E2E tests

```bash
pnpm test:subagent-e2e
```
Expected: all 6 tests pass.

### Step 3: Fix any issues and commit if needed

```bash
git add -A
git commit -m "fix: address test failures in subagent E2E tests"
```
