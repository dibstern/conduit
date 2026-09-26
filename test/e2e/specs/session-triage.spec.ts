import type { Locator } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

async function sectionBefore(row: Locator) {
	return row.evaluate((element) => {
		let previous = element.previousElementSibling;
		while (previous && !previous.classList.contains("session-group-label")) {
			previous = previous.previousElementSibling;
		}
		return previous?.textContent?.trim();
	});
}

test("settle, undo, search, pin and reload preserve triage and shelf preference", async ({
	page,
	relayUrl,
}) => {
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	// The recording holds one session; triage needs a second to move around.
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const settleId = await rows.nth(1).getAttribute("data-session-id");
	const pinId = await rows.first().getAttribute("data-session-id");
	const row = page.locator(`[data-session-id="${settleId}"]`);
	const pinRow = page.locator(`[data-session-id="${pinId}"]`);
	const title = (await row.locator(".session-title-inner").innerText()).trim();
	const originalSection = await sectionBefore(row);
	const toggle = page.getByTestId("settled-shelf-toggle");
	const shelf = page.locator("#settled-shelf-rows");

	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(toggle).toHaveText("Settled");
	await expect(row).toHaveCount(0);
	// Other live regions exist ("Connected", the composer); only one may speak
	// about the settle.
	await expect(
		page.getByRole("status").filter({ hasText: `Moved “${title}” to Settled` }),
	).toHaveCount(1);
	await expect(page.locator("#session-list [aria-live]")).toHaveCount(0);
	await page.getByTestId("toast-action").click();
	await expect(row).toBeVisible();
	await expect.poll(() => sectionBefore(row)).toBe(originalSection);
	await expect(toggle).toHaveCount(0);

	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	await expect(row).toHaveCount(0);
	await toggle.click();
	await expect(shelf.locator(`[data-session-id="${settleId}"]`)).toBeVisible();
	await page.reload();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(shelf.locator(`[data-session-id="${settleId}"]`)).toBeVisible();
	await toggle.click();
	await expect(row).toHaveCount(0);
	await page.getByPlaceholder("Search sessions...").fill(title);
	await expect(shelf.locator(`[data-session-id="${settleId}"]`)).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	expect(
		await page.evaluate(() => localStorage.getItem("settled-shelf-open")),
	).toBe("false");
	await page.getByPlaceholder("Search sessions...").press("Escape");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");

	await pinRow.click({ button: "right" });
	await page.getByTestId("session-ctx-pin").click();
	await expect(page.locator(".session-group-label").first()).toHaveText(
		"Pinned",
	);
	await expect(rows.first()).toHaveAttribute("data-session-id", pinId ?? "");
	await pinRow.click({ button: "right" });
	const settle = page.getByTestId("session-ctx-settle");
	await expect(settle).toHaveAttribute("aria-disabled", "true");
	await expect(settle).toContainText("Unpin to settle");
	await expect(page.getByTestId("session-ctx-unpin")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(page.locator(".session-group-label").first()).toHaveText(
		"Pinned",
	);
	await expect(rows.first()).toHaveAttribute("data-session-id", pinId ?? "");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(row).toHaveCount(0);
	await toggle.click();
	await expect(shelf.locator(`[data-session-id="${settleId}"]`)).toBeVisible();
});
