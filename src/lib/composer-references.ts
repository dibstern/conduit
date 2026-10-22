/** References travel in the existing draft string, never in a browser-only registry. */
export type ReplyReference =
	| {
			kind: "message" | "excerpt";
			ordinal: number;
			category: string;
			/** Stable identity for theme colours; labels and glyphs can belong to custom categories. */
			builtinCategory?: string | undefined;
			glyph: string;
			time: string;
			text: string;
	  }
	| { kind: "recap-excerpt"; text: string };

const ENVELOPE = /\uFFF9ref:([^\uFFFB]*)\uFFFB/g;

export function encodeReference(reference: ReplyReference): string {
	return `\uFFF9ref:${encodeURIComponent(JSON.stringify(reference))}\uFFFB`;
}

function decodeReference(encoded: string): ReplyReference | null {
	try {
		const value: unknown = JSON.parse(decodeURIComponent(encoded));
		if (
			!value ||
			typeof value !== "object" ||
			!("kind" in value) ||
			!("text" in value) ||
			typeof value.text !== "string"
		)
			return null;
		if (value.kind === "recap-excerpt")
			return { kind: value.kind, text: value.text };
		if (
			(value.kind === "message" || value.kind === "excerpt") &&
			"ordinal" in value &&
			typeof value.ordinal === "number" &&
			Number.isSafeInteger(value.ordinal) &&
			value.ordinal > 0 &&
			"category" in value &&
			typeof value.category === "string" &&
			"glyph" in value &&
			typeof value.glyph === "string" &&
			"time" in value &&
			typeof value.time === "string"
		) {
			return {
				kind: value.kind,
				text: value.text,
				ordinal: value.ordinal,
				category: value.category,
				...("builtinCategory" in value &&
				typeof value.builtinCategory === "string"
					? { builtinCategory: value.builtinCategory }
					: {}),
				glyph: value.glyph,
				time: value.time,
			};
		}
	} catch {
		/* A damaged or literal envelope remains editable plain text. */
	}
	return null;
}

export function referenceLabel(reference: ReplyReference): string {
	const chars = Array.from(reference.text.replace(/\s+/g, " "));
	const quote = `"${chars.slice(0, 24).join("")}${chars.length > 24 ? "…" : ""}"`;
	const label =
		"ordinal" in reference
			? `${reference.glyph} #${reference.ordinal} ${reference.kind === "excerpt" ? quote : reference.category} ×`
			: `✦ Recap ${quote} ×`;
	// No-break spaces keep a short label on one line, and the narrow ones at
	// either end pad the chip inside the text itself, so the transparent
	// textarea and the painted backdrop keep identical glyph positions.
	return `\u202f${label.replaceAll(" ", "\u00a0")}\u202f`;
}

export function projectReferences(draft: string) {
	const references: Array<{
		start: number;
		end: number;
		displayStart: number;
		displayEnd: number;
		label: string;
		reference: ReplyReference;
	}> = [];
	let text = "";
	let last = 0;
	for (const match of draft.matchAll(ENVELOPE)) {
		const reference = decodeReference(match[1] ?? "");
		if (!reference) continue;
		text += draft.slice(last, match.index);
		const label = referenceLabel(reference);
		references.push({
			start: match.index,
			end: match.index + match[0].length,
			displayStart: text.length,
			displayEnd: text.length + label.length,
			label,
			reference,
		});
		text += label;
		last = match.index + match[0].length;
	}
	return { text: text + draft.slice(last), references };
}

/** Native selection offsets are UTF-16, just like the rest of the composer. */
export function draftOffset(
	draft: string,
	offset: number,
	edge: "start" | "end" = "start",
): number {
	let delta = 0;
	for (const span of projectReferences(draft).references) {
		if (offset <= span.displayStart) break;
		if (offset < span.displayEnd)
			return edge === "start" ? span.start : span.end;
		delta += span.end - span.start - span.label.length;
	}
	return offset + delta;
}

export function displayOffset(draft: string, offset: number): number {
	let delta = 0;
	for (const span of projectReferences(draft).references) {
		if (offset <= span.start) break;
		if (offset < span.end) return span.displayStart;
		delta += span.end - span.start - span.label.length;
	}
	return offset - delta;
}

/** Expand edits touching a chip to its entire persisted envelope. Also covers
 * cut, drag/drop, dictation and edits whose beforeinput is not cancelable. */
export function editReferenceDraft(
	draft: string,
	next: string,
	range?: { start: number; end: number; text?: string | undefined },
): { draft: string; caret: number } {
	const previous = projectReferences(draft).text;
	let start = 0;
	while (
		start < previous.length &&
		start < next.length &&
		previous[start] === next[start]
	)
		start++;
	let end = previous.length;
	let nextEnd = next.length;
	while (
		end > start &&
		nextEnd > start &&
		previous[end - 1] === next[nextEnd - 1]
	) {
		end--;
		nextEnd--;
	}
	// beforeinput disambiguates edits to identical-looking chips whose full
	// excerpts differ. A string diff alone could delete the wrong payload. It
	// widened the selection to whole chips, which only counts if the edit then
	// replaced exactly that range with the expected text: user agents that keep
	// their own selection leave label remnants, and the diff handles those.
	const replaced =
		range &&
		next.slice(range.start, next.length - (previous.length - range.end));
	if (
		range &&
		(range.text === undefined || replaced === range.text) &&
		next.startsWith(previous.slice(0, range.start)) &&
		next.endsWith(previous.slice(range.end))
	) {
		start = range.start;
		end = range.end;
		nextEnd = next.length - (previous.length - end);
	}
	const from = draftOffset(draft, start);
	const to = draftOffset(draft, end, "end");
	const inserted = next.slice(start, nextEnd);
	const result = draft.slice(0, from) + inserted + draft.slice(to);
	return { draft: result, caret: displayOffset(draft, from) + inserted.length };
}

/** The design puts quoted lines first, retaining their encounter order, then prose. */
export function serializeReferences(draft: string): string {
	const { references } = projectReferences(draft);
	if (!references.length) return draft;
	const blocks: string[] = [];
	let prose = "";
	let last = 0;
	for (const span of references) {
		const ref = span.reference;
		// Each reference is one quoted line; a whole message is clipped to 280.
		const chars = Array.from(ref.text.replace(/\s+/g, " ").trim());
		const text =
			ref.kind === "message" && chars.length > 280
				? `${chars.slice(0, 280).join("").trimEnd()}…`
				: chars.join("");
		blocks.push(
			"ordinal" in ref
				? `Re #${ref.ordinal} (${ref.category}, ${ref.time}): "${text}"`
				: `Re recap: "${text}"`,
		);
		prose += draft.slice(last, span.start);
		last = span.end;
		// A token sits between spaces; dropping it must not leave two.
		if (/(^|\s)$/.test(prose) && draft[last] === " ") last++;
	}
	prose = (prose + draft.slice(last)).trim();
	return blocks.join("\n") + (prose ? `\n\n${prose}` : "");
}
