import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("media generation", () => {
	it("setup scene generates GIF without errors", () => {
		// Run the setup scene
		execSync("pnpm generate:media setup", {
			cwd: ROOT,
			stdio: "pipe",
			timeout: 120_000,
		});

		// Verify output exists and has reasonable size
		const gifPath = path.join(ROOT, "media/GENERATE-SETUP.gif");
		expect(existsSync(gifPath)).toBe(true);
		const stat = statSync(gifPath);
		expect(stat.size).toBeGreaterThan(50_000); // At least 50KB

		// Verify no debug artifacts (no failures)
		const debugDir = path.join(ROOT, "media/_debug");
		if (existsSync(debugDir)) {
			const failures = readdirSync(debugDir).filter((f) =>
				f.startsWith("setup-"),
			);
			expect(failures).toHaveLength(0);
		}
	}, 120_000);
});
