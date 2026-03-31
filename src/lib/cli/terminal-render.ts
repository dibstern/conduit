// ─── Terminal Rendering Engine (Ticket 8.0) ──────────────────────────────────
// Pure-function terminal rendering primitives for CLI output. ANSI escape
// sequences, gradient text, symbolic indicators, and status line formatting.
// Ported from claude-relay/bin/cli.js lines 200-245.

// ─── Types ───────────────────────────────────────────────────────────────────

/** Writable stream interface for injectable stdout. */
export interface Writable {
	write(s: string): void;
}

/** Options for gradient rendering. */
export interface GradientOptions {
	/** Override basic-terminal detection for testing. */
	isBasicTerm?: boolean;
}

// ─── ANSI Constants ──────────────────────────────────────────────────────────

/** ANSI escape sequences for common terminal styling. */
export const a = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
} as const;

// ─── Terminal Detection ──────────────────────────────────────────────────────

/**
 * Check if the terminal is a "basic" terminal that doesn't support 24-bit
 * color (e.g. Apple Terminal). Accepts an injectable env for testing.
 */
export function isBasicTerm(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env["TERM_PROGRAM"] === "Apple_Terminal";
}

// ─── ANSI Regex ──────────────────────────────────────────────────────────────

/** ESC character as a string constant (avoids control-char-in-regex lint). */
const ESC = "\x1b";
const ESC_CODE = 0x1b;

/** Matches a single SGR escape sequence: ESC [ digits/semicolons m */
const ANSI_SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Matches an SGR sequence at the start of a string. */
const ANSI_SGR_START_RE = new RegExp(`^${ESC}\\[[0-9;]*m`);

// ─── Width Utilities ─────────────────────────────────────────────────────────

/**
 * Count the number of visible (non-ANSI-escape) characters in a string.
 *
 * @example
 * visibleLength("hello")                   // => 5
 * visibleLength("\x1b[1mhello\x1b[0m")     // => 5
 */
export function visibleLength(text: string): number {
	return text.replace(ANSI_SGR_RE, "").length;
}

/**
 * Truncate text so it occupies at most `maxWidth` visible characters.
 * ANSI escape sequences are preserved and do not count toward the width.
 * When truncated, a trailing `…` and ANSI reset are appended.
 *
 * @example
 * truncateToWidth("Hello, world!", 8) // => "Hello, …" + reset
 */
export function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";

	const stripped = text.replace(ANSI_SGR_RE, "");
	if (stripped.length <= maxWidth) return text;

	// Walk through the original text, counting visible characters.
	// Stop at maxWidth - 1 to leave room for the ellipsis.
	let visible = 0;
	let i = 0;
	const truncAt = maxWidth - 1;

	while (i < text.length && visible < truncAt) {
		if (text.charCodeAt(i) === ESC_CODE) {
			const remaining = text.slice(i);
			const match = remaining.match(ANSI_SGR_START_RE);
			if (match) {
				i += match[0].length;
				continue;
			}
		}
		visible++;
		i++;
	}

	return `${text.slice(0, i)}\u2026${a.reset}`;
}

// ─── Gradient ────────────────────────────────────────────────────────────────

/**
 * Render text with a cyan-to-blue gradient using 24-bit ANSI color.
 * Falls back to plain cyan when `isBasicTerm()` is true.
 *
 * Color ramp: #22D3EE (34,211,238) → #3B82F6 (59,130,246)
 *
 * ANSI-aware: existing escape sequences (e.g. bold, reset) are passed
 * through unchanged so callers can embed inline styles.
 */
export function gradient(text: string, opts?: GradientOptions): string {
	if (text.length === 0) {
		return "";
	}

	const basic =
		opts?.isBasicTerm !== undefined ? opts.isBasicTerm : isBasicTerm();

	if (basic) {
		return a.cyan + text + a.reset;
	}

	// Cyan (#22D3EE) → Blue (#3B82F6)
	const r0 = 34;
	const g0 = 211;
	const b0 = 238;
	const r1 = 59;
	const g1 = 130;
	const b1 = 246;

	let out = "";

	// Count visible (non-ANSI-escape) characters for even gradient distribution
	const visibleLen = text.replace(ANSI_SGR_RE, "").length;
	let visibleIdx = 0;

	for (let i = 0; i < text.length; ) {
		// Pass through ANSI escape sequences unchanged
		if (text.charCodeAt(i) === ESC_CODE) {
			const remaining = text.slice(i);
			const match = remaining.match(ANSI_SGR_START_RE);
			if (match) {
				out += match[0];
				i += match[0].length;
				continue;
			}
		}

		const t = visibleLen > 1 ? visibleIdx / (visibleLen - 1) : 0;
		const r = Math.round(r0 + (r1 - r0) * t);
		const g = Math.round(g0 + (g1 - g0) * t);
		const b = Math.round(b0 + (b1 - b0) * t);
		out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
		visibleIdx++;
		i++;
	}

	return out + a.reset;
}

// ─── Symbols ─────────────────────────────────────────────────────────────────

/** Pre-styled Unicode symbols for terminal output. */
export const sym = {
	/** Cyan diamond — active/in-progress indicator */
	pointer: `${a.cyan}\u25C6${a.reset}`,
	/** Green diamond outline — completed indicator */
	done: `${a.green}\u25C7${a.reset}`,
	/** Dim vertical bar — continuation line */
	bar: `${a.dim}\u2502${a.reset}`,
	/** Dim corner — final line in a group */
	end: `${a.dim}\u2514${a.reset}`,
	/** Yellow triangle — warning indicator */
	warn: `${a.yellow}\u25B2${a.reset}`,
} as const;

// ─── Output Helpers ──────────────────────────────────────────────────────────

/**
 * Clear N previous terminal lines by writing move-up + erase sequences.
 * Each line: `\x1b[1A` (cursor up) + `\x1b[2K` (erase line).
 */
export function clearUp(n: number, stdout: Writable = process.stdout): void {
	for (let i = 0; i < n; i++) {
		stdout.write("\x1b[1A\x1b[2K");
	}
}

/**
 * Write a 2-space-indented line to stdout.
 */
export function log(s: string, stdout: Writable = process.stdout): void {
	stdout.write(`  ${s}\n`);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Join status items with a dimmed ` · ` separator.
 *
 * @example
 * formatStatusLine(["3 tokens", "2.1s", "$0.01"])
 * // => "3 tokens\x1b[2m · \x1b[0m2.1s\x1b[2m · \x1b[0m$0.01"
 */
export function formatStatusLine(items: string[]): string {
	if (items.length === 0) {
		return "";
	}
	const sep = `${a.dim} \u00B7 ${a.reset}`;
	return items.join(sep);
}

/**
 * Wrap text in an ANSI color code with a reset suffix.
 *
 * @example
 * wrapColor("hello", a.red)
 * // => "\x1b[31mhello\x1b[0m"
 */
export function wrapColor(text: string, color: string): string {
	return `${color}${text}${a.reset}`;
}
