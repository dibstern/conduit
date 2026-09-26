import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

test("snooze, undo, shelf, reload, search, unsnooze and a time wake", async ({
	page,
	relayUrl,
}) => {
	// A controllable clock lets the time wake happen without waiting an hour; the
	// server still checks against real time, which the installed clock starts at.
	await page.clock.install();
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	// The recording holds one session; snooze needs a second to move around.
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const id = await rows.nth(1).getAttribute("data-session-id");
	const row = page.locator(`#session-list [data-session-id="${id}"]`);
	const title = (await row.locator(".session-title-inner").innerText()).trim();
	const toggle = page.getByTestId("snoozed-shelf-toggle");
	const shelfRow = page.locator(
		`#snoozed-shelf-rows [data-session-id="${id}"]`,
	);

	const snooze = async (option: string) => {
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-snooze").click();
		await page.getByTestId(option).click();
	};

	await snooze("snooze-option-indefinite");
	await expect(row).toHaveCount(0);
	await expect(toggle).toHaveText("Snoozed");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: `Snoozed “${title}” until something happens` }),
	).toHaveCount(1);
	await page.getByTestId("toast-action").click();
	await expect(row).toBeVisible();
	await expect(toggle).toHaveCount(0);

	await snooze("snooze-option-1h");
	await expect(row).toHaveCount(0);
	await toggle.click();
	await expect(shelfRow).toBeVisible();
	await expect(shelfRow.locator(".session-item-meta")).toHaveText(
		/\d{1,2}:\d{2}/,
	);

	await page.reload();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(shelfRow).toBeVisible();
	await toggle.click();
	await expect(shelfRow).toHaveCount(0);
	await page.getByPlaceholder("Search sessions...").fill(title);
	await expect(shelfRow).toBeVisible();
	await page.getByPlaceholder("Search sessions...").press("Escape");
	await expect(shelfRow).toHaveCount(0);

	// The client clock wakes the row the moment its time passes, marked as woken.
	await page.clock.fastForward("01:01:00");
	await expect(row).toBeVisible();
	await expect(row.getByTestId("session-woke-pill")).toHaveText("Woke");
	await expect(toggle).toHaveCount(0);

	// Unsnooze by hand from the shelf.
	await snooze("snooze-option-indefinite");
	await toggle.click();
	await shelfRow.click({ button: "right" });
	await page.getByTestId("session-ctx-unsnooze").click();
	await expect(row).toBeVisible();
	await expect(row.getByTestId("session-woke-pill")).toHaveCount(0);
	await expect(toggle).toHaveCount(0);
});
