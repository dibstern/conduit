import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIST_DIR = join(import.meta.dirname, "../../dist/frontend");
const ASSETS_DIR = join(DIST_DIR, "assets");

function findManifest(): string {
	const files = readdirSync(ASSETS_DIR);
	const manifest = files.find((f) => f.endsWith(".webmanifest"));
	if (!manifest) throw new Error("No .webmanifest found in assets/");
	return join(ASSETS_DIR, manifest);
}

describe("manifest icon paths", () => {
	const manifestPath = findManifest();
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
	const icons: Array<{ src: string }> = manifest.icons;

	it("has at least one icon", () => {
		expect(icons.length).toBeGreaterThan(0);
	});

	it("icon src values do NOT start with /static/", () => {
		for (const icon of icons) {
			expect(icon.src).not.toMatch(/^\/static\//);
		}
	});

	it("icon src values are absolute paths", () => {
		for (const icon of icons) {
			expect(icon.src).toMatch(/^\//);
		}
	});

	it("each icon file exists in the build output", () => {
		for (const icon of icons) {
			// icon.src is an absolute path like /apple-touch-icon.png
			const filePath = join(DIST_DIR, icon.src);
			expect(existsSync(filePath), `Missing: ${icon.src} (${filePath})`).toBe(
				true,
			);
		}
	});
});
