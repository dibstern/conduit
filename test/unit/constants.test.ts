import { describe, expect, it } from "vitest";
import {
	DEFAULT_OPENCODE_PORT,
	DEFAULT_OPENCODE_URL,
} from "../../src/lib/constants.js";

describe("constants", () => {
	it("DEFAULT_OPENCODE_PORT is 4096", () => {
		expect(DEFAULT_OPENCODE_PORT).toBe(4096);
	});

	it("DEFAULT_OPENCODE_URL uses the default port", () => {
		expect(DEFAULT_OPENCODE_URL).toBe("http://localhost:4096");
	});
});
