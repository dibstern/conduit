// Tests all multi-instance UI features defined in the multi-instance plan.
//
// Groups 1-14: Implemented features (all passing)
//
// Uses WS mock — no real OpenCode or relay needed (except Group 14 daemon smoke).
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import {
	instancesWith,
	multiInstanceInitMessages,
	noInstanceInitMessages,
	singleInstanceInitMessages,
} from "../fixtures/mockup-state.js";
import { mockWsRpc, type RpcMockControl } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;
type WsMockControl = Awaited<ReturnType<typeof mockRelayWebSocket>>;
type MultiInstanceControl = WsMockControl & { rpc: RpcMockControl };

/** Hold the RPC retry so the disconnected overlay can be inspected. */
async function disconnectControl(
	page: Page,
	rpc: RpcMockControl,
): Promise<void> {
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
	rpc.closeStreamSocket("SubscribeInstances");
}

/** Health changes reach the browser as a fresh SubscribeInstances list. */
const pushInstances = (
	rpc: RpcMockControl,
	statuses: Record<string, string>,
): void =>
	rpc.setDaemonList("SubscribeInstances", {
		instances: instancesWith(statuses),
	});

/** The project URL for multi-instance tests (must match fixture's current slug). */
const PROJECT_URL = "/?p=myapp";

/** Wait for the routed app shell to be ready and connected. */
async function waitForChatReady(page: Page): Promise<void> {
	// Use the test-level timeout (default 30s) rather than a hardcoded 10s.
	// The SPA needs to load a ~2.4MB bundle, mount Svelte, connect the
	// mocked WS, receive init messages, and render — under resource
	// pressure this can exceed 10s.
	await page.locator("#layout").waitFor({ state: "attached" });
	// On a phone the list route hides #app, including the connection overlay, so
	// visibility cannot prove readiness. Wait for the overlay to unmount instead.
	await page.waitForFunction(
		() => document.querySelector(".connect-overlay") === null,
	);
}

/** Navigate and wait for SPA readiness. */
async function gotoAndWait(
	page: Page,
	baseURL: string | undefined,
): Promise<void> {
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`, {
		waitUntil: "domcontentloaded",
	});
	await waitForChatReady(page);
}

/** Set up WS mock with multi-instance init, navigate, wait for ready. */
async function setupMultiInstance(
	page: Page,
	baseURL?: string,
): Promise<MultiInstanceControl> {
	const rpc = await mockInstanceRpc(page);
	const control = await mockRelayWebSocket(page, {
		initMessages: multiInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await gotoAndWait(page, baseURL);
	return Object.assign(control, { rpc });
}

/** Set up WS mock with single-instance init, navigate, wait for ready. */
async function setupSingleInstance(
	page: Page,
	baseURL?: string,
): Promise<MultiInstanceControl> {
	const rpc = await mockInstanceRpc(page);
	const control = await mockRelayWebSocket(page, {
		initMessages: singleInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await gotoAndWait(page, baseURL);
	return Object.assign(control, { rpc });
}

/** Set up WS mock with no instances (for Getting Started panel tests). */
async function setupNoInstances(
	page: Page,
	baseURL?: string,
): Promise<MultiInstanceControl> {
	const rpc = await mockInstanceRpc(page);
	const control = await mockRelayWebSocket(page, {
		initMessages: noInstanceInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await gotoAndWait(page, baseURL);
	return Object.assign(control, { rpc });
}

async function mockInstanceRpc(page: Page): Promise<RpcMockControl> {
	return await mockWsRpc(page, {
		handlers: {
			DetectProxy: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				found: false,
				port: 8317,
			}),
			StartInstance: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				instances: instancesWith({ personal: "unhealthy", work: "starting" }),
			}),
			StopInstance: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				instances: instancesWith({ personal: "unhealthy", work: "stopped" }),
			}),
			RemoveInstance: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				instances: instancesWith({ personal: "unhealthy" }).filter(
					(instance) => instance.id === "personal",
				),
			}),
			RenameInstance: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				instances: instancesWith({
					personal: "unhealthy",
					work: "healthy",
				}).map((instance) =>
					instance.id === "work"
						? { ...instance, name: String(params["name"] ?? "Work") }
						: instance,
				),
			}),
			ScanNow: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				discovered: [4098],
				lost: [],
				active: [4096, 4098],
			}),
			SetProjectInstance: (params) => ({
				projectSlug: String(params["projectSlug"] ?? "myapp"),
				projects: [
					{
						slug: "myapp",
						title: "myapp",
						folders: ["/src/myapp"],
						instanceId: String(params["instanceId"] ?? "personal"),
					},
					{
						slug: "company-api",
						title: "company-api",
						folders: ["/src/company-api"],
						instanceId: "work",
					},
				],
				current: "myapp",
			}),
		},
	});
}

/**
 * Settings lives in the list overflow or session title sheet on a phone,
 * and in the session bar overflow on desktop.
 */
async function openSettingsPanel(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
		return;
	}
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
		return;
	}
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
}

/** The status dot of one instance in the header badge's dropdown. */
function instanceDot(page: Page, name: string) {
	return page
		.locator("[data-testid='instance-selector-dropdown']")
		.getByRole("menuitemradio", { name })
		.locator("[data-testid='instance-status-dot']");
}

// Group 2: Header Instance Badge (IMPLEMENTED)

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

	test("badge updates on an instance list update", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		const badge = page.locator("[data-testid='instance-badge']");
		const dot = badge.locator("[data-testid='instance-status-dot']");
		await expect(dot).toHaveClass(/bg-green-500/);

		// Send: Personal becomes unhealthy
		pushInstances(control.rpc, { personal: "unhealthy" });
		await expect(dot).toHaveClass(/bg-red-500/);
	});
});

// Group 3: ConnectOverlay Instance Name (PARTIALLY IMPLEMENTED)
// The overlay shows `Connecting to ${instanceName}...` only when statusText is
// empty (initial connection). After disconnect, statusText is "Disconnected" and
// the generic reconnecting copy is displayed.
//
// Current behavior: instanceName resolves from the instance store, but the store
// is empty during initial connect (the instance list arrives after connecting),
// so the overlay always shows "Connecting to OpenCode..." on first load.
//
// The instance-aware disconnect message (e.g., "OpenCode instance 'work' is not
// responding") from the design doc is NOT yet implemented.

test.describe("ConnectOverlay: Reconnect Message", () => {
	test("shows generic reconnecting message when instance store is populated", async ({
		page,
		baseURL,
	}) => {
		await page.clock.install();
		const control = await setupMultiInstance(page, baseURL);
		await disconnectControl(page, control.rpc);
		const overlay = page.locator(".connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		await expect(overlay).toContainText("Reconnecting...");
	});

	test("shows generic reconnecting message with no instance binding", async ({
		page,
		baseURL,
	}) => {
		await page.clock.install();
		const control = await setupSingleInstance(page, baseURL);
		await disconnectControl(page, control.rpc);
		const overlay = page.locator(".connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		await expect(overlay).toContainText("Reconnecting...");
	});
});

// Group 4: Instance Store Reactivity (IMPLEMENTED)

test.describe("Instance Store: Reactivity", () => {
	test("instance list populates UI", async ({ page, baseURL }) => {
		await setupMultiInstance(page, baseURL);

		// The header badge and its dropdown both read the instance store.
		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toBeVisible();
		await badge.click();
		const dropdown = page.locator("[data-testid='instance-selector-dropdown']");
		await expect(dropdown.getByRole("menuitemradio")).toHaveCount(2);
	});

	test("instance list status change updates only that instance", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await page.locator("[data-testid='instance-badge']").click();
		const personalDot = instanceDot(page, "Personal");
		const workDot = instanceDot(page, "Work");

		// Personal = green, Work = red initially
		await expect(personalDot).toHaveClass(/bg-green-500/);
		await expect(workDot).toHaveClass(/bg-red-500/);

		// Update only Work to healthy
		pushInstances(control.rpc, { work: "healthy" });
		await expect(workDot).toHaveClass(/bg-green-500/);

		// Personal should STILL be green, in the dropdown and on the badge
		await expect(personalDot).toHaveClass(/bg-green-500/);
		await expect(
			page.locator(
				"[data-testid='instance-badge'] [data-testid='instance-status-dot']",
			),
		).toHaveClass(/bg-green-500/);
	});

	test("store survives a /ws disconnect", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);

		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toBeVisible();

		// The list rides the RPC subscription, so closing /ws must not empty it:
		// nothing on /ws would re-populate it after the reconnect.
		control.close();
		await expect(page.locator(".connect-overlay")).toBeHidden({
			timeout: 5_000,
		});
		await expect(badge).toContainText("Personal");
	});
});

// Group 5: Status Color Mapping (IMPLEMENTED)

test.describe("Status Color Mapping", () => {
	test("each status maps to correct color", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await page.locator("[data-testid='instance-badge']").click();
		const workDot = instanceDot(page, "Work");

		// unhealthy (initial) = red
		await expect(workDot).toHaveClass(/bg-red-500/);

		// starting = yellow
		pushInstances(control.rpc, { work: "starting" });
		await expect(workDot).toHaveClass(/bg-yellow-500/);

		// healthy = green
		pushInstances(control.rpc, { work: "healthy" });
		await expect(workDot).toHaveClass(/bg-green-500/);

		// stopped = zinc/gray
		pushInstances(control.rpc, { work: "stopped" });
		await expect(workDot).toHaveClass(/bg-zinc-500/);
	});
});

test.describe("Instance Selector Dropdown", () => {
	test("clicking header badge opens instance selector dropdown", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const badge = page.locator("[data-testid='instance-badge']");
		await badge.click();
		const dropdown = page.locator("[data-testid='instance-selector-dropdown']");
		await expect(dropdown).toBeVisible();
	});

	test("dropdown lists all instances with health status", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		const badge = page.locator("[data-testid='instance-badge']");
		await badge.click();
		const dropdown = page.locator("[data-testid='instance-selector-dropdown']");
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
			.locator("[data-testid='instance-selector-dropdown']")
			.getByText("Manage Instances");
		await expect(manageLink).toBeVisible();
	});
});

test.describe("Instance Management Settings", () => {
	test("gear icon opens settings with Instances tab", async ({
		page,
		baseURL,
	}) => {
		await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
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
		await openSettingsPanel(page);
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
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Personal").click();
		await expect(page.getByText("Start")).toBeVisible();
		await expect(page.getByText("Stop")).toBeVisible();
		await expect(
			page.locator("[data-testid='rename-instance-btn']"),
		).toBeVisible();
		await expect(page.getByText("Remove")).toBeVisible();
	});

	test("start button sends StartInstance RPC", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Work").click();
		await page.click("button:has-text('Start')");
		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "StartInstance",
		);
		expect(request.payload).toMatchObject({
			instanceId: "work",
		});
	});

	test("stop button sends StopInstance RPC", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Personal").click();
		await page.click("button:has-text('Stop')");
		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "StopInstance",
		);
		expect(request.payload).toMatchObject({
			instanceId: "personal",
		});
	});

	test("remove button shows confirmation then sends RemoveInstance RPC", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();
		await page.locator("#instance-settings-list").getByText("Work").click();
		await page.click("button:has-text('Remove')");
		const confirmModal = page.locator("#confirm-modal");
		await expect(confirmModal).toBeVisible();
		await expect(confirmModal).toContainText("Work");
		await page.click("#confirm-modal button:has-text('Confirm')");
		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "RemoveInstance",
		);
		expect(request.payload).toMatchObject({
			instanceId: "work",
		});
	});

	test("new instance appears after the daemon publishes an updated list", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();

		// Verify only 2 instances initially
		const instanceList = page.locator("#instance-settings-list");
		await expect(instanceList).toContainText("Personal");
		await expect(instanceList).toContainText("Work");

		// Simulate server auto-discovering a new instance (scanner finds it)
		control.rpc.setDaemonList("SubscribeInstances", {
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

	test("Scan Now button sends ScanNow RPC", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();

		const scanBtn = page.locator("[data-testid='scan-now-btn']");
		await expect(scanBtn).toBeVisible();
		await scanBtn.click();

		await control.rpc.waitForRequest((req) => req.tag === "ScanNow");
	});

	test("inline rename sends RenameInstance RPC", async ({ page, baseURL }) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
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

		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "RenameInstance",
		);
		expect(request.payload).toMatchObject({
			instanceId: "work",
			name: "Production",
		});
	});
});

test.describe("ConnectOverlay: Instance Actions", () => {
	test("'Start Instance' button when instance is down", async ({
		page,
		baseURL,
	}) => {
		await page.clock.install();
		const control = await setupMultiInstance(page, baseURL);
		pushInstances(control.rpc, { personal: "unhealthy" });
		await expect(
			page.locator("[data-testid='instance-status-dot']"),
		).toHaveClass(/bg-red-500/);
		await disconnectControl(page, control.rpc);
		const overlay = page.locator("#connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		const startBtn = overlay.getByText("Start Instance");
		await expect(startBtn).toBeVisible();
	});

	test("'Switch Instance' button when instance is down", async ({
		page,
		baseURL,
	}) => {
		await page.clock.install();
		const control = await setupMultiInstance(page, baseURL);
		pushInstances(control.rpc, { personal: "unhealthy" });
		await expect(
			page.locator("[data-testid='instance-status-dot']"),
		).toHaveClass(/bg-red-500/);
		await disconnectControl(page, control.rpc);
		const overlay = page.locator("#connect-overlay");
		await expect(overlay).toBeVisible({ timeout: 5_000 });
		const switchBtn = overlay.getByText("Switch Instance");
		await expect(switchBtn).toBeVisible();
	});
});

test.describe("Session List: Instance Status Banner", () => {
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
		await mockInstanceRpc(page);
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
		await mockInstanceRpc(page);
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
		const rpc = await mockInstanceRpc(page);
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

		// A healthy list clears the banner (simulates health poll succeeding)
		pushInstances(rpc, { personal: "healthy" });

		// Banner should disappear
		await expect(banner).not.toBeVisible({ timeout: 5_000 });
	});
});

test.describe("Instance Selector: Rebind Project", () => {
	test("clicking instance in dropdown sends SetProjectInstance RPC and updates badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		// Badge should show "Personal" (myapp's instanceId is "personal")
		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).toContainText("Personal");

		// Click badge to open dropdown
		await badge.click();
		const dropdown = page.locator("[data-testid='instance-selector-dropdown']");
		await expect(dropdown).toBeVisible();

		// Click "Work" in the dropdown
		await dropdown.getByText("Work").click();

		const request = await control.rpc.waitForRequest(
			(req) => req.tag === "SetProjectInstance",
		);
		expect(request.payload).toMatchObject({
			slug: "myapp",
			instanceId: "work",
		});

		// The daemon publishes the rebound project list to every subscriber.
		control.rpc.setDaemonList("SubscribeProjects", {
			projects: [
				{
					slug: "myapp",
					title: "myapp",
					folders: ["/src/myapp"],
					instanceId: "work",
				},
				{
					slug: "mylib",
					title: "mylib",
					folders: ["/src/mylib"],
					instanceId: "personal",
				},
				{
					slug: "company-api",
					title: "company-api",
					folders: ["/src/company-api"],
					instanceId: "work",
				},
			],
			current: "myapp",
		});

		// Badge should now show "Work"
		await expect(badge).toContainText("Work", { timeout: 3_000 });
	});
});

test.describe("Settings: Instance Status Updates", () => {
	test("instance list update changes status color in settings panel", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);

		// Open settings and navigate to Instances tab
		await openSettingsPanel(page);
		const settingsPanel = page.locator("#settings-panel");
		await expect(settingsPanel).toBeVisible();
		await settingsPanel.getByText("Instances").click();

		// "Work" instance should show red dot (unhealthy status from fixture)
		const instanceList = page.locator("#instance-settings-list");
		const workRow = instanceList.locator("button", { hasText: "Work" });
		await expect(workRow).toBeVisible();
		const workDot = workRow.locator(".w-2.h-2.rounded-full");
		await expect(workDot).toHaveClass(/bg-red-500/);

		// Work becomes "starting" (yellow)
		pushInstances(control.rpc, { work: "starting" });

		// Dot should turn yellow
		await expect(workDot).toHaveClass(/bg-yellow-500/, { timeout: 3_000 });

		// Work becomes "healthy" (green)
		pushInstances(control.rpc, { work: "healthy" });

		// Dot should turn green
		await expect(workDot).toHaveClass(/bg-green-500/, { timeout: 3_000 });
	});
});

// Moved to daemon-smoke.spec.ts — uses the DaemonHarness fixture instead of
// inline Daemon setup. Run via: pnpm test:daemon

test.describe("Auto-Discovery: Getting Started Panel", () => {
	test("Getting Started panel shows when no instances exist", async ({
		page,
		baseURL,
	}) => {
		await setupNoInstances(page, baseURL);
		await openSettingsPanel(page);
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
		await openSettingsPanel(page);
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
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();

		// Getting Started panel should be visible
		await expect(
			page.getByText("No OpenCode instances detected"),
		).toBeVisible();

		// Simulate auto-discovery: the daemon publishes a list with a discovered instance
		control.rpc.setDaemonList("SubscribeInstances", {
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

	test("'Scan Now' link in Getting Started sends ScanNow RPC", async ({
		page,
		baseURL,
	}) => {
		const control = await setupNoInstances(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();

		// Click "Scan Now" link at bottom of Getting Started
		const scanLink = page.locator("[data-testid='scan-now-link']");
		await expect(scanLink).toBeVisible();
		await scanLink.click();

		await control.rpc.waitForRequest((req) => req.tag === "ScanNow");
	});

	test("discovered instance shows 'discovered' badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupMultiInstance(page, baseURL);
		await openSettingsPanel(page);
		await page.locator("#settings-panel").getByText("Instances").click();

		// Publish a list with a discovered (unmanaged) instance
		control.rpc.setDaemonList("SubscribeInstances", {
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
