// ─── Scene Runner ─────────────────────────────────────────────────────────────
// Playwright lifecycle, phase execution, assertions, debug collection,
// video capture, and screenshot helpers for media generation.

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
	chromium,
	type Page,
} from "@playwright/test";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const MEDIA_DIR = path.join(PROJECT_ROOT, "media");
const DEBUG_DIR = path.join(MEDIA_DIR, "_debug");
const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SceneConfig {
	name: string;
	/** Output filename (e.g., "GENERATE-MAIN-UI.png") */
	outputFile: string;
	/** Viewport width and height */
	viewport: { width: number; height: number };
	/** Whether this is a GIF (uses video recording) */
	animated: boolean;
	/** Mobile emulation */
	isMobile?: boolean;
	hasTouch?: boolean;
	/** Device scale factor (default: 2 for retina) */
	deviceScaleFactor?: number;
}

export interface SceneContext {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	config: SceneConfig;
	previewUrl: string;
	mediaDir: string;
	projectRoot: string;
	/** Log a named phase with timing. Use for actions (navigate, click, etc.) */
	phase: (name: string, fn: () => Promise<void>) => Promise<void>;
	/** Assert a DOM condition. Fails the scene with a descriptive message if not met. */
	assert: (name: string, fn: () => Promise<void>) => Promise<void>;
	/** Intentional hold for GIF pacing — only use in animated scenes. */
	hold: (ms: number, label?: string) => Promise<void>;
}

type SceneFn = (ctx: SceneContext) => Promise<void>;

export interface SceneDefinition {
	config: SceneConfig;
	run: SceneFn;
}

// ─── Build & Preview ────────────────────────────────────────────────────────

/** Build the frontend (vite build). */
export function buildFrontend(): void {
	console.log("  Building frontend...");
	execSync("pnpm build:frontend", { cwd: PROJECT_ROOT, stdio: "pipe" });
}

/** Start vite preview and wait for it to be ready. */
export async function startPreview(): Promise<ChildProcess> {
	console.log("  Starting preview server...");
	const proc = spawn(
		"npx",
		["vite", "preview", "--port", String(PREVIEW_PORT), "--strictPort"],
		{
			cwd: PROJECT_ROOT,
			stdio: "pipe",
			env: { ...process.env },
		},
	);

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Preview server timeout")),
			15_000,
		);
		proc.stdout?.on("data", (data: Buffer) => {
			if (data.toString().includes(String(PREVIEW_PORT))) {
				clearTimeout(timeout);
				resolve();
			}
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
	});

	return proc;
}

// ─── Scene Execution ────────────────────────────────────────────────────────

/** Run all scenes sequentially with phase logging and debug collection. */
export async function runScenes(scenes: SceneDefinition[]): Promise<void> {
	mkdirSync(MEDIA_DIR, { recursive: true });
	mkdirSync(DEBUG_DIR, { recursive: true });

	const browser = await chromium.launch();
	let failCount = 0;

	for (const scene of scenes) {
		console.log(`\n  Generating ${scene.config.outputFile}...`);
		const { config } = scene;

		const contextOptions: BrowserContextOptions = {
			viewport: config.viewport,
			deviceScaleFactor: config.deviceScaleFactor ?? 2,
			isMobile: config.isMobile ?? false,
			hasTouch: config.hasTouch ?? false,
			colorScheme: "dark",
			...(config.animated && {
				recordVideo: {
					dir: path.join(MEDIA_DIR, "_video_tmp"),
					size: config.viewport,
				},
			}),
		};

		const context = await browser.newContext(contextOptions);
		const page = await context.newPage();

		// ── Debug collection ──────────────────────────────────────────────
		const consoleLogs: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error" || msg.type() === "warning") {
				consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
			}
		});
		page.on("pageerror", (err) => {
			consoleLogs.push(`[pageerror] ${err.message}`);
		});

		// ── Phase runner ──────────────────────────────────────────────────
		const phase = async (
			name: string,
			fn: () => Promise<void>,
		): Promise<void> => {
			const start = Date.now();
			try {
				await fn();
				console.log(`    [${name}] done (${Date.now() - start}ms)`);
			} catch (err) {
				console.error(`    [${name}] FAILED after ${Date.now() - start}ms`);
				throw err;
			}
		};

		const assert = async (
			name: string,
			fn: () => Promise<void>,
		): Promise<void> => {
			const start = Date.now();
			try {
				await fn();
				console.log(`    [assert: ${name}] passed (${Date.now() - start}ms)`);
			} catch (err) {
				const elapsed = Date.now() - start;
				console.error(`    [assert: ${name}] FAILED after ${elapsed}ms`);
				console.error(`      ${err instanceof Error ? err.message : err}`);
				throw new Error(
					`Assertion "${name}" failed: ${err instanceof Error ? err.message : err}`,
				);
			}
		};

		const hold = async (ms: number, label?: string): Promise<void> => {
			if (label) console.log(`    [hold: ${label}] ${ms}ms`);
			await page.waitForTimeout(ms);
		};

		const ctx: SceneContext = {
			browser,
			context,
			page,
			config,
			previewUrl: PREVIEW_URL,
			mediaDir: MEDIA_DIR,
			projectRoot: PROJECT_ROOT,
			phase,
			assert,
			hold,
		};

		try {
			await scene.run(ctx);

			if (config.animated) {
				const video = page.video();
				if (!video) throw new Error("No video recorded");
				// Save video to a known path before closing (ensures proper finalization)
				const videoPath = path.join(
					MEDIA_DIR,
					"_video_tmp",
					`${config.name}.webm`,
				);
				mkdirSync(path.dirname(videoPath), { recursive: true });
				await page.close();
				await video.saveAs(videoPath);
				const outputPath = path.join(MEDIA_DIR, config.outputFile);
				await phase("convert-gif", () =>
					convertToGif(videoPath, outputPath, config.viewport),
				);
				console.log(`    ✓ ${config.outputFile}`);
			} else {
				const outputPath = path.join(MEDIA_DIR, config.outputFile);
				await page.screenshot({ path: outputPath, type: "png" });
				await page.close();
				console.log(`    ✓ ${config.outputFile}`);
			}
		} catch (err) {
			failCount++;
			console.error(
				`    ✗ ${config.outputFile}: ${err instanceof Error ? err.message : err}`,
			);

			// Save debug screenshot
			try {
				const debugPath = path.join(DEBUG_DIR, `${config.name}-failure.png`);
				await page.screenshot({ path: debugPath, type: "png" });
				console.error(`    Debug screenshot: ${debugPath}`);
			} catch {
				/* page may already be closed */
			}

			// Dump console errors
			if (consoleLogs.length > 0) {
				console.error("    Browser console:");
				for (const log of consoleLogs.slice(-20)) {
					console.error(`      ${log}`);
				}
				// Also write full log to file
				const logPath = path.join(DEBUG_DIR, `${config.name}-console.log`);
				writeFileSync(logPath, consoleLogs.join("\n"));
			}

			await page.close().catch(() => {});
		}

		await context.close();
	}

	await browser.close();

	if (failCount > 0) {
		console.error(
			`\n  ${failCount} scene(s) failed. Debug artifacts in: ${DEBUG_DIR}`,
		);
		process.exitCode = 1;
	}
}

// ─── GIF Conversion ─────────────────────────────────────────────────────────

/** Convert WebM video to GIF using ffmpeg. Throws with stderr on failure. */
async function convertToGif(
	inputPath: string,
	outputPath: string,
	size: { width: number; height: number },
): Promise<void> {
	const palettePath = inputPath.replace(".webm", "-palette.png");
	const fps = 15;
	const filters = `fps=${fps},scale=${size.width}:-1:flags=lanczos`;

	try {
		execSync(
			`ffmpeg -y -i "${inputPath}" -vf "${filters},palettegen=stats_mode=diff" "${palettePath}"`,
			{ stdio: "pipe" },
		);
		execSync(
			`ffmpeg -y -i "${inputPath}" -i "${palettePath}" -lavfi "${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "${outputPath}"`,
			{ stdio: "pipe" },
		);
	} catch (err: unknown) {
		// Extract stderr from ExecSyncError for diagnosability
		const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
		throw new Error(`ffmpeg failed: ${stderr.slice(-500)}`);
	}

	// Cleanup temp files
	try {
		unlinkSync(palettePath);
	} catch {}
	try {
		unlinkSync(inputPath);
	} catch {}
}

export { PREVIEW_URL, MEDIA_DIR, DEBUG_DIR, PROJECT_ROOT };
