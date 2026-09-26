import type { Locator, Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({
	recording: "chat-simple",
	persistence: true,
	viewport: { width: 1440, height: 900 },
	screenshot: "off",
});

// Synthetic touch pointer events, because Playwright's touchscreen only taps.
// Each step is a horizontal offset as a fraction of the row's width.
async function drag(row: Locator, steps: number[], release = true) {
	await row.evaluate(
		(element, { steps, release }) => {
			const box = element.getBoundingClientRect();
			const x0 = box.left + box.width / 2;
			const y = box.top + box.height / 2;
			const fire = (type: string, x: number) =>
				element.dispatchEvent(
					new PointerEvent(type, {
						pointerType: "touch",
						pointerId: 7,
						isPrimary: true,
						bubbles: true,
						cancelable: true,
						clientX: x,
						clientY: y,
					}),
				);
			fire("pointerdown", x0);
			// Small first moves so the direction lock sees a horizontal gesture.
			fire("pointermove", x0 + Math.sign(steps[0] ?? 1) * 12);
			for (const step of steps) fire("pointermove", x0 + step * box.width);
			const lastX = x0 + (steps.at(-1) ?? 0) * box.width;
			if (release) {
				fire("pointerup", lastX);
				// A real finger lifting after a swipe still produces a click.
				(element as HTMLElement).click();
			} else {
				// Held: lift() releases here later, where the finger still is.
				element.setAttribute("data-test-lift", `${lastX},${y}`);
			}
		},
		{ steps, release },
	);
}

async function lift(row: Locator) {
	await row.evaluate((element) => {
		const [x = 0, y = 0] = (element.getAttribute("data-test-lift") ?? "")
			.split(",")
			.map(Number);
		element.dispatchEvent(
			new PointerEvent("pointerup", {
				pointerType: "touch",
				pointerId: 7,
				isPrimary: true,
				bubbles: true,
				clientX: x,
				clientY: y,
			}),
		);
		(element as HTMLElement).click();
	});
}

// Tap the part of a held action exposed by the translated row.
async function tapExposed(action: Locator, edge: "left" | "right") {
	const box = await action.boundingBox();
	if (!box) throw new Error("swipe action is not rendered");
	await action.tap({
		position: { x: edge === "left" ? 20 : box.width - 20, y: box.height / 2 },
	});
}

async function setUp(page: Page, relayUrl: string) {
	await gotoRelay(page, relayUrl);
	const rows = page.locator("#session-list .session-item");
	await expect(rows.first()).toBeVisible();
	// The recording holds one session; the verbs need a second to move around.
	await new SidebarPage(page).createNewSession();
	await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(2);
	const id = await rows.nth(1).getAttribute("data-session-id");
	const row = page.locator(`#session-list [data-session-id="${id}"]`);
	const title = (await row.locator(".session-title-inner").innerText()).trim();
	return { row, title };
}

test("desktop: hover and Tab reach the row's verbs, and the menu returns focus", async ({
	page,
	relayUrl,
}) => {
	const { row, title } = await setUp(page, relayUrl);
	const settled = page
		.getByRole("status")
		.filter({ hasText: `Moved “${title}” to Settled` });

	// Pointer: the actions replace the time on hover.
	await row.hover();
	await expect(row.locator(".session-item-meta")).toBeHidden();
	await expect(row.getByTestId("session-act-snooze")).toBeVisible();
	await expect(row.getByTestId("session-act-pin")).toBeVisible();
	// ● leads the strip and teaches u; on an unread row it flips to ○, Mark read.
	const markUnread = row.getByTestId("session-act-mark-unread");
	await expect(markUnread).toHaveAttribute("title", "Mark unread (u)");
	await markUnread.click();
	await expect(row.getByTestId("session-unread-dot")).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "Marked unread" }),
	).toHaveCount(1);
	await expect(row.getByTestId("session-act-mark-read")).toHaveAttribute(
		"title",
		"Mark read (u)",
	);
	await page.getByTestId("toast-action").last().click();
	await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
	await row.hover();
	await expect(markUnread).toBeVisible();
	await row.getByTestId("session-act-settle").click();
	await expect(row).toHaveCount(0);
	await expect(settled).toHaveCount(1);
	await page.getByTestId("toast-action").last().click();
	await expect(row).toBeVisible();

	// Keyboard: ● then the settle twin are the first stops after the row link.
	await page.mouse.move(0, 0);
	await row.focus();
	await page.keyboard.press("Tab");
	await expect(markUnread).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(row.getByTestId("session-act-settle")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(row).toHaveCount(0);
	await page.getByTestId("toast-action").last().click();
	await expect(row).toBeVisible();

	// The menu is keyboard operable and Escape hands focus back to its trigger.
	await row.focus();
	const more = row.locator(".session-more-btn");
	while (
		!(await more.evaluate((element) => element === document.activeElement))
	) {
		await page.keyboard.press("Tab");
	}
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("session-ctx-header")).toContainText(title);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("session-ctx-menu")).toHaveCount(0);
	await expect(more).toBeFocused();
});

test("desktop: a settled row un-settles from the shelf by menu and by hover", async ({
	page,
	relayUrl,
}) => {
	const { row } = await setUp(page, relayUrl);
	const id = await row.getAttribute("data-session-id");
	const shelfRow = page.locator(
		`#settled-shelf-rows [data-session-id="${id}"]`,
	);
	const toggle = page.getByTestId("settled-shelf-toggle");

	await row.click({ button: "right" });
	await page.getByTestId("session-ctx-settle").click();
	await toggle.click();
	await expect(shelfRow).toBeVisible();

	// On a settled row the menu offers Un-settle in Settle's place.
	await shelfRow.click({ button: "right" });
	await expect(page.getByTestId("session-ctx-settle")).toHaveCount(0);
	await page.getByTestId("session-ctx-unsettle").click();
	await expect(shelfRow).toHaveCount(0);
	await expect(toggle).toHaveCount(0);
	await expect(row).toBeVisible();

	// The hover verb flips the same way.
	await row.hover();
	await row.getByTestId("session-act-settle").click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await shelfRow.hover();
	await shelfRow.getByTestId("session-act-unsettle").click();
	await expect(shelfRow).toHaveCount(0);
	await expect(row).toBeVisible();
});

test.describe("phone", () => {
	// Touch devices report no hover, so only this test gets a touchscreen.
	test.use({ hasTouch: true });

	test("phone: a full swipe right on a settled row un-settles it", async ({
		page,
		relayUrl,
	}) => {
		const { row } = await setUp(page, relayUrl);
		const id = await row.getAttribute("data-session-id");
		await page.setViewportSize({ width: 375, height: 740 });
		await page.goto(new URL("/", page.url()).toString());
		await expect(row).toBeVisible();
		const shelfRow = page.locator(
			`#settled-shelf-rows [data-session-id="${id}"]`,
		);
		const action = page.getByTestId("session-swipe-action");

		await drag(row, [0.3, 0.7]);
		await page.getByTestId("settled-shelf-toggle").tap();
		await expect(shelfRow).toBeVisible();
		await drag(shelfRow, [0.4]);
		await expect(action).toHaveAttribute("data-stage", "reveal");
		await expect(action).toHaveAccessibleName(/Un-settle/);
		await expect(page.getByTestId("session-swipe-mark-unread")).toHaveCount(0);
		await shelfRow.tap();
		await expect(action).toHaveCount(0);

		await drag(shelfRow, [0.3, 0.7], false);
		await expect(action).toContainText("Release to un-settle");
		await lift(shelfRow);
		await expect(shelfRow).toHaveCount(0);
		await expect(row).toBeVisible();
	});

	test("phone: swipe settles and snoozes, holds on a short swipe, and long press opens the menu", async ({
		page,
		relayUrl,
	}) => {
		const { row, title } = await setUp(page, relayUrl);
		await page.setViewportSize({ width: 375, height: 740 });
		await page.goto(new URL("/", page.url()).toString());
		await expect(row).toBeVisible();
		const onList = (url: URL) => url.pathname === "/";
		const action = page.getByTestId("session-swipe-action");
		const settled = page
			.getByRole("status")
			.filter({ hasText: `Moved “${title}” to Settled` });

		// No per-row buttons on a phone, and vertical scrolling stays the browser's.
		await expect(row.locator(".session-more-btn")).toBeHidden();
		expect(
			await row.evaluate((element) => getComputedStyle(element).touchAction),
		).toBe("pan-y");

		// Past halfway the row says what will fire, then commits on release.
		await drag(row, [0.3, 0.7], false);
		await expect(action).toHaveAttribute("data-stage", "commit");
		await expect(action).toContainText("Release to settle");
		await lift(row);
		await expect(row).toHaveCount(0);
		await expect(settled).toHaveCount(1);
		await expect(page).toHaveURL(onList);
		await page.getByTestId("toast-action").click();
		await expect(row).toBeVisible();

		// Backing out below the reveal threshold leaves the row untouched.
		await drag(row, [0.3, 0.7, 0.1]);
		await expect(row).toBeVisible();
		await expect(action).toHaveCount(0);
		await expect(page).toHaveURL(onList);

		// A short swipe is a look: it holds the tray under the thumb, and a
		// tap on the row closes it without opening the session.
		await drag(row, [0.4]);
		const settleButton = page.getByTestId("session-swipe-settle");
		const unreadButton = page.getByTestId("session-swipe-mark-unread");
		await expect(settleButton).toHaveAttribute("data-stage", "reveal");
		await expect(settleButton).toBeVisible();
		await expect(settleButton).toHaveAccessibleName(`Settle ${title}`);
		await expect(unreadButton).toHaveAccessibleName(`Mark unread ${title}`);
		await expect(row).toHaveCSS("transform", "matrix(1, 0, 0, 1, 148, 0)");
		await expect(row).toBeVisible();
		await row.tap();
		await expect(settleButton).toHaveCount(0);
		await expect(page).toHaveURL(onList);

		// Tapping Settle in the held tray runs it.
		await drag(row, [0.4]);
		await settleButton.tap();
		await expect(row).toHaveCount(0);
		await page.getByTestId("toast-action").last().click();
		await expect(row).toBeVisible();

		// Left: a full swipe snoozes to tomorrow morning, a short one offers presets.
		await drag(row, [-0.3, -0.7]);
		await expect(row).toHaveCount(0);
		await expect(
			page.getByRole("status").filter({ hasText: `Snoozed “${title}” until` }),
		).toContainText("9:00");
		await page.getByTestId("toast-action").last().click();
		await expect(row).toBeVisible();
		await drag(row, [-0.4]);
		await tapExposed(
			page.getByRole("button", { name: `Snooze ${title}` }),
			"right",
		);
		await expect(page.getByTestId("snooze-option-1h")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("snooze-option-1h")).toHaveCount(0);

		// Long press opens the row's menu with the whole title, and does not navigate.
		await row.evaluate(async (element) => {
			const box = element.getBoundingClientRect();
			const init = {
				pointerType: "touch",
				pointerId: 9,
				isPrimary: true,
				bubbles: true,
				clientX: box.left + box.width / 2,
				clientY: box.top + box.height / 2,
			};
			element.dispatchEvent(new PointerEvent("pointerdown", init));
			await new Promise((resolve) => setTimeout(resolve, 700));
			element.dispatchEvent(new PointerEvent("pointerup", init));
			(element as HTMLElement).click();
		});
		await expect(page.getByTestId("session-ctx-header")).toContainText(title);
		await expect(page.getByTestId("session-ctx-menu")).toHaveCount(1);
		await expect(page).toHaveURL(onList);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("session-ctx-menu")).toHaveCount(0);

		// A plain tap still opens the session.
		await row.tap();
		await expect(page).not.toHaveURL(onList);
	});

	test("phone: the right tray marks unread and then offers Read", async ({
		page,
		relayUrl,
	}) => {
		const { row, title } = await setUp(page, relayUrl);
		await page.setViewportSize({ width: 375, height: 740 });
		await page.goto(new URL("/", page.url()).toString());
		await expect(row).toBeVisible();

		await drag(row, [0.4]);
		await page.getByTestId("session-swipe-mark-unread").tap();
		await expect(row.getByTestId("session-unread-dot")).toBeVisible();
		await expect(page.getByTestId("session-swipe-mark-unread")).toHaveCount(0);
		await expect(
			page.getByRole("status").filter({ hasText: "Marked unread" }),
		).toHaveCount(1);
		await expect(page.getByTestId("toast-action")).toBeVisible();

		await drag(row, [0.4]);
		const readButton = page.getByTestId("session-swipe-mark-read");
		await expect(readButton).toHaveAccessibleName(`Mark read ${title}`);
		await expect(readButton).toBeVisible();
		await readButton.tap();
		await expect(row.getByTestId("session-unread-dot")).toHaveCount(0);
	});

	test("phone: a row that cannot settle holds only Unread after a full swipe", async ({
		page,
		relayUrl,
	}) => {
		const { row } = await setUp(page, relayUrl);
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-pin").click();
		await expect(
			page.getByRole("status").filter({ hasText: "Pinned" }),
		).toBeVisible();
		await page.setViewportSize({ width: 375, height: 740 });
		await page.goto(new URL("/", page.url()).toString());
		await expect(row).toBeVisible();
		await row.click({ button: "right" });
		await expect(page.getByTestId("session-ctx-unpin")).toBeVisible();
		await page.keyboard.press("Escape");

		await drag(row, [0.3, 0.7]);
		await expect(row).toHaveCSS("transform", "matrix(1, 0, 0, 1, 74, 0)");
		await expect(page.getByTestId("session-swipe-settle")).toHaveCount(0);
		await expect(page.getByTestId("session-swipe-action")).toHaveCount(0);
		await expect(page.getByTestId("session-swipe-mark-unread")).toBeVisible();
		await expect(row).toBeVisible();
	});
});
