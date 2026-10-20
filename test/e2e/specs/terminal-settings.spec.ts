import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import {
	DEFAULT_TERMINAL_KEYS,
	type TerminalKeyAction,
} from "../../../src/lib/contracts/terminal-keys.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { chooseSettingsOption } from "../helpers/settings.js";
import { startByteDump } from "../helpers/terminal-bytes.js";
import {
	confirmationsShown,
	countConfirmations,
	finger,
	flick,
	openPhoneTerminal,
	row,
	rowKey,
	setTerminalPanelWidth,
	tap,
	textarea,
} from "../helpers/terminal-keys.js";
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
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else {
		await page
			.getByTestId("session-bar-overflow")
			.or(page.getByTestId("session-bar-island-overflow"))
			.click();
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

test("the folded Keys menu follows the same groups and separators as the inline bar", async ({
	page,
	sessionUrl,
}, testInfo) => {
	await new AppPage(page).goto(sessionUrl);
	await showTerminal(page);
	await openTerminalSettings(page);
	await toggle(page, "Arrows").click();
	await closeSettings(page);
	await expect(terminalKey(page, "Right arrow")).toHaveCount(0);
	const inline = await keys(page)
		.locator(":scope > button, :scope > span")
		.evaluateAll((items) =>
			items.map((item) => item.getAttribute("aria-label") ?? "separator"),
		);
	expect(inline).toEqual([
		"Paste",
		"separator",
		"Escape",
		"Tab",
		"separator",
		"Control",
		"Option",
		"Command",
		"Shift",
	]);
	await setTerminalPanelWidth(page, 420);
	const trigger = page.getByTestId("terminal-keys-menu-trigger");
	await expect(trigger).toBeVisible();
	await trigger.click();
	const menu = page.getByRole("menu", { name: "Terminal keys", exact: true });
	await expect(menu).toBeVisible();
	expect(
		await menu
			.locator('[role="menuitem"], [role="separator"]')
			.evaluateAll((items) =>
				items.map((item) => item.getAttribute("aria-label") ?? "separator"),
			),
	).toEqual(inline);
	await testInfo.attach("Keys menu with Arrows hidden", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
	await page.keyboard.press("Escape");
	await openTerminalSettings(page);
	await toggle(page, "Paste, esc and tab").click();
	await toggle(page, "Modifiers").click();
	await closeSettings(page);
	await expect(trigger).toHaveCount(0);
	await expect(keys(page).getByRole("button")).toHaveCount(0);
	await testInfo.attach("no Keys button when all groups are hidden", {
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
		const saved = await harness.requestRpc({ _tag: "GetTerminalKeys" });
		expect(saved.terminalKeys).toEqual({
			bar: {
				show: false,
				paste: false,
				escTab: false,
				modifiers: false,
				arrows: false,
			},
			row: DEFAULT_TERMINAL_KEYS.row,
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

test("a desktop row edit reaches an open phone and persists after reload", async ({
	page,
	browser,
	harness,
	sessionUrl,
}, testInfo) => {
	await new AppPage(page).goto(sessionUrl);
	await openTerminalSettings(page);
	const phoneContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	try {
		const phone = await phoneContext.newPage();
		await new AppPage(phone).goto(sessionUrl);
		await phone.getByTestId("session-bar-island-overflow").tap();
		await phone.getByTestId("overflow-view-terminal").tap();
		const row = phone.locator(".term-key-row");
		await expect(
			row.getByRole("button", {
				name: "Paste, flick up for Copy",
				exact: true,
			}),
		).toBeVisible();
		await page
			.getByTestId("terminal-row-key-0")
			.getByRole("button")
			.first()
			.click();
		await expect(page.getByTestId("terminal-key-slot-tap")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await page.getByTestId("terminal-key-action-home").click();
		await expect(page.getByTestId("terminal-key-action-home")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(
			row.getByRole("button", { name: "Home, flick up for Copy", exact: true }),
		).toHaveText("home");
		await expect(
			row.getByRole("button", {
				name: "Paste, flick up for Copy",
				exact: true,
			}),
		).toHaveCount(0);
		await testInfo.attach("desktop key editor", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await testInfo.attach("phone updated live", {
			body: await phone.screenshot(),
			contentType: "image/png",
		});
		await page.getByTestId("terminal-key-editor-close").click();
		await page.reload();
		await new AppPage(page).layout.waitFor({ state: "attached" });
		await openTerminalSettings(page);
		await expect(
			page
				.getByTestId("terminal-row-key-0")
				.getByRole("button", { name: "Home, flick up for Copy", exact: true }),
		).toHaveText("home");
		const saved = await harness.requestRpc({ _tag: "GetTerminalKeys" });
		expect(saved.terminalKeys.row.keys[0]).toEqual({ tap: "home", up: "copy" });
		await testInfo.attach("saved phone row", {
			body: JSON.stringify(saved, null, 2),
			contentType: "application/json",
		});
	} finally {
		await phoneContext.close();
	}
});

test("stored Terminal settings without a row decode to the default phone row", async ({
	browser,
	harness,
	sessionUrl,
}, testInfo) => {
	const legacy = {
		bar: { ...DEFAULT_TERMINAL_KEYS.bar, show: false },
		optionKey: "meta",
		tapTwiceToLock: false,
		pasteAsOneBlock: false,
	};
	writeFileSync(
		join(harness.configDir, "settings.jsonc"),
		JSON.stringify({ terminalKeys: legacy }),
	);
	const saved = await harness.requestRpc({ _tag: "GetTerminalKeys" });
	expect(saved.terminalKeys).toEqual({
		...legacy,
		row: DEFAULT_TERMINAL_KEYS.row,
	});
	const phoneContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	try {
		const phone = await phoneContext.newPage();
		await new AppPage(phone).goto(sessionUrl);
		await phone.getByTestId("session-bar-island-overflow").tap();
		await phone.getByTestId("overflow-view-terminal").tap();
		for (const name of [
			"Paste, flick up for Copy",
			"Escape, flick up for Tab",
			"Control, flick up for Command",
			"Option, flick up for Shift",
		])
			await expect(
				phone
					.locator(".term-key-row")
					.getByRole("button", { name, exact: true }),
			).toBeVisible();
		await expect(phone.locator(".term-key-row [data-corner]")).toHaveCount(4);
		await testInfo.attach("legacy settings with default phone row", {
			body: await phone.screenshot(),
			contentType: "image/png",
		});
		await testInfo.attach("decoded legacy settings", {
			body: JSON.stringify(saved, null, 2),
			contentType: "application/json",
		});
	} finally {
		await phoneContext.close();
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

test.describe("Phone row", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		permissions: ["clipboard-read", "clipboard-write"],
	});

	async function openPhoneSettings(page: Page) {
		await tap(page, page.getByTestId("session-bar-island-overflow"));
		await tap(page, page.getByTestId("overflow-settings"));
		await tap(page, page.getByTestId("settings-tab-terminal"));
		await expect(page.getByTestId("terminal-row-preview")).toBeVisible();
	}

	async function closePhoneSettings(page: Page) {
		await tap(page, page.getByTestId("settings-back-btn"));
		await tap(page, page.getByTestId("settings-close-btn"));
		await expect(page.locator("#settings-panel")).toHaveCount(0);
		await textarea(page).focus();
	}

	async function editPhoneRow(
		page: Page,
		edits: readonly {
			index: number;
			tap?: TerminalKeyAction;
			up?: TerminalKeyAction;
		}[],
	) {
		await openPhoneSettings(page);
		for (const edit of edits) {
			// A real finger: the sheet must survive the click that follows it.
			await tap(
				page,
				page
					.getByTestId(`terminal-row-key-${edit.index}`)
					.getByRole("button")
					.first(),
			);
			await expect(page.getByTestId("terminal-key-slot-tap")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			for (const slot of ["tap", "up"] as const) {
				const action = edit[slot];
				if (action === undefined) continue;
				await tap(page, page.getByTestId(`terminal-key-slot-${slot}`));
				const choice = page.getByTestId(`terminal-key-action-${action}`);
				await expect(choice).toBeEnabled();
				await tap(page, choice);
				await expect(choice).toHaveAttribute("aria-pressed", "true");
			}
			await tap(page, page.getByTestId("terminal-key-editor-close"));
			await expect(page.getByTestId("terminal-key-editor")).toHaveCount(0);
		}
		await closePhoneSettings(page);
	}

	test("editing tap and flick-up changes the phone key labels and bytes", async ({
		page,
		sessionUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		await editPhoneRow(page, [{ index: 0, tap: "return", up: "delete" }]);
		const edited = rowKey(page, "Return, flick up for Delete");
		await expect(edited).toBeVisible();
		await expect(edited).toHaveText("ret");
		await expect(rowKey(page, "Delete")).toHaveText("del");
		await expect(rowKey(page, "Paste, flick up for Copy")).toHaveCount(0);
		const dump = await startByteDump(page, testInfo);
		await tap(page, edited);
		await dump.group();
		await flick(page, edited);
		expect(await dump.finish()).toEqual(["0d", "7f"]);
	});

	test("Nothing removes a flick action and keeps a waiting modifier through empty taps and flicks", async ({
		page,
		sessionUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		await editPhoneRow(page, [{ index: 0, tap: "nothing", up: "nothing" }]);
		const empty = rowKey(page, "Nothing");
		await expect(empty).toBeEmpty();
		await expect(
			row(page).locator(".flick-key").first().locator("[data-corner]"),
		).toHaveCount(0);
		await expect(rowKey(page, "Copy")).toHaveCount(0);
		await countConfirmations(page);
		const dump = await startByteDump(page, testInfo);
		const ctrl = rowKey(page, "Control, flick up for Command");
		await tap(page, ctrl);
		await tap(page, empty);
		await flick(page, empty);
		await expect(ctrl).toHaveAttribute("aria-pressed", "mixed");
		await expect(row(page).locator(".flick-bubble")).toHaveCount(0);
		expect(await confirmationsShown(page)).toBe(0);
		await page.keyboard.insertText("c");
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		expect(await dump.finish()).toEqual(["03"]);
	});

	test("Flick hints hide the corners without disabling flicks, and Show the key row removes it", async ({
		page,
		sessionUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		await openPhoneSettings(page);
		await tap(
			page,
			page.getByRole("switch", { name: "Flick hints", exact: true }),
		);
		await expect(
			page.getByRole("switch", { name: "Flick hints", exact: true }),
		).toHaveAttribute("aria-checked", "false");
		await closePhoneSettings(page);
		await expect(row(page).locator("[data-corner]")).toHaveCount(0);
		const dump = await startByteDump(page, testInfo);
		await flick(page, rowKey(page, "Escape, flick up for Tab"));
		expect(await dump.finish()).toEqual(["09"]);
		await openPhoneSettings(page);
		await tap(
			page,
			page.getByRole("switch", { name: "Show the key row", exact: true }),
		);
		await expect(
			page.getByRole("switch", { name: "Show the key row", exact: true }),
		).toHaveAttribute("aria-checked", "false");
		await closePhoneSettings(page);
		await expect(row(page)).toHaveCount(0);
		await testInfo.attach("phone row hidden", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	});

	test("hiding the phone row from another device stops a held arrow", async ({
		page,
		sessionUrl,
		harness,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		const dump = await startByteDump(page, testInfo);
		const touch = await finger(
			page,
			row(page).getByRole("group", { name: "Arrows" }),
		);
		try {
			await touch.moveTo(35, 0);
			await harness.requestRpc({
				_tag: "SetTerminalKeys",
				terminalKeys: {
					...DEFAULT_TERMINAL_KEYS,
					row: { ...DEFAULT_TERMINAL_KEYS.row, show: false },
				},
			});
			await expect(row(page)).toHaveCount(0);
			await dump.group();
			await page.waitForTimeout(650);
			const [before, after] = await dump.finish();
			expect(before).toContain("1b 5b 43");
			expect(after).toBe("");
		} finally {
			await touch.lift();
		}
	});

	test("the remaining actions send their terminal bytes from phone keys", async ({
		page,
		sessionUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		await editPhoneRow(page, [
			{ index: 0, tap: "return", up: "delete" },
			{ index: 1, tap: "home", up: "end" },
			{ index: 2, tap: "pageUp", up: "pageDown" },
			{ index: 3, tap: "interrupt", up: "nothing" },
		]);
		const dump = await startByteDump(page, testInfo);
		for (const name of [
			"Return, flick up for Delete",
			"Home, flick up for End",
			"Page up, flick up for Page down",
		]) {
			await tap(page, rowKey(page, name));
			await dump.group();
			await flick(page, rowKey(page, name));
			await dump.group();
		}
		await tap(page, rowKey(page, "Interrupt"));
		expect(await dump.finish()).toEqual([
			"0d",
			"7f",
			"1b 5b 48",
			"1b 5b 46",
			"1b 5b 35 7e",
			"1b 5b 36 7e",
			"03",
		]);
	});

	test("Home and End follow application mode and navigation keys spend waiting modifiers and keep locked ones", async ({
		page,
		sessionUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		await editPhoneRow(page, [
			{ index: 0, tap: "home", up: "end" },
			{ index: 1, tap: "pageUp", up: "pageDown" },
		]);
		const dump = await startByteDump(page, testInfo, {
			applicationCursor: true,
		});
		const home = rowKey(page, "Home, flick up for End");
		const pageUp = rowKey(page, "Page up, flick up for Page down");
		const ctrl = rowKey(page, "Control, flick up for Command");
		await tap(page, home);
		await flick(page, home);
		await dump.group();
		for (const navigation of [home, pageUp]) {
			await tap(page, ctrl);
			await tap(page, navigation);
			await expect(ctrl).toHaveAttribute("aria-pressed", "false");
			await dump.group();
		}
		await tap(page, ctrl);
		await tap(page, ctrl);
		await flick(page, home);
		await flick(page, pageUp);
		await expect(ctrl).toHaveAttribute("aria-pressed", "true");
		await tap(page, ctrl);
		expect(await dump.finish()).toEqual([
			"1b 4f 48 1b 4f 46",
			"1b 5b 31 3b 35 48",
			"1b 5b 35 3b 35 7e",
			"1b 5b 31 3b 35 46 1b 5b 36 3b 35 7e",
		]);
	});

	test("Return, Delete and Interrupt spend waiting modifiers like Escape and Tab", async ({
		page,
		sessionUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, sessionUrl);
		await editPhoneRow(page, [
			{ index: 0, tap: "return", up: "delete" },
			{ index: 1, tap: "interrupt", up: "nothing" },
		]);
		const dump = await startByteDump(page, testInfo);
		const ctrl = rowKey(page, "Control, flick up for Command");
		const option = rowKey(page, "Option, flick up for Shift");
		const enter = rowKey(page, "Return, flick up for Delete");
		await tap(page, ctrl);
		await tap(page, enter);
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		await dump.group();
		await tap(page, option);
		await flick(page, enter);
		await expect(option).toHaveAttribute("aria-pressed", "false");
		await dump.group();
		await tap(page, ctrl);
		await tap(page, rowKey(page, "Interrupt"));
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		expect(await dump.finish()).toEqual(["0d", "1b 7f", "03"]);
	});
});
