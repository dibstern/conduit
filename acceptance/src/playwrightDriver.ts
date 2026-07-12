import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "@playwright/test";
import {
	compareImages,
	freezeAnimations,
	screenshotLocator,
	waitForFonts,
	waitForIcons,
} from "../../test/e2e/helpers/visual-helpers.js";
import type { VisualMode } from "./visualMode.js";

type Viewport = {
	name: string;
	width: number;
	height: number;
};

export type VisualMatchResult = {
	matches: boolean;
	diffCount: number;
	diffRatio: number;
	actualPath?: string;
	diffPath?: string;
};

const DEFAULT_VIEWPORT: Viewport = {
	name: "desktop",
	width: 1440,
	height: 900,
};

function viewportFromEnv(value = process.env["VIEWPORT"]): Viewport {
	if (!value || value === "desktop") {
		return DEFAULT_VIEWPORT;
	}

	const match = value.match(/^(\d+)x(\d+)$/);
	if (!match) {
		throw new Error(
			`Unsupported VIEWPORT: ${value}. Use desktop or <width>x<height>.`,
		);
	}

	const width = Number(match[1]);
	const height = Number(match[2]);
	if (width <= 0 || height <= 0) {
		throw new Error(`Invalid VIEWPORT dimensions: ${value}`);
	}

	return { name: value, width, height };
}

function safeArtifactName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export class PlaywrightDriver {
	readonly viewport = viewportFromEnv();
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;

	async launch(): Promise<Browser> {
		if (this.browser) {
			return this.browser;
		}

		try {
			this.browser = await chromium.launch({
				headless: process.env["ACCEPTANCE_HEADED"] !== "1",
			});
			return this.browser;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`INFRASTRUCTURE_ERROR: Chromium launch failed: ${message}`,
				{
					cause: error,
				},
			);
		}
	}

	async newExecution(): Promise<Page> {
		await this.closeExecution();
		const browser = await this.launch();
		this.context = await browser.newContext({
			viewport: {
				width: this.viewport.width,
				height: this.viewport.height,
			},
			colorScheme: "dark",
		});
		return this.context.newPage();
	}

	async closeExecution(): Promise<void> {
		const context = this.context;
		this.context = undefined;
		await context?.close();
	}

	async close(): Promise<void> {
		await this.closeExecution();
		const browser = this.browser;
		this.browser = undefined;
		await browser?.close();
	}

	async matchRegion(
		page: Page,
		regionId: string,
		baseline: string,
		threshold: number,
		mode: VisualMode,
	): Promise<VisualMatchResult> {
		if (!/^[a-z0-9-]+$/.test(regionId)) {
			throw new Error(`Unsupported visual region: ${regionId}`);
		}
		if (!/^[a-z0-9-]+$/.test(baseline)) {
			throw new Error(`Unsupported visual baseline: ${baseline}`);
		}
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
			throw new Error(
				`Visual threshold must be between 0 and 100: ${threshold}`,
			);
		}

		await waitForFonts(page);
		await waitForIcons(page);
		await freezeAnimations(page);

		const locator = page.locator(`#${regionId}`);
		await locator.waitFor({ state: "visible", timeout: 10_000 });
		const actual = await screenshotLocator(locator);
		const projectRoot = process.cwd();
		const baselineRoot = resolve(
			projectRoot,
			process.env["VISUAL_ACCEPTANCE_BASELINE_ROOT"] ??
				join("acceptance", "visual", "baselines", this.viewport.name),
		);
		const baselinePath = join(baselineRoot, `${baseline}.png`);

		await mkdir(baselineRoot, { recursive: true });
		if (mode === "capture") {
			await writeFile(baselinePath, actual);
			console.log(`CAPTURE ${baselinePath}`);
			return { matches: true, diffCount: 0, diffRatio: 0 };
		}

		let expected: Buffer;
		try {
			expected = await readFile(baselinePath);
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				throw new Error(
					`Visual baseline is missing: ${baselinePath}. Run pnpm acceptance:visual:capture first.`,
				);
			}
			throw error;
		}

		const comparison = compareImages(expected, actual);
		const similarity = (1 - comparison.diffRatio) * 100;
		const matches = !comparison.sizeMismatch && similarity >= threshold;
		if (matches) {
			console.log(
				`MATCH ${baseline}: ${similarity.toFixed(2)}% (${comparison.diffCount} pixels differ)`,
			);
			return {
				matches,
				diffCount: comparison.diffCount,
				diffRatio: comparison.diffRatio,
			};
		}

		const artifactDir = resolve(projectRoot, "acceptance/visual/artifacts");
		await mkdir(artifactDir, { recursive: true });
		const artifactName = safeArtifactName(`${regionId}-${baseline}`);
		const actualPath = join(artifactDir, `${artifactName}-actual.png`);
		const diffPath = join(artifactDir, `${artifactName}-diff.png`);
		await Promise.all([
			writeFile(actualPath, actual),
			writeFile(diffPath, comparison.diffImage),
		]);

		return {
			matches,
			diffCount: comparison.diffCount,
			diffRatio: comparison.diffRatio,
			actualPath,
			diffPath,
		};
	}
}
