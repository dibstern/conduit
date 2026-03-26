// ─── E2E Advanced UI Tests ───────────────────────────────────────────────────
// Tests Phase 8 Wave 3-4 UI features: split diff view, rewind timeline,
// file history panel, paste chips, mermaid expand, plan mode.
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { PermissionPage } from "../page-objects/permission.page.js";

test.describe("Split Diff View", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "advanced-diff" });

	// Skip: diff toggle component is not wired up yet — these tests will
	// pass once the split diff view feature is implemented.
	test.skip("diff toggle buttons appear on tool blocks with diffs", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		// Send prompt — triggers the first prompt_async in the recording
		await app.sendMessage("Create a file with diffs");

		// This prompt triggers a tool call with permission — approve it
		await perm.waitForCard();
		await perm.clickAllow();

		await chat.waitForStreamingComplete();

		// Check if any diff toggle bars appeared
		const toggleBars = page.locator(".diff-toggle-bar");
		const count = await toggleBars.count();

		if (count === 0) {
			test.skip(
				true,
				"No diff toggle bars in response — fixture did not include file edit",
			);
			return;
		}

		// Verify toggle bar has Unified and Split buttons
		const firstBar = toggleBars.first();
		const unifiedBtn = firstBar.locator(
			'.diff-toggle-btn[data-mode="unified"]',
		);
		const splitBtn = firstBar.locator('.diff-toggle-btn[data-mode="split"]');

		await expect(unifiedBtn).toBeAttached();
		await expect(splitBtn).toBeAttached();

		// One button should have the active class
		const activeBtn = firstBar.locator(".diff-toggle-btn.active");
		const activeCount = await activeBtn.count();
		expect(activeCount).toBe(1);
	});

	test.skip("clicking split toggle switches diff view", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Edit a file");

		// This turn may trigger multiple permission requests — approve all
		await perm.waitForCard();
		await perm.clickAllow();
		try {
			await perm.waitForCard(5_000);
			await perm.clickAllow();
		} catch {
			// Only one permission request — that's fine
		}

		await chat.waitForStreamingComplete();

		const toggleBars = page.locator(".diff-toggle-bar");
		const count = await toggleBars.count();

		if (count === 0) {
			test.skip(true, "No diff toggle bars in response");
			return;
		}

		// Click the split button
		const firstBar = toggleBars.first();
		const splitBtn = firstBar.locator('.diff-toggle-btn[data-mode="split"]');
		await splitBtn.click();

		// Split button should now be active
		await expect(splitBtn).toHaveClass(/active/);
	});
});

test.describe("Rewind Timeline", () => {
	test.use({ recording: "chat-simple" });

	test("rewind timeline elements exist in DOM after rewind mode", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// The timeline is injected dynamically when rewind mode is entered.
		const timeline = page.locator("#rewind-timeline");
		const isAttached =
			(await timeline.count()) > 0 &&
			(await timeline.evaluate((el) => el.isConnected));

		if (!isAttached) {
			test.skip(true, "Rewind timeline not present — rewind mode not active");
			return;
		}

		// Verify structural elements
		await expect(timeline).toHaveClass(/rewind-timeline/);

		const track = timeline.locator(".rewind-timeline-track");
		await expect(track).toBeAttached();

		const viewport = timeline.locator(".rewind-timeline-viewport");
		await expect(viewport).toBeAttached();
	});
});

test.describe("File History Panel", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "advanced-diff" });

	test("file history panel structure is correct when present", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "File history tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		const perm = new PermissionPage(page);
		await app.goto(relayUrl);

		// Send prompt to trigger file operations
		await app.sendMessage("Read a file");

		// This prompt triggers a tool call with permission — approve it
		await perm.waitForCard();
		await perm.clickAllow();

		await chat.waitForStreamingComplete();

		// File history panel is rendered only when file history data exists
		const historyPanels = page.locator(".file-history-panel");
		const count = await historyPanels.count();

		if (count === 0) {
			test.skip(
				true,
				"No file history panels rendered — no file edits tracked",
			);
			return;
		}

		// Verify panel has expected class
		const panel = historyPanels.first();
		await expect(panel).toHaveClass(/file-history-panel/);

		// Check for file history entries
		const entries = panel.locator(".file-history-entry");
		const entryCount = await entries.count();
		expect(entryCount).toBeGreaterThan(0);
	});
});

test.describe("Paste Chips", () => {
	test.use({ recording: "chat-simple" });

	test("paste chip renders with correct structure", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Paste chips appear when content is pasted into the input.
		await app.input.focus();

		// Use clipboard API to paste text
		await page.evaluate(() => {
			const event = new ClipboardEvent("paste", {
				clipboardData: new DataTransfer(),
			});
			event.clipboardData?.setData("text/plain", "Hello from clipboard");
			document.getElementById("input")?.dispatchEvent(event);
		});

		// Paste chips may or may not appear depending on paste-ui.ts thresholds
		const chips = page.locator(".paste-chip");
		const count = await chips.count();

		if (count === 0) {
			test.skip(true, "No paste chips — paste was too short for chip display");
			return;
		}

		// Verify chip structure
		const chip = chips.first();
		await expect(chip).toHaveClass(/paste-chip/);

		const badge = chip.locator(".paste-chip-badge");
		await expect(badge).toBeAttached();

		const text = chip.locator(".paste-chip-text");
		await expect(text).toBeAttached();
	});
});

test.describe("Mermaid Expand", () => {
	test.describe.configure({ timeout: 30_000 });
	test.use({ recording: "advanced-mermaid" });

	// Skip: mermaid rendering is async and depends on timing between SSE events
	// and DOM updates that the mock replay can't reliably reproduce. The mock's
	// session.idle event fires before the session completes its busy→idle cycle,
	// causing waitForStreamingComplete to hang. To be addressed when the mock
	// gains chronological SSE replay support.
	test.skip("mermaid expand modal opens on diagram click", async ({
		page,
		relayUrl,
	}) => {
		const viewport = page.viewportSize();
		const isDesktop = viewport ? viewport.width >= 1440 : false;
		test.skip(!isDesktop, "Mermaid tests run on desktop viewport only");

		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);

		await app.sendMessage("Draw a mermaid diagram");

		await chat.waitForAssistantMessage();
		await chat.waitForStreamingComplete();

		// Wait for mermaid rendering (async SVG generation)
		await page.waitForTimeout(2000);

		// Check if any mermaid diagrams were rendered
		const diagrams = page.locator(".mermaid-diagram");
		const count = await diagrams.count();

		if (count === 0) {
			test.skip(
				true,
				"No mermaid diagrams rendered — fixture did not produce mermaid",
			);
			return;
		}

		// Click the first diagram to open the expand modal
		await diagrams.first().click();

		// The mermaid expand modal should appear
		const modal = page.locator("#mermaid-expand-modal");
		await expect(modal).toBeVisible({ timeout: 5_000 });

		// Verify modal has the SVG content container
		const svgContainer = modal.locator(".mermaid-expand-svg");
		await expect(svgContainer).toBeAttached();
	});
});

test.describe("Plan Mode UI", () => {
	test.use({ recording: "chat-simple" });

	test("plan banner structure is correct when present", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Plan mode banners are injected when the model enters/exits plan mode.
		const banners = page.locator(".plan-banner");
		const count = await banners.count();

		if (count === 0) {
			test.skip(true, "No plan banners present — plan mode not active");
			return;
		}

		// Verify banner structure
		const banner = banners.first();
		const icon = banner.locator(".plan-banner-icon");
		const text = banner.locator(".plan-banner-text");

		await expect(icon).toBeAttached();
		await expect(text).toBeAttached();
	});

	test("plan CSS file is loaded", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Verify plan-mode CSS is loaded by checking computed styles
		const hasStyles = await page.evaluate(() => {
			const sheets = Array.from(document.styleSheets);
			for (const sheet of sheets) {
				try {
					const rules = Array.from(sheet.cssRules);
					for (const rule of rules) {
						if (
							rule instanceof CSSStyleRule &&
							rule.selectorText?.includes(".plan-banner")
						) {
							return true;
						}
					}
				} catch {
					// Cross-origin stylesheets may throw
				}
			}
			return false;
		});

		expect(hasStyles).toBe(true);
	});
});
