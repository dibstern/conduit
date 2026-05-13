import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Storybook preview head", () => {
	it("does not load parser-blocking external scripts in visual test iframes", () => {
		const previewHead = readFileSync(
			resolve(process.cwd(), ".storybook/preview-head.html"),
			"utf8",
		);

		expect(previewHead).not.toMatch(
			/<script\b[^>]*\bsrc=["']https?:\/\/[^"']+["'][^>]*>/i,
		);
	});
});
