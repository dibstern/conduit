import type { Locator } from "@playwright/test";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

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
	await row.click();
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
	await page.getByTestId("toast-action").last().click();
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
	await row.click();
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
	await row.click();
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

test.describe("phone", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("overflow and composer shortcut return to the list with undo", async ({
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
		await page.getByTestId("session-bar-overflow").click();
		await expect(page.getByTestId("overflow-mark-unread")).toContainText("⌘⇧U");
		await page.getByTestId("overflow-mark-unread").click();
		await expect(page.getByTestId("session-bar")).toHaveCount(0);
		await expect(row.getByTestId("session-unread-dot")).toBeVisible();
		await expect(
			page.getByRole("status").filter({ hasText: "Marked unread" }),
		).toHaveCount(1);
		await page.getByTestId("toast-action").last().click();
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
});
