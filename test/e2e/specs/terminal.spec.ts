// Tests the terminal panel UI with real xterm.js rendering and local PTYs.
// The replay fixture mocks OpenCode, but terminal tabs run the worker's shell.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test.describe("Terminal Panel", () => {
	test("phone terminal view fills the viewport width", async ({
		page,
		relayUrl,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await new AppPage(page).goto(relayUrl);
		await page.getByTestId("session-bar-views-button").click();
		await page.getByTestId("session-bar-view-terminal").click();
		const panel = page.locator("#terminal-panel");
		await expect(panel).toBeVisible();
		await expect.poll(async () => (await panel.boundingBox())?.width).toBe(390);
	});

	test("clicking terminal toggle opens the panel and creates a tab", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Terminal panel should not be visible initially
		await expect(page.locator("#terminal-panel")).toBeHidden();

		// Click the terminal toggle button
		await app.terminalToggleBtn.click();

		// Panel should appear
		await expect(page.locator("#terminal-panel")).toBeVisible();

		// A tab should be auto-created (togglePanel auto-creates when no tabs exist)
		const tab = page.locator(".term-tab").first();
		await expect(tab).toBeVisible({ timeout: 10_000 });
		await expect(tab).toContainText("Terminal 1");
	});

	test("terminal tab renders xterm and shows initial prompt", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open terminal panel
		await app.terminalToggleBtn.click();
		await expect(page.locator("#terminal-panel")).toBeVisible();

		// Wait for tab creation
		await expect(page.locator(".term-tab").first()).toBeVisible({
			timeout: 10_000,
		});

		// xterm should render inside the terminal body
		// xterm.js creates a .xterm container with a .xterm-screen inside
		const xtermScreen = page.locator("#terminal-panel .xterm-screen");
		await expect(xtermScreen).toBeVisible({ timeout: 10_000 });

		// xterm renders shell output into rows; check that the screen is mounted.
		const xtermRows = page.locator("#terminal-panel .xterm-rows");
		await expect(xtermRows).toBeVisible();
	});

	test("typing in terminal produces shell output", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open terminal
		await app.terminalToggleBtn.click();
		await expect(page.locator(".term-tab").first()).toBeVisible({
			timeout: 10_000,
		});

		// Wait for xterm to render
		const xtermScreen = page.locator("#terminal-panel .xterm-screen");
		await expect(xtermScreen).toBeVisible({ timeout: 10_000 });

		// The marker appears only in command output, not in the echoed input.
		await page.keyboard.type("printf 'hel%s\\n' lo", { delay: 50 });
		await page.keyboard.press("Enter");
		await expect(page.locator("#terminal-panel .xterm-rows")).toContainText(
			"hello",
			{ timeout: 5_000 },
		);
	});

	test("creating a second terminal tab works", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open terminal (auto-creates first tab)
		await app.terminalToggleBtn.click();
		await expect(page.locator(".term-tab").first()).toBeVisible({
			timeout: 10_000,
		});

		// Click the "+ Terminal" button to create a second tab
		const newTabBtn = page.locator(".term-new-btn");
		await expect(newTabBtn).toBeVisible();
		await newTabBtn.click();

		// Should now have 2 tabs
		const tabs = page.locator(".term-tab");
		await expect(tabs).toHaveCount(2, { timeout: 10_000 });

		// Second tab should be "Terminal 2"
		await expect(tabs.nth(1)).toContainText("Terminal 2");

		// Second tab should be active (auto-switched)
		await expect(tabs.nth(1)).toHaveClass(/term-tab-active/);
	});

	test("closing a terminal tab removes it", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open terminal (auto-creates first tab)
		await app.terminalToggleBtn.click();
		const tab = page.locator(".term-tab").first();
		await expect(tab).toBeVisible({ timeout: 10_000 });

		// Close the tab
		const closeBtn = tab.locator(".term-tab-close");
		await closeBtn.click();

		// Tab should be gone, panel should close (no tabs left)
		await expect(page.locator(".term-tab")).toHaveCount(0);
		await expect(page.locator("#terminal-panel")).toBeHidden();
	});

	test("close panel button hides the panel", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open terminal
		await app.terminalToggleBtn.click();
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await expect(page.locator(".term-tab").first()).toBeVisible({
			timeout: 10_000,
		});

		// Click the close panel button
		const closePanelBtn = page.locator(".term-close-panel-btn");
		await closePanelBtn.click();

		// Panel should be hidden
		await expect(page.locator("#terminal-panel")).toBeHidden();

		// Re-open — tab should still exist (panel close doesn't destroy tabs)
		await app.terminalToggleBtn.click();
		await expect(page.locator("#terminal-panel")).toBeVisible();
		await expect(page.locator(".term-tab")).toHaveCount(1);
	});

	test("switching between tabs shows different terminal content", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open terminal (creates tab 1)
		await app.terminalToggleBtn.click();
		const tabs = page.locator(".term-tab");
		await expect(tabs.first()).toBeVisible({ timeout: 10_000 });

		// Wait for xterm to render in tab 1
		await expect(page.locator("#terminal-panel .xterm-screen")).toBeVisible({
			timeout: 10_000,
		});

		const activeRows = page.locator(
			"#terminal-panel .term-tab-content:not(.hidden) .xterm-rows",
		);

		// Wait for command output, rather than input echoed during shell startup.
		await page.keyboard.type("printf 'tab1%s\\n' data", { delay: 30 });
		await page.keyboard.press("Enter");
		await expect(activeRows).toContainText("tab1data", { timeout: 5_000 });

		// Create tab 2
		await page.locator(".term-new-btn").click();
		await expect(tabs).toHaveCount(2, { timeout: 10_000 });

		// Tab 2 should be active and have its own xterm instance
		await expect(tabs.nth(1)).toHaveClass(/term-tab-active/);
		await expect(
			page.locator(
				"#terminal-panel .term-tab-content:not(.hidden) .xterm-screen",
			),
		).toBeVisible();
		await page.keyboard.type("printf 'tab2%s\\n' data", { delay: 30 });
		await page.keyboard.press("Enter");
		await expect(activeRows).toContainText("tab2data", { timeout: 5_000 });
		await expect(activeRows).not.toContainText("tab1data");

		// Switch back to tab 1
		await tabs.first().click();
		await expect(tabs.first()).toHaveClass(/term-tab-active/);

		// Inactive tabs stay mounted; switching back should restore tab 1's output.
		await expect(activeRows).toContainText("tab1data", { timeout: 5_000 });
		await expect(activeRows).not.toContainText("tab2data");
	});
});
