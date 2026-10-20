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
		new URL(
			"/s/sess-mockup-001",
			baseURL ?? "http://localhost:4173",
		).toString(),
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
		// These fixtures leave the caret at the end. Measure its rendered text
		// line, not the CSS line box's leading, which native caret scrolling
		// need not reveal. Both layers share the same text metrics below.
		const range = document.createRange();
		range.selectNodeContents(mirror);
		const lines = range.getClientRects();
		const caretLine = lines[lines.length - 1];
		if (!caretLine) throw new Error("Composer has no rendered text line");
		const taBox = ta.getBoundingClientRect();
		const visible = scroller.getBoundingClientRect();
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
			visible: { top: visible.top, bottom: visible.bottom },
			caret: { top: caretLine.top, bottom: caretLine.bottom },
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
	await test.info().attach("composer-geometry.json", {
		body: JSON.stringify(m),
		contentType: "application/json",
	});
	await test.info().attach("composer-overflow.png", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
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
		m.caret.top,
		"caret line must not be above the visible window",
	).toBeGreaterThanOrEqual(m.visible.top);
	expect(
		m.caret.bottom,
		"caret line must not be below the visible window",
	).toBeLessThanOrEqual(m.visible.bottom);
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
