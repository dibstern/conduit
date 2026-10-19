// Tests the terminal panel UI with real xterm.js rendering and local PTYs.
// The replay fixture mocks OpenCode, but terminal tabs run the worker's shell.

import type { Page } from "@playwright/test";
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
		await page.getByTestId("session-bar-island-overflow").click();
		await page.getByTestId("overflow-view-terminal").click();
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

// The relay runs in this worker, so the PTY host it spawns inherits this
// process's environment (conduit-test-ni8.59).
test.describe("Terminal host startup", () => {
	test("a slow host start shows the starting tab, then attaches", async ({
		page,
		relayUrl,
	}) => {
		// Longer than the fixed 5 s start deadline this replaced.
		process.env["CONDUIT_PTY_HOST_START_DELAY_MS"] = "6000";
		try {
			const app = new AppPage(page);
			await app.goto(relayUrl);
			await app.terminalToggleBtn.click();

			await expect(page.locator(".term-starting")).toHaveText(
				"Starting terminal…",
			);
			await expect(page.locator(".term-tab-pending")).toHaveText("Terminal 1");
			await expect(page.locator(".term-tab")).toHaveCount(0);

			// The server waits for a live host up to its 15 s backstop.
			const tab = page.locator(".term-tab");
			await expect(tab).toHaveText(/Terminal 1/, { timeout: 15_000 });
			await expect(tab).toHaveClass(/term-tab-active/);
			await expect(page.locator(".term-tab-pending")).toHaveCount(0);
			await expect(page.locator(".term-starting")).toBeHidden();
			await expect(page.locator("#terminal-panel .xterm-screen")).toBeVisible();
		} finally {
			delete process.env["CONDUIT_PTY_HOST_START_DELAY_MS"];
		}
	});

	test("a host that exits at once fails fast with the error shown", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);
		const nodeOptions = process.env["NODE_OPTIONS"];
		// Node rejects this before running any code, so the host exits at once.
		process.env["NODE_OPTIONS"] = "--conduit-invalid-option";
		try {
			const started = Date.now();
			await app.terminalToggleBtn.click();
			await expect(page.locator(".term-status")).toHaveText(
				/^Failed to create terminal: \S/,
			);
			// Well under the 15 s backstop for a host that is still alive.
			expect(Date.now() - started).toBeLessThan(5_000);
			await expect(page.locator(".term-tab, .term-tab-pending")).toHaveCount(0);
			const path = testInfo.outputPath("terminal-host-failure.png");
			await page.screenshot({ path });
			await testInfo.attach("terminal-host-failure", {
				path,
				contentType: "image/png",
			});
		} finally {
			if (nodeOptions === undefined) delete process.env["NODE_OPTIONS"];
			else process.env["NODE_OPTIONS"] = nodeOptions;
		}
	});
});

// Pinch over the terminal steps the header's font size (conduit-test-6lk5).
// A trackpad pinch is a ctrl+wheel; 10 units of deltaY make one 1px step.
test.describe("Terminal pinch zoom", () => {
	async function openTerminal(page: Page, relayUrl: string) {
		const app = new AppPage(page);
		await app.goto(relayUrl);
		await app.terminalToggleBtn.click();
		await expect(page.locator("#terminal-panel .xterm-screen")).toBeVisible({
			timeout: 10_000,
		});
		const box = await page.locator("#terminal-panel .term-body").boundingBox();
		if (!box) throw new Error("terminal body is not rendered");
		return {
			fontSize: page.getByTestId("terminal-font-size"),
			center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
		};
	}

	// The PTY's own view of its size, read back through the shell.
	async function expectPtyCols(page: Page, check: (cols: number) => void) {
		await expect(async () => {
			await page.keyboard.type("printf 'S%sS\\n' \"$(stty size)\"");
			await page.keyboard.press("Enter");
			const text = await page
				.locator("#terminal-panel .xterm-rows")
				.innerText();
			const sizes = [...text.matchAll(/S\d+ (\d+)S/g)];
			check(Number(sizes.at(-1)?.[1]));
		}).toPass({ timeout: 10_000 });
	}

	test("ctrl+wheel over the terminal steps and clamps the font size; elsewhere it is left alone", async ({
		page,
		relayUrl,
	}) => {
		const { fontSize, center } = await openTerminal(page, relayUrl);
		await expect(fontSize).toHaveText("13");
		let colsAt13 = 0;
		await expectPtyCols(page, (cols) => {
			expect(cols).toBeGreaterThan(0);
			colsAt13 = cols;
		});

		await page.mouse.move(center.x, center.y);
		await page.keyboard.down("Control");
		// Pinch out: 30 units of small deltas are three steps.
		for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -5);
		await expect(fontSize).toHaveText("16");
		// A ctrl+mouse-wheel notch is one step, not ten.
		await page.mouse.wheel(0, -100);
		await expect(fontSize).toHaveText("17");
		// The PTY was resized to the refitted terminal, as with the +/- buttons.
		await page.keyboard.up("Control");
		await expectPtyCols(page, (cols) => expect(cols).toBeLessThan(colsAt13));
		await page.keyboard.down("Control");

		// Pinch in, then past both limits.
		await page.mouse.move(center.x, center.y);
		for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 10);
		await expect(fontSize).toHaveText("13");
		for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 100);
		await expect(fontSize).toHaveText("6");
		await expect(
			page.getByRole("button", { name: "Decrease font size" }),
		).toBeDisabled();
		for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -100);
		await expect(fontSize).toHaveText("24");
		await expect(
			page.getByRole("button", { name: "Increase font size" }),
		).toBeDisabled();
		// Persisted like the +/- buttons.
		expect(
			await page.evaluate(() => localStorage.getItem("terminal-font-size")),
		).toBe("24");

		// Outside the terminal the event reaches the page unhandled.
		const panelTop =
			(await page.locator("#terminal-panel").boundingBox())?.y ?? 0;
		const outside = { x: center.x, y: panelTop / 2 };
		expect(
			await page.evaluate(
				({ x, y }) =>
					document.elementFromPoint(x, y)?.closest("#terminal-panel") ?? null,
				outside,
			),
		).toBeNull();
		await page.evaluate(() => {
			window.addEventListener("wheel", (e) => {
				(window as Window & { lastWheel?: unknown }).lastWheel = {
					ctrlKey: e.ctrlKey,
					defaultPrevented: e.defaultPrevented,
				};
			});
		});
		await page.mouse.move(outside.x, outside.y);
		await page.mouse.wheel(0, 100);
		await page.keyboard.up("Control");
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as Window & { lastWheel?: unknown }).lastWheel,
				),
			)
			.toEqual({ ctrlKey: true, defaultPrevented: false });
		await expect(fontSize).toHaveText("24");
	});

	test.describe("on a touchscreen", () => {
		test.use({ hasTouch: true });

		test("two-finger pinch steps the font size and one finger still scrolls", async ({
			page,
			relayUrl,
		}) => {
			const { fontSize, center } = await openTerminal(page, relayUrl);
			await expect(fontSize).toHaveText("13");
			await page.keyboard.type("seq 1 200 | sed 's/^/L/'");
			await page.keyboard.press("Enter");
			const rows = page.locator("#terminal-panel .xterm-rows");
			await expect(rows).toContainText("L200");

			const cdp = await page.context().newCDPSession(page);
			const fingers = (spread: number) => [
				{ x: center.x - spread, y: center.y, id: 0 },
				{ x: center.x + spread, y: center.y, id: 1 },
			];
			async function pinch(from: number, to: number) {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: fingers(from),
				});
				for (let i = 1; i <= 10; i++) {
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: fingers(from + ((to - from) * i) / 10),
					});
				}
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			}

			// 1.5x spread: 100·ln(1.5) ≈ 41 units, four steps.
			await pinch(40, 60);
			await expect(fontSize).toHaveText("17");
			// Half the spread: ≈ -69 units, six steps down.
			await pinch(60, 30);
			await expect(fontSize).toHaveText("11");
			// Far past both limits.
			await pinch(10, 200);
			await expect(fontSize).toHaveText("24");
			await pinch(200, 5);
			await expect(fontSize).toHaveText("6");

			// One finger dragging down scrolls back through the output, at any size.
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x: center.x, y: center.y - 100 }],
			});
			for (let i = 1; i <= 10; i++) {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x: center.x, y: center.y - 100 + i * 40 }],
				});
			}
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
			await cdp.detach();
			await expect(rows).not.toContainText("L200");
			await expect(fontSize).toHaveText("6");
		});
	});
});
