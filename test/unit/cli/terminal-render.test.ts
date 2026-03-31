// ─── Terminal Rendering Engine — Unit Tests (Ticket 8.0) ─────────────────────
// Tests for ANSI constants, gradient, symbols, clearUp, log, isBasicTerm,
// formatStatusLine, and wrapColor.

import { describe, expect, it } from "vitest";
import {
	a,
	clearUp,
	formatStatusLine,
	gradient,
	isBasicTerm,
	log,
	sym,
	truncateToWidth,
	visibleLength,
	wrapColor,
} from "../../../src/lib/cli/terminal-render.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Capture everything written to a mock stdout. */
function mockStdout(): { write(s: string): void; output: string } {
	const buf = {
		output: "",
		write(s: string) {
			buf.output += s;
		},
	};
	return buf;
}

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
	// Build regex dynamically to avoid biome's noControlCharactersInRegex rule
	const esc = String.fromCharCode(0x1b);
	return s.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

// ─── gradient: basic output ──────────────────────────────────────────────────

describe("gradient — basic output", () => {
	it("returns a string with the same visible characters (correct length)", () => {
		const result = gradient("Hello");
		const stripped = stripAnsi(result);
		expect(stripped).toBe("Hello");
	});

	it("contains RGB escape codes for non-basic terminals", () => {
		const result = gradient("AB", { isBasicTerm: false });
		// Should contain 24-bit color codes: \x1b[38;2;R;G;Bm
		expect(result).toContain("\x1b[38;2;");
	});

	it("interpolates colors from start (#22D3EE) to end (#3B82F6)", () => {
		const result = gradient("AB", { isBasicTerm: false });
		// First character: RGB should be (34,211,238) = #22D3EE
		expect(result).toContain("\x1b[38;2;34;211;238m");
		// Last character: RGB should be (59,130,246) = #3B82F6
		expect(result).toContain("\x1b[38;2;59;130;246m");
	});

	it("works for a single character", () => {
		const result = gradient("X", { isBasicTerm: false });
		// Single char uses t=0, so start color
		expect(result).toContain("\x1b[38;2;34;211;238m");
		const stripped = stripAnsi(result);
		expect(stripped).toBe("X");
	});

	it("returns empty string for empty input", () => {
		expect(gradient("")).toBe("");
		expect(gradient("", { isBasicTerm: false })).toBe("");
		expect(gradient("", { isBasicTerm: true })).toBe("");
	});
});

// ─── symbols ─────────────────────────────────────────────────────────────────

describe("symbols", () => {
	it("pointer contains cyan diamond (\u25C6)", () => {
		expect(sym.pointer).toContain("\u25C6");
		expect(sym.pointer).toContain(a.cyan);
		expect(sym.pointer).toContain(a.reset);
	});

	it("done contains green diamond outline (\u25C7)", () => {
		expect(sym.done).toContain("\u25C7");
		expect(sym.done).toContain(a.green);
		expect(sym.done).toContain(a.reset);
	});

	it("bar contains dim vertical bar (\u2502)", () => {
		expect(sym.bar).toContain("\u2502");
		expect(sym.bar).toContain(a.dim);
		expect(sym.bar).toContain(a.reset);
	});

	it("end contains dim corner (\u2514)", () => {
		expect(sym.end).toContain("\u2514");
		expect(sym.end).toContain(a.dim);
		expect(sym.end).toContain(a.reset);
	});

	it("warn contains yellow triangle (\u25B2)", () => {
		expect(sym.warn).toContain("\u25B2");
		expect(sym.warn).toContain(a.yellow);
		expect(sym.warn).toContain(a.reset);
	});
});

// ─── clearUp ─────────────────────────────────────────────────────────────────

describe("clearUp", () => {
	it("writes nothing when n=0", () => {
		const out = mockStdout();
		clearUp(0, out);
		expect(out.output).toBe("");
	});

	it("writes one cursor-up + erase sequence when n=1", () => {
		const out = mockStdout();
		clearUp(1, out);
		expect(out.output).toBe("\x1b[1A\x1b[2K");
	});

	it("writes five cursor-up + erase sequences when n=5", () => {
		const out = mockStdout();
		clearUp(5, out);
		const expected = "\x1b[1A\x1b[2K".repeat(5);
		expect(out.output).toBe(expected);
	});
});

// ─── log ─────────────────────────────────────────────────────────────────────

describe("log", () => {
	it("writes 2-space-indented text with newline", () => {
		const out = mockStdout();
		log("hello world", out);
		expect(out.output).toBe("  hello world\n");
	});

	it("handles empty string input", () => {
		const out = mockStdout();
		log("", out);
		expect(out.output).toBe("  \n");
	});
});

// ─── isBasicTerm ─────────────────────────────────────────────────────────────

describe("isBasicTerm", () => {
	it("returns true when TERM_PROGRAM is Apple_Terminal", () => {
		expect(isBasicTerm({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
	});

	it("returns false when TERM_PROGRAM is not Apple_Terminal", () => {
		expect(isBasicTerm({ TERM_PROGRAM: "iTerm2" })).toBe(false);
		expect(isBasicTerm({ TERM_PROGRAM: undefined })).toBe(false);
		expect(isBasicTerm({})).toBe(false);
	});
});

// ─── gradient fallback ───────────────────────────────────────────────────────

describe("gradient — basic terminal fallback", () => {
	it("uses cyan ANSI code when isBasicTerm is true", () => {
		const result = gradient("Hello", { isBasicTerm: true });
		expect(result).toContain(a.cyan);
		expect(result).toContain(a.reset);
	});

	it("does not contain 24-bit RGB codes when isBasicTerm is true", () => {
		const result = gradient("Hello", { isBasicTerm: true });
		expect(result).not.toContain("\x1b[38;2;");
	});

	it("wraps the entire text in cyan (no per-character codes)", () => {
		const result = gradient("ABC", { isBasicTerm: true });
		expect(result).toBe(`${a.cyan}ABC${a.reset}`);
	});
});

// ─── formatStatusLine ────────────────────────────────────────────────────────

describe("formatStatusLine", () => {
	it("joins items with a dimmed middle-dot separator", () => {
		const result = formatStatusLine(["3 tokens", "2.1s"]);
		expect(result).toContain("3 tokens");
		expect(result).toContain("2.1s");
		expect(result).toContain(a.dim);
		expect(result).toContain("\u00B7");
	});

	it("returns the single item when given one element", () => {
		const result = formatStatusLine(["only"]);
		expect(result).toBe("only");
	});

	it("returns empty string for empty array", () => {
		expect(formatStatusLine([])).toBe("");
	});
});

// ─── wrapColor ───────────────────────────────────────────────────────────────

describe("wrapColor", () => {
	it("wraps text with the given color and a reset suffix", () => {
		const result = wrapColor("error", a.red);
		expect(result).toBe(`${a.red}error${a.reset}`);
	});

	it("works with all ANSI color constants", () => {
		for (const [name, code] of Object.entries(a)) {
			if (name === "reset") continue;
			const result = wrapColor("test", code);
			expect(result).toBe(`${code}test${a.reset}`);
		}
	});
});

// ─── gradient: ANSI awareness ────────────────────────────────────────────────

describe("gradient — ANSI awareness", () => {
	it("passes through embedded ANSI escape sequences unchanged", () => {
		const result = gradient("\x1b[1mAB", { isBasicTerm: false });
		// Bold escape should be passed through
		expect(result).toContain("\x1b[1m");
		// Gradient colors should also be present
		expect(result).toContain("\x1b[38;2;");
	});

	it("distributes gradient only across visible characters", () => {
		// "\x1b[1m" is bold (non-visible ANSI), then A and B are visible
		const result = gradient("\x1b[1mAB", { isBasicTerm: false });
		// A (first visible) should get start color (34,211,238)
		expect(result).toContain("\x1b[38;2;34;211;238mA");
		// B (last visible) should get end color (59,130,246)
		expect(result).toContain("\x1b[38;2;59;130;246mB");
	});

	it("handles multiple embedded ANSI sequences", () => {
		const result = gradient("\x1b[32mX\x1b[0mY", { isBasicTerm: false });
		// Both ANSI sequences should pass through
		expect(result).toContain("\x1b[32m");
		expect(result).toContain("\x1b[0m");
		// Visible characters X and Y should get gradient colors
		const stripped = stripAnsi(result);
		expect(stripped).toBe("XY");
	});
});

// ─── visibleLength ───────────────────────────────────────────────────────────

describe("visibleLength", () => {
	it("returns length for plain text", () => {
		expect(visibleLength("hello")).toBe(5);
	});

	it("excludes ANSI escape sequences from count", () => {
		expect(visibleLength("\x1b[1mhello\x1b[0m")).toBe(5);
	});

	it("handles text with multiple ANSI sequences", () => {
		expect(visibleLength("\x1b[32m\x1b[1mhi\x1b[0m there")).toBe(8);
	});

	it("returns 0 for empty string", () => {
		expect(visibleLength("")).toBe(0);
	});

	it("returns 0 for ANSI-only string", () => {
		expect(visibleLength("\x1b[1m\x1b[0m")).toBe(0);
	});
});

// ─── truncateToWidth ─────────────────────────────────────────────────────────

describe("truncateToWidth", () => {
	it("returns text unchanged when within width", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
	});

	it("returns text unchanged when exactly at width", () => {
		expect(truncateToWidth("hello", 5)).toBe("hello");
	});

	it("truncates plain text with ellipsis", () => {
		const result = truncateToWidth("hello world", 8);
		const stripped = stripAnsi(result);
		// 7 chars + ellipsis = 8 visible chars
		expect(stripped).toBe("hello w\u2026");
	});

	it("preserves ANSI sequences when truncating", () => {
		const result = truncateToWidth("\x1b[1mhello world\x1b[0m", 8);
		// Should contain the bold escape
		expect(result).toContain("\x1b[1m");
		// Visible text should be truncated
		const stripped = stripAnsi(result);
		expect(stripped).toBe("hello w\u2026");
	});

	it("handles text with embedded ANSI not needing truncation", () => {
		const input = `\x1b[1mhi\x1b[0m`;
		expect(truncateToWidth(input, 10)).toBe(input);
	});

	it("returns empty string for maxWidth 0", () => {
		expect(truncateToWidth("hello", 0)).toBe("");
	});

	it("returns empty string for negative maxWidth", () => {
		expect(truncateToWidth("hello", -5)).toBe("");
	});

	it("handles maxWidth of 1 (just ellipsis)", () => {
		const result = truncateToWidth("hello", 1);
		const stripped = stripAnsi(result);
		// 0 chars + ellipsis = 1 visible char
		expect(stripped).toBe("\u2026");
	});
});
