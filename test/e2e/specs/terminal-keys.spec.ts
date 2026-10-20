// On-screen terminal keys, asserted by the exact bytes a real PTY receives.
// Each test opens a fresh terminal, runs one byte dump and groups many presses
// inside it. Artifacts: a screenshot and bytes.log per test.

import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
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

test.use({ recording: "chat-simple" });

async function openTerminal(page: Page, relayUrl: string): Promise<void> {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.terminalToggleBtn.click();
	await expect(page.locator("#terminal-panel .xterm-screen")).toBeVisible({
		timeout: 10_000,
	});
}

const key = (page: Page, name: string) =>
	page.getByRole("toolbar", { name: "Terminal keys" }).getByRole("button", {
		name,
		exact: true,
	});

const ARROWS = ["Left arrow", "Up arrow", "Down arrow", "Right arrow"];

const keysMenu = (page: Page) =>
	page.getByRole("menu", { name: "Terminal keys", exact: true });
const keysMenuTrigger = (page: Page) =>
	page.getByTestId("terminal-keys-menu-trigger");

async function chooseMenuKey(page: Page, name: string): Promise<void> {
	await keysMenuTrigger(page).click();
	await keysMenu(page).getByRole("menuitem", { name, exact: true }).click();
	await expect(keysMenu(page)).toBeHidden();
}

test.describe("Terminal keys menu on desktop", () => {
	test("the panel's own width folds and unfolds the keys without changing the viewport", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const viewport = page.viewportSize();
		const toolbar = page.getByRole("toolbar", { name: "Terminal keys" });
		await expect(toolbar).toBeVisible();
		await expect(keysMenuTrigger(page)).toHaveCount(0);
		await setTerminalPanelWidth(page, 420);
		await expect(keysMenuTrigger(page)).toBeVisible();
		await expect(toolbar).toHaveCount(0);
		// Let several observer deliveries pass, so a fit/fold loop cannot pass.
		await page.waitForTimeout(250);
		await expect(keysMenuTrigger(page)).toBeVisible();
		expect(page.viewportSize()).toEqual(viewport);
		await testInfo.attach("narrow terminal tab bar", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await setTerminalPanelWidth(page, null);
		await expect(toolbar).toBeVisible();
		await expect(keysMenuTrigger(page)).toHaveCount(0);
		await page.waitForTimeout(250);
		await expect(toolbar).toBeVisible();
		expect(page.viewportSize()).toEqual(viewport);
		await testInfo.attach("wide terminal tab bar restored", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	});

	test("menu escape, arrow and Control-arrow send the inline keys' exact bytes", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		await key(page, "Escape").click();
		await key(page, "Right arrow").click();
		await key(page, "Control").click();
		await key(page, "Right arrow").click();
		await dump.group();
		await setTerminalPanelWidth(page, 420);
		await chooseMenuKey(page, "Escape");
		await chooseMenuKey(page, "Right arrow");
		await chooseMenuKey(page, "Control");
		await chooseMenuKey(page, "Right arrow");
		expect(await dump.finish()).toEqual([
			"1b 1b 5b 43 1b 5b 31 3b 35 43",
			"1b 1b 5b 43 1b 5b 31 3b 35 43",
		]);
	});

	test("choosing Control and dismissing the menu both return focus to the terminal", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		await setTerminalPanelWidth(page, 420);
		await chooseMenuKey(page, "Control");
		await expect(textarea(page)).toBeFocused();
		await page.keyboard.press("c");
		await dump.group();
		await keysMenuTrigger(page).click();
		await expect(keysMenu(page)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(keysMenu(page)).toBeHidden();
		await expect(textarea(page)).toBeFocused();
		await page.keyboard.press("x");
		expect(await dump.finish()).toEqual(["03", "78"]);
	});

	test("the Keys button and menu expose waiting and locked modifiers", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await setTerminalPanelWidth(page, 420);
		const trigger = keysMenuTrigger(page);
		await chooseMenuKey(page, "Control");
		await expect(trigger).toHaveAccessibleDescription("Control waiting");
		await trigger.click();
		const control = keysMenu(page).getByRole("menuitem", {
			name: "Control",
			exact: true,
		});
		await expect(control).toHaveAttribute("data-modifier-state", "waiting");
		await expect(control).toHaveAccessibleDescription("waiting");
		await testInfo.attach("Control waiting in Keys menu", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await control.click();
		await expect(keysMenu(page)).toBeHidden();
		await expect(trigger).toHaveAccessibleDescription("Control locked");
		await trigger.click();
		await expect(control).toHaveAttribute("data-modifier-state", "locked");
		await expect(control).toHaveAccessibleDescription("locked");
		await testInfo.attach("Control locked in Keys menu", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		await control.click();
		await expect(trigger).not.toHaveAccessibleDescription(/Control/);
	});
});

test.describe("Terminal keys on desktop", () => {
	test("esc, tab and arrows send what the physical keys send, and typing keeps its place", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		// A fine pointer gets the tab-bar keys and never the touch row.
		await expect(page.locator(".term-key-row")).toHaveCount(0);
		const dump = await startByteDump(page, testInfo);

		await key(page, "Escape").click();
		await key(page, "Tab").click();
		await dump.group();
		for (const arrow of ARROWS) await key(page, arrow).click();
		await dump.group();
		// The key leaves focus on the terminal, so typing lands right after it.
		await key(page, "Escape").click();
		await page.keyboard.type("x");

		expect(await dump.finish()).toEqual([
			"1b 09",
			"1b 5b 44 1b 5b 41 1b 5b 42 1b 5b 43",
			"1b 78",
		]);
	});

	test("arrows send SS3 in application cursor mode", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo, {
			applicationCursor: true,
		});

		for (const arrow of ARROWS) await key(page, arrow).click();

		expect(await dump.finish()).toEqual([
			"1b 4f 44 1b 4f 41 1b 4f 42 1b 4f 43",
		]);
	});

	test("a held arrow repeats after a delay, and a short click sends one", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		await key(page, "Up arrow").hover();
		await page.mouse.down();
		await page.waitForTimeout(1_000);
		await page.mouse.up();
		await dump.group();
		await key(page, "Up arrow").hover();
		await page.mouse.down();
		await page.waitForTimeout(100);
		await page.mouse.up();

		const [held, clicked] = await dump.finish();
		const up = "1b 5b 41";
		// 400ms delay then every 50ms: about 13 in a second; 5 leaves slack.
		expect(held?.split(up).length ?? 0).toBeGreaterThan(5);
		expect(held?.replaceAll(up, "").trim()).toBe("");
		expect(clicked).toBe(up);
	});
});

/** The Paste key reads the clipboard asynchronously, so a single line, which
 *  shows nothing, can land after keys pressed straight afterwards. */
const clipboardRead = (page: Page) => page.waitForTimeout(300);

test.describe("Sticky modifiers on desktop", () => {
	test("⌃ applies to a physical key and an on-screen one, and confirms only on-screen combinations", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await countConfirmations(page);
		const dump = await startByteDump(page, testInfo);

		await key(page, "Control").click();
		await page.keyboard.press("c");
		await expect(page.locator(".term-key-confirmation")).toHaveText(
			"Sent ⌃C · interrupt",
		);
		await dump.group();
		await key(page, "Control").click();
		await key(page, "Left arrow").click();
		await dump.group();
		// A physical ⌃C, with no on-screen modifier, shows nothing.
		await page.keyboard.press("Control+c");

		expect(await dump.finish()).toEqual(["03", "1b 5b 31 3b 35 44", "03"]);
		expect(await confirmationsShown(page)).toBe(2);
	});

	test("⌥ sends Meta with its tip, ⇧ tab sends back-tab, and ⌃⇧ apply together", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		const tip = page.getByRole("note");

		await key(page, "Option").click();
		await expect(tip).toContainText("⌥ is waiting for your next key");
		await page.keyboard.press("b");
		await expect(tip).toHaveCount(0);
		await dump.group();
		await key(page, "Shift").click();
		await key(page, "Tab").click();
		await dump.group();
		await key(page, "Control").click();
		await key(page, "Shift").click();
		await key(page, "Left arrow").click();
		await dump.group();
		await key(page, "Left arrow").click();

		expect(await dump.finish()).toEqual([
			"1b 62",
			"1b 5b 5a",
			"1b 5b 31 3b 36 44",
			// Both were spent by the one key.
			"1b 5b 44",
		]);
	});

	test("waiting is spent by one key, locked is kept until clicked off, and ⌃1 sends 1", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		const shift = key(page, "Shift");

		await shift.click();
		await page.keyboard.type("ab");
		await dump.group();
		await shift.click();
		await shift.click();
		await page.keyboard.type("ab");
		await dump.group();
		await shift.click();
		await page.keyboard.type("ab");
		await dump.group();
		await key(page, "Control").click();
		await page.keyboard.press("1");
		await expect(key(page, "Control")).toHaveAttribute("aria-pressed", "false");

		expect(await dump.finish()).toEqual(["41 62", "41 42", "61 62", "31"]);
	});

	test("multi-character input passes through and leaves a waiting modifier waiting", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		await key(page, "Control").click();
		// One input event carrying three characters, as an IME commit sends.
		await page.keyboard.insertText("xyz");
		await page.keyboard.press("c");

		expect(await dump.finish()).toEqual(["78 79 7a 03"]);
	});

	test("with ⌃ locked, a held arrow shows one confirmation", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await countConfirmations(page);
		const dump = await startByteDump(page, testInfo);
		const control = key(page, "Control");

		await control.click();
		await control.click();
		await key(page, "Up arrow").hover();
		await page.mouse.down();
		await page.waitForTimeout(1_000);
		await page.mouse.up();
		// Release before the marker, which would otherwise be re-encoded.
		await control.click();

		const [held] = await dump.finish();
		const up = "1b 5b 31 3b 35 41";
		expect(held?.split(up).length ?? 0).toBeGreaterThan(5);
		expect(held?.replaceAll(up, "").trim()).toBe("");
		expect(await confirmationsShown(page)).toBe(1);
	});

	for (const applicationCursor of [false, true]) {
		test(`on-screen ⌃ and ⇧ match the physical combination for every recognised key${applicationCursor ? " in application cursor mode" : ""}`, async ({
			page,
			relayUrl,
		}, testInfo) => {
			await openTerminal(page, relayUrl);
			const dump = await startByteDump(page, testInfo, { applicationCursor });
			const physical = [
				"ArrowUp",
				"ArrowDown",
				"ArrowLeft",
				"ArrowRight",
				"Home",
				"End",
				"PageUp",
				"PageDown",
				"Tab",
				"Escape",
				"Enter",
				"Backspace",
			];
			const combos = [
				...physical.map((name) => ["Control", name] as const),
				// A physical ⇧ page key scrolls the scrollback instead of sending.
				...physical
					.filter((name) => !name.startsWith("Page"))
					.map((name) => ["Shift", name] as const),
			];

			for (const [modifier, name] of combos) {
				await key(page, modifier).click();
				await page.keyboard.press(name);
				await dump.group();
				await page.keyboard.press(`${modifier}+${name}`);
				await dump.group();
			}

			const groups = await dump.finish();
			// Equal but empty would hide a key the dump never saw.
			expect(groups.slice(0, 2 * combos.length)).not.toContain("");
			const onScreen = combos.map(
				([m, name], i) => `${m}+${name}: ${groups[2 * i]}`,
			);
			const typed = combos.map(
				([m, name], i) => `${m}+${name}: ${groups[2 * i + 1]}`,
			);
			expect(onScreen).toEqual(typed);
		});
	}

	test("each modifier reports off, waiting and locked", async ({
		page,
		relayUrl,
	}) => {
		await openTerminal(page, relayUrl);
		for (const name of ["Control", "Option", "Command", "Shift"]) {
			const modifier = key(page, name);
			await expect(modifier).toHaveAttribute("aria-pressed", "false");
			await modifier.click();
			await expect(modifier).toHaveAttribute("aria-pressed", "mixed");
			await modifier.click();
			await expect(modifier).toHaveAttribute("aria-pressed", "true");
			await modifier.click();
			await expect(modifier).toHaveAttribute("aria-pressed", "false");
		}
	});
});

test.describe("Paste on desktop", () => {
	test.beforeEach(async ({ context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	});

	const copy = (page: Page, text: string) =>
		page.evaluate((t) => navigator.clipboard.writeText(t), text);
	const guard = (page: Page) => page.getByRole("alertdialog");

	test("a single line arrives as typed, and a waiting ⌃ is neither applied nor spent", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		await copy(page, "echo hi");
		await key(page, "Paste").click();
		await clipboardRead(page);
		await dump.group();
		await key(page, "Control").click();
		await copy(page, "c");
		await key(page, "Paste").click();
		await clipboardRead(page);
		await expect(key(page, "Control")).toHaveAttribute("aria-pressed", "mixed");
		// The still-waiting ⌃ applies to the next key instead.
		await page.keyboard.press("a");

		expect(await dump.finish()).toEqual(["65 63 68 6f 20 68 69", "63 01"]);
	});

	test("with bracketed paste on, several lines arrive as one block", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo, { bracketedPaste: true });

		await copy(page, "a\nb\nc\n");
		await key(page, "Paste").click();
		await expect(
			page.locator("#terminal-panel").getByText("Pasted 3 lines as one block"),
		).toBeVisible();
		await expect(guard(page)).toHaveCount(0);

		expect(await dump.finish()).toEqual([
			"1b 5b 32 30 30 7e 61 0d 62 0d 63 0d 1b 5b 32 30 31 7e",
		]);
	});

	test("with bracketed paste off, several lines wait for confirmation", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		await copy(page, "a\nb\nc");
		await key(page, "Paste").click();
		await expect(guard(page)).toContainText(
			"Paste 3 lines? They'll run one at a time.",
		);
		await dump.group();
		await guard(page).getByRole("button", { name: "Cancel" }).click();
		await expect(guard(page)).toHaveCount(0);
		await dump.group();
		await key(page, "Paste").click();
		await guard(page).getByRole("button", { name: "Paste" }).click();

		// Nothing while asking, nothing on cancel, then the lines once confirmed.
		expect(await dump.finish()).toEqual(["", "", "61 0d 62 0d 63"]);
	});

	test("the keyboard's own paste gets the same confirmation", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		await copy(page, "a\nb");
		await page.keyboard.press("ControlOrMeta+v");
		await expect(guard(page)).toContainText("Paste 2 lines?");
		await dump.group();
		await guard(page).getByRole("button", { name: "Paste" }).click();

		expect(await dump.finish()).toEqual(["", "61 0d 62"]);
	});

	test("a denied clipboard says so and suggests the keyboard", async ({
		page,
		context,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await context.clearPermissions();

		await key(page, "Paste").click();
		await expect(
			page
				.locator("#terminal-panel")
				.getByText(
					"Can't read the clipboard here. Paste with the keyboard instead.",
				),
		).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("screen.png") });
	});
});

test.describe("⌘ commands on desktop", () => {
	test.beforeEach(async ({ context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	});

	const copy = (page: Page, text: string) =>
		page.evaluate((t) => navigator.clipboard.writeText(t), text);
	const clipboard = (page: Page) =>
		page.evaluate(() => navigator.clipboard.readText());
	const notice = (page: Page, text: string) =>
		page.locator("#terminal-panel").getByText(text, { exact: true });
	const rows = (page: Page) =>
		page.locator("#terminal-panel .xterm-rows").filter({ visible: true });

	test("⌘ then V pastes through the multi-line guard", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		await copy(page, "a\nb");
		await key(page, "Command").click();
		await page.keyboard.press("v");
		await expect(page.getByRole("alertdialog")).toContainText("Paste 2 lines?");
		await dump.group();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Paste" })
			.click();

		expect(await dump.finish()).toEqual(["", "61 0d 62"]);
	});

	test("⌘ then c copies the selection kept while ⌘ is held, and says when there is none", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await page.keyboard.type("echo SELECTME");
		await page.keyboard.press("Enter");
		const word = page
			.locator("#terminal-panel .xterm-rows > div")
			.filter({ hasText: /^SELECTME\s*$/ });
		const dump = await startByteDump(page, testInfo);
		const command = key(page, "Command");

		// Selected before ⌘.
		await word.dblclick({ position: { x: 20, y: 5 }, force: true });
		await command.click();
		await page.keyboard.press("c");
		await expect(notice(page, "Copied the selection")).toBeVisible();
		expect(await clipboard(page)).toBe("SELECTME");
		// Selected while ⌘ waits.
		await copy(page, "other");
		await word.click({ position: { x: 20, y: 5 }, force: true });
		await command.click();
		await word.dblclick({ position: { x: 20, y: 5 }, force: true });
		await page.keyboard.press("c");
		await expect.poll(() => clipboard(page)).toBe("SELECTME");
		// Nothing selected.
		await word.click({ position: { x: 20, y: 5 }, force: true });
		await command.click();
		await page.keyboard.press("c");
		await expect(notice(page, "Nothing selected")).toBeVisible();

		expect(await dump.finish()).toEqual([""]);
	});

	test("⌘ then k clears to the prompt line, sends nothing, and stays cleared", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await page.keyboard.type("echo BEFORE-CLEAR");
		await page.keyboard.press("Enter");
		const dump = await startByteDump(page, testInfo);
		const textRows = () =>
			rows(page)
				.locator(":scope > div")
				.evaluateAll((divs) =>
					divs.map((d) => d.textContent?.trim() ?? "").filter(Boolean),
				);

		await key(page, "Command").click();
		await page.keyboard.press("k");
		// The dump's own output line is the prompt line here.
		await expect.poll(textRows).toEqual(["BYTE-DUMP-READY"]);
		await page.locator(".term-new-btn").click();
		await expect(page.locator(".term-tab-label")).toHaveCount(2);
		await page.locator(".term-tab-label", { hasText: "Terminal 1" }).click();
		await expect.poll(textRows).toEqual(["BYTE-DUMP-READY"]);
		await page.locator("#terminal-panel .xterm-screen").first().click();

		expect(await dump.finish()).toEqual([""]);
		// Reopening the panel replays the tab's kept output: still cleared.
		const app = new AppPage(page);
		await app.terminalToggleBtn.click();
		await app.terminalToggleBtn.click();
		await expect(rows(page)).toContainText("BYTE-DUMP-DONE");
		await expect(rows(page)).not.toContainText("BEFORE-CLEAR");
	});

	test("pastes skip ⌘, other keys go as Meta, and ⌃⌘ apply together", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		const command = key(page, "Command");

		await copy(page, "k");
		await command.click();
		await key(page, "Paste").click();
		await clipboardRead(page);
		await expect(command).toHaveAttribute("aria-pressed", "mixed");
		// No group here: the separator would spend the waiting ⌘.
		await page.keyboard.press("x");
		await dump.group();
		await key(page, "Control").click();
		await command.click();
		await page.keyboard.press("c");

		expect(await dump.finish()).toEqual(["6b 1b 78", "1b 03"]);
	});

	test("the physical ⌘K still opens deep search", async ({
		page,
		relayUrl,
	}) => {
		await openTerminal(page, relayUrl);
		await page.keyboard.press("Meta+k");
		await expect(page.getByTestId("deep-search")).toBeVisible();
	});
});

test.describe("Find on desktop", () => {
	const field = (page: Page) =>
		page.getByRole("textbox", { name: "Find in terminal" });
	const findBar = (page: Page) => page.getByRole("search");
	/** Prints the word without the command line itself matching it. */
	const print = async (page: Page, word: string, times = 1) => {
		const split = `${word.slice(0, 3)}''${word.slice(3)}`;
		await page.keyboard.type(
			Array.from({ length: times }, () => `echo ${split}`).join("; "),
		);
		await page.keyboard.press("Enter");
	};

	test("⌘ then F finds in the output, steps between matches, and esc hands focus back, sending nothing", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openTerminal(page, relayUrl);
		await print(page, "FINDME", 2);
		const dump = await startByteDump(page, testInfo);

		await key(page, "Command").click();
		await page.keyboard.press("f");
		await expect(field(page)).toBeFocused();
		await page.keyboard.type("FINDME");
		await expect(findBar(page)).toContainText(/[12] of 2/);
		await expect(
			page.locator("#terminal-panel .xterm-decoration-container > *"),
		).not.toHaveCount(0);
		const first = await findBar(page).textContent();
		await page.getByRole("button", { name: "Next match" }).click();
		await expect(findBar(page)).not.toHaveText(first ?? "");
		await page.getByRole("button", { name: "Previous match" }).click();
		await expect(findBar(page)).toHaveText(first ?? "");
		await field(page).press("Escape");
		await expect(findBar(page)).toHaveCount(0);
		await expect(
			page.locator("#terminal-panel .xterm-helper-textarea").first(),
		).toBeFocused();

		expect(await dump.finish()).toEqual([""]);
	});

	test("after switching tabs, ⌘ then F searches the new tab", async ({
		page,
		relayUrl,
	}) => {
		await openTerminal(page, relayUrl);
		await print(page, "FIRSTTAB");
		await page.locator(".term-new-btn").click();
		await expect(page.locator(".term-tab-label")).toHaveCount(2);
		const second = page.locator("#terminal-panel .xterm-screen").last();
		await expect(second).toBeVisible();
		await second.click();
		await print(page, "SECONDTAB");
		await expect(second).toContainText("SECONDTAB");

		await key(page, "Command").click();
		await page.keyboard.press("f");
		await field(page).fill("FIRSTTAB");
		await expect(findBar(page)).toContainText("No results");
		await field(page).fill("SECONDTAB");
		await expect(findBar(page)).toContainText("1 of 1");
	});
});

test.describe("Phone row", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		permissions: ["clipboard-read", "clipboard-write"],
	});

	async function attachScreen(page: Page, testInfo: TestInfo) {
		const path = testInfo.outputPath("screen.png");
		await page.screenshot({ path });
		await testInfo.attach("screen", { path, contentType: "image/png" });
	}

	test("a touch-primary device gets the row instead of tab-bar keys, each key named for both its actions", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);

		await expect(page.locator(".term-tab-bar [role=toolbar]")).toHaveCount(0);
		await expect(row(page)).toBeVisible();
		for (const [tap, up] of [
			["Paste", "Copy"],
			["Escape", "Tab"],
			["Control", "Command"],
			["Option", "Shift"],
		]) {
			await expect(rowKey(page, `${tap}, flick up for ${up}`)).toBeVisible();
			await expect(rowKey(page, up ?? "")).toBeVisible();
		}
		await expect(rowKey(page, "Keyboard")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await attachScreen(page, testInfo);
	});

	test("tapping and flicking each key sends its action, and a waiting modifier applies to the software keyboard", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		await page.evaluate(() => navigator.clipboard.writeText("echo hi"));
		const dump = await startByteDump(page, testInfo);
		const paste = rowKey(page, "Paste, flick up for Copy");
		const esc = rowKey(page, "Escape, flick up for Tab");
		const ctrl = rowKey(page, "Control, flick up for Command");
		const opt = rowKey(page, "Option, flick up for Shift");

		await tap(page, paste);
		await clipboardRead(page);
		await dump.group();
		await flick(page, paste);
		await expect(
			page.locator("#terminal-panel").getByText("Nothing selected"),
		).toBeVisible();
		await tap(page, esc);
		await flick(page, esc);
		await dump.group();
		// insertText is how a software keyboard types: an input event, no keydown.
		await tap(page, ctrl);
		await expect(ctrl).toHaveAttribute("aria-pressed", "mixed");
		await page.keyboard.insertText("c");
		await dump.group();
		await flick(page, ctrl);
		await expect(rowKey(page, "Command")).toHaveAttribute(
			"aria-pressed",
			"mixed",
		);
		await page.keyboard.insertText("x");
		await dump.group();
		await tap(page, opt);
		await page.keyboard.insertText("b");
		await dump.group();
		await flick(page, opt);
		await page.keyboard.insertText("a");

		expect(await dump.finish()).toEqual([
			"65 63 68 6f 20 68 69",
			"1b 09",
			"03",
			"1b 78",
			"1b 62",
			"41",
		]);
	});

	test("the bubble shows the flick, sliding back cancels to the tap, and the corner label sends the flick", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		const esc = rowKey(page, "Escape, flick up for Tab");
		const bubble = row(page).locator(".flick-bubble");

		const touch = await finger(page, esc);
		await touch.moveTo(0, -30);
		await expect(bubble).toHaveText(/tab\s*Tab/);
		await touch.moveTo(0, 0);
		await expect(bubble).toHaveCount(0);
		await touch.lift();
		await dump.group();
		await tap(page, rowKey(page, "Tab"));
		await dump.group();
		await rowKey(page, "Tab").press("Enter");
		await textarea(page).focus();

		expect(await dump.finish()).toEqual(["1b", "09", "09"]);
	});

	test("the keyboard toggle hides the keyboard, the row stays and still sends, and a second tap brings it back", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		const toggle = rowKey(page, "Keyboard");

		await tap(page, toggle);
		await expect(textarea(page)).not.toBeFocused();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(row(page)).toBeVisible();
		await tap(page, rowKey(page, "Escape, flick up for Tab"));
		await tap(page, toggle);
		await expect(textarea(page)).toBeFocused();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");

		expect(await dump.finish()).toEqual(["1b"]);
	});

	test("when the software keyboard shrinks the viewport, the row sits at its bottom under the prompt line", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		await page.keyboard.type("PROMPT-LINE");
		const prompt = page
			.locator("#terminal-panel .xterm-rows")
			.getByText("PROMPT-LINE");
		await expect(prompt).toBeVisible();

		await page.setViewportSize({ width: 390, height: 480 });
		// Inside the panel's 1px bottom border.
		await expect
			.poll(async () => {
				const box = await row(page).boundingBox();
				return box && 480 - Math.round(box.y + box.height);
			})
			.toBe(1);
		const rowTop = (await row(page).boundingBox())?.y ?? 0;
		const promptBox = await prompt.boundingBox();
		expect(promptBox?.y).toBeGreaterThanOrEqual(0);
		expect((promptBox?.y ?? 0) + (promptBox?.height ?? 0)).toBeLessThanOrEqual(
			rowTop,
		);
		await attachScreen(page, testInfo);
	});

	const pad = (page: Page) => row(page).getByRole("group", { name: "Arrows" });
	const ARROW = {
		up: "1b 5b 41",
		down: "1b 5b 42",
		right: "1b 5b 43",
		left: "1b 5b 44",
	};
	/** A drag of `steps` 14px pad steps, plus half a step of slack. */
	const stepPx = (steps: number) => steps * 14 + 7;

	test("dragging the arrow pad sends one arrow per step in the dominant direction, and tapping a side sends that arrow once", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		// Released without pausing, with a wobble across the drag.
		let touch = await finger(page, pad(page));
		await touch.moveTo(stepPx(3), 8);
		await touch.lift();
		await dump.group();
		touch = await finger(page, pad(page));
		await touch.moveTo(-5, -stepPx(2));
		await touch.lift();
		await dump.group();
		await tap(page, pad(page), { x: -0.4, y: 0 });
		await dump.group();
		await tap(page, pad(page), { x: 0, y: 0.4 });
		await attachScreen(page, testInfo);

		expect(await dump.finish()).toEqual([
			Array(3).fill(ARROW.right).join(" "),
			Array(2).fill(ARROW.up).join(" "),
			ARROW.left,
			ARROW.down,
		]);
	});

	test("holding still after a drag repeats its direction", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);

		const touch = await finger(page, pad(page));
		await touch.moveTo(stepPx(2), 0);
		await page.waitForTimeout(1_000);
		await touch.lift();

		const [bytes = ""] = await dump.finish();
		const arrows = bytes.match(/1b 5b \w\w/g) ?? [];
		expect(new Set(arrows)).toEqual(new Set([ARROW.right]));
		// Two drag steps, then at least as many repeats.
		expect(arrows.length).toBeGreaterThanOrEqual(4);
	});

	test("with ⌃ waiting, the pad sends the ⌃ arrow and the modifier is spent", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openPhoneTerminal(page, relayUrl);
		const dump = await startByteDump(page, testInfo);
		const ctrl = rowKey(page, "Control, flick up for Command");

		await tap(page, ctrl);
		await expect(ctrl).toHaveAttribute("aria-pressed", "mixed");
		await tap(page, pad(page), { x: 0.4, y: 0 });
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");

		expect(await dump.finish()).toEqual(["1b 5b 31 3b 35 43"]);
	});
});
