import type { Locator, Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

async function rowsReady(page: Page, relayUrl: string, count = 3) {
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	const sidebar = new SidebarPage(page);
	for (let current = await rows.count(); current < count; current++) {
		await sidebar.createNewSession();
		await expect.poll(() => rows.count()).toBeGreaterThan(current);
	}
	return rows;
}

async function sectionBefore(row: Locator) {
	return row.evaluate((element) => {
		let previous = element.previousElementSibling;
		while (previous && !previous.classList.contains("session-group-label"))
			previous = previous.previousElementSibling;
		return previous?.textContent?.trim();
	});
}

// Real touch through CDP: a synthetic click() after pointerup would stand in
// for the compat click that a real long press cancels at touchend.
async function longPress(page: Page, row: Locator) {
	const box = await row.boundingBox();
	if (!box) throw new Error("row is not rendered");
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
	});
	await page.waitForTimeout(700);
	await cdp.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await cdp.detach();
}

async function selectRows(page: Page, ids: string[]) {
	await page.getByRole("button", { name: "Select sessions" }).click();
	for (const id of ids) {
		const row = page.locator(`#session-list [data-session-id="${id}"]`);
		await row.getByRole("checkbox").click();
	}
}

test("desktop: bulk settle announces once and Undo restores only this batch", async ({
	page,
	relayUrl,
}) => {
	const rows = await rowsReady(page, relayUrl);
	const ids = await rows.evaluateAll((elements) =>
		elements.map((element) => element.getAttribute("data-session-id")),
	);
	const [existingId, firstId, secondId] = ids;
	if (!existingId || !firstId || !secondId)
		throw new Error("missing session ids");
	const existing = page.locator(
		`#session-list [data-session-id="${existingId}"]`,
	);
	await existing.click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	const shelf = page.locator("#settled-shelf-rows");
	await page.getByTestId("settled-shelf-toggle").click();
	await expect(
		shelf.locator(`[data-session-id="${existingId}"]`),
	).toBeVisible();
	const first = page.locator(`#session-list [data-session-id="${firstId}"]`);
	const second = page.locator(`#session-list [data-session-id="${secondId}"]`);
	const firstSection = await sectionBefore(first);
	const secondSection = await sectionBefore(second);
	await page.getByRole("button", { name: "Select sessions" }).click();
	for (const row of [first, second]) {
		const title = (
			await row.locator(".session-title-inner").innerText()
		).trim();
		const checkbox = row.getByRole("checkbox", { name: `Select ${title}` });
		await expect(checkbox).toHaveAttribute("aria-checked", "false");
		await checkbox.click();
	}
	await expect(page.getByText("2 selected")).toBeVisible();
	await page.getByTestId("select-bar-settle").click();
	await expect(shelf.locator(`[data-session-id="${firstId}"]`)).toBeVisible();
	await expect(shelf.locator(`[data-session-id="${secondId}"]`)).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "Settled 2 sessions" }),
	).toHaveCount(1);
	await page.getByTestId("toast-action").last().click();
	await expect(first).toBeVisible();
	await expect(second).toBeVisible();
	await expect.poll(() => sectionBefore(first)).toBe(firstSection);
	await expect.poll(() => sectionBefore(second)).toBe(secondSection);
	await expect(
		shelf.locator(`[data-session-id="${existingId}"]`),
	).toBeVisible();
});

test("bulk Pin changes two rows with one toast and Undo restores both", async ({
	page,
	relayUrl,
}) => {
	const rows = await rowsReady(page, relayUrl);
	const ids = (
		await rows.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("data-session-id")),
		)
	).slice(-2);
	if (ids.some((id) => !id)) throw new Error("missing session ids");
	await selectRows(page, ids as string[]);
	await expect(page.getByTestId("select-bar-pin")).toHaveAccessibleName(
		"Pin 2 sessions",
	);
	await page.getByTestId("select-bar-pin").click();
	for (const id of ids)
		await expect(
			page
				.locator(`#session-list [data-session-id="${id}"]`)
				.getByTitle("Pinned session"),
		).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "Pinned 2 sessions" }),
	).toHaveCount(1);
	await page.getByTestId("toast-action").last().click();
	for (const id of ids)
		await expect(
			page
				.locator(`#session-list [data-session-id="${id}"]`)
				.getByTitle("Pinned session"),
		).toHaveCount(0);
});

test("two pinned rows show Unpin in select mode", async ({
	page,
	relayUrl,
}) => {
	const rows = await rowsReady(page, relayUrl);
	const ids = (
		await rows.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("data-session-id")),
		)
	).slice(-2);
	if (ids.some((id) => !id)) throw new Error("missing session ids");
	for (const id of ids) {
		await page
			.locator(`#session-list [data-session-id="${id}"]`)
			.click({ button: "right" });
		await page.getByTestId("session-ctx-pin").click();
	}
	await selectRows(page, ids as string[]);
	await expect(page.getByTestId("select-bar-pin")).toHaveAccessibleName(
		"Unpin 2 sessions",
	);
	await expect(page.getByTestId("select-bar-pin")).toContainText("Unpin");
	await expect(page.getByTestId("select-bar-settle")).toBeDisabled();
	await expect(page.getByTestId("select-bar-snooze")).toBeDisabled();
	await page.getByTestId("select-bar-pin").click();
	for (const id of ids)
		await expect(
			page
				.locator(`#session-list [data-session-id="${id}"]`)
				.getByTitle("Pinned session"),
		).toHaveCount(0);
	await expect(
		page.getByRole("status").filter({ hasText: "Unpinned 2 sessions" }),
	).toHaveCount(1);
});

test("bulk Snooze uses one sheet and Undo returns both rows", async ({
	page,
	relayUrl,
}) => {
	const rows = await rowsReady(page, relayUrl);
	const ids = (
		await rows.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("data-session-id")),
		)
	).slice(-2);
	if (ids.some((id) => !id)) throw new Error("missing session ids");
	await selectRows(page, ids as string[]);
	await expect(page.getByTestId("select-bar-snooze")).toHaveAccessibleName(
		"Snooze 2 sessions",
	);
	await page.getByTestId("select-bar-snooze").click();
	await expect(page.getByRole("dialog")).toContainText("2 sessions");
	await page.getByTestId("snooze-option-tomorrow").click();
	await page.getByTestId("snoozed-shelf-toggle").click();
	for (const id of ids)
		await expect(
			page.locator(`#snoozed-shelf-rows [data-session-id="${id}"]`),
		).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "Snoozed 2 sessions until" }),
	).toHaveCount(1);
	await page.getByTestId("toast-action").last().click();
	for (const id of ids) {
		await expect(
			page.locator(`#snoozed-shelf-rows [data-session-id="${id}"]`),
		).toHaveCount(0);
		await expect(
			page.locator(`#session-list [data-session-id="${id}"]`),
		).toBeVisible();
	}
});

test("bulk Settle skips a pinned row", async ({ page, relayUrl }) => {
	const rows = await rowsReady(page, relayUrl, 2);
	const ids = await rows.evaluateAll((elements) =>
		elements.map((element) => element.getAttribute("data-session-id")),
	);
	const [pinnedId, settleId] = ids;
	if (!pinnedId || !settleId) throw new Error("missing session ids");
	const pinned = page.locator(`#session-list [data-session-id="${pinnedId}"]`);
	await pinned.click({ button: "right" });
	await page.getByTestId("session-ctx-pin").click();
	await selectRows(page, [pinnedId, settleId]);
	await expect(page.getByTestId("select-bar-settle")).toHaveAccessibleName(
		"Settle 1 session",
	);
	await page.getByTestId("select-bar-settle").click();
	await expect(pinned.getByTitle("Pinned session")).toBeVisible();
	await expect(
		page.locator(`#settled-shelf-rows [data-session-id="${pinnedId}"]`),
	).toHaveCount(0);
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Settled 1 session, 1 skipped" }),
	).toHaveCount(1);
});

test("All selects only visible search results; Done makes no change", async ({
	page,
	relayUrl,
}) => {
	const rows = await rowsReady(page, relayUrl);
	const title = (
		await rows.first().locator(".session-title-inner").innerText()
	).trim();
	const before = await rows.evaluateAll((elements) =>
		elements.map((element) => element.getAttribute("data-session-id")),
	);
	await page.getByRole("button", { name: "Select sessions" }).click();
	await rows.first().getByRole("checkbox").click();
	await rows.last().getByRole("checkbox").click();
	await expect(page.getByText("2 selected")).toBeVisible();
	await page.getByPlaceholder("Search sessions...").fill(title);
	await expect(page.getByPlaceholder("Search sessions...")).toHaveValue(title);
	await expect(page.getByText("1 selected")).toBeVisible();
	const visible = await page
		.locator("#session-list .session-item [role=checkbox]")
		.count();
	await page
		.locator("#session-list .session-list-header")
		.getByRole("button", { name: "None", exact: true })
		.click();
	await expect(page.getByText("0 selected")).toBeVisible();
	await page
		.locator("#session-list .session-list-header")
		.getByRole("button", { name: "All", exact: true })
		.click();
	await expect(page.getByText(`${visible} selected`)).toBeVisible();
	await page.getByRole("button", { name: "Done" }).click();
	await expect(page.getByTestId("select-bar")).toHaveCount(0);
	await page.getByPlaceholder("Search sessions...").fill("");
	await expect
		.poll(() =>
			rows.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-session-id")),
			),
		)
		.toEqual(before);
});

test("keyboard enters, toggles a checkbox, and Escape leaves", async ({
	page,
	relayUrl,
}) => {
	await rowsReady(page, relayUrl, 2);
	const entry = page.getByRole("button", { name: "Select sessions" });
	await entry.focus();
	await page.keyboard.press("Enter");
	const checkbox = page
		.locator("#session-list .session-item [role=checkbox]")
		.first();
	// Search and chips precede the list in tab order; Tab through them.
	for (
		let index = 0;
		index < 50 &&
		!(await checkbox.evaluate((element) => element === document.activeElement));
		index++
	)
		await page.keyboard.press("Tab");
	await expect(checkbox).toBeFocused();
	await page.keyboard.press("Space");
	await expect(checkbox).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Enter");
	await expect(checkbox).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("select-bar")).toHaveCount(0);
});

test("phone overflow and long-press sheet enter select mode", async ({
	page,
	relayUrl,
}) => {
	await page.setViewportSize({ width: 393, height: 852 });
	await gotoRelay(page, relayUrl);
	await page.goto(new URL("/", page.url()).toString());
	const row = page.locator("#session-list .session-item").first();
	await expect(row).toBeVisible();
	await page.getByTestId("list-bar-overflow").click();
	await page.getByTestId("list-overflow-select").click();
	await expect(page.getByTestId("select-bar")).toBeVisible();
	await expect(page.getByTestId("select-bar")).toBeInViewport();
	for (const action of ["settle", "snooze", "pin", "delete"]) {
		await expect(page.getByTestId(`select-bar-${action}`)).toBeDisabled();
		await expect(page.getByTestId(`select-bar-${action}`)).toHaveCSS(
			"opacity",
			"0.35",
		);
	}
	const geometry = await page.getByTestId("select-bar").evaluate((bar) => ({
		overflows: bar.scrollWidth > bar.clientWidth,
		pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
		buttons: [...bar.querySelectorAll("button")].map((button) => {
			const rect = button.getBoundingClientRect();
			return { top: rect.top, width: rect.width, height: rect.height };
		}),
	}));
	expect(geometry.overflows).toBe(false);
	expect(geometry.pageOverflows).toBe(false);
	expect(geometry.buttons).toHaveLength(4);
	expect(new Set(geometry.buttons.map((button) => button.top)).size).toBe(1);
	for (const button of geometry.buttons)
		expect(button.height).toBeGreaterThanOrEqual(44);
	expect(
		Math.max(...geometry.buttons.map((button) => button.width)) -
			Math.min(...geometry.buttons.map((button) => button.width)),
	).toBeLessThanOrEqual(1);
	await page.getByRole("button", { name: "Done" }).click();
	await longPress(page, row);
	await page.getByTestId("session-ctx-select").click();
	await expect(row.getByRole("checkbox")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(page.getByText("1 selected")).toBeVisible();
});

test("Delete in select mode still confirms and deletes", async ({
	page,
	relayUrl,
}) => {
	const rows = await rowsReady(page, relayUrl, 2);
	const id = await rows.first().getAttribute("data-session-id");
	if (!id) throw new Error("missing session id");
	await page.getByRole("button", { name: "Select sessions" }).click();
	await rows.first().getByRole("checkbox").click();
	await page.getByTestId("select-bar-delete").click();
	await expect(page.locator("#confirm-modal")).toContainText(
		"Delete 1 session?",
	);
	await page
		.locator("#confirm-modal")
		.getByRole("button", { name: "Delete" })
		.click();
	await expect(
		page.locator(`#session-list [data-session-id="${id}"]`),
	).toHaveCount(0);
});
