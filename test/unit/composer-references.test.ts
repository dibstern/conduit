import { describe, expect, it } from "vitest";
import {
	displayOffset,
	draftOffset,
	editReferenceDraft,
	encodeReference,
	projectReferences,
	type ReplyReference,
	serializeReferences,
} from "../../src/lib/composer-references.js";
import { tokenizeSkills } from "../../src/lib/skill-recognition.js";

const message: ReplyReference = {
	kind: "message",
	ordinal: 24,
	category: "Ask",
	glyph: "?",
	time: "31:02",
	text: "Recapture it?",
};

describe("self-contained reply drafts", () => {
	it("sends references in order before the free text, including after a JSON round trip", () => {
		const draft = `Before ${encodeReference(message)}after ${encodeReference({ kind: "recap-excerpt", text: 'A "quote"\nwith 🦊' })}done`;
		expect(serializeReferences(JSON.parse(JSON.stringify(draft)))).toBe(
			'Re #24 (Ask, 31:02): "Recapture it?"\nRe recap: "A "quote" with 🦊"\n\nBefore after done',
		);
	});
	it("clips whole messages to 280 characters while retaining the complete excerpt", () => {
		const text = "🦊".repeat(300);
		expect(serializeReferences(encodeReference({ ...message, text }))).toBe(
			`Re #24 (Ask, 31:02): "${"🦊".repeat(280)}…"`,
		);
		expect(
			serializeReferences(
				encodeReference({ ...message, kind: "excerpt", text }),
			),
		).toBe(`Re #24 (Ask, 31:02): "${text}"`);
		expect(
			serializeReferences(encodeReference({ kind: "recap-excerpt", text })),
		).toBe(`Re recap: "${text}"`);
	});
	it("leaves literal or damaged envelopes unchanged", () => {
		for (const text of [
			"ordinary text",
			"\uFFF9ref:%oops\uFFFB",
			"\uFFF9ref:%7B%7D\uFFFB",
			"\uFFF9ref:unterminated",
		])
			expect(serializeReferences(text)).toBe(text);
	});
	it("maps UTF-16 caret positions around several tokens and clips only their displayed quotes", () => {
		const token = encodeReference(message);
		const draft = `🦊 ${token} and ${encodeReference({ ...message, kind: "excerpt", text: "abcdefghijklmnopqrstuvwxyz" })}`;
		const view = projectReferences(draft);
		expect(view.text.replaceAll("\u00a0", " ")).toBe(
			'🦊 \u202f? #24 Ask ×\u202f and \u202f? #24 "abcdefghijklmnopqrstuvwx…" ×\u202f',
		);
		for (const span of view.references) {
			expect(draftOffset(draft, span.displayStart)).toBe(span.start);
			expect(draftOffset(draft, span.displayEnd)).toBe(span.end);
			expect(displayOffset(draft, span.end)).toBe(span.displayEnd);
		}
	});
	it("removes an entire token on Backspace, partial replacement or cut", () => {
		const draft = `a${encodeReference(message)}b`;
		const visible = projectReferences(draft).text;
		const end = visible.length - 1;
		expect(
			editReferenceDraft(draft, `${visible.slice(0, end - 1)}b`).draft,
		).toBe("ab");
		expect(
			editReferenceDraft(draft, `${visible.slice(0, 3)}X${visible.slice(5)}`)
				.draft,
		).toBe("aXb");
		expect(editReferenceDraft(draft, "ab").draft).toBe("ab");
	});
	it("preserves neighboring tokens and payloads while typing on either side", () => {
		const token = encodeReference(message);
		const draft = `${token}${token}`;
		const visible = projectReferences(draft).text;
		expect(editReferenceDraft(draft, `a${visible}`).draft).toBe(`a${draft}`);
		expect(editReferenceDraft(draft, `${visible}b`).draft).toBe(`${draft}b`);
		const segments = tokenizeSkills(
			`Use /review ${draft}`,
			new Set(["review"]),
		);
		expect(
			segments.filter((segment) => segment.kind === "reference"),
		).toHaveLength(2);
		expect(new Set(segments.map((segment) => segment.key)).size).toBe(
			segments.length,
		);
		expect(segments.map((segment) => segment.text).join("")).toBe(
			`Use /review ${draft}`,
		);
	});
});
