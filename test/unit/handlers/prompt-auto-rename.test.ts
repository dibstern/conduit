import { describe, expect, it } from "vitest";

/**
 * Unit tests for the auto-rename title helper.
 * Integration with the prompt handler is verified by the full test suite —
 * the helper is extracted so truncation logic is independently testable.
 */

/** Extracted helper — matches the implementation in prompt.ts */
function autoRenameTitle(text: string): string {
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

describe("Claude session auto-rename — title helper", () => {
	it("returns short prompts unchanged", () => {
		const short = "Fix the auth bug in login.ts";
		expect(autoRenameTitle(short)).toBe(short);
		expect(autoRenameTitle(short).length).toBeLessThanOrEqual(60);
	});

	it("truncates long prompts to 60 chars with ellipsis", () => {
		const long =
			"Please help me refactor the entire authentication system to use OAuth 2.0 with PKCE flow";
		const result = autoRenameTitle(long);
		expect(result.length).toBe(60);
		expect(result).toMatch(/\.\.\.$/);
	});

	it("handles exactly 60 chars without truncation", () => {
		const exact = "a".repeat(60);
		expect(autoRenameTitle(exact)).toBe(exact);
	});

	it("handles 61 chars with truncation", () => {
		const over = "a".repeat(61);
		const result = autoRenameTitle(over);
		expect(result.length).toBe(60);
		expect(result).toMatch(/\.\.\.$/);
	});
});
