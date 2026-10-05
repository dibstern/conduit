import type { Page } from "@playwright/test";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

test.use({ recording: "chat-simple" });

async function addProbeMessages(page: Page): Promise<void> {
	await page.locator("#messages").evaluate((scroller) => {
		for (let index = 0; index < 30; index++) {
			const probe = document.createElement("div");
			probe.dataset["testid"] = `island-probe-${index}`;
			probe.textContent = `Probe message ${index}`;
			probe.style.height = "120px";
			scroller.append(probe);
		}
	});
}

async function pinToBottom(page: Page): Promise<void> {
	const messages = page.locator("#messages");
	await messages.evaluate((scroller) => {
		scroller.scrollTop = scroller.scrollHeight;
	});
	await expect
		.poll(() =>
			messages.evaluate(
				(scroller) =>
					scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
			),
		)
		.toBeLessThanOrEqual(1);
	await messages.evaluate((scroller) => {
		scroller.scrollTop -= 120;
	});
	await expect(page.locator("#scroll-btn")).toBeVisible();
	await messages.evaluate((scroller) => {
		scroller.scrollTop = scroller.scrollHeight;
	});
	await expect(page.getByTestId("session-bar")).toHaveAttribute(
		"data-collapsed",
		"true",
	);
}

test.describe("phone session island", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});

	test("scrolling changes presentation without moving the reading position", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, relayUrl);
		await addProbeMessages(page);
		await pinToBottom(page);
		const bar = page.getByTestId("session-bar");
		await expect(page.getByTestId("session-bar-island-overflow")).toBeVisible();
		await expect(page.getByTestId("session-bar-views-button")).toHaveCount(0);
		const probe = page.getByTestId("island-probe-29");
		const before = await probe.evaluate(
			(element) => element.getBoundingClientRect().top,
		);
		await page.locator("#messages").evaluate((scroller) => {
			scroller.scrollTop -= 60;
		});
		await expect(bar).toHaveAttribute("data-collapsed", "false");
		await expect(page.getByTestId("session-bar-island-overflow")).toBeVisible();
		const after = await probe.evaluate(
			(element) => element.getBoundingClientRect().top,
		);
		expect(Math.round(after - before)).toBe(60);
		await pinToBottom(page);
		await expect(page.getByTestId("session-bar-island-overflow")).toBeVisible();
	});

	test("back returns to Sessions and the chevron forces the full bar open", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, relayUrl);
		await addProbeMessages(page);
		await pinToBottom(page);
		await page.getByTestId("session-bar-expand").tap();
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"false",
		);
		await expect(page.getByTestId("session-bar-island-overflow")).toBeVisible();
		await page.locator("#messages").evaluate((scroller) => {
			scroller.scrollTop -= 60;
		});
		await pinToBottom(page);
		await page.getByTestId("session-bar-back").tap();
		await expect(page.locator("#session-list")).toBeVisible();
	});

	test("touch sheets, modal layering, focus modality and dismissal", async ({
		page,
		relayUrl,
	}) => {
		await page.addInitScript(() =>
			localStorage.setItem("feature-flags", '["debug"]'),
		);
		await gotoRelay(page, relayUrl);
		await page
			.locator(".debug-panel")
			.getByRole("button", { name: "Close panel" })
			.click();
		await page.getByTestId("session-bar-island-overflow").tap();
		await expect(page.getByTestId("session-bar-island-menu")).toBeVisible();
		// The views sheet must stay open through this observation window.
		await page.waitForTimeout(100);
		await expect(page.getByTestId("session-bar-island-menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await addProbeMessages(page);
		await pinToBottom(page);
		await page.getByTestId("session-bar-island-overflow").tap();
		const sheet = page.getByTestId("session-bar-island-menu");
		await expect(sheet).toBeVisible();
		// The overflow sheet must stay open through this observation window.
		await page.waitForTimeout(100);
		await expect(sheet).toBeVisible();
		for (const view of ["chat", "terminal", "diff", "files"]) {
			await expect(sheet.getByTestId(`overflow-view-${view}`)).toBeVisible();
		}
		await expect(sheet.getByTestId("overflow-view-diff")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		for (const action of ["share", "settings", "debug"]) {
			await expect(sheet.getByTestId(`overflow-${action}`)).toBeVisible();
		}
		const content = (await sheet.textContent()) ?? "";
		for (const [before, after] of [
			["Views", "Chat"],
			["Chat", "Terminal"],
			["Terminal", "Diff"],
			["Diff", "Files"],
			["Files", "Session"],
			["Session", "Snooze"],
			["Snooze", "Delete"],
			["Delete", "More actions"],
			["More actions", "Share"],
			["Share", "Settings"],
			["Settings", "Debug"],
		] as const) {
			expect(content.indexOf(before)).toBeLessThan(content.indexOf(after));
		}

		await sheet.getByTestId("session-ctx-snooze").click();
		const snooze = page.getByRole("dialog", { name: /Snooze until/ });
		await expect(snooze).toBeVisible();
		const first = page.getByTestId("snooze-option-1h");
		await expect(first).toBeFocused();
		expect(
			await first.evaluate((element) => element.matches(":focus-visible")),
		).toBe(false);
		const topLayer = await page.evaluate(() => {
			const dialog = document.querySelector("dialog[open]");
			const island = document.querySelector("#session-bar");
			const composer = document.querySelector("#input");
			if (!dialog || !island || !composer) return false;
			return [island, composer].every((element) => {
				const rect = element.getBoundingClientRect();
				const hit = document.elementFromPoint(
					rect.left + rect.width / 2,
					rect.top + rect.height / 2,
				);
				return hit === dialog || dialog.contains(hit);
			});
		});
		expect(topLayer).toBe(true);
		await snooze.getByRole("button", { name: "Close" }).click();
		await expect(snooze).toBeHidden();

		await page.getByTestId("session-bar-island-overflow").tap();
		await sheet.getByTestId("session-ctx-snooze").focus();
		await page.keyboard.press("Enter");
		await expect(first).toBeFocused();
		expect(
			await first.evaluate((element) => element.matches(":focus-visible")),
		).toBe(true);
		await page.keyboard.press("Escape");
		await expect(snooze).toBeHidden();
		await expect(page.getByTestId("session-bar-island-overflow")).toBeFocused();

		await page.getByTestId("session-bar-island-overflow").tap();
		await sheet.getByTestId("session-ctx-delete").click();
		const confirm = page.getByRole("dialog", { name: /Delete/ });
		await expect(confirm).toBeVisible();
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toBeHidden();
		await expect(page.getByTestId("session-bar-island-overflow")).toBeFocused();
		await expect(page.getByTestId("session-bar")).toBeVisible();
	});

	test("phone chrome clears banners and preserves a detached transcript across views", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, relayUrl);
		await page.locator("#session-chrome").evaluate((chrome) => {
			const banner = document.createElement("div");
			banner.className = "banner";
			banner.textContent = "Connection notice";
			banner.style.height = "36px";
			chrome.querySelector("#session-bar")?.after(banner);
		});
		const bar = await page.locator("#session-bar").boundingBox();
		const banner = await page
			.locator("#session-chrome > .banner")
			.boundingBox();
		expect(bar).not.toBeNull();
		expect(banner).not.toBeNull();
		if (bar && banner) expect(bar.y + bar.height).toBeLessThanOrEqual(banner.y);
		await expect
			.poll(() =>
				page.locator("#messages").evaluate((scroller) => {
					const chrome = document.querySelector<HTMLElement>("#session-chrome");
					const style = getComputedStyle(scroller);
					return (
						style.paddingTop === `${chrome?.offsetHeight}px` &&
						style.scrollPaddingTop === style.paddingTop
					);
				}),
			)
			.toBe(true);
		await addProbeMessages(page);
		await page.locator("#messages").evaluate((scroller) => {
			scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 300;
		});
		await expect(page.locator("#scroll-btn")).toBeVisible();
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"false",
		);
		const before = await page.locator("#messages").evaluate((scroller) => ({
			height: scroller.clientHeight,
			top: scroller.scrollTop,
		}));
		await page.getByTestId("session-bar-island-overflow").tap();
		await page.getByTestId("overflow-view-files").click();
		await page.getByTestId("session-bar-island-overflow").tap();
		await page.getByTestId("overflow-view-chat").click();
		const after = await page.locator("#messages").evaluate((scroller) => ({
			height: scroller.clientHeight,
			top: scroller.scrollTop,
		}));
		expect(after).toEqual(before);
	});

	test("terminal uses the full bar and full viewport width", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, relayUrl);
		await page.getByTestId("session-bar-island-overflow").tap();
		await page.getByTestId("overflow-view-terminal").click();
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"false",
		);
		await expect(page.getByTestId("session-bar-island-overflow")).toBeVisible();
		await expect
			.poll(
				async () =>
					(await page.locator("#terminal-panel").boundingBox())?.width,
			)
			.toBe(390);
	});

	test("dialog backdrops stay dark in both themes", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, relayUrl);
		await addProbeMessages(page);
		await pinToBottom(page);
		for (const theme of ["dark", "light"]) {
			await page.evaluate((nextTheme) => {
				document.documentElement.classList.toggle(
					"light-theme",
					nextTheme === "light",
				);
				document.documentElement.classList.toggle(
					"dark-theme",
					nextTheme === "dark",
				);
			}, theme);
			await page.getByTestId("session-bar-island-overflow").tap();
			await page.getByTestId("session-ctx-snooze").click();
			const channels = await page.locator("dialog[open]").evaluate((dialog) => {
				const color = getComputedStyle(dialog, "::backdrop").backgroundColor;
				return color.match(/[\d.]+/g)?.map(Number) ?? [];
			});
			expect(channels).toHaveLength(4);
			expect(channels.slice(0, 3).every((channel) => channel <= 40)).toBe(true);
			expect(channels[3]).toBeGreaterThanOrEqual(0.3);
			await page
				.locator("dialog[open]")
				.getByRole("button", { name: "Close" })
				.click();
		}
	});
});

test.describe("session island across viewport changes", () => {
	test.use({
		viewport: { width: 1440, height: 900 },
		hasTouch: true,
		isMobile: true,
	});

	test("bottom pin survives resizing from desktop to phone", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, relayUrl);
		await addProbeMessages(page);
		await page.locator("#messages").evaluate((scroller) => {
			scroller.scrollTop = scroller.scrollHeight;
		});
		await expect
			.poll(() =>
				page
					.locator("#messages")
					.evaluate(
						(scroller) =>
							scroller.scrollHeight -
							scroller.clientHeight -
							scroller.scrollTop,
					),
			)
			.toBeLessThanOrEqual(1);
		await page.setViewportSize({ width: 390, height: 844 });
		await expect
			.poll(() =>
				page
					.locator("#messages")
					.evaluate(
						(scroller) =>
							scroller.scrollHeight -
							scroller.clientHeight -
							scroller.scrollTop,
					),
			)
			.toBeLessThanOrEqual(1);
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-compact",
			"true",
		);
	});
});

test.describe("desktop session bar", () => {
	test.use({
		viewport: { width: 1440, height: 900 },
		hasTouch: false,
		isMobile: false,
	});

	test("never becomes an island at the bottom", async ({ page, relayUrl }) => {
		await gotoRelay(page, relayUrl);
		await addProbeMessages(page);
		await page.locator("#messages").evaluate((scroller) => {
			scroller.scrollTop = scroller.scrollHeight;
		});
		await expect(page.getByTestId("session-bar")).toHaveAttribute(
			"data-collapsed",
			"false",
		);
		await expect(page.getByTestId("session-bar-island-overflow")).toHaveCount(
			0,
		);
		await expect(page.getByTestId("session-bar-overflow")).toBeVisible();
	});
});
