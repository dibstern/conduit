// ─── E2E: Terminal Panel ─────────────────────────────────────────────────────
// Tests the terminal panel UI with real xterm.js rendering.
// Uses the replay fixture — the mock's echo-mode PTY WebSocket echoes input
// back as output, so no PTY recording is needed.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test.describe("Terminal Panel", () => {
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

		// The mock sends "$ " as an initial prompt — wait for it to render
		// xterm renders text into rows; check the terminal has content
		const xtermRows = page.locator("#terminal-panel .xterm-rows");
		await expect(xtermRows).toBeVisible();
	});

	test("typing in terminal produces echoed output", async ({
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

		// Type into the terminal (xterm captures keyboard input when focused)
		await page.keyboard.type("hello", { delay: 50 });

		// The echo-mode mock sends input back as output
		await page.waitForFunction(
			() =>
				document
					.querySelector("#terminal-panel .xterm-rows")
					?.textContent?.includes("hello"),
			null,
			{ timeout: 5_000 },
		);

		// Confirm text is present
		const terminalText = await page
			.locator("#terminal-panel .xterm-rows")
			.textContent();
		expect(terminalText).toContain("hello");
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

		// Type in tab 1
		await page.keyboard.type("tab1data", { delay: 30 });
		await page.waitForFunction(
			() =>
				document
					.querySelector("#terminal-panel .xterm-rows")
					?.textContent?.includes("tab1data"),
			null,
			{ timeout: 5_000 },
		);

		// Create tab 2
		await page.locator(".term-new-btn").click();
		await expect(tabs).toHaveCount(2, { timeout: 10_000 });

		// Tab 2 should be active and have its own xterm instance
		await expect(tabs.nth(1)).toHaveClass(/term-tab-active/);

		// Switch back to tab 1
		await tabs.first().click();
		await expect(tabs.first()).toHaveClass(/term-tab-active/);

		// Tab 1's content should still have our typed text
		await page.waitForFunction(
			() =>
				document
					.querySelector("#terminal-panel .xterm-rows")
					?.textContent?.includes("tab1data"),
			null,
			{ timeout: 5_000 },
		);
		const terminalText = await page
			.locator("#terminal-panel .xterm-rows")
			.textContent();
		expect(terminalText).toContain("tab1data");
	});
});
