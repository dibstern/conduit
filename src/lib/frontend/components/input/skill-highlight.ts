// Tokenizes composer text into runs of plain text and slash-command ("skill")
// tokens so the input backdrop can render recognised skills as pills and unknown
// ones as errors. A "skill token" is a `/name` that sits in command position
// (start of input or after whitespace) and is NOT immediately followed by another
// `/` — the latter guard keeps file paths like `/etc/hosts` from lighting up.

export type SkillSegmentKind = "text" | "skill" | "unknown";

export interface SkillSegment {
	readonly text: string;
	readonly kind: SkillSegmentKind;
	/**
	 * Stable identity for Svelte's keyed `{#each}`. Keeping a token's node stable
	 * across keystrokes lets the one-shot recognition shimmer play exactly once
	 * (a node is only recreated when the token itself changes).
	 */
	readonly key: string;
}

// `(^|\s)` — command position. The trailing `(?![\w:/-])` requires the token to
// end at a real boundary: forbidding a following name char blocks the regex from
// backtracking to a truncated match, and forbidding a following `/` rejects path
// segments (`/etc/hosts` matches nothing rather than `/et`).
const SLASH_TOKEN = /(^|\s)(\/[A-Za-z0-9][A-Za-z0-9_:-]*)(?![\w:/-])/g;

export function tokenizeSkills(
	text: string,
	knownNames: ReadonlySet<string>,
): SkillSegment[] {
	const segments: SkillSegment[] = [];
	const occurrences = new Map<string, number>();
	let last = 0;

	for (const match of text.matchAll(SLASH_TOKEN)) {
		const lead = match[1] ?? "";
		const token = match[2] ?? "";
		const tokenStart = (match.index ?? 0) + lead.length;

		const pre = text.slice(last, tokenStart);
		if (pre) segments.push({ text: pre, kind: "text", key: `t${last}` });

		const name = token.slice(1);
		const kind: SkillSegmentKind = knownNames.has(name) ? "skill" : "unknown";
		const occ = occurrences.get(name) ?? 0;
		occurrences.set(name, occ + 1);
		segments.push({ text: token, kind, key: `${kind}:${name}:${occ}` });

		last = tokenStart + token.length;
	}

	const tail = text.slice(last);
	if (tail) segments.push({ text: tail, kind: "text", key: `t${last}` });

	return segments;
}
