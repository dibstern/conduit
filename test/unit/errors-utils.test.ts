import { describe, expect, it } from "vitest";
import { formatErrorDetail } from "../../src/lib/errors-utils.js";

class EmptyTaggedError extends Error {
	readonly _tag = "EmptyTaggedError";

	constructor(cause: unknown) {
		super("", { cause });
	}
}

describe("formatErrorDetail", () => {
	it("uses the innermost meaningful message from an empty tagged error", () => {
		const error = new EmptyTaggedError(
			new Error("", {
				cause: new Error("FOREIGN KEY constraint failed"),
			}),
		);

		expect(formatErrorDetail(error)).toContain("FOREIGN KEY constraint failed");
	});
});
