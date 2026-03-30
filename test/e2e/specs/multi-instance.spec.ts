// ─── Multi-Instance E2E Tests ────────────────────────────────────────────────
// Tests all multi-instance UI features defined in the multi-instance plan.
//
// Groups 1-14: Implemented features (all passing)
//
// Uses WS mock — no real OpenCode or relay needed (except Group 14 daemon smoke).
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import {
	multiInstanceInitMessages,
	noInstanceInitMessages,
	personalInstanceUnhealthy,
	singleInstanceInitMessages,
	workInstanceHealthy,
	workInstanceStarting,
	workInstanceStopped,
} from "../fixtures/mockup-state.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;
type WsMockControl = Awaited<ReturnType<typeof mockRelayWebSocket>>;

/** The project URL for multi-instance tests (must match fixture's current slug). */
const PROJECT_URL = "/p/myapp/";

/** Wait for the chat page to be ready (WS connected, input visible). */
async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	// Overlay uses class not id, and it fades out via opacity transition.
	// Wait for it to be either removed from DOM or have opacity 0 (fadeOut).
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

/** Set up WS mock with multi-instance init, navigate, wait for ready. */
async function setupMultiInstance(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: multiInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

/** Set up WS mock with single-instance init, navigate, wait for ready. */
async function setupSingleInstance(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: singleInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

/** Set up WS mock with no instances (for Getting Started panel tests). */
async function setupNoInstances(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: noInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

/** Open the ProjectSwitcher dropdown. On mobile, opens hamburger first. */
async function openProjectSwitcher(page: Page): Promise<void> {
	const hamburger = page.locator("#hamburger-btn");
	if (await hamburger.isVisible()) {
		await hamburger.click();
		await page.locator("#project-switcher-btn").waitFor({ state: "visible" });
	}
	const switcherBtn = page.locator("#project-switcher-btn");
	await switcherBtn.click();
	// Wait for the dropdown container to appear
	await page
		.locator("[data-testid='project-switcher-dropdown']")
		.waitFor({ state: "visible" });
}

// ─── Group 1: ProjectSwitcher Instance Grouping (IMPLEMENTED) ──────────────

test.describe("ProjectSwitcher: Instance Grouping", () => {
	test("groups projects by instance when multiple instances exist", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		// Instance group headers have specific styling
		const instanceHeaders = page.locator(
			"[data-testid='instance-group-header']",
		);
		await expect(instanceHeaders).toHaveCount(2);
		await expect(instanceHeaders.nth(0)).toContainText("Personal");
		await expect(instanceHeaders.nth(1)).toContainText("Work");
	});

	test("shows flat list when single instance", async ({ page, baseURL }) => {
		await setupSingleInstance(page, baseURL);
		await openProjectSwitcher(page);

		// No instance group headers
		const instanceHeaders = page.locator(
			"[data-testid='instance-group-header']",
		);
		await expect(instanceHeaders).toHaveCount(0);
	});

	test("shows instance status color in group header", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		const instanceHeaders = page.locator(
			"[data-testid='instance-group-header']",
		);

		// Personal = healthy = green dot
		const personalDot = instanceHeaders
			.nth(0)
			.locator("[data-testid='instance-status-dot']");
		await expect(personalDot).toHaveClass(/bg-green-500/);

		// Work = unhealthy = red dot
		const workDot = instanceHeaders
			.nth(1)
			.locator("[data-testid='instance-status-dot']");
		await expect(workDot).toHaveClass(/bg-red-500/);
	});

	test("updates instance status color on instance_status message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		const instanceHeaders = page.locator(
			"[data-testid='instance-group-header']",
		);
		const workDot = instanceHeaders
			.nth(1)
			.locator("[data-testid='instance-status-dot']");
		await expect(workDot).toHaveClass(/bg-red-500/);

		// Send status update: work becomes healthy
		control.sendMessage(workInstanceHealthy);
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

		// Badge in header-left with instance name
		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toBeVisible();
		await expect(badge).toContainText("Personal");
	});

	test("hides instance badge with single instance", async ({
		page,
		baseURL,
	}) => {
		await setupSingleInstance(page, baseURL);

		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toHaveCount(0);
	});

	test("badge shows correct instance name and status color", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);

		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toContainText("Personal");

		// Status dot inside badge should be green (healthy)
		const dot = badge.locator("[data-testid='instance-status-dot']");
		await expect(dot).toHaveClass(/bg-green-500/);
	});

	test("badge updates on instance_status message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		const badge = page.locator("[data-testid='instance-badge']");
		const dot = badge.locator("[data-testid='instance-status-dot']");
		await expect(dot).toHaveClass(/bg-green-500/);

		// Send: Personal becomes unhealthy
		control.sendMessage(personalInstanceUnhealthy);
		await expect(dot).toHaveClass(/bg-red-500/);
	});
});

// ─── Group 3: ConnectOverlay Instance Name (PARTIALLY IMPLEMENTED) ──────────
// The overlay shows `Connecting to ${instanceName}...` only when statusText is
// empty (initial connection). After disconnect, statusText is "Disconnected" and
// the instanceName fallback is not displayed.
//
// Current behavior: instanceName resolves from the instance store, but the store
// is empty during initial connect (instance_list arrives after WS connects),
// so the overlay always shows "Connecting to OpenCode..." on first load.
//
// The instance-aware disconnect message (e.g., "OpenCode instance 'work' is not
// responding") from the design doc is NOT yet implemented.

test.describe("ConnectOverlay: Instance Name", () => {
	// The ConnectOverlay shows `Connecting to ${instanceName}...` only when
	// wsState.statusText is empty (initial connection). However:
	// 1. During initial connect, the instance store is empty → always "OpenCode"
	// 2. After disconnect, statusText is "Disconnected" → instanceName not shown
	// 3. The WS mock connects instantly → overlay hides before we can assert
	//
	// Both tests are deferred until the overlay is enhanced per the design doc
	// to show instance-specific messages like "OpenCode instance 'work' is not
	// responding. [Start Instance] [Switch Instance]"

	test("shows instance name in connecting message when instance store is populated", async ({
		page,
		baseURL,
	}) => {
		// The overlay should show "Connecting to Personal..." when reconnecting
		// to an instance that was previously known. This requires the overlay to
		// use the instance store even after disconnect (currently it's cleared).
		const control = await setupMultiInstance(page, baseURL);
		control.close();
		const overlay = page.locator(".connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		await expect(overlay).toContainText("Personal");
	});

	test("falls back to 'OpenCode' with no instance binding", async ({
		page,
		baseURL,
	}) => {
		const control = await setupSingleInstance(page, baseURL);
		control.close();
		const overlay = page.locator(".connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		await expect(overlay).toContainText("OpenCode");
	});
});

// ─── Group 4: Instance Store Reactivity (IMPLEMENTED) ───────────────────────

test.describe("Instance Store: Reactivity", () => {
	test("instance_list message populates UI", async ({ page, baseURL }) => {
		await setupMultiInstance(page, baseURL);

		// Header badge proves store → UI reactivity
		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toBeVisible();

		// ProjectSwitcher grouping proves store → ProjectSwitcher
		await openProjectSwitcher(page);
		const instanceHeaders = page.locator(
			"[data-testid='instance-group-header']",
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
			"[data-testid='instance-group-header']",
		);

		// Personal = green, Work = red initially
		await expect(
			instanceHeaders.nth(0).locator("[data-testid='instance-status-dot']"),
		).toHaveClass(/bg-green-500/);
		await expect(
			instanceHeaders.nth(1).locator("[data-testid='instance-status-dot']"),
		).toHaveClass(/bg-red-500/);

		// Update only Work to healthy
		control.sendMessage(workInstanceHealthy);

		// Work should now be green
		await expect(
			instanceHeaders.nth(1).locator("[data-testid='instance-status-dot']"),
		).toHaveClass(/bg-green-500/);

		// Personal should STILL be green
		await expect(
			instanceHeaders.nth(0).locator("[data-testid='instance-status-dot']"),
		).toHaveClass(/bg-green-500/);
	});

	test("store clears on WS disconnect", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);

		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toBeVisible();

		// Close WS — store should clear
		control.close();

		// Badge should disappear (instances cleared → length ≤ 1)
		await expect(badge).toBeHidden({ timeout: 5_000 });
	});
});

// ─── Group 5: Status Color Mapping (IMPLEMENTED) ───────────────────────────

test.describe("Status Color Mapping", () => {
	test("each status maps to correct color", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);

		const instanceHeaders = page.locator(
			"[data-testid='instance-group-header']",
		);
		const workDot = instanceHeaders
			.nth(1)
			.locator("[data-testid='instance-status-dot']");

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

// ─── Group 6: Instance Selector Dropdown ─────────────────────────────────

test.describe("Instance Selector Dropdown", () => {
	test("clicking header badge opens instance selector dropdown", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const badge = page.locator("[data-testid='instance-badge']");
		await badge.click();
		const dropdown = page.locator("#instance-selector-dropdown");
		await expect(dropdown).toBeVisible();
	});

	test("dropdown lists all instances with health status", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const badge = page.locator("[data-testid='instance-badge']");
		await badge.click();
		const dropdown = page.locator("#instance-selector-dropdown");
		await expect(dropdown).toContainText("Personal");
		await expect(dropdown).toContainText("Work");
		const dots = dropdown.locator("[data-testid='instance-status-dot']");
		await expect(dots).toHaveCount(2);
	});

	// NOTE: The old "selecting instance switches to its projects" test was deleted.
	// That behavior was replaced by the Bug B fix: clicking an instance in the
	// dropdown now rebinds the current project's instance (see Group 12:
	// "Instance Selector: Rebind Project").

	test("'Manage Instances' link at bottom of dropdown", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const badge = page.locator("[data-testid='instance-badge']");
		await badge.click();
		const manageLink = page
			.locator("#instance-selector-dropdown")
			.getByText("Manage Instances");
		await expect(manageLink).toBeVisible();
	});
});

// ─── Group 7: Instance Management Settings Panel ─────────────────────────

test.describe("Instance Management Settings", () => {
	test("gear icon opens settings with Instances tab", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		const settingsPanel = page.locator("#settings-panel");
		await expect(settingsPanel).toBeVisible();
		const instancesTab = settingsPanel.getByText("Instances");
		await expect(instancesTab).toBeVisible();
	});

	test("instances tab lists all instances with status and port", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();
		const instanceList = page.locator("#instance-settings-list");
		await expect(instanceList).toContainText("Personal");
		await expect(instanceList).toContainText("Work");
		await expect(instanceList).toContainText("4096");
		await expect(instanceList).toContainText("4097");
	});

	test("instance expand shows start/stop/rename/remove buttons for managed instances", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Personal").click();
		await expect(page.getByText("Start")).toBeVisible();
		await expect(page.getByText("Stop")).toBeVisible();
		await expect(
			page.locator("[data-testid='rename-instance-btn']"),
		).toBeVisible();
		await expect(page.getByText("Remove")).toBeVisible();
	});

	test("start button sends instance_start WS message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
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
	});

	test("stop button sends instance_stop WS message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Personal").click();
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
	});

	test("remove button shows confirmation then sends instance_remove", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Work").click();
		await page.click("button:has-text('Remove')");
		const confirmModal = page.locator("#confirm-modal");
		await expect(confirmModal).toBeVisible();
		await expect(confirmModal).toContainText("Work");
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
	});

	test("new instance appears after server sends updated instance_list", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Verify only 2 instances initially
		const instanceList = page.locator("#instance-settings-list");
		await expect(instanceList).toContainText("Personal");
		await expect(instanceList).toContainText("Work");

		// Simulate server auto-discovering a new instance (scanner finds it)
		control.sendMessage({
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
				{
					id: "discovered-4098",
					name: "OpenCode :4098",
					port: 4098,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		});

		// The new instance should appear in the settings list
		await expect(instanceList.getByText("OpenCode :4098")).toBeVisible({
			timeout: 3_000,
		});
		await expect(instanceList).toContainText("4098");
	});

	test("Scan Now button sends scan_now WS message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		const scanBtn = page.locator("[data-testid='scan-now-btn']");
		await expect(scanBtn).toBeVisible();
		await scanBtn.click();

		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "scan_now",
		);
		expect(msg).toMatchObject({ type: "scan_now" });
	});

	test("inline rename sends instance_rename WS message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Expand instance and click Rename
		await page.locator("#instance-settings-list").getByText("Work").click();
		await page.locator("[data-testid='rename-instance-btn']").click();

		// Fill new name and press Enter
		const renameInput = page
			.locator("#instance-settings-list input[type='text']")
			.first();
		await expect(renameInput).toBeVisible();
		await renameInput.fill("Production");
		await renameInput.press("Enter");

		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "instance_rename",
		);
		expect(msg).toMatchObject({
			type: "instance_rename",
			instanceId: "work",
			name: "Production",
		});
	});
});

// ─── Group 8: ConnectOverlay Instance Actions ────────────────────────────

test.describe("ConnectOverlay: Instance Actions", () => {
	test("'Start Instance' button when instance is down", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		control.sendMessage(personalInstanceUnhealthy);
		await page.waitForTimeout(200);
		control.close();
		const overlay = page.locator("#connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		const startBtn = overlay.getByText("Start Instance");
		await expect(startBtn).toBeVisible();
	});

	test("'Switch Instance' button when instance is down", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		control.sendMessage(personalInstanceUnhealthy);
		await page.waitForTimeout(200);
		control.close();
		const overlay = page.locator("#connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		const switchBtn = overlay.getByText("Switch Instance");
		await expect(switchBtn).toBeVisible();
	});
});

// ─── Group 9: Project-Instance Binding UI ────────────────────────────────

test.describe("Project-Instance Binding", () => {
	test("add project form includes instance selector", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);
		const addBtn = page.getByText("Add project");
		await addBtn.click();
		const instanceSelect = page.locator(
			"select[name='instance'], #instance-selector",
		);
		await expect(instanceSelect).toBeVisible();
	});

	test("instance selector defaults to first healthy instance", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();
		const instanceSelect = page.locator(
			"select[name='instance'], #instance-selector",
		);
		await expect(instanceSelect).toContainText("Personal");
	});
});

// ─── Group 10: Dashboard Instance Status ─────────────────────────────────

test.describe("Dashboard: Instance Status Banner", () => {
	test("banner when no healthy instances", async ({ page, baseURL }) => {
		// Custom init with all instances unhealthy
		const unhealthyInit = multiInstanceInitMessages.map((m) => {
			if (m.type === "instance_list") {
				return {
					type: "instance_list" as const,
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
							status: "unhealthy",
							restartCount: 3,
							createdAt: Date.now(),
						},
					],
				};
			}
			return m;
		});
		await mockRelayWebSocket(page, {
			initMessages: unhealthyInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});
		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);
		const banner = page.getByText("No healthy OpenCode instances");
		await expect(banner).toBeVisible({ timeout: 10_000 });
	});

	test("'Manage Instances' link in banner", async ({ page, baseURL }) => {
		const unhealthyInit = multiInstanceInitMessages.map((m) => {
			if (m.type === "instance_list") {
				return {
					type: "instance_list" as const,
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
			return m;
		});
		await mockRelayWebSocket(page, {
			initMessages: unhealthyInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});
		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);
		const manageLink = page.getByText("Manage Instances");
		await expect(manageLink).toBeVisible({ timeout: 10_000 });
	});

	test("banner hidden when at least one instance is healthy", async ({
		page,
		baseURL,
	}) => {
		// Standard multi-instance setup has "personal" healthy + "work" unhealthy
		await setupMultiInstance(page, baseURL);
		const banner = page.getByText("No healthy OpenCode instances");
		// Banner should NOT be visible because "personal" is healthy
		await expect(banner).not.toBeVisible({ timeout: 5_000 });
	});

	test("banner disappears when unhealthy instance becomes healthy", async ({
		page,
		baseURL,
	}) => {
		// Start with ALL instances unhealthy → banner shows
		const unhealthyInit = multiInstanceInitMessages.map((m) => {
			if (m.type === "instance_list") {
				return {
					type: "instance_list" as const,
					instances: [
						{
							id: "personal",
							name: "Personal",
							port: 4096,
							managed: false,
							status: "unhealthy",
							restartCount: 0,
							createdAt: Date.now(),
						},
					],
				};
			}
			return m;
		});
		const control = await mockRelayWebSocket(page, {
			initMessages: unhealthyInit,
			responses: new Map(),
			initDelay: 0,
			messageDelay: 0,
		});
		await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
		await waitForChatReady(page);

		const banner = page.getByText("No healthy OpenCode instances");
		await expect(banner).toBeVisible({ timeout: 10_000 });

		// Send instance_status to make it healthy (simulates health poll succeeding)
		control.sendMessage({
			type: "instance_status",
			instanceId: "personal",
			status: "healthy",
		});

		// Banner should disappear
		await expect(banner).not.toBeVisible({ timeout: 5_000 });
	});
});

// ─── Group 11: Add Project with Instance Binding ────────────────────────────

test.describe("Add Project: Instance Binding", () => {
	test("add_project WS message includes selected instanceId", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openProjectSwitcher(page);
		await page.getByText("Add project").click();

		// Fill directory
		await page.fill(
			"[data-testid='project-switcher-dropdown'] input[type='text']",
			"~/src/work/ds/test-generator-skill",
		);

		// Select "Work" instance
		const instanceSelect = page.locator("#instance-selector");
		await instanceSelect.selectOption("work");

		// Click "Add"
		await page.click("text=Add");

		// Verify the add_project message includes instanceId
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "add_project",
		);
		expect(msg).toMatchObject({
			type: "add_project",
			directory: "~/src/work/ds/test-generator-skill",
			instanceId: "work",
		});
	});
});

// ─── Group 12: Instance Selector Rebinds Current Project ────────────────────

test.describe("Instance Selector: Rebind Project", () => {
	test("clicking instance in dropdown sends set_project_instance and updates badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		// Badge should show "Personal" (myapp's instanceId is "personal")
		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toContainText("Personal");

		// Click badge to open dropdown
		await badge.click();
		const dropdown = page.locator("#instance-selector-dropdown");
		await expect(dropdown).toBeVisible();

		// Click "Work" in the dropdown
		await dropdown.getByText("Work").click();

		// Should send a set_project_instance message
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "set_project_instance",
		);
		expect(msg).toMatchObject({
			type: "set_project_instance",
			slug: "myapp",
			instanceId: "work",
		});

		// Simulate server responding with updated project_list
		control.sendMessage({
			type: "project_list",
			projects: [
				{
					slug: "myapp",
					title: "myapp",
					directory: "/src/myapp",
					instanceId: "work",
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
		});

		// Badge should now show "Work"
		await expect(badge).toContainText("Work", { timeout: 3_000 });
	});
});

// ─── Group 13: Instance Status Updates in Settings ──────────────────────────

test.describe("Settings: Instance Status Updates", () => {
	test("instance_status message updates status color in settings panel", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		// Open settings and navigate to Instances tab
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		const settingsPanel = page.locator("#settings-panel");
		await expect(settingsPanel).toBeVisible();
		await settingsPanel.getByText("Instances").click();

		// "Work" instance should show red dot (unhealthy status from fixture)
		const instanceList = page.locator("#instance-settings-list");
		const workRow = instanceList.locator("button", { hasText: "Work" });
		await expect(workRow).toBeVisible();
		const workDot = workRow.locator("[class*='rounded-full']");
		await expect(workDot).toHaveClass(/bg-red-500/);

		// Send instance_status to make Work "starting" (yellow)
		control.sendMessage({
			type: "instance_status",
			instanceId: "work",
			status: "starting",
		});

		// Dot should turn yellow
		await expect(workDot).toHaveClass(/bg-yellow-500/, { timeout: 3_000 });

		// Send instance_status to make Work "healthy" (green)
		control.sendMessage({
			type: "instance_status",
			instanceId: "work",
			status: "healthy",
		});

		// Dot should turn green
		await expect(workDot).toHaveClass(/bg-green-500/, { timeout: 3_000 });
	});
});

// ─── Group 14: Real Daemon Smoke ─────────────────────────────────────────────
// Moved to daemon-smoke.spec.ts — uses the DaemonHarness fixture instead of
// inline Daemon setup. Run via: pnpm test:daemon

// ─── Group 15: Auto-Discovery & Getting Started Panel ────────────────────────

test.describe("Auto-Discovery: Getting Started Panel", () => {
	test("Getting Started panel shows when no instances exist", async ({
		page,
		baseURL,
	}) => {
		await setupNoInstances(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Should show "No OpenCode instances detected" message
		await expect(
			page.getByText("No OpenCode instances detected"),
		).toBeVisible();

		// Should show three scenario cards
		await expect(page.getByText("Quick Start — Direct API Key")).toBeVisible();
		await expect(page.getByText("Multi-Provider — Via CCS")).toBeVisible();
		await expect(page.getByText("Custom Setup")).toBeVisible();
	});

	test("scenario cards expand to show copyable commands", async ({
		page,
		baseURL,
	}) => {
		await setupNoInstances(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Click "Quick Start" to expand
		await page.getByText("Quick Start — Direct API Key").click();

		// Should show terminal commands
		await expect(page.getByText("opencode serve --port 4098")).toBeVisible();
		await expect(
			page.getByText("It will appear here automatically.", { exact: true }),
		).toBeVisible();
	});

	test("Getting Started hides when instances arrive", async ({
		page,
		baseURL,
	}) => {
		const control = await setupNoInstances(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Getting Started panel should be visible
		await expect(
			page.getByText("No OpenCode instances detected"),
		).toBeVisible();

		// Simulate auto-discovery: server sends instance_list with a discovered instance
		control.sendMessage({
			type: "instance_list",
			instances: [
				{
					id: "discovered-4098",
					name: "OpenCode :4098",
					port: 4098,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		});

		// Getting Started should disappear
		await expect(
			page.getByText("No OpenCode instances detected"),
		).not.toBeVisible({ timeout: 3_000 });

		// Instance list should appear
		await expect(
			page.locator("#instance-settings-list").getByText("OpenCode :4098"),
		).toBeVisible({ timeout: 3_000 });
	});

	test("'Scan Now' link in Getting Started sends scan_now", async ({
		page,
		baseURL,
	}) => {
		const control = await setupNoInstances(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Click "Scan Now" link at bottom of Getting Started
		const scanLink = page.locator("[data-testid='scan-now-link']");
		await expect(scanLink).toBeVisible();
		await scanLink.click();

		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "scan_now",
		);
		expect(msg).toMatchObject({ type: "scan_now" });
	});

	test("discovered instance shows 'discovered' badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		const gearBtn = page.locator("#settings-btn, [title='Settings']");
		await gearBtn.click();
		await page.locator("#settings-panel").getByText("Instances").click();

		// Send an instance_list with a discovered (unmanaged) instance
		control.sendMessage({
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
					id: "discovered-4098",
					name: "OpenCode :4098",
					port: 4098,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		});

		// The discovered instance should show a "discovered" badge
		const instanceList = page.locator("#instance-settings-list");
		await expect(instanceList.getByText("discovered")).toBeVisible({
			timeout: 3_000,
		});
	});
});
