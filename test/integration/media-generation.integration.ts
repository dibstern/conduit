import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEST_OUTPUT_DIR = path.join(ROOT, "media/_test_output");

describe("media generation", () => {
	afterAll(() => {
		rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
	});

	it("setup scene generates GIF without errors", () => {
		// Write to a gitignored test output directory instead of the
		// tracked media/ folder to avoid dirty working tree after tests.
		mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

		// Run the setup scene with MEDIA_DIR override so it writes to
		// the test output directory instead of the production media/ path.
		execSync("pnpm generate:media setup", {
			cwd: ROOT,
			stdio: "pipe",
			timeout: 120_000,
			env: { ...process.env, MEDIA_DIR: TEST_OUTPUT_DIR },
		});

		// Verify output exists and has reasonable size
		const gifPath = path.join(TEST_OUTPUT_DIR, "GENERATE-SETUP.gif");
		expect(existsSync(gifPath)).toBe(true);
		const stat = statSync(gifPath);
		expect(stat.size).toBeGreaterThan(50_000); // At least 50KB

		// Verify no debug artifacts (no failures)
		const debugDir = path.join(TEST_OUTPUT_DIR, "_debug");
		if (existsSync(debugDir)) {
			const failures = readdirSync(debugDir).filter((f) =>
				f.startsWith("setup-"),
			);
			expect(failures).toHaveLength(0);
		}
	}, 120_000);
});
