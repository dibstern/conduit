import { expect, test } from "@playwright/test";
import { dragSheet, settleSheet } from "../e2e/helpers/sheet-drag.js";

test.use({
	viewport: { width: 393, height: 852 },
	hasTouch: true,
	isMobile: true,
});

const sheets = [
	{
		name: "Turn summary",
		story: "chat-surfacing-summary--drag-dismiss",
		control: "summary-close-count",
		scrim: "modal-sheet-scrim",
		nativeDialog: true,
		edge: "bottom",
	},
	{
		name: "Side threads",
		story: "layout-sessionbar--side-threads-scrollable",
		control: "side-threads-control",
		scrim: "side-threads-scrim",
		nativeDialog: false,
		edge: "top",
	},
	{
		name: "Goal",
		story: "layout-sessionbar--goal-sheet-scrollable",
		control: "session-goal-subtitle",
		scrim: "goal-details-scrim",
		nativeDialog: false,
		edge: "top",
	},
] as const;

test("locking sheet dismissal preserves its form and focus", async ({
	page,
}, testInfo) => {
	await page.goto("/iframe.html?id=ui-dialog--saving-sheet&viewMode=story");
	const sheet = page.locator("[data-sheet-chrome]:visible");
	const draft = page.getByRole("textbox", { name: "Draft" });
	const toggle = page.getByTestId("sheet-save-toggle");
	await draft.fill("Keep this draft");
	const original = await draft.elementHandle();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(draft).toHaveValue("Keep this draft");
	expect(
		await draft.evaluate((node, previous) => node === previous, original),
	).toBe(true);
	await expect(toggle).toBeFocused();
	const before = await sheet.boundingBox();
	const { end } = await dragSheet(page, sheet, 80, false, 10, {
		durationMs: 600,
	});
	expect((await sheet.boundingBox())?.y).toBeCloseTo(before?.y ?? 0, 0);
	await end();
	await expect(sheet).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(draft).toHaveValue("Keep this draft");
	expect(30).toBeLessThan((before?.height ?? 0) * 0.25);
	const drag = await dragSheet(page, sheet, 30, false, 10, { durationMs: 600 });
	expect((await sheet.boundingBox())?.y).toBeCloseTo(drag.top + 30, 0);
	await drag.end();
	await expect
		.poll(async () => (await sheet.boundingBox())?.y)
		.toBeCloseTo(drag.top, 0);
	await testInfo.attach("sheet-form-preserved", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
});

for (const surface of sheets) {
	// Drop-down sheets dismiss upward from the handle on their bottom edge.
	const away = surface.edge === "top" ? -1 : 1;
	const handle = surface.edge === "top" ? -10 : 10;
	test.describe(`${surface.name} phone sheet`, () => {
		test.beforeEach(async ({ page }) => {
			await page.goto(`/iframe.html?id=${surface.story}&viewMode=story`);
			await expect(page.locator("[data-sheet-chrome]:visible")).toBeVisible();
			await settleSheet(page);
		});

		test("tracks a slow short drag with its scrim and springs back", async ({
			page,
		}, testInfo) => {
			const sheet = page.locator("[data-sheet-chrome]:visible");
			const scrim = page.getByTestId(surface.scrim);
			const opacity = () =>
				scrim.evaluate(
					(node, nativeDialog) =>
						Number.parseFloat(
							getComputedStyle(node, nativeDialog ? "::backdrop" : null)
								.opacity,
						),
					surface.nativeDialog,
				);
			const before = await sheet.boundingBox();
			const beforeOpacity = await opacity();
			const { top, end } = await dragSheet(
				page,
				sheet,
				away * 30,
				false,
				handle,
				{
					durationMs: 600,
				},
			);
			const during = await sheet.boundingBox();
			const duringOpacity = await opacity();
			const transformY = await sheet.evaluate((node) => {
				// Menu/Popover move their content shell; Dialog moves its sheet shell.
				for (
					let shell: Element | null = node;
					shell;
					shell = shell.parentElement
				) {
					const transform = getComputedStyle(shell).transform;
					if (transform !== "none") return new DOMMatrixReadOnly(transform).m42;
				}
				return 0;
			});
			expect((during?.y ?? top) - top).toBeCloseTo(away * 30, 0);
			expect(transformY).toBeCloseTo(away * 30, 0);
			expect(duringOpacity).toBeLessThan(beforeOpacity - 0.01);
			await testInfo.attach("short-drag-midgesture", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
			await end();
			await expect(sheet).toBeVisible();
			await expect
				.poll(async () => (await sheet.boundingBox())?.y)
				.toBeCloseTo(top, 0);
			await expect.poll(opacity).toBeCloseTo(beforeOpacity, 2);
			if (surface.control === "summary-close-count") {
				await expect(page.getByTestId(surface.control)).toHaveText("0");
			} else {
				await expect(page.getByTestId(surface.control)).toHaveAttribute(
					"aria-expanded",
					"true",
				);
			}
			await testInfo.attach("short-drag-geometry.json", {
				body: JSON.stringify({
					before,
					during,
					transformY,
					beforeOpacity,
					duringOpacity,
				}),
				contentType: "application/json",
			});
		});

		test("a long drag fades the scrim and calls the owner dismissal", async ({
			page,
		}, testInfo) => {
			const sheet = page.locator("[data-sheet-chrome]:visible");
			const box = await sheet.boundingBox();
			if (!box) throw new Error("sheet is not rendered");
			const distance = box.height * 0.35;
			const { top, end } = await dragSheet(
				page,
				sheet,
				away * distance,
				false,
				handle,
				{
					durationMs: 1200,
				},
			);
			const during = await sheet.boundingBox();
			expect((during?.y ?? top) - top).toBeCloseTo(away * distance, 0);
			const opacity = await page
				.getByTestId(surface.scrim)
				.evaluate(
					(node, nativeDialog) =>
						Number.parseFloat(
							getComputedStyle(node, nativeDialog ? "::backdrop" : null)
								.opacity,
						),
					surface.nativeDialog,
				);
			expect(opacity).toBeLessThan(0.7);
			expect(opacity).toBeGreaterThan(0.5);
			await testInfo.attach("long-drag-midgesture", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
			const fade = page.getByTestId(surface.scrim).evaluate(
				(node, nativeDialog) =>
					new Promise<number[]>((resolve) => {
						const samples: number[] = [];
						const sample = () => {
							if (
								!node.isConnected ||
								(nativeDialog && !(node as HTMLDialogElement).open)
							) {
								resolve(samples);
								return;
							}
							samples.push(
								Number.parseFloat(
									getComputedStyle(node, nativeDialog ? "::backdrop" : null)
										.opacity,
								),
							);
							if (samples.length === 30) resolve(samples);
							else requestAnimationFrame(sample);
						};
						requestAnimationFrame(sample);
					}),
				surface.nativeDialog,
			);
			await end();
			const fadeSamples = await fade;
			expect(Math.min(...fadeSamples)).toBeLessThan(opacity - 0.2);
			await expect(sheet).toBeHidden();
			if (surface.control === "summary-close-count") {
				await expect(page.getByTestId(surface.control)).toHaveText("1");
			} else {
				await expect(page.getByTestId(surface.control)).toHaveAttribute(
					"aria-expanded",
					"false",
				);
			}
			await testInfo.attach("long-drag-geometry.json", {
				body: JSON.stringify({ top, distance, during, opacity, fadeSamples }),
				contentType: "application/json",
			});
		});

		test("a fast flick below the distance threshold dismisses", async ({
			page,
		}, testInfo) => {
			const sheet = page.locator("[data-sheet-chrome]:visible");
			const box = await sheet.boundingBox();
			if (!box) throw new Error("sheet is not rendered");
			expect(50).toBeLessThan(box.height * 0.25);
			const { top, end } = await dragSheet(
				page,
				sheet,
				away * 50,
				false,
				handle,
				{
					durationMs: 60,
				},
			);
			expect(((await sheet.boundingBox())?.y ?? top) - top).toBeCloseTo(
				away * 50,
				0,
			);
			await end();
			await expect(sheet).toBeHidden();
			if (surface.control === "summary-close-count") {
				await expect(page.getByTestId(surface.control)).toHaveText("1");
			} else {
				await expect(page.getByTestId(surface.control)).toHaveAttribute(
					"aria-expanded",
					"false",
				);
			}
			await testInfo.attach("flick.json", {
				body: JSON.stringify({
					distance: 50,
					durationMs: 60,
					height: box.height,
				}),
				contentType: "application/json",
			});
		});

		test("a scrolled body keeps native scrolling instead of moving the sheet", async ({
			page,
		}, testInfo) => {
			const sheet = page.locator("[data-sheet-chrome]:visible");
			const body = sheet.locator("[data-sheet-body]");
			await expect
				.poll(() =>
					body.evaluate((node) => node.scrollHeight - node.clientHeight),
				)
				.toBeGreaterThan(160);
			await body.evaluate((node) => {
				node.scrollTop = 80;
			});
			const before = await sheet.boundingBox();
			const { end } = await dragSheet(page, body, away * 30, false, away * 40, {
				durationMs: 600,
			});
			const during = await sheet.boundingBox();
			expect(during?.y).toBeCloseTo(before?.y ?? 0, 0);
			await end();
			await expect(sheet).toBeVisible();
			await expect
				.poll(() =>
					body.evaluate((node, away) => (node.scrollTop - 80) * away, away),
				)
				.toBeLessThan(0);
			await testInfo.attach("native-scroll-handoff", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
			await testInfo.attach("native-scroll-handoff.json", {
				body: JSON.stringify({
					before,
					during,
					scrollTop: await body.evaluate((node) => node.scrollTop),
				}),
				contentType: "application/json",
			});
		});
	});
}
