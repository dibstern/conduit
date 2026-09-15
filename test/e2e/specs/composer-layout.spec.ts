// The composer paints its text twice: a highlight mirror below, a transparent
// textarea above supplying the caret. These tests pin the two invariants that
// keeps them readable as one surface — the boxes coincide exactly, and the line
// you are typing on is inside the visible window.
import { expect, test } from "@playwright/test";
import { initMessages } from "../fixtures/mockup-state.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;

async function openComposer(page: Page, baseURL: string | undefined) {
	await mockRelayWebSocket(page, {
		initMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(
		new URL("/p/myapp/", baseURL ?? "http://localhost:4173").toString(),
	);
	await page.waitForSelector("#input", { timeout: 15_000 });
	await page.locator("#input").click();
}

/** Geometry of the three boxes that have to agree, in viewport coordinates. */
function measure(page: Page) {
	return page.evaluate(() => {
		const ta = document.getElementById("input") as HTMLTextAreaElement;
		const row = ta.parentElement as HTMLElement;
		const mirror = row.querySelector("div[aria-hidden='true']") as HTMLElement;
		const scroller = row.parentElement as HTMLElement;
		const cs = getComputedStyle(ta);
		const lineHeight = parseFloat(cs.lineHeight);
		// No soft wrapping in these fixtures, so the caret's line index is just the
		// number of newlines before it.
		const lineIndex =
			ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
		const taBox = ta.getBoundingClientRect();
		// Every property that decides where a glyph lands. Both layers must agree on
		// all of them, which is what the shared `composer-text-metrics` class buys.
		const metrics = (el: HTMLElement) => {
			const c = getComputedStyle(el);
			return [
				c.fontFamily,
				c.fontSize,
				c.lineHeight,
				c.letterSpacing,
				c.wordSpacing,
				c.paddingTop,
				c.paddingRight,
				c.paddingBottom,
				c.paddingLeft,
				c.whiteSpace,
				c.overflowWrap,
				c.wordBreak,
				c.textIndent,
				c.tabSize,
			].join(" | ");
		};
		const round = (r: DOMRect) => ({
			top: Math.round(r.top),
			left: Math.round(r.left),
			width: Math.round(r.width),
			height: Math.round(r.height),
		});
		return {
			textarea: round(taBox),
			// The textarea must never be a scroller in its own right: a second scroll
			// position is what lets the caret drift off the text.
			textareaScrolls: ta.scrollHeight > ta.clientHeight || ta.scrollTop !== 0,
			// Content heights, which reflect where each layer chose to wrap.
			textareaContent: ta.scrollHeight,
			mirrorContent: mirror.scrollHeight,
			textareaMetrics: metrics(ta),
			mirrorMetrics: metrics(mirror),
			mirror: round(mirror.getBoundingClientRect()),
			visible: round(scroller.getBoundingClientRect()),
			caretTop: taBox.top + parseFloat(cs.paddingTop) + lineIndex * lineHeight,
			lineHeight,
			overflows: scroller.scrollHeight > scroller.clientHeight,
		};
	});
}

test("the caret stays on the text once the composer is taller than its cap", async ({
	page,
	baseURL,
}) => {
	await openComposer(page, baseURL);
	for (let i = 1; i <= 8; i++) {
		await page.keyboard.type(`line ${i}`);
		if (i < 8) await page.keyboard.press("Shift+Enter");
	}

	const m = await measure(page);
	expect(m.overflows, "8 lines should overflow the composer's height cap").toBe(
		true,
	);
	expect(m.mirror, "mirror and textarea must occupy the same box").toEqual(
		m.textarea,
	);
	expect(m.textareaScrolls, "the textarea must not scroll independently").toBe(
		false,
	);
	expect(
		m.caretTop,
		"caret line must not be above the visible window",
	).toBeGreaterThanOrEqual(m.visible.top - 1);
	expect(
		m.caretTop + m.lineHeight,
		"caret line must not be below the visible window",
	).toBeLessThanOrEqual(m.visible.top + m.visible.height + 1);
});

test("both layers lay text out identically", async ({ page, baseURL }) => {
	await openComposer(page, baseURL);
	// A long unbroken token: the case where a difference in wrapping rules shows up
	// as text and caret landing on different lines.
	await page.keyboard.type("x".repeat(400));

	const m = await measure(page);
	expect(
		m.textareaMetrics,
		"mirror and textarea must share every layout metric",
	).toBe(m.mirrorMetrics);
	expect(m.mirrorContent, "both layers must wrap at the same points").toBe(
		m.textareaContent,
	);
});
