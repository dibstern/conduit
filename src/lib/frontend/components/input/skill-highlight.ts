// Tokenizes composer text into runs of plain text and slash-command ("skill")
// tokens so the input backdrop can render recognised skills as pills and likely
// typo near-misses as errors while leaving arbitrary tokens and common absolute-
// path roots plain. A slash token is a `/name` that sits in command position
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

// Bare absolute-path roots are common in prose but otherwise look exactly like
// slash commands. Keep this exact-case allowlist to Unix FHS and common macOS roots.
const ABSOLUTE_PATH_ROOTS: ReadonlySet<string> = new Set([
	"bin",
	"boot",
	"dev",
	"etc",
	"home",
	"lib",
	"media",
	"mnt",
	"opt",
	"proc",
	"root",
	"run",
	"sbin",
	"srv",
	"sys",
	"tmp",
	"usr",
	"var",
	"Users",
	"Applications",
	"Library",
	"System",
	"Volumes",
	"private",
]);

// Optimal string alignment (Damerau-Levenshtein with adjacent transpositions).
function editDistanceOSA(a: string, b: string): number {
	const dp: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];

	for (let i = 1; i <= a.length; i += 1) {
		const previousRow = dp[i - 1] ?? [];
		const currentRow = [i];

		for (let j = 1; j <= b.length; j += 1) {
			const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
			currentRow[j] = Math.min(
				(previousRow[j] ?? 0) + 1,
				(currentRow[j - 1] ?? 0) + 1,
				(previousRow[j - 1] ?? 0) + substitutionCost,
			);

			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				currentRow[j] = Math.min(
					currentRow[j] ?? 0,
					(dp[i - 2]?.[j - 2] ?? 0) + 1,
				);
			}
		}

		dp.push(currentRow);
	}

	return dp[a.length]?.[b.length] ?? 0;
}

// A proper prefix is still being typed, so it must never flash as an error.
function isProperPrefixOfKnownCommand(
	name: string,
	knownNames: ReadonlySet<string>,
): boolean {
	const lowerName = name.toLowerCase();
	for (const knownName of knownNames) {
		if (
			name.length < knownName.length &&
			knownName.toLowerCase().startsWith(lowerName)
		) {
			return true;
		}
	}
	return false;
}

// Keep typo detection conservative so arbitrary slash tokens remain plain text.
function isTypoOfKnownCommand(
	name: string,
	knownNames: ReadonlySet<string>,
): boolean {
	if (name.length < 2) return false;

	const lowerName = name.toLowerCase();
	for (const knownName of knownNames) {
		const lowerKnownName = knownName.toLowerCase();
		const maxDistance =
			Math.min(lowerName.length, lowerKnownName.length) <= 4 ? 1 : 2;
		if (Math.abs(lowerName.length - lowerKnownName.length) > maxDistance) {
			continue;
		}
		if (editDistanceOSA(lowerName, lowerKnownName) <= maxDistance) return true;
	}
	return false;
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
		const kind: SkillSegmentKind = knownNames.has(name)
			? "skill"
			: ABSOLUTE_PATH_ROOTS.has(name)
				? "text"
				: isProperPrefixOfKnownCommand(name, knownNames)
					? "text"
					: isTypoOfKnownCommand(name, knownNames)
						? "unknown"
						: "text";
		const occ = occurrences.get(name) ?? 0;
		occurrences.set(name, occ + 1);
		segments.push({ text: token, kind, key: `${kind}:${name}:${occ}` });

		last = tokenStart + token.length;
	}

	const tail = text.slice(last);
	if (tail) segments.push({ text: tail, kind: "text", key: `t${last}` });

	return segments;
}
