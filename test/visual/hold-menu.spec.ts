import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

test("hold menu native touch capture, scroll, sheet dismissal and selection", async ({
	page,
	context,
}, testInfo) => {
	test.setTimeout(30_000);
	const port = process.env["STORYBOOK_PORT"] ?? "6007";
	await page.goto(
		`http://localhost:${port}/iframe.html?id=ui-holdmenu--device-probe&viewMode=story`,
	);
	const sheet = page.getByRole("dialog", {
		name: "Session actions",
		exact: true,
	});
	const list = page.getByRole("menu", { name: "Snooze until", exact: true });
	const trigger = page.getByRole("menuitem", { name: /Snooze/ });
	const picked = page.getByTestId("hold-menu-picked");
	const picks = page.getByTestId("hold-menu-picks");
	const scroller = sheet.locator("[data-sheet-body]");
	await expect(trigger).toBeVisible();
	await expect(scroller).toHaveJSProperty("scrollTop", 0);
	const session = await context.newCDPSession(page);
	const point = async (locator: typeof trigger) => {
		const box = await locator.boundingBox();
		if (!box) throw new Error("Missing touch target");
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	};
	const touch = async (
		type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
		at?: { x: number; y: number },
	) => {
		await session.send("Input.dispatchTouchEvent", {
			type,
			touchPoints: at ? [{ ...at, id: 1 }] : [],
		});
	};
	const reopen = async () => {
		await page.getByRole("button", { name: "Open session actions" }).click();
		await expect(sheet).toBeVisible();
	};
	const evidence = async (name: string) => {
		await testInfo.attach(name, {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	};
	const tapDim = async () => {
		const at = await point(page.getByTestId("hold-menu-header"));
		await page.touchscreen.tap(at.x, at.y);
	};

	// A short native tap stays open and dismisses only the list on the dim layer.
	await trigger.tap();
	await expect(list).toBeVisible();
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "open");
	await tapDim();
	await expect(list).toBeHidden();
	await expect(sheet).toBeVisible();
	await evidence("tap-dim-dismissal");

	// A trusted pointer is explicitly captured. Its downward slide neither scrolls
	// the body nor reaches the sheet's drag-to-dismiss listener.
	await touch("touchStart", await point(trigger));
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "following");
	await expect(trigger).toHaveJSProperty("ariaExpanded", "true");
	const captured = await trigger.evaluate((node) => {
		const events = JSON.parse(
			document.querySelector('[data-testid="hold-menu-probe-json"]')
				?.textContent ?? "[]",
		) as { type: string; pointerId: number }[];
		const down = events.reverse().find((event) => event.type === "pointerdown");
		return down ? node.hasPointerCapture(down.pointerId) : false;
	});
	expect(captured).toBe(true);
	const row = list.getByRole("menuitem", { name: /This evening/ });
	const idleBackground = await row.evaluate(
		(node) => getComputedStyle(node).backgroundColor,
	);
	await touch("touchMove", await point(row));
	await expect
		.poll(() => row.evaluate((node) => getComputedStyle(node).backgroundColor))
		.not.toBe(idleBackground);
	await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(scroller).toHaveJSProperty("scrollTop", 0);
	expect(
		await sheet.evaluate((node) => (node as HTMLElement).style.transform),
	).toBe("");
	await evidence("following-highlighted");
	await touch("touchEnd");
	await expect(sheet).toBeHidden();
	await expect(picked).toHaveText("evening");
	await expect(picks).toHaveText("1");

	await reopen();
	const offList = await point(trigger);
	await touch("touchStart", offList);
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "following");
	await touch("touchEnd");
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "open");
	await expect(list).toBeVisible();
	await expect(picks).toHaveText("1");
	await evidence("release-off-list");
	await tapDim();

	// Cancellation after the threshold becomes a sticky menu.
	await touch("touchStart", await point(trigger));
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "following");
	await touch("touchCancel");
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "open");
	await expect(sheet).toBeVisible();
	await tapDim();

	// A swipe before the threshold belongs to native scrolling, never to hold.
	const start = await point(trigger);
	await touch("touchStart", start);
	for (let step = 1; step <= 8; step++) {
		await touch("touchMove", { x: start.x, y: start.y - step * 12 });
		await page.waitForTimeout(20);
	}
	await touch("touchEnd");
	await page.waitForTimeout(500);
	await expect(list).toBeHidden();
	await expect(sheet).toBeVisible();
	await expect
		.poll(() => scroller.evaluate((node) => node.scrollTop))
		.toBeGreaterThan(0);
	await evidence("swipe-scrolls-without-opening");
	await scroller.evaluate((node) => {
		node.scrollTop = 0;
	});

	// Ordinary sticky selection still uses the library's root dismissal.
	await trigger.tap();
	await list.getByRole("menuitem", { name: /In 1 hour/ }).tap();
	await expect(sheet).toBeHidden();
	await expect(picked).toHaveText("hour");
	await expect(picks).toHaveText("2");
	await testInfo.attach("device-probe", {
		body:
			(await page.getByTestId("hold-menu-probe-json").textContent()) ?? "[]",
		contentType: "application/json",
	});
});

test("hold menu keeps bits-ui keyboard navigation and reduced-motion mouse following", async ({
	page,
}, testInfo) => {
	test.setTimeout(30_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const port = process.env["STORYBOOK_PORT"] ?? "6007";
	await page.goto(
		`http://localhost:${port}/iframe.html?id=ui-holdmenu--device-probe&viewMode=story`,
	);
	const trigger = page.getByRole("menuitem", { name: /Snooze/ });
	const list = page.getByRole("menu", { name: "Snooze until", exact: true });
	await expect(trigger).toBeVisible();
	for (const key of ["Enter", "Space", "ArrowRight"]) {
		await trigger.focus();
		await page.keyboard.press(key);
		await expect(
			list.getByRole("menuitem", { name: /In 1 hour/ }),
		).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await expect(list).toBeHidden();
		await expect(trigger).toBeFocused();
	}
	await page.keyboard.press("Enter");
	await expect(list.getByRole("menuitem", { name: /In 1 hour/ })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(list).toBeHidden();
	const sheet = page.getByRole("dialog", {
		name: "Session actions",
		exact: true,
	});
	await expect(sheet).toBeHidden();
	await page.getByRole("button", { name: "Open session actions" }).click();
	await expect(sheet).toBeVisible();
	await trigger.hover();
	await page.mouse.down();
	await expect(trigger).toHaveAttribute("data-hold-menu-phase", "following");
	expect(await trigger.evaluate((node) => getComputedStyle(node).scale)).toBe(
		"1",
	);
	const row = list.getByRole("menuitem", { name: /Tomorrow/ });
	const idleBackground = await row.evaluate(
		(node) => getComputedStyle(node).backgroundColor,
	);
	const rowBox = await row.boundingBox();
	if (!rowBox) throw new Error("Missing mouse target");
	await page.mouse.move(
		rowBox.x + rowBox.width / 2,
		rowBox.y + rowBox.height / 2,
	);
	await expect
		.poll(() => row.evaluate((node) => getComputedStyle(node).backgroundColor))
		.not.toBe(idleBackground);
	await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await testInfo.attach("reduced-motion-mouse-following", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
	await page.mouse.up();
	await expect(sheet).toBeHidden();
	await expect(page.getByTestId("hold-menu-picked")).toHaveText("tomorrow");
	await expect(page.getByTestId("hold-menu-picks")).toHaveText("1");
	await testInfo.attach("device-probe", {
		body:
			(await page.getByTestId("hold-menu-probe-json").textContent()) ?? "[]",
		contentType: "application/json",
	});
});
