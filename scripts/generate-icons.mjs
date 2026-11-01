#!/usr/bin/env node

/**
 * Generate favicon and app icon PNGs from the Conduit brand mark: a white hook
 * on the indigo tile, drawn with ConduitMark.svelte's brand geometry.
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const BRAND = "#4352d2"; // --color-brand in style.css
const HOOK = "M2 4h5a2 2 0 0 1 0 4H5"; // ConduitMark's 12-unit hook

// The rounded tile on transparent: browser tabs, bookmarks, and manifest "any"
// icons, which desktop installs show as drawn.
const ROUNDED_OUTPUTS = [
	{ name: "favicon-96x96.png", size: 96 },
	{ name: "web-app-manifest-192x192.png", size: 192 },
	{ name: "web-app-manifest-512x512.png", size: 512 },
];

// Full-bleed tile for iOS and manifest "maskable" icons: the OS cuts its own
// corners, and iOS fills transparent ones with black.
const FULL_BLEED_OUTPUTS = [
	{ name: "apple-touch-icon.png", size: 180 },
	{ name: "web-app-manifest-maskable-512x512.png", size: 512 },
];

const STATIC_DIR = join(
	import.meta.dirname,
	"..",
	"src",
	"lib",
	"frontend",
	"static",
);

/**
 * @param {number} size  Canvas width/height in px
 * @param {object} [opts]
 * @param {boolean} [opts.fullBleed]  Square tile with no rounded corners
 */
function generateSVG(size, { fullBleed = false } = {}) {
	// The hook sits in the centred 60% of the tile, as in the app.
	const scale = (size * 0.6) / 12;
	const inset = size * 0.2;
	const radius = fullBleed ? 0 : size * 0.27;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${BRAND}"/><path d="${HOOK}" transform="translate(${inset} ${inset}) scale(${scale})" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`;
}

async function main() {
	console.log("Generating Conduit icons...\n");

	// Favicons

	const svgFavicon = generateSVG(32);
	const svgPath = join(STATIC_DIR, "favicon.svg");
	writeFileSync(svgPath, svgFavicon);
	console.log(`  ✓ favicon.svg (transparent)`);

	for (const { name, size } of ROUNDED_OUTPUTS) {
		const svg = generateSVG(size);
		const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
		writeFileSync(join(STATIC_DIR, name), pngBuffer);
		console.log(`  ✓ ${name} (${size}×${size}, transparent)`);
	}

	// ICO (contains 16, 32, 48)
	const icoSizes = [16, 32, 48];
	const pngBuffers = [];
	for (const s of icoSizes) {
		const svg = generateSVG(s);
		const png = await sharp(Buffer.from(svg)).png().toBuffer();
		pngBuffers.push(png);
	}
	const icoBuffer = createICO(pngBuffers, icoSizes);
	writeFileSync(join(STATIC_DIR, "favicon.ico"), icoBuffer);
	console.log(`  ✓ favicon.ico (${icoSizes.join(", ")}px, transparent)`);

	// Full-bleed icons

	for (const { name, size } of FULL_BLEED_OUTPUTS) {
		const svg = generateSVG(size, { fullBleed: true });
		const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
		writeFileSync(join(STATIC_DIR, name), pngBuffer);
		console.log(`  ✓ ${name} (${size}×${size}, full bleed)`);
	}

	console.log("\nDone! All icons written to src/lib/frontend/static/");
}

/**
 * Create a minimal ICO file from PNG buffers.
 * ICO format: 6-byte header + 16-byte entry per image + raw PNG data.
 */
function createICO(pngBuffers, sizes) {
	const numImages = pngBuffers.length;
	const headerSize = 6;
	const entrySize = 16;
	const dataOffset = headerSize + entrySize * numImages;

	let totalSize = dataOffset;
	for (const buf of pngBuffers) totalSize += buf.length;

	const ico = Buffer.alloc(totalSize);

	// ICO header
	ico.writeUInt16LE(0, 0); // reserved
	ico.writeUInt16LE(1, 2); // type: 1 = ICO
	ico.writeUInt16LE(numImages, 4); // count

	let offset = dataOffset;
	for (let i = 0; i < numImages; i++) {
		const entryOffset = headerSize + i * entrySize;
		const s = sizes[i] >= 256 ? 0 : sizes[i];

		ico.writeUInt8(s, entryOffset); // width
		ico.writeUInt8(s, entryOffset + 1); // height
		ico.writeUInt8(0, entryOffset + 2); // color palette
		ico.writeUInt8(0, entryOffset + 3); // reserved
		ico.writeUInt16LE(1, entryOffset + 4); // color planes
		ico.writeUInt16LE(32, entryOffset + 6); // bits per pixel
		ico.writeUInt32LE(pngBuffers[i].length, entryOffset + 8); // size
		ico.writeUInt32LE(offset, entryOffset + 12); // offset

		pngBuffers[i].copy(ico, offset);
		offset += pngBuffers[i].length;
	}

	return ico;
}

main().catch((err) => {
	console.error("Error generating icons:", err);
	process.exit(1);
});
