import type { Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

async function twoRows(page: Page, relayUrl: string) {
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	return rows;
}

test("j/k cross groups; Enter opens; settle, undo, pin, snooze and rename work from focus", async ({
	page,
	relayUrl,
}) => {
	const rows = await twoRows(page, relayUrl);
	const first = rows.first();
	const firstId = await first.getAttribute("data-session-id");
	if (!firstId) throw new Error("missing session id");
	const firstRow = page.locator(`#session-list [data-session-id="${firstId}"]`);
	await firstRow.focus();
	await page.keyboard.press("p");
	await expect(
		page.locator("#session-list-scroller > .session-group-label").first(),
	).toHaveText(/Pinned\s+1/);
	await expect(firstRow).toBeFocused();
	await page.keyboard.press("j");
	const neighbour = rows.nth(1);
	await expect(neighbour).toBeFocused();
	await page.keyboard.press("k");
	await expect(firstRow).toBeFocused();
	await page.keyboard.press("ControlOrMeta+z");
	await expect(
		page.locator("#session-list-scroller > .session-group-label", {
			hasText: /^Pinned\s+1$/,
		}),
	).toHaveCount(0);

	await page.keyboard.press("j");
	const settledId = await neighbour.getAttribute("data-session-id");
	if (!settledId) throw new Error("missing neighbour id");
	await page.keyboard.press("s");
	await expect(
		page.locator(`#session-list [data-session-id="${settledId}"]`),
	).toHaveCount(0);
	await expect(rows.first()).toBeFocused();
	await page.keyboard.press("ControlOrMeta+z");
	await expect(
		page.locator(`#session-list [data-session-id="${settledId}"]`),
	).toBeVisible();

	await rows.first().focus();
	await page.keyboard.press("z");
	await expect(page.getByTestId("snooze-option-indefinite")).toBeVisible();
	await page.keyboard.press("Escape");
	await rows.first().focus();
	await page.keyboard.press("r");
	await expect(
		rows.first().getByRole("textbox", { name: "Session name" }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await rows.first().focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/s\/[^/]+$/);
});

test("scope digits, shortcut sheet and text-field guards", async ({
	page,
	relayUrl,
}) => {
	const rows = await twoRows(page, relayUrl);
	await rows.first().focus();
	await page.keyboard.press("1");
	await expect(page.getByTestId("session-scope-chip")).not.toContainText(
		"All projects",
	);
	await page.keyboard.press("0");
	await expect(page.getByTestId("session-scope-chip")).toContainText(
		"All projects",
	);
	await rows.first().focus();
	const id = await rows.first().getAttribute("data-session-id");
	await page.keyboard.press("?");
	await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
	await expect(page.getByTestId("shortcut-sheet")).toContainText("⌘Z");
	await page.keyboard.press("Escape");
	await expect(
		page.locator(`#session-list [data-session-id="${id}"]`),
	).toBeFocused();

	for (const selector of ["#input", "#session-search-input"]) {
		const field = page.locator(selector);
		await field.focus();
		await page.keyboard.press("s");
		await page.keyboard.press("p");
		await page.keyboard.press("?");
		await expect(field).toBeFocused();
		await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
		if (selector === "#session-search-input") await field.fill("");
		await expect(
			page.locator(`#session-list [data-session-id="${id}"]`),
		).toBeVisible();
		await expect(
			page
				.locator(`#session-list [data-session-id="${id}"]`)
				.getByTestId("session-act-pin"),
		).toHaveAttribute("title", "Pin (p)");
	}
});

test("each row verb has pointer and touch controls", async ({
	page,
	relayUrl,
}) => {
	const rows = await twoRows(page, relayUrl);
	const row = rows.last();
	const twins = [
		{ key: "s", pointer: "session-act-settle", touch: "session-ctx-settle" },
		{ key: "z", pointer: "session-act-snooze", touch: "session-ctx-snooze" },
		{ key: "p", pointer: "session-act-pin", touch: "session-ctx-pin" },
		{
			key: "u",
			pointer: "session-act-mark-unread",
			touch: "session-ctx-mark-unread",
		},
		{ key: "r", pointer: "session-more-btn", touch: "session-ctx-rename" },
	] as const;
	for (const { key, pointer, touch } of twins) {
		await row.hover();
		if (pointer === "session-more-btn")
			await expect(row.locator(`.${pointer}`), key).toBeVisible();
		else await expect(row.getByTestId(pointer), key).toBeVisible();
		await row.click({ button: "right" });
		await expect(page.getByTestId(touch), `${key} touch twin`).toBeVisible();
		await page.keyboard.press("Escape");
	}
});
