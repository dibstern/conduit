import { writeFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import { GetTerminalKeys } from "../../../src/lib/contracts/ws-rpc.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { chooseSettingsOption } from "../helpers/settings.js";
import { startByteDump } from "../helpers/terminal-bytes.js";
import { AppPage } from "../page-objects/app.page.js";

// Exercise the daemon's persisted settings and live project stream, with a
// real PTY for key behavior. Only the provider SDK is fake.
const test = base.extend<{ harness: ProcessHarness; sessionUrl: string }>({
	harness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
		async ({}, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await use(harness);
			} finally {
				writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
				await harness.dispose();
				harness.assertNoRunners();
			}
		},
		{ timeout: 120_000 },
	],
	sessionUrl: async ({ harness }, use) => {
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Terminal settings");
		await use(`${harness.baseUrl}/s/${sessionId}`);
	},
});

test.setTimeout(180_000);
test.use({ actionTimeout: 30_000 });

if (process.env["CONDUIT_E2E_SINGLE_PROCESS"] === "1") {
	test.use({
		launchOptions: { args: ["--single-process", "--in-process-gpu"] },
	});
}

const toggle = (page: Page, name: string) =>
	page.locator("#settings-panel").getByRole("switch", { name, exact: true });
const keys = (page: Page) =>
	page.getByRole("toolbar", { name: "Terminal keys" });
const terminalKey = (page: Page, name: string) =>
	keys(page).getByRole("button", { name, exact: true });

async function openSettings(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
	}
	await expect(page.locator("#settings-panel")).toBeVisible();
}

async function openTerminalSettings(page: Page): Promise<void> {
	await openSettings(page);
	await page.getByTestId("settings-tab-terminal").click();
	await expect(toggle(page, "Keys in the tab bar")).toBeEnabled();
}

async function closeSettings(page: Page): Promise<void> {
	await page.getByTestId("settings-close-btn").click();
	await expect(page.locator("#settings-panel")).toHaveCount(0);
}

async function chooseOptionKey(
	page: Page,
	value: "characters" | "meta",
): Promise<void> {
	const picker = page.getByTestId("settings-terminal-option-key");
	await chooseSettingsOption(page, picker, value);
	await expect(picker).toHaveAttribute("data-value", value);
}

async function showTerminal(page: Page): Promise<void> {
	if (!(await page.locator("#terminal-panel").isVisible()))
		await new AppPage(page).terminalToggleBtn.click();
	const screen = page
		.locator("#terminal-panel .xterm-screen")
		.filter({ visible: true });
	await expect(screen).toBeVisible();
	await screen.click();
}

async function reportMacOS(page: Page): Promise<void> {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "platform", {
			configurable: true,
			get: () => "MacIntel",
		});
		Object.defineProperty(navigator, "userAgentData", {
			configurable: true,
			get: () => ({ platform: "macOS" }),
		});
	});
}

test("Terminal settings hide each desktop key group and the entire bar", async ({
	page,
	sessionUrl,
}, testInfo) => {
	await new AppPage(page).goto(sessionUrl);
	await showTerminal(page);
	for (const [label, names] of [
		["Paste, esc and tab", ["Paste", "Escape", "Tab"]],
		["Modifiers", ["Control", "Option", "Command", "Shift"]],
		["Arrows", ["Left arrow", "Up arrow", "Down arrow", "Right arrow"]],
	] as const) {
		await openTerminalSettings(page);
		await toggle(page, label).click();
		await expect(toggle(page, label)).toHaveAttribute("aria-checked", "false");
		await closeSettings(page);
		for (const name of names)
			await expect(terminalKey(page, name)).toHaveCount(0);
	}
	await expect(keys(page).getByRole("button")).toHaveCount(0);
	await openTerminalSettings(page);
	await toggle(page, "Paste, esc and tab").click();
	await toggle(page, "Keys in the tab bar").click();
	await expect(toggle(page, "Paste, esc and tab")).toBeHidden();
	await closeSettings(page);
	await expect(keys(page).getByRole("button")).toHaveCount(0);
	await testInfo.attach("hidden desktop keys", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

test("Terminal Option key changes physical Alt+b bytes on connected and new tabs", async ({
	page,
	sessionUrl,
}, testInfo) => {
	await reportMacOS(page);
	await new AppPage(page).goto(sessionUrl);
	await showTerminal(page);
	await openTerminalSettings(page);
	await chooseOptionKey(page, "meta");
	await closeSettings(page);
	await showTerminal(page);
	const dump = await startByteDump(page, testInfo);
	await page.keyboard.press("Alt+b");
	await dump.group();
	await openTerminalSettings(page);
	await chooseOptionKey(page, "characters");
	await closeSettings(page);
	await showTerminal(page);
	await page.keyboard.press("Alt+b");
	const [meta, characters] = await dump.finish();
	expect(meta).toBe("1b 62");
	// Reporting macOS doesn't change the host's keyboard layout or produce
	// native Option characters. In character mode, it must send no Meta escape.
	expect(characters).toBeDefined();
	expect(characters?.split(" ")).not.toContain("1b");
	await openTerminalSettings(page);
	await chooseOptionKey(page, "meta");
	await closeSettings(page);
	await page.locator(".term-new-btn").click();
	await expect(page.locator(".term-tab-label")).toHaveCount(2);
	await showTerminal(page);
	const secondDump = await startByteDump(page, testInfo);
	await page.keyboard.press("Alt+b");
	expect(await secondDump.finish()).toEqual(["1b 62"]);
});

test("Terminal tap twice off releases the modifier instead of locking", async ({
	page,
	sessionUrl,
}, testInfo) => {
	await new AppPage(page).goto(sessionUrl);
	await openTerminalSettings(page);
	await toggle(page, "Tap twice to lock").click();
	await expect(toggle(page, "Tap twice to lock")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await closeSettings(page);
	await showTerminal(page);
	const dump = await startByteDump(page, testInfo);
	const shift = terminalKey(page, "Shift");
	await shift.click();
	await expect(shift).toHaveAttribute("aria-pressed", "mixed");
	await shift.click();
	await expect(shift).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.type("ab");
	expect(await dump.finish()).toEqual(["61 62"]);
});

test("Terminal paste as one block off sends several lines without confirmation", async ({
	page,
	context,
	sessionUrl,
}, testInfo) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await new AppPage(page).goto(sessionUrl);
	await openTerminalSettings(page);
	await toggle(page, "Paste as one block").click();
	await expect(toggle(page, "Paste as one block")).toHaveAttribute(
		"aria-checked",
		"false",
	);
	await closeSettings(page);
	await showTerminal(page);
	const dump = await startByteDump(page, testInfo);
	await page.evaluate(() => navigator.clipboard.writeText("a\nb\nc"));
	await terminalKey(page, "Paste").click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	// Clipboard reads are asynchronous; wait for the real bytes before the marker.
	await expect(
		page
			.locator("#terminal-panel")
			.getByText("Pasted 3 lines", { exact: false }),
	).toBeVisible();
	expect(await dump.finish()).toEqual(["61 0d 62 0d 63"]);
});

test("Terminal settings persist each change and update a second device live", async ({
	page,
	browser,
	harness,
	sessionUrl,
}, testInfo) => {
	await reportMacOS(page);
	await new AppPage(page).goto(sessionUrl);
	await openSettings(page);
	await expect(page.getByTestId("settings-terminal-new")).toBeVisible();
	await page.getByTestId("settings-tab-terminal").click();
	await expect(page.getByTestId("settings-terminal-new")).toHaveCount(0);
	const secondContext = await browser.newContext({
		viewport: { width: 1440, height: 900 },
	});
	try {
		const second = await secondContext.newPage();
		await reportMacOS(second);
		await new AppPage(second).goto(sessionUrl);
		await openSettings(second);
		await expect(second.getByTestId("settings-terminal-new")).toBeVisible();
		await second.getByTestId("settings-tab-terminal").click();
		for (const label of [
			"Paste, esc and tab",
			"Modifiers",
			"Arrows",
			"Tap twice to lock",
			"Paste as one block",
			"Keys in the tab bar",
		]) {
			await toggle(page, label).click();
			await expect(toggle(second, label)).toHaveAttribute(
				"aria-checked",
				"false",
			);
			await page.reload();
			await new AppPage(page).layout.waitFor({ state: "attached" });
			await openTerminalSettings(page);
			await expect(toggle(page, label)).toHaveAttribute(
				"aria-checked",
				"false",
			);
			await expect(page.getByTestId("settings-terminal-new")).toHaveCount(0);
		}
		await chooseOptionKey(page, "meta");
		await expect(
			second.getByTestId("settings-terminal-option-key"),
		).toHaveAttribute("data-value", "meta");
		await page.reload();
		await new AppPage(page).layout.waitFor({ state: "attached" });
		await openTerminalSettings(page);
		await expect(
			page.getByTestId("settings-terminal-option-key"),
		).toHaveAttribute("data-value", "meta");
		const saved = await harness.requestRpc(new GetTerminalKeys({}));
		expect(saved.terminalKeys).toEqual({
			bar: {
				show: false,
				paste: false,
				escTab: false,
				modifiers: false,
				arrows: false,
			},
			optionKey: "meta",
			tapTwiceToLock: false,
			pasteAsOneBlock: false,
		});
		await testInfo.attach("saved terminal settings", {
			body: JSON.stringify(saved, null, 2),
			contentType: "application/json",
		});
		for (const [name, device] of [
			["first device", page],
			["second device", second],
		] as const)
			await testInfo.attach(name, {
				body: await device.screenshot(),
				contentType: "image/png",
			});
	} finally {
		await secondContext.close();
	}
});

test("Terminal Option key is absent away from macOS", async ({
	page,
	sessionUrl,
}, testInfo) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "platform", {
			configurable: true,
			get: () => "Linux x86_64",
		});
		Object.defineProperty(navigator, "userAgentData", {
			configurable: true,
			get: () => ({ platform: "Linux" }),
		});
	});
	await new AppPage(page).goto(sessionUrl);
	await openTerminalSettings(page);
	await expect(page.getByTestId("settings-terminal-option-key")).toHaveCount(0);
	await testInfo.attach("non-macOS Terminal settings", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});
