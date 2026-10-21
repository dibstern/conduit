import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("EffectPromptQueue", () => {
	it("keeps producer operations free of local runtime bridges", () => {
		const source = readFileSync(
			"src/lib/provider/claude/effect-prompt-queue.ts",
			"utf8",
		);
		expect(source).not.toMatch(/Effect\.run(?:Promise|Sync)/);
	});
});
