import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("ClaudePermissionBridge", () => {
	it("keeps permission waits behind a named Claude SDK callback boundary", () => {
		const source = readFileSync(
			join(
				process.cwd(),
				"src/lib/provider/claude/claude-permission-bridge.ts",
			),
			"utf8",
		);

		expect(source).toContain("runPermissionRequestAtSdkBoundary");
		expect(source.match(/Effect\.runPromise/g)).toHaveLength(1);
		expect(source).toMatch(
			/function runPermissionRequestAtSdkBoundary[\s\S]*Effect\.runPromise/,
		);
	});
});
