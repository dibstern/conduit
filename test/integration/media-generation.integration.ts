import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** The scene runner needs two different ffmpeg binaries, and missing either
 *  one fails the same way. `ffmpeg` on PATH converts the WebM to a GIF; the
 *  copy Playwright downloads for itself backs recordVideo, and only a full
 *  `playwright install` fetches it — `playwright install chromium` does not.
 *  Checking just the first one is how this test came to fail on a machine
 *  that had ffmpeg installed, which reads as a product failure and is not. */
function hasFfmpeg(): boolean {
	try {
		execSync("ffmpeg -version", { stdio: "pipe" });
	} catch {
		return false;
	}
	return (
		existsSync(playwrightBrowsersDir()) &&
		readdirSync(playwrightBrowsersDir()).some((entry) =>
			entry.startsWith("ffmpeg-"),
		)
	);
}

function playwrightBrowsersDir(): string {
	const override = process.env["PLAYWRIGHT_BROWSERS_PATH"];
	if (override) return override;
	if (process.platform === "darwin")
		return path.join(homedir(), "Library", "Caches", "ms-playwright");
	if (process.platform === "win32")
		return path.join(process.env["LOCALAPPDATA"] ?? homedir(), "ms-playwright");
	return path.join(homedir(), ".cache", "ms-playwright");
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEST_OUTPUT_DIR = path.join(ROOT, "media/_test_output");

describe("media generation", () => {
	afterAll(() => {
		rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
	});

	it.skipIf(!hasFfmpeg())(
		"setup scene generates GIF without errors",
		() => {
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
		},
		120_000,
	);
});
