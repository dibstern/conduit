import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

describe("daemon lifecycle Effect boundary", () => {
	it("does not run an Effect for pure tagged IPC request decoding", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/daemon/daemon-lifecycle.ts"),
			"utf8",
		);

		expect(source).not.toMatch(
			/Effect\s*\.\s*run(?:Promise|Sync)\s*\(\s*decodeTaggedRequest\s*\(/,
		);
	});
});
