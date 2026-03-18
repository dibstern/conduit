// ─── Visual Testing Helpers ──────────────────────────────────────────────────
// Utilities for visual comparison tests: freeze animations, take region
// screenshots, and compare images with pixelmatch.

import type { Locator, Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Inject CSS to freeze all animations and transitions.
 * Call this after page load but before taking screenshots.
 */
export async function freezeAnimations(page: Page): Promise<void> {
	await page.addStyleTag({
		content: `
      *, *::before, *::after {
        animation-delay: -0.0001s !important;
        animation-duration: 0s !important;
        animation-play-state: paused !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
	});
	// Wait a frame for the style to apply
	await page.waitForTimeout(50);
}

/**
 * Wait for fonts to load (prevents layout shifts in screenshots).
 */
export async function waitForFonts(page: Page): Promise<void> {
	await page.evaluate(() => document.fonts.ready);
}

/**
 * Wait for Lucide icons to render (they load async).
 */
export async function waitForIcons(page: Page): Promise<void> {
	// Lucide replaces <i data-lucide="..."> with <svg> elements
	// Wait until no unprocessed icon placeholders remain
	await page
		.waitForFunction(
			() => document.querySelectorAll("i[data-lucide]").length === 0,
			{ timeout: 5000 },
		)
		.catch(() => {
			// Icons may not be present; that's fine
		});
}

/**
 * Take a screenshot of a specific region identified by selector.
 * Returns a PNG buffer.
 */
export async function screenshotRegion(
	page: Page,
	selector: string,
): Promise<Buffer> {
	const element = page.locator(selector);
	return (await element.screenshot()) as Buffer;
}

/**
 * Take a screenshot of a Playwright Locator.
 */
export async function screenshotLocator(locator: Locator): Promise<Buffer> {
	return (await locator.screenshot()) as Buffer;
}

/**
 * Compare two PNG image buffers using pixelmatch.
 * Returns { diffCount, diffRatio, diffImage }.
 */
export function compareImages(
	imageA: Buffer,
	imageB: Buffer,
	options?: { threshold?: number },
): ComparisonResult {
	const pngA = PNG.sync.read(imageA);
	const pngB = PNG.sync.read(imageB);

	// Use the smaller dimensions for comparison
	const width = Math.min(pngA.width, pngB.width);
	const height = Math.min(pngA.height, pngB.height);

	// Resize both to the common dimensions (crop to fit)
	const dataA = cropImageData(pngA, width, height);
	const dataB = cropImageData(pngB, width, height);

	const diffPng = new PNG({ width, height });

	const diffCount = pixelmatch(dataA, dataB, diffPng.data, width, height, {
		threshold: options?.threshold ?? 0.1,
		includeAA: false,
	});

	const totalPixels = width * height;

	return {
		diffCount,
		diffRatio: totalPixels > 0 ? diffCount / totalPixels : 0,
		diffImage: PNG.sync.write(diffPng),
		width,
		height,
		sizeMismatch: pngA.width !== pngB.width || pngA.height !== pngB.height,
	};
}

export interface ComparisonResult {
	/** Number of differing pixels */
	diffCount: number;
	/** Ratio of differing pixels (0-1) */
	diffRatio: number;
	/** PNG buffer of the diff image */
	diffImage: Buffer;
	/** Comparison width */
	width: number;
	/** Comparison height */
	height: number;
	/** Whether the images had different dimensions */
	sizeMismatch: boolean;
}

/** Crop PNG data to a specific width × height (top-left origin) */
function cropImageData(
	png: PNG,
	targetWidth: number,
	targetHeight: number,
): Buffer {
	if (png.width === targetWidth && png.height === targetHeight) {
		return png.data as unknown as Buffer;
	}

	const cropped = Buffer.alloc(targetWidth * targetHeight * 4);
	for (let y = 0; y < targetHeight; y++) {
		const srcOffset = y * png.width * 4;
		const dstOffset = y * targetWidth * 4;
		png.data.copy(cropped, dstOffset, srcOffset, srcOffset + targetWidth * 4);
	}
	return cropped;
}
