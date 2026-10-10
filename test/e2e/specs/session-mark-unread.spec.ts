import type { Locator, Page } from "@playwright/test";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

async function markCurrentUnreadFromTitle(page: Page): Promise<void> {
	await page.getByTestId("session-bar-title-menu").click();
	await page.getByTestId("session-ctx-mark-unread").click();
}

test.use({
	recording: "chat-simple",
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

// Rows are picked by their title: the row centre can land on a hover verb
// such as Mark read (e5b2819b).
// Unread is relative to a turn end (ADR-0004, Scope; conduit-test-hk9m.3), and
// the recorded session has none until its prompt replays. The replay also
// reorders the list, so the returned row is pinned to that session.
async function finishTurn(harness: ReplayHarness, firstRow: Locator) {
	const id = await firstRow.getAttribute("data-session-id");
	if (!id) throw new Error("the recorded session has no row id");
	const row = firstRow
		.page()
		.locator(`#session-list .session-item[data-session-id="${id}"]`);
	harness.mock.triggerPromptSse(id);
	await expect(row.getByTestId("session-unread-dot")).toBeVisible({
		timeout: 20_000,
	});
	return row;
}

test("context menu, focused row and transcript toggle read state with undo", async ({
	page,
	relayUrl,
	harness,
}) => {
	await gotoRelay(page, new URL("/", relayUrl).toString());
	const row = await finishTurn(
		harness,
		page.locator("#session-list .session-item").first(),
	);
	await expect(row).toBeVisible();
	await row.locator(".session-item-title").click();
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);

	await row.click({ button: "right" });
	await expect(page.getByTestId("session-ctx-mark-unread")).toContainText(
		"⌘⇧U",
	);
	await page.getByTestId("session-ctx-mark-unread").click();
	await expect(
		page.getByRole("status").filter({ hasText: "Marked unread" }),
	).toHaveCount(1);
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await expect(row).toHaveAttribute("aria-label", /Done, unread/);
	await expect(page.getByTestId("session-filter-chip-unread")).toContainText(
		"1",
	);
	await page.getByTestId("toast-action").first().click();
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);

	await row.focus();
	await page.keyboard.press("u");
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-mark-read").click();
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);

	await page.locator("#messages").focus();
	await page.keyboard.press("u");
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await page.locator("#input").fill("u");
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+Shift+U");
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+Shift+U");
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await expect(page.locator("#input")).toHaveValue("u");
});

// A session whose turn never ended has nothing to be unread relative to, but
// the user asked for a dot, so it gets one until the next pick (hk9m.7).
test("marking unread before any turn end shows a dot until the next pick", async ({
	page,
	relayUrl,
}) => {
	await gotoRelay(page, new URL("/", relayUrl).toString());
	const row = page.locator("#session-list .session-item").first();
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-mark-unread").click();
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await gotoRelay(page, new URL("/", relayUrl).toString());
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await row.locator(".session-item-title").click();
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
});

test("settling and un-settling preserve unread while the menu hides the action", async ({
	page,
	relayUrl,
	harness,
}) => {
	await gotoRelay(page, new URL("/", relayUrl).toString());
	const row = await finishTurn(
		harness,
		page.locator("#session-list .session-item").first(),
	);
	await row.locator(".session-item-title").click();
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-mark-unread").click();
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	// The mark is persisted, not client state: a fresh load of the list keeps it.
	await gotoRelay(page, new URL("/", relayUrl).toString());
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	await expect(page.getByTestId("session-filter-chip-unread")).toContainText(
		"0",
	);
	await page.getByTestId("settled-shelf-toggle").click();
	const shelfRow = page.locator("#settled-shelf-rows .session-item").first();
	await shelfRow.click({ button: "right" });
	await expect(page.getByTestId("session-ctx-mark-unread")).toHaveCount(0);
	await expect(page.getByTestId("session-ctx-mark-read")).toHaveCount(0);
	await page.getByTestId("session-ctx-unsettle").click();
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await expect(page.getByTestId("session-filter-chip-unread")).toContainText(
		"1",
	);
	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-snooze").click();
	await page.getByTestId("snooze-option-indefinite").click();
	await page.getByTestId("snoozed-shelf-toggle").click();
	await page
		.locator("#snoozed-shelf-rows .session-item")
		.first()
		.click({ button: "right" });
	await expect(page.getByTestId("session-ctx-mark-unread")).toHaveCount(0);
	await expect(page.getByTestId("session-ctx-mark-read")).toHaveCount(0);
});

test("desktop unread chip survives reload, has one keyboard-accessible read action, and ends on another session", async ({
	page,
	relayUrl,
	harness,
}) => {
	await gotoRelay(page, new URL("/", relayUrl).toString());
	const sidebar = new SidebarPage(page);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	await finishTurn(harness, rows.first());
	const firstId = await rows.first().getAttribute("data-session-id");
	if (!firstId) throw new Error("missing first session id");
	await sidebar.createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const secondId = (
		await rows.evaluateAll((items) =>
			items.map((item) => item.getAttribute("data-session-id")),
		)
	).find((id) => id && id !== firstId);
	if (!secondId) throw new Error("missing second session id");
	const firstRow = page.locator(`#session-list [data-session-id="${firstId}"]`);
	await firstRow.locator(".session-item-title").click();
	const bar = page.getByTestId("session-bar");
	const heightWithoutChip = (await bar.boundingBox())?.height;
	if (heightWithoutChip == null) throw new Error("missing session bar box");

	await markCurrentUnreadFromTitle(page);
	const chip = page.getByTestId("session-bar-unread-chip");
	await expect(chip).toBeVisible();
	await expect(firstRow.getByTestId("session-unread-dot")).toBeVisible();
	await expect(chip.locator(".bg-brand-a")).toHaveCount(1);
	const titleOrder = await page
		.locator("#session-bar-title-row")
		.evaluate((row) =>
			Array.from(row.querySelectorAll("[data-testid]"), (el) =>
				el.getAttribute("data-testid"),
			),
		);
	expect(titleOrder.indexOf("session-bar-unread-chip")).toBeGreaterThan(
		titleOrder.indexOf("session-bar-title-menu"),
	);
	expect((await bar.boundingBox())?.height).toBe(heightWithoutChip);
	expect((await chip.boundingBox())?.height).toBeGreaterThanOrEqual(44);

	const observer = await page.context().newPage();
	await gotoRelay(observer, new URL("/", relayUrl).toString());
	const observerRow = observer.locator(
		`#session-list [data-session-id="${firstId}"]`,
	);
	await expect(observerRow.getByTestId("session-unread-dot")).toBeVisible();
	await page.reload();
	await expect(chip).toBeVisible();
	await expect(firstRow.getByTestId("session-unread-dot")).toBeVisible();
	await observer.reload();
	await expect(observerRow.getByTestId("session-unread-dot")).toBeVisible();
	await expect(chip).toBeVisible();
	await page.getByTestId("session-bar-title-menu").focus();
	await page.keyboard.press("Tab");
	await expect(chip).toBeFocused();
	await page.keyboard.press("Enter");
	const menu = page.getByTestId("session-bar-unread-menu");
	await expect(menu.getByRole("menuitem")).toHaveCount(1);
	await expect(menu.getByRole("menuitem")).toHaveText("Mark read");
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(chip).toBeFocused();
	await chip.click();
	await page.getByTestId("session-bar-unread-mark-read").click();
	await expect(chip).toHaveCount(0);
	await expect(firstRow.getByTestId("session-unread-dot")).toHaveCount(0);

	await markCurrentUnreadFromTitle(page);
	await expect(chip).toBeVisible();
	await sidebar.clickSession(secondId);
	await sidebar.clickSession(firstId);
	await expect(chip).toHaveCount(0);
	await expect(firstRow.getByTestId("session-unread-dot")).toHaveCount(0);
});

test.describe("phone", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("title sheet and composer shortcut return to the list with undo", async ({
		page,
		relayUrl,
		harness,
	}) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const row = await finishTurn(
			harness,
			page.locator("#session-list .session-item").first(),
		);
		await row.click();
		await page.getByTestId("session-bar-title-menu").click();
		const sheet = page.getByTestId("session-action-sheet");
		await expect(sheet.locator(".shortcut-hint").first()).toBeVisible();
		await sheet.getByTestId("session-ctx-mark-unread").click();
		await expect(page.getByTestId("session-bar")).toHaveCount(0);
		await expect(row.getByTestId("session-unread-dot")).toBeVisible();
		await expect(
			page.getByRole("status").filter({ hasText: "Marked unread" }),
		).toHaveCount(1);
		await page.getByTestId("toast-action").first().click();
		await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);

		await row.click();
		await page.locator("#input").focus();
		await page.keyboard.press("ControlOrMeta+Shift+U");
		await expect(page.getByTestId("session-bar")).toHaveCount(0);
		await expect(row.getByTestId("session-unread-dot")).toBeVisible();
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-mark-read").click();
		await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
	});

	test("marking unread never shows the desktop chip", async ({
		page,
		relayUrl,
		harness,
	}) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const row = await finishTurn(
			harness,
			page.locator("#session-list .session-item").first(),
		);
		await row.click();
		await markCurrentUnreadFromTitle(page);
		await expect(page.getByTestId("session-bar-unread-chip")).toHaveCount(0);
		await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	});
});
