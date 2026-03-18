# Multi-Instance Playwright E2E Tests — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write Playwright tests covering ALL multi-instance features from the design. Tests for implemented features pass; tests for deferred features are marked `test.fixme()` and fail until the UI is built.

**Architecture:** Single spec file `test/e2e/specs/multi-instance.spec.ts` using the WS-mock approach (no real backend). Canned `instance_list`, `instance_status`, and `project_list` messages injected via `ws-mock.ts`. Separate Playwright config for multi-instance tests. One real-daemon smoke test at the end.

**Tech Stack:** Playwright, ws-mock.ts, mockup-state.ts fixtures, Vite preview

---

### Task 1: Create Playwright Config for Multi-Instance Tests

**Files:**
- Create: `test/e2e/playwright-multi-instance.config.ts`

**Step 1: Write the config file**

Model after `test/e2e/playwright-visual.config.ts` but with two viewport projects (desktop + mobile) and matching `multi-instance.spec.ts`.

```ts
// ─── Playwright Config: Multi-Instance Tests ────────────────────────────────
// Tests all multi-instance UI features via WS mock.
// No real OpenCode or relay needed — serves built frontend via Vite preview.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "multi-instance.spec.ts",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: process.env.CI
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
		{
			name: "mobile",
			use: {
				viewport: { width: 393, height: 852 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],

	webServer: {
		command: "npx vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		reuseExistingServer: !process.env.CI,
		timeout: 15_000,
	},
});
```

**Step 2: Add npm script to package.json**

Add to `scripts`:
```json
"test:multi-instance": "npx playwright test --config test/e2e/playwright-multi-instance.config.ts"
```

**Step 3: Run to verify config loads**

Run: `pnpm test:multi-instance --list`
Expected: Lists 0 tests (spec file doesn't exist yet), no config errors.

**Step 4: Commit**

```
feat: add Playwright config for multi-instance E2E tests
```

---

### Task 2: Add Multi-Instance Fixtures to mockup-state.ts

**Files:**
- Modify: `test/e2e/fixtures/mockup-state.ts`

**Step 1: Add instance and project fixtures to the end of the file**

Append these exports after the existing ones:

```ts
// ─── Multi-Instance Fixtures ─────────────────────────────────────────────────
// Canned messages for testing multi-instance UI features.

/** Two instances: "personal" (healthy) and "work" (unhealthy) */
export const multiInstanceList: MockMessage = {
	type: "instance_list",
	instances: [
		{
			id: "personal",
			name: "Personal",
			port: 4096,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: Date.now() - 86400_000,
		},
		{
			id: "work",
			name: "Work",
			port: 4097,
			managed: true,
			status: "unhealthy",
			restartCount: 2,
			createdAt: Date.now() - 43200_000,
		},
	],
};

/** Single default instance (healthy) */
export const singleInstanceList: MockMessage = {
	type: "instance_list",
	instances: [
		{
			id: "default",
			name: "Default",
			port: 4096,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: Date.now(),
		},
	],
};

/** Status update: "work" becomes healthy */
export const workInstanceHealthy: MockMessage = {
	type: "instance_status",
	instanceId: "work",
	status: "healthy",
};

/** Status update: "personal" becomes unhealthy */
export const personalInstanceUnhealthy: MockMessage = {
	type: "instance_status",
	instanceId: "personal",
	status: "unhealthy",
};

/** Status update: "work" becomes stopped */
export const workInstanceStopped: MockMessage = {
	type: "instance_status",
	instanceId: "work",
	status: "stopped",
};

/** Status update: "work" becomes starting */
export const workInstanceStarting: MockMessage = {
	type: "instance_status",
	instanceId: "work",
	status: "starting",
};

/** Project list with instanceId bindings — use with multi-instance init */
export const multiInstanceProjectList: MockMessage = {
	type: "project_list",
	projects: [
		{
			slug: "myapp",
			title: "myapp",
			directory: "/src/myapp",
			instanceId: "personal",
		},
		{
			slug: "mylib",
			title: "mylib",
			directory: "/src/mylib",
			instanceId: "personal",
		},
		{
			slug: "company-api",
			title: "company-api",
			directory: "/src/company-api",
			instanceId: "work",
		},
	],
	current: "myapp",
};

/** Project list with single instance — projects have no instanceId */
export const singleInstanceProjectList: MockMessage = {
	type: "project_list",
	projects: [
		{
			slug: "myapp",
			title: "myapp",
			directory: "/src/myapp",
		},
		{
			slug: "mylib",
			title: "mylib",
			directory: "/src/mylib",
		},
	],
	current: "myapp",
};

/** Init messages for multi-instance testing (session + model + instances + projects) */
export const multiInstanceInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-mi-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		sessions: [
			{
				id: "sess-mi-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	multiInstanceList,
	multiInstanceProjectList,
];

/** Init messages for single-instance testing */
export const singleInstanceInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-si-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		sessions: [
			{
				id: "sess-si-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	singleInstanceList,
	singleInstanceProjectList,
];
```

**Step 2: Run TypeScript check**

Run: `pnpm tsc --noEmit`
Expected: No new errors

**Step 3: Commit**

```
feat: add multi-instance WS mock fixtures for Playwright tests
```

---

### Task 3: Extend WS Mock to Support Delayed Extra Messages

The WS mock currently only supports init messages and text-response pairs. We need a way to send additional messages after the initial connection (e.g., `instance_status` updates mid-test). 

**Files:**
- Modify: `test/e2e/helpers/ws-mock.ts`

**Step 1: Add `sendMessage` to `WsMockControl`**

Add a `sendMessage(msg)` method that sends a message to the connected client. This requires storing a reference to the `WebSocketRoute`.

```ts
// In WsMockControl class, add:
private _ws?: WebSocketRoute;

/** @internal */
_setWs(ws: WebSocketRoute): void {
	this._ws = ws;
}

/** Send a message to the connected client (for mid-test injections). */
sendMessage(msg: MockMessage): void {
	if (!this._ws) throw new Error("WebSocket not connected yet");
	this._ws.send(JSON.stringify(msg));
}

/** Send multiple messages with optional delay between them. */
async sendMessages(msgs: MockMessage[], delay = 0): Promise<void> {
	for (const msg of msgs) {
		this.sendMessage(msg);
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
	}
}
```

And in the `mockRelayWebSocket` function, after `control._onRouted()`, add:
```ts
control._setWs(ws);
```

**Step 2: Add `onClientMessage` to `WsMockControl`**

For testing deferred features (like "Add Instance" form), we need to verify what the frontend sends. Add:

```ts
// In WsMockControl class:
private _clientMessages: string[] = [];

/** @internal */
_onClientMessage(data: string): void {
	this._clientMessages.push(data);
}

/** Get all messages sent by the client (parsed JSON). */
getClientMessages(): unknown[] {
	return this._clientMessages.map((m) => JSON.parse(m));
}

/** Wait for a client message matching a predicate. */
async waitForClientMessage(
	predicate: (msg: unknown) => boolean,
	timeout = 5000,
): Promise<unknown> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const match = this.getClientMessages().find(predicate);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for client message`);
}
```

And in the `ws.onMessage` handler in `mockRelayWebSocket`, add at the top:
```ts
control._onClientMessage(typeof data === "string" ? data : "");
```

**Step 3: Run existing visual tests to verify no regression**

Run: `pnpm test:visual`
Expected: All existing visual tests pass

**Step 4: Commit**

```
feat: extend WS mock with sendMessage and client message capture
```

---

### Task 4: Write the Multi-Instance Spec File — Implemented Features (Groups 1-5)

**Files:**
- Create: `test/e2e/specs/multi-instance.spec.ts`

**Step 1: Write the spec file with all implemented-feature tests**

```ts
// ─── Multi-Instance E2E Tests ────────────────────────────────────────────────
// Tests all multi-instance UI features defined in the multi-instance plan.
//
// Groups 1-5: Implemented features (should pass)
// Groups 6-10: Deferred features (marked test.fixme, will fail until UI is built)
// Group 11: Real daemon smoke test
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import {
	multiInstanceInitMessages,
	singleInstanceInitMessages,
	workInstanceHealthy,
	workInstanceStopped,
	workInstanceStarting,
	personalInstanceUnhealthy,
} from "../fixtures/mockup-state.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

/** Set up WS mock with multi-instance init, navigate, wait for ready. */
async function setupMultiInstance(page: Page, baseURL?: string) {
	const control = await mockRelayWebSocket(page, {
		initMessages: multiInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(baseURL ?? "http://localhost:4173");
	// Wait for WS connection + session list + send button
	await page.waitForFunction(
		() => {
			const send = document.getElementById("send") as HTMLButtonElement | null;
			return send && !send.disabled;
		},
		{ timeout: 10_000 },
	);
	return control;
}

/** Set up WS mock with single-instance init, navigate, wait for ready. */
async function setupSingleInstance(page: Page, baseURL?: string) {
	const control = await mockRelayWebSocket(page, {
		initMessages: singleInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(baseURL ?? "http://localhost:4173");
	await page.waitForFunction(
		() => {
			const send = document.getElementById("send") as HTMLButtonElement | null;
			return send && !send.disabled;
		},
		{ timeout: 10_000 },
	);
	return control;
}

/** Open the ProjectSwitcher dropdown. On mobile, opens hamburger first. */
async function openProjectSwitcher(page: Page) {
	// Check if mobile — hamburger visible
	const hamburger = page.locator("#hamburger-btn");
	if (await hamburger.isVisible()) {
		await hamburger.click();
		await page.waitForTimeout(300); // sidebar animation
	}
	// Click the project name to open the switcher
	const projectName = page.locator("#project-name");
	await projectName.click();
	// Wait for dropdown to appear
	await page.waitForTimeout(200);
}

// ─── Group 1: ProjectSwitcher Instance Grouping (IMPLEMENTED) ──────────────

test.describe("ProjectSwitcher: Instance Grouping", () => {
	test("groups projects by instance when multiple instances exist", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		// Should have instance group headers
		// Instance headers have 10px uppercase text with status dots
		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);
		await expect(instanceHeaders).toHaveCount(2);

		// Check header names
		await expect(instanceHeaders.nth(0)).toContainText("Personal");
		await expect(instanceHeaders.nth(1)).toContainText("Work");
	});

	test("shows flat list when single instance", async ({ page, baseURL }) => {
		await setupSingleInstance(page, baseURL);
		await openProjectSwitcher(page);

		// Should NOT have instance group headers
		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);
		await expect(instanceHeaders).toHaveCount(0);

		// But should have projects visible
		const projectItems = page.locator("[class*='cursor-pointer']").filter({
			hasText: /myapp|mylib/,
		});
		expect(await projectItems.count()).toBeGreaterThanOrEqual(2);
	});

	test("shows instance status color in group header", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);

		// Personal = healthy = green dot
		const personalDot = instanceHeaders.nth(0).locator(".rounded-full");
		await expect(personalDot).toHaveClass(/bg-green-500/);

		// Work = unhealthy = red dot
		const workDot = instanceHeaders.nth(1).locator(".rounded-full");
		await expect(workDot).toHaveClass(/bg-red-500/);
	});

	test("updates instance status color on instance_status message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		// Work starts unhealthy (red)
		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);
		const workDot = instanceHeaders.nth(1).locator(".rounded-full");
		await expect(workDot).toHaveClass(/bg-red-500/);

		// Send status update: work becomes healthy
		control.sendMessage(workInstanceHealthy);

		// Dot should turn green
		await expect(workDot).toHaveClass(/bg-green-500/);
	});
});

// ─── Group 2: Header Instance Badge (IMPLEMENTED) ──────────────────────────

test.describe("Header: Instance Badge", () => {
	test("shows instance badge when multiple instances exist", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);

		// Badge should be visible next to project name
		// It's a span with instance name inside #header-left
		const badge = page.locator("#header-left span").filter({
			hasText: "Personal",
		});
		await expect(badge).toBeVisible();
	});

	test("hides instance badge with single instance", async ({
		page,
		baseURL,
	}) => {
		await setupSingleInstance(page, baseURL);

		// Badge should NOT be visible (only shown when > 1 instance)
		// Look for any badge-like span with instance name in header-left
		const badge = page.locator(
			"#header-left .text-\\[10px\\].font-medium",
		);
		await expect(badge).toHaveCount(0);
	});

	test("badge shows correct instance name and status color", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);

		// Current project is "myapp" bound to "personal" instance
		const badge = page.locator("#header-left span").filter({
			hasText: "Personal",
		});
		await expect(badge).toBeVisible();

		// Status dot inside badge should be green (healthy)
		const dot = badge.locator(".rounded-full");
		await expect(dot).toHaveClass(/bg-green-500/);
	});

	test("badge updates on instance_status message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		// Initial: Personal is healthy (green)
		const badge = page.locator("#header-left span").filter({
			hasText: "Personal",
		});
		const dot = badge.locator(".rounded-full");
		await expect(dot).toHaveClass(/bg-green-500/);

		// Send: Personal becomes unhealthy
		control.sendMessage(personalInstanceUnhealthy);

		// Dot should turn red
		await expect(dot).toHaveClass(/bg-red-500/);
	});
});

// ─── Group 3: ConnectOverlay Instance Name (IMPLEMENTED) ────────────────────

test.describe("ConnectOverlay: Instance Name", () => {
	test("shows instance name in connecting message", async ({
		page,
		baseURL,
	}) => {
		// Set up WS mock but DON'T send init messages — simulate connecting state
		// Actually, we need to send project/instance info then disconnect
		// Better approach: set up, connect, then close WS to trigger reconnect
		const control = await mockRelayWebSocket(page, {
			initMessages: multiInstanceInitMessages,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});
		await page.goto(baseURL ?? "http://localhost:4173");
		// Wait for connection
		await page.waitForFunction(
			() => {
				const send = document.getElementById(
					"send",
				) as HTMLButtonElement | null;
				return send && !send.disabled;
			},
			{ timeout: 10_000 },
		);

		// Now close the WS to trigger the overlay
		control.close();

		// ConnectOverlay should show instance name
		const overlay = page.locator("#connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });

		// Should show instance name "Personal" (current project's instance)
		await expect(overlay).toContainText("Personal");
	});

	test("falls back to 'OpenCode' with no instance binding", async ({
		page,
		baseURL,
	}) => {
		// Use single-instance init (no instanceId on projects)
		const control = await mockRelayWebSocket(page, {
			initMessages: singleInstanceInitMessages,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});
		await page.goto(baseURL ?? "http://localhost:4173");
		await page.waitForFunction(
			() => {
				const send = document.getElementById(
					"send",
				) as HTMLButtonElement | null;
				return send && !send.disabled;
			},
			{ timeout: 10_000 },
		);

		// Close WS to trigger overlay
		control.close();

		const overlay = page.locator("#connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });

		// Should fall back to "OpenCode"
		await expect(overlay).toContainText("OpenCode");
	});
});

// ─── Group 4: Instance Store Reactivity (IMPLEMENTED) ───────────────────────

test.describe("Instance Store: Reactivity", () => {
	test("instance_list message populates UI", async ({ page, baseURL }) => {
		await setupMultiInstance(page, baseURL);

		// Header badge should show instance name (proves store → UI reactivity)
		const badge = page.locator("#header-left span").filter({
			hasText: "Personal",
		});
		await expect(badge).toBeVisible();

		// ProjectSwitcher should have grouped projects (proves store → ProjectSwitcher)
		await openProjectSwitcher(page);
		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);
		await expect(instanceHeaders).toHaveCount(2);
	});

	test("instance_status updates single instance without affecting others", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);

		// Personal = green, Work = red initially
		await expect(
			instanceHeaders.nth(0).locator(".rounded-full"),
		).toHaveClass(/bg-green-500/);
		await expect(
			instanceHeaders.nth(1).locator(".rounded-full"),
		).toHaveClass(/bg-red-500/);

		// Update only Work to healthy
		control.sendMessage(workInstanceHealthy);

		// Work should be green now
		await expect(
			instanceHeaders.nth(1).locator(".rounded-full"),
		).toHaveClass(/bg-green-500/);

		// Personal should STILL be green (unchanged)
		await expect(
			instanceHeaders.nth(0).locator(".rounded-full"),
		).toHaveClass(/bg-green-500/);
	});

	test("store clears on WS disconnect", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);

		// Badge visible before disconnect
		const badge = page.locator("#header-left span").filter({
			hasText: "Personal",
		});
		await expect(badge).toBeVisible();

		// Close WS
		control.close();

		// Badge should disappear (store cleared, instances.length becomes 0 or 1)
		// The overlay will appear, but the badge should be gone since instances cleared
		await expect(badge).toBeHidden({ timeout: 5_000 });
	});
});

// ─── Group 5: Status Color Mapping (IMPLEMENTED) ───────────────────────────

test.describe("Status Color Mapping", () => {
	test("each status maps to correct color", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		const instanceHeaders = page.locator(
			".text-\\[10px\\].font-semibold.uppercase",
		);
		const workDot = instanceHeaders.nth(1).locator(".rounded-full");

		// unhealthy (initial) = red
		await expect(workDot).toHaveClass(/bg-red-500/);

		// starting = yellow
		control.sendMessage(workInstanceStarting);
		await expect(workDot).toHaveClass(/bg-yellow-500/);

		// healthy = green
		control.sendMessage(workInstanceHealthy);
		await expect(workDot).toHaveClass(/bg-green-500/);

		// stopped = zinc/gray
		control.sendMessage(workInstanceStopped);
		await expect(workDot).toHaveClass(/bg-zinc-500/);
	});
});

// ─── Group 6: Instance Selector Dropdown (DEFERRED) ─────────────────────────

test.describe("Instance Selector Dropdown (Deferred)", () => {
	test.fixme(
		"clicking header badge opens instance selector dropdown",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			// Click the instance badge in the header
			const badge = page.locator("#header-left span").filter({
				hasText: "Personal",
			});
			await badge.click();

			// Dropdown should appear with instance list
			const dropdown = page.locator("#instance-selector-dropdown");
			await expect(dropdown).toBeVisible();
		},
	);

	test.fixme(
		"dropdown lists all instances with health status",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			const badge = page.locator("#header-left span").filter({
				hasText: "Personal",
			});
			await badge.click();

			const dropdown = page.locator("#instance-selector-dropdown");
			await expect(dropdown).toContainText("Personal");
			await expect(dropdown).toContainText("Work");

			// Status dots
			const dots = dropdown.locator(".rounded-full");
			await expect(dots).toHaveCount(2);
		},
	);

	test.fixme(
		"selecting instance switches to its projects",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			// Open dropdown
			const badge = page.locator("#header-left span").filter({
				hasText: "Personal",
			});
			await badge.click();

			// Click "Work" instance
			const workOption = page
				.locator("#instance-selector-dropdown")
				.getByText("Work");
			await workOption.click();

			// Project name should switch to a work project
			await expect(page.locator("#project-name")).toContainText(
				"company-api",
			);
		},
	);

	test.fixme(
		"'Manage Instances' link at bottom of dropdown",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			const badge = page.locator("#header-left span").filter({
				hasText: "Personal",
			});
			await badge.click();

			const manageLink = page
				.locator("#instance-selector-dropdown")
				.getByText("Manage Instances");
			await expect(manageLink).toBeVisible();
		},
	);
});

// ─── Group 7: Instance Management Settings Panel (DEFERRED) ─────────────────

test.describe("Instance Management Settings (Deferred)", () => {
	test.fixme(
		"gear icon opens settings with Instances tab",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			// Click settings/gear icon
			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();

			// Settings panel should be visible with Instances tab
			const settingsPanel = page.locator("#settings-panel");
			await expect(settingsPanel).toBeVisible();

			const instancesTab = settingsPanel.getByText("Instances");
			await expect(instancesTab).toBeVisible();
			await instancesTab.click();
		},
	);

	test.fixme(
		"instances tab lists all instances with status and port",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			// Navigate to instances settings
			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();

			// Should list both instances
			const instanceList = page.locator("#instance-settings-list");
			await expect(instanceList).toContainText("Personal");
			await expect(instanceList).toContainText("Work");
			await expect(instanceList).toContainText("4096");
			await expect(instanceList).toContainText("4097");
		},
	);

	test.fixme(
		"'Add Instance' button shows inline form",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();

			const addBtn = page.getByText("Add Instance");
			await expect(addBtn).toBeVisible();
			await addBtn.click();

			// Form fields should appear
			const nameInput = page.locator(
				"#instance-form input[name='instance-name']",
			);
			await expect(nameInput).toBeVisible();
		},
	);

	test.fixme(
		"add managed instance via form sends WS message",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();

			await page.getByText("Add Instance").click();

			// Fill form
			await page.fill("input[name='instance-name']", "staging");
			await page.fill("input[name='instance-port']", "4098");
			// Select managed
			await page.check("input[name='managed']");

			// Submit
			await page.click("button:has-text('Create')");

			// Verify WS message sent
			const msg = await control.waitForClientMessage(
				(m: unknown) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: string }).type === "instance_add",
			);
			expect(msg).toMatchObject({
				type: "instance_add",
				name: "staging",
				port: 4098,
				managed: true,
			});
		},
	);

	test.fixme(
		"add external instance via form sends WS message",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();

			await page.getByText("Add Instance").click();

			await page.fill("input[name='instance-name']", "remote");
			await page.fill(
				"input[name='instance-url']",
				"http://remote.example.com:4096",
			);

			await page.click("button:has-text('Create')");

			const msg = await control.waitForClientMessage(
				(m: unknown) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: string }).type === "instance_add",
			);
			expect(msg).toMatchObject({
				type: "instance_add",
				name: "remote",
				managed: false,
			});
		},
	);

	test.fixme(
		"instance expand shows start/stop/remove buttons",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);

			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();

			// Click to expand an instance
			await page
				.locator("#instance-settings-list")
				.getByText("Personal")
				.click();

			await expect(page.getByText("Start")).toBeVisible();
			await expect(page.getByText("Stop")).toBeVisible();
			await expect(page.getByText("Remove")).toBeVisible();
		},
	);

	test.fixme(
		"start button sends instance_start WS message",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			// Navigate to instance settings, expand "work" (stopped)
			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();
			await page.locator("#instance-settings-list").getByText("Work").click();

			await page.click("button:has-text('Start')");

			const msg = await control.waitForClientMessage(
				(m: unknown) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: string }).type === "instance_start",
			);
			expect(msg).toMatchObject({
				type: "instance_start",
				instanceId: "work",
			});
		},
	);

	test.fixme(
		"stop button sends instance_stop WS message",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();
			await page
				.locator("#instance-settings-list")
				.getByText("Personal")
				.click();

			await page.click("button:has-text('Stop')");

			const msg = await control.waitForClientMessage(
				(m: unknown) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: string }).type === "instance_stop",
			);
			expect(msg).toMatchObject({
				type: "instance_stop",
				instanceId: "personal",
			});
		},
	);

	test.fixme(
		"remove button shows confirmation then sends instance_remove",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			const gearBtn = page.locator("#settings-btn, [title='Settings']");
			await gearBtn.click();
			await page.locator("#settings-panel").getByText("Instances").click();
			await page
				.locator("#instance-settings-list")
				.getByText("Work")
				.click();

			await page.click("button:has-text('Remove')");

			// Confirmation dialog should appear
			const confirmModal = page.locator("#confirm-modal");
			await expect(confirmModal).toBeVisible();
			await expect(confirmModal).toContainText("Work");

			// Confirm
			await page.click("#confirm-modal button:has-text('Confirm')");

			const msg = await control.waitForClientMessage(
				(m: unknown) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: string }).type === "instance_remove",
			);
			expect(msg).toMatchObject({
				type: "instance_remove",
				instanceId: "work",
			});
		},
	);
});

// ─── Group 8: ConnectOverlay Instance Actions (DEFERRED) ────────────────────

test.describe("ConnectOverlay: Instance Actions (Deferred)", () => {
	test.fixme(
		"'Start Instance' button when instance is down",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			// Make current instance unhealthy then close WS
			control.sendMessage(personalInstanceUnhealthy);
			await page.waitForTimeout(200);
			control.close();

			const overlay = page.locator("#connect-overlay");
			await expect(overlay).toBeVisible({ timeout: 5_000 });

			const startBtn = overlay.getByText("Start Instance");
			await expect(startBtn).toBeVisible();
		},
	);

	test.fixme(
		"'Switch Instance' button when instance is down",
		async ({ page, baseURL }) => {
			const control = await setupMultiInstance(page, baseURL);

			control.sendMessage(personalInstanceUnhealthy);
			await page.waitForTimeout(200);
			control.close();

			const overlay = page.locator("#connect-overlay");
			await expect(overlay).toBeVisible({ timeout: 5_000 });

			const switchBtn = overlay.getByText("Switch Instance");
			await expect(switchBtn).toBeVisible();
		},
	);
});

// ─── Group 9: Project-Instance Binding UI (DEFERRED) ────────────────────────

test.describe("Project-Instance Binding (Deferred)", () => {
	test.fixme(
		"add project form includes instance selector",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);
			await openProjectSwitcher(page);

			// Click "Add project" button
			const addBtn = page.getByText("Add project");
			await addBtn.click();

			// Instance selector dropdown should appear in the form
			const instanceSelect = page.locator(
				"select[name='instance'], #instance-selector",
			);
			await expect(instanceSelect).toBeVisible();
		},
	);

	test.fixme(
		"instance selector defaults to first healthy instance",
		async ({ page, baseURL }) => {
			await setupMultiInstance(page, baseURL);
			await openProjectSwitcher(page);

			await page.getByText("Add project").click();

			const instanceSelect = page.locator(
				"select[name='instance'], #instance-selector",
			);
			// Should default to "Personal" (first healthy instance)
			await expect(instanceSelect).toContainText("Personal");
		},
	);
});

// ─── Group 10: Dashboard Instance Status (DEFERRED) ─────────────────────────

test.describe("Dashboard: Instance Status Banner (Deferred)", () => {
	test.fixme(
		"banner when no healthy instances",
		async ({ page, baseURL }) => {
			// Set up with all instances unhealthy
			const unhealthyInit = [...multiInstanceInitMessages];
			// Replace the instance_list with all-unhealthy version
			const idx = unhealthyInit.findIndex(
				(m) => m.type === "instance_list",
			);
			if (idx !== -1) {
				unhealthyInit[idx] = {
					type: "instance_list",
					instances: [
						{
							id: "personal",
							name: "Personal",
							port: 4096,
							managed: true,
							status: "unhealthy",
							restartCount: 5,
							createdAt: Date.now(),
						},
						{
							id: "work",
							name: "Work",
							port: 4097,
							managed: true,
							status: "stopped",
							restartCount: 3,
							createdAt: Date.now(),
						},
					],
				};
			}

			await mockRelayWebSocket(page, {
				initMessages: unhealthyInit,
				responses: new Map(),
				initDelay: 0,
				messageDelay: 0,
			});
			await page.goto(baseURL ?? "http://localhost:4173");

			// Banner should appear
			const banner = page.getByText("No healthy OpenCode instances");
			await expect(banner).toBeVisible({ timeout: 10_000 });
		},
	);

	test.fixme(
		"'Manage Instances' link in banner",
		async ({ page, baseURL }) => {
			// Same setup as above
			const unhealthyInit = [...multiInstanceInitMessages];
			const idx = unhealthyInit.findIndex(
				(m) => m.type === "instance_list",
			);
			if (idx !== -1) {
				unhealthyInit[idx] = {
					type: "instance_list",
					instances: [
						{
							id: "personal",
							name: "Personal",
							port: 4096,
							managed: true,
							status: "unhealthy",
							restartCount: 5,
							createdAt: Date.now(),
						},
					],
				};
			}

			await mockRelayWebSocket(page, {
				initMessages: unhealthyInit,
				responses: new Map(),
				initDelay: 0,
				messageDelay: 0,
			});
			await page.goto(baseURL ?? "http://localhost:4173");

			const manageLink = page.getByText("Manage Instances");
			await expect(manageLink).toBeVisible({ timeout: 10_000 });
		},
	);
});

// ─── Group 11: Real Daemon Smoke Test ───────────────────────────────────────
// This test requires a running relay daemon with multiple instances configured.
// Skip if no daemon is available.

test.describe("Real Daemon Smoke (requires daemon)", () => {
	test.fixme(
		"daemon with instances sends instance_list on browser connect",
		async ({ page }) => {
			// This test would need a real E2EHarness with InstanceManager configured.
			// Deferred until we have a test harness that can spawn a daemon with instances.
			//
			// Outline:
			// 1. Start daemon with 2 instances via IPC
			// 2. Connect browser to daemon's relay URL
			// 3. Verify instance_list arrives and UI renders instance grouping
			// 4. Verify header badge shows instance name
			expect(true).toBe(true);
		},
	);
});
```

**Step 2: Run the tests to see what passes and what's fixme'd**

Run: `pnpm run build && pnpm test:multi-instance`
Expected: Groups 1-5 pass (implemented features), Groups 6-11 are skipped (fixme).

**Step 3: Commit**

```
feat: add comprehensive Playwright tests for all multi-instance features

Groups 1-5 test implemented features (should pass):
- ProjectSwitcher instance grouping
- Header instance badge
- ConnectOverlay instance name
- Instance store reactivity
- Status color mapping

Groups 6-10 are test.fixme() for deferred features (TDD stubs):
- Instance Selector dropdown
- Instance Management settings panel
- ConnectOverlay instance actions
- Project-instance binding UI
- Dashboard instance status banner

Group 11: Real daemon smoke test (deferred)
```

---

### Task 5: Fix Any Failing Tests in Groups 1-5

After running the tests, some may fail due to:
- CSS selector mismatches (Tailwind classes may differ from expectations)
- Timing issues (need `waitFor` instead of immediate assertions)
- Mock message format issues (missing fields the frontend requires)

**Step 1: Run tests and capture failures**

Run: `pnpm test:multi-instance --reporter=list 2>&1`

**Step 2: Fix each failure**

For each failing test:
1. Read the error message
2. Check the actual DOM structure with `page.content()` or screenshots
3. Fix selectors, timing, or fixture data as needed

**Step 3: Re-run until Groups 1-5 all pass**

Run: `pnpm test:multi-instance`
Expected: All non-fixme tests pass

**Step 4: Commit**

```
fix: correct selectors and timing in multi-instance Playwright tests
```

---

### Task 6: Add `close()` Method to WsMockControl

The ConnectOverlay tests need to simulate WS disconnect. The `WsMockControl` currently doesn't expose a `close()` method.

**Files:**
- Modify: `test/e2e/helpers/ws-mock.ts`

**Step 1: Add close method**

```ts
// In WsMockControl class:
/** Close the WebSocket connection (simulates server disconnect). */
close(): void {
	if (!this._ws) throw new Error("WebSocket not connected yet");
	this._ws.close();
}
```

**Step 2: Run ConnectOverlay tests specifically**

Run: `pnpm test:multi-instance -g "ConnectOverlay"`
Expected: The two implemented ConnectOverlay tests pass

**Step 3: Commit**

```
feat: add close() to WsMockControl for disconnect testing
```

---

### Task 7: Final Verification and Summary

**Step 1: Run full test suite**

Run: `pnpm test:multi-instance`
Expected output summary:
- Groups 1-5: all PASS
- Groups 6-11: all SKIPPED (fixme)

**Step 2: Run existing tests to verify no regressions**

Run: `pnpm test:visual && pnpm test`
Expected: All existing tests still pass

**Step 3: Commit if any final adjustments**

```
chore: final test adjustments for multi-instance E2E suite
```
