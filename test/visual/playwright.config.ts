import { defineConfig } from "@playwright/test";

/**
 * Strict mode (`VISUAL_STRICT=1`) turns the visual suite from a regression
 * detector into a fidelity gate, for the migration swap commits that claim
 * "this component renders IDENTICALLY after the primitive swap".
 *
 * The default tolerance is calibrated for cross-platform noise: 1% of a
 * 1440x900 capture is ~12,960 pixels, which comfortably hides a changed border
 * radius, a shifted icon, a wrong font weight, or a story whose fixtures are
 * nondeterministic. That is the right call for everyday regression runs and
 * useless for proving a refactor changed nothing.
 *
 * Three settings have to move together, and the two beyond the obvious one are
 * what make the mode real:
 *
 * - `threshold` is the per-pixel colour distance below which Playwright does
 *   not count a pixel as differing at all. It defaults to 0.2 (YIQ), so
 *   `maxDiffPixels: 0` alone still permits every single pixel in the image to
 *   shift, as long as each shifts only a little. Zeroing the pixel budget
 *   without zeroing the threshold looks strict and is not.
 * - `retries` must be 0. A retry that passes is precisely the nondeterminism
 *   this mode exists to expose; retrying converts the signal into a green run.
 *
 * Measured 2026-08-03 (conduit-test-de3.11), because "is zero actually
 * achievable?" is not a question to answer by assertion:
 *
 * - Recapture the whole suite under strict, then re-run strict immediately →
 *   **843 of 848 passed**. Zero-diff is achievable on this machine; the five
 *   failures are three genuinely nondeterministic stories, named in
 *   `STRICT_NONDETERMINISTIC` in components.spec.ts (conduit-test-de3.20).
 * - Strict against the *committed* baselines → 224 of 848 fail, and two
 *   independent runs failed the identical set. That is stable disagreement, not
 *   flake: the committed images do not depict what HEAD renders today, and the
 *   1% tolerance hides all of it (conduit-test-de3.21).
 * - `--update-snapshots` defaults to mode `changed`, which respects the
 *   configured tolerance — so under the default config an intentional change
 *   *smaller* than the tolerance cannot be written into a baseline at all.
 *   Recapturing a sub-tolerance fix silently no-ops. Use strict to record one.
 */
const strict = process.env["VISUAL_STRICT"] === "1";

/**
 * Chromium's default compositing is not bit-reproducible, and zero-tolerance
 * mode is the only thing sensitive enough to notice.
 *
 * Measured 2026-08-06 (conduit-test-de3.20). Overlays/SettingsPanel failed
 * strict on every run, roaming between its Default / Debug / Notifications
 * Enabled stories — which reads exactly like shared story state under parallel
 * workers, and is not. The actual diff is ~8 pixels, each off by 1/255 in a
 * single channel, all on the rounded corners of a panel that sits above a
 * `backdrop-blur-sm` layer (SettingsPanel.svelte:399). It is the GPU compositing
 * the blurred backdrop against the panel edge, not anything the app controls.
 *
 * Recapture-then-rerun, four runs, no flags:   4 of 4 runs FAILED (3,3,1,3).
 * Recapture-then-rerun, ten runs, these flags: 0 of 10 runs failed.
 *
 * The list is deliberately not reduced further: `--disable-gpu` ALONE was
 * measured and is NOT sufficient — it passed three consecutive runs and failed
 * the fourth, which is precisely how a flaky fix disguises itself as a fix.
 * Narrowing the set is only worth doing against a run count large enough to see
 * a ~25% per-run failure rate, so the set is adopted and justified as a set.
 *
 * These flags shift a small number of pixels, so they invalidate baselines:
 * two of the three SettingsPanel captures moved by 45-47 of the same ±1 corner
 * pixels, one was byte-identical. Change them only alongside a full recapture.
 */
const DETERMINISTIC_RASTER_ARGS = [
	"--disable-gpu",
	"--disable-partial-raster",
	"--disable-skia-runtime-opts",
	"--disable-lcd-text",
	"--force-color-profile=srgb",
	"--disable-composited-antialiasing",
];

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	timeout: 10_000,
	workers: 4,
	retries: strict ? 0 : 1,
	expect: {
		toHaveScreenshot: strict
			? { threshold: 0, maxDiffPixels: 0, maxDiffPixelRatio: 0 }
			: { maxDiffPixelRatio: 0.01 },
	},
	use: {
		baseURL: "http://localhost:6007",
		colorScheme: "dark",
		launchOptions: { args: DETERMINISTIC_RASTER_ARGS },
	},
	webServer: {
		command: "pnpm exec http-server dist/storybook -p 6007 -s",
		port: 6007,
		reuseExistingServer: !process.env["CI"],
		cwd: process.cwd().replace(/\/test\/visual$/, ""),
	},
	projects: [
		{
			name: "desktop",
			use: { viewport: { width: 1440, height: 900 } },
		},
		{
			name: "mobile",
			use: { viewport: { width: 393, height: 852 } },
		},
	],
});
