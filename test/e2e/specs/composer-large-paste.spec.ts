// Regression coverage for: pasting a log dump into the composer froze the tab.
// Two costs scaled with the draft, both on the input event's critical path —
// the old auto-resize read `scrollHeight`, forcing a synchronous layout of the whole
// value, and the highlight mirror laid the same text out a second time. A 1MB
// paste took ~320ms to settle and 16MB took ~5s, linear in size.
//
// Past HIGHLIGHT_MAX_CHARS the composer drops both: the mirror is emptied and
// the textarea paints its own text, and the height is pinned to the cap without
// measuring. This asserts that mechanism (a timing assertion would flake).
//
// Uses WS + RPC mocks — no real relay needed.

import { expect, test } from "@playwright/test";
import { initMessages } from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

/** Comfortably past the composer's 20k-char highlight limit. */
const LARGE_DRAFT = "conduit relay event log line\n".repeat(4_000);

test.beforeEach(async ({ page }) => {
	await mockRelayWebSocket(page, { initMessages, responses: new Map() });
	await mockWsRpc(page, {
		stubs: {
			GetProjects: async () => ({
				projects: [{ slug: "myapp", title: "myapp", folders: ["/tmp/myapp"] }],
			}),
		},
	});
	await page.goto("/s/sess-mockup-001");
	await page.locator("#input").waitFor({ state: "visible", timeout: 20_000 });
});

test("@large-paste a pasted log dump bypasses the highlight mirror", async ({
	page,
}) => {
	const textarea = page.locator("#input");

	// A small draft is mirrored: the textarea's own text stays transparent.
	await textarea.fill("/commit the fix");
	const mirror = page.locator("#input-row div.mirror");
	await expect(mirror).toHaveText("/commit the fix");
	await expect(textarea).toHaveClass(/text-transparent/);

	// One input event, like a paste. Playwright's fill() types 116KB through
	// the protocol and takes ~20s on its own, even into a bare textarea.
	await textarea.evaluate((el: HTMLTextAreaElement, draft) => {
		el.value = draft;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, LARGE_DRAFT);

	// The mirror is emptied — it never lays the draft out a second time…
	await expect(mirror).toHaveText("");
	// …and the textarea shows its own text instead, so the draft stays visible.
	await expect(textarea).not.toHaveClass(/text-transparent/);
	// CSS pins the row to the cap without reading scrollHeight.
	await expect(textarea.locator("..")).toHaveClass(/h-\[120px\]/);
	// Height is pinned to the cap without measuring the draft.
	await expect
		.poll(async () => (await textarea.boundingBox())?.height)
		.toBe(120);
	// The draft itself is untouched.
	expect(await textarea.inputValue()).toBe(LARGE_DRAFT);
});

// Crossing the limit swaps scrollers: the outer field stops scrolling and the
// textarea scrolls itself from the top, so the browser's own reveal (made in the
// outer field) is lost and the caret ends up thousands of pixels below the view.
for (const at of ["end", "middle"] as const) {
	test(`@large-paste the caret stays visible when an insert at the ${at} crosses the highlight limit`, async ({
		page,
	}) => {
		const line = "conduit relay event log line\n";
		const caretLine = at === "end" ? 689 : 300;
		const textarea = page.locator("#input");
		await textarea.evaluate(
			(el: HTMLTextAreaElement, [line, caretLine, at]) => {
				el.focus();
				el.value = line.repeat(700).slice(0, 20_000);
				el.dispatchEvent(new Event("input", { bubbles: true }));
				const caret = at === "end" ? el.value.length : caretLine * line.length;
				el.setSelectionRange(caret, caret);
			},
			[line, caretLine, at] as const,
		);
		await expect(textarea).toHaveClass(/text-transparent/);

		// One character through the native editing path.
		await textarea.evaluate(() =>
			document.execCommand("insertText", false, "z"),
		);
		await expect(textarea).not.toHaveClass(/text-transparent/);

		// Every line fits the width, so the caret's line sits at a known offset.
		// ComposerFrame uses 22.5px lines with asymmetric padding here; derive
		// native pitch from content height after subtracting both paddings.
		await expect
			.poll(() =>
				textarea.evaluate((el: HTMLTextAreaElement, caretLine) => {
					const style = getComputedStyle(el);
					const paddingTop = parseFloat(style.paddingTop);
					const paddingBottom = parseFloat(style.paddingBottom);
					const lines = el.value.split("\n").length;
					const pitch = (el.scrollHeight - paddingTop - paddingBottom) / lines;
					const top = paddingTop + caretLine * pitch;
					return (
						el.scrollTop > 0 &&
						top >= el.scrollTop &&
						top + pitch <= el.scrollTop + el.clientHeight
					);
				}, caretLine),
			)
			.toBe(true);
	});
}

// Past the limit the browser keeps the caret in view itself; laying a
// multi-megabyte draft out again per keystroke is what plain text avoids.
test("@large-paste typing into a pasted log dump never lays the draft out again", async ({
	page,
}) => {
	const textarea = page.locator("#input");
	await textarea.evaluate((el: HTMLTextAreaElement, draft) => {
		const probes = { count: 0 };
		Object.assign(window, { probes });
		new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes)
					if (
						node instanceof HTMLDivElement &&
						node.classList.contains("composer-text-metrics")
					)
						probes.count += 1;
		}).observe(el.parentElement ?? el, { childList: true });
		el.focus();
		el.value = draft;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, LARGE_DRAFT);
	await expect(textarea).not.toHaveClass(/text-transparent/);

	await page.keyboard.type("tail");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("more");
	await expect(textarea).toHaveValue(`${LARGE_DRAFT}tail\nmore`);

	expect(
		await page.evaluate(
			() => (window as unknown as { probes: { count: number } }).probes.count,
		),
	).toBe(0);
	// The browser's own reveal keeps the caret's last line in view, though not
	// necessarily the field's bottom padding below it.
	expect(
		await textarea.evaluate((el: HTMLTextAreaElement) => {
			const style = getComputedStyle(el);
			const paddingTop = parseFloat(style.paddingTop);
			const paddingBottom = parseFloat(style.paddingBottom);
			const pitch =
				(el.scrollHeight - paddingTop - paddingBottom) /
				el.value.split("\n").length;
			return (
				el.scrollHeight - el.clientHeight - el.scrollTop <=
				paddingBottom + pitch / 2
			);
		}),
	).toBe(true);
});
