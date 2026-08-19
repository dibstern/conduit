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
 * Overridable so two worktrees can run this suite at once. With a fixed port the
 * second run either dies on a busy port or — before `reuseExistingServer: false`
 * below — silently tested the first worktree's build. Snapshots do not depend on
 * the port, so this is safe to vary per checkout.
 */
const PORT = Number(process.env["STORYBOOK_PORT"] ?? 6007);

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
		baseURL: `http://localhost:${PORT}`,
		colorScheme: "dark",
		launchOptions: { args: DETERMINISTIC_RASTER_ARGS },
	},
	webServer: {
		// `npx --no-install`, NOT `pnpm exec`. The Linux baselines are captured by
		// running this same config inside mcr.microsoft.com/playwright:*-noble
		// (scripts/update-visual-snapshots.sh), and that image ships node and npx
		// but NO pnpm — verified 2026-08-06: `pnpm --version` => command not found.
		// With `pnpm exec` here, Playwright cannot start the static server inside
		// the container, so the run dies before capturing a single snapshot. That
		// is the mechanism behind 366 of the 726 linux goldens never having existed
		// (conduit-test-de3.10); the script was not merely unrun, it could not work.
		// `npx --no-install http-server` resolves from the mounted node_modules
		// both on the host (v14.1.1) and in the container. `--no-install` so a
		// missing dependency fails loudly rather than being fetched from the
		// network in the middle of a capture run.
		command: `npx --no-install http-server dist/storybook -p ${PORT} -s`,
		port: PORT,
		// NEVER reuse. Measured 2026-08-20 (conduit-test-de3.32): a stale
		// `python3 -m http.server 6007` rooted in *conduit-wt-de32*'s dist/storybook
		// was still listening, and `reuseExistingServer: !CI` silently attached to
		// it — so a full 451-test run in conduit-wt-harness, including a deliberate
		// sentinel that broke a component, passed green against another worktree's
		// build. This repo routinely has 5+ worktrees open, so that is the normal
		// case, not a freak one.
		//
		// The failure is invisible by construction: every assertion still runs,
		// every one passes, and the suite reports on a build nobody asked about.
		// Reuse trades a few seconds of startup for the possibility that every
		// green run in the repo means nothing. If the port is busy Playwright now
		// fails loudly with "port 6007 is used", which is the correct outcome —
		// stop the stale server and re-run.
		reuseExistingServer: false,
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
