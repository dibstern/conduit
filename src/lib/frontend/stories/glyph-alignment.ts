import { expect } from "storybook/test";

/** Measure the first line's baseline, rather than centring on its line box. */
export async function expectSessionGlyphAlignment(root: HTMLElement) {
	await document.fonts.ready;
	const rows = [...root.querySelectorAll<HTMLElement>(".session-item")];
	const groups = [
		...root.querySelectorAll<HTMLElement>(".session-group-label"),
	];
	const pairs = [...rows, ...groups].flatMap((owner) => {
		const glyph = owner.querySelector<HTMLElement>(".session-status-glyph");
		const title = owner.querySelector<HTMLElement>(
			".session-title-inner, [data-group-label]",
		);
		return glyph && title ? [{ glyph, title }] : [];
	});
	await expect(pairs.length).toBeGreaterThan(0);

	for (const { glyph, title } of pairs) {
		const text = document
			.createTreeWalker(title, NodeFilter.SHOW_TEXT)
			.nextNode();
		if (!text) throw new TypeError("Glyph label has no text");
		const range = document.createRange();
		range.selectNodeContents(text);
		const firstLine = [...range.getClientRects()].find(
			(rect) => rect.width > 0,
		);
		if (!firstLine)
			throw new TypeError("Glyph label has no visible first line");
		const font = getComputedStyle(title);
		const canvas = document.createElement("canvas").getContext("2d");
		if (!canvas) throw new TypeError("Font metrics are unavailable");
		canvas.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
		const xHeight = canvas.measureText("x").actualBoundingBoxAscent;

		const sample = document.createElement("span");
		sample.style.cssText =
			"position:fixed;left:-10000px;top:0;visibility:hidden;white-space:nowrap";
		sample.style.font = font.font;
		const sampleText = document.createTextNode("x");
		const baseline = document.createElement("span");
		baseline.style.cssText =
			"display:inline-block;width:0;height:0;vertical-align:baseline";
		sample.append(sampleText, baseline);
		document.body.append(sample);
		const sampleRange = document.createRange();
		sampleRange.selectNodeContents(sampleText);
		const baselineOffset =
			baseline.getBoundingClientRect().top -
			sampleRange.getBoundingClientRect().top;
		sample.remove();

		const box = glyph.getBoundingClientRect();
		const xCentre = firstLine.top + baselineOffset - xHeight / 2;
		await expect(
			Math.abs(box.top + box.height / 2 - xCentre),
			title.textContent ?? "Glyph alignment",
		).toBeLessThanOrEqual(1);
	}

	const firstRow = rows.find((row) =>
		row.querySelector(".session-status-glyph"),
	);
	const rowGlyph = firstRow?.querySelector(".session-status-glyph");
	const rowTitle = firstRow?.querySelector(".session-title-inner");
	if (!rowGlyph || !rowTitle) return;
	for (const group of groups) {
		const glyph = group.querySelector(".session-status-glyph");
		const label = group.querySelector("[data-group-label]");
		if (!glyph || !label) continue;
		await expect(
			Math.abs(
				glyph.getBoundingClientRect().left -
					rowGlyph.getBoundingClientRect().left,
			),
		).toBeLessThanOrEqual(1);
		await expect(
			Math.abs(
				label.getBoundingClientRect().left -
					rowTitle.getBoundingClientRect().left,
			),
		).toBeLessThanOrEqual(1);
	}
}
