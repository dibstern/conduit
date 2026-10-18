import { expect, type Locator, type Page } from "@playwright/test";
import { AppPage } from "../page-objects/app.page.js";

/** Count each confirmation shown, so a test can tell one from one per repeat. */
export async function countConfirmations(page: Page): Promise<void> {
	await page.evaluate(() => {
		let shown = 0;
		const record = () =>
			document.body.setAttribute("data-confirmations", String(shown));
		record();
		new MutationObserver((mutations) => {
			for (const mutation of mutations)
				for (const node of mutation.addedNodes)
					if (
						node instanceof HTMLElement &&
						node.classList.contains("term-key-confirmation")
					) {
						shown++;
						record();
					}
		}).observe(document.body, { childList: true, subtree: true });
	});
}

export const confirmationsShown = (page: Page) =>
	page.evaluate(() => Number(document.body.getAttribute("data-confirmations")));

export const row = (page: Page) => page.locator(".term-key-row");
export const rowKey = (page: Page, name: string) =>
	row(page).getByRole("button", { name, exact: true });
export const textarea = (page: Page) =>
	page.locator("#terminal-panel .xterm-helper-textarea");

/** Resize the panel independently of the desktop viewport. */
export async function setTerminalPanelWidth(page: Page, width: number | null) {
	await page.locator("#terminal-panel").evaluate((panel, value) => {
		panel.style.width = value === null ? "" : `${value}px`;
		panel.style.maxWidth = value === null ? "" : `${value}px`;
	}, width);
}

export async function openPhoneTerminal(page: Page, url: string) {
	await new AppPage(page).goto(url);
	// Touch emulation alone must read as touch-primary, or the row never shows.
	expect(
		await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
	).toBe(true);
	await page.getByTestId("session-bar-island-overflow").click();
	await page.getByTestId("overflow-view-terminal").click();
	await expect(page.locator("#terminal-panel .xterm-screen")).toBeVisible({
		timeout: 10_000,
	});
	await expect(textarea(page)).toBeFocused();
}

/** A real finger: CDP touch events, which the page sees as touch pointer
 *  events. It starts at the target's centre, offset by `at` as a fraction
 *  of its size. */
export async function finger(
	page: Page,
	target: Locator,
	at: { x: number; y: number } = { x: 0, y: 0 },
) {
	await target.scrollIntoViewIfNeeded();
	const box = await target.boundingBox();
	if (!box) throw new Error("touch target is not visible");
	const x0 = box.x + box.width * (0.5 + at.x);
	const y0 = box.y + box.height * (0.5 + at.y);
	let [x, y] = [x0, y0];
	const cdp = await page.context().newCDPSession(page);
	const touch = (
		type: "touchStart" | "touchMove" | "touchEnd",
		points: { x: number; y: number }[],
	) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
	await touch("touchStart", [{ x, y }]);
	return {
		/** Move to (dx, dy) from the start, in small steps like a real drag. */
		async moveTo(dx: number, dy: number) {
			const [fromX, fromY] = [x, y];
			for (let step = 1; step <= 6; step++) {
				x = fromX + ((x0 + dx - fromX) * step) / 6;
				y = fromY + ((y0 + dy - fromY) * step) / 6;
				await touch("touchMove", [{ x, y }]);
			}
		},
		async lift() {
			await touch("touchEnd", []);
			await cdp.detach();
		},
	};
}

export async function tap(
	page: Page,
	target: Locator,
	at?: { x: number; y: number },
) {
	await (await finger(page, target, at)).lift();
}

export async function flick(page: Page, target: Locator) {
	const touch = await finger(page, target);
	await touch.moveTo(0, -30);
	await touch.lift();
}
