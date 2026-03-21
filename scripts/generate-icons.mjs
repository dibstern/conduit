#!/usr/bin/env node

/**
 * Generate favicon and app icon PNGs from the Conduit "C vertical bars" design.
 *
 * Design: 4 horizontal bands of 10 vertical bars forming a "C" shape.
 *   - Band 0: cyan, full width  (top cap)
 *   - Band 1: cyan, short arm   (opening)
 *   - Band 2: pink, short arm   (opening)
 *   - Band 3: pink, full width  (bottom cap)
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const PINK = { r: 255, g: 45, b: 123 };
const CYAN = { r: 0, g: 229, b: 255 };
const BG_COLOR = "#18181B"; // matches connect overlay / app background

// Favicons: transparent background, tight padding (browser tabs, bookmarks)
const FAVICON_OUTPUTS = [{ name: "favicon-96x96.png", size: 96 }];

// App icons: dark background, generous padding (iOS home screen, PWA install)
const APP_ICON_OUTPUTS = [
	{ name: "apple-touch-icon.png", size: 180 },
	{ name: "web-app-manifest-192x192.png", size: 192 },
	{ name: "web-app-manifest-512x512.png", size: 512 },
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
 * @param {string|null} [opts.bg]       Background fill colour, or null for transparent
 * @param {number}      [opts.padding]  Padding fraction (0–1) of size. Default 0.08
 */
function generateSVG(size, { bg = null, padding: padFrac = 0.08 } = {}) {
	const hRows = 4;
	const fullTop = 1;
	const fullBottom = 1;
	const armWidth = 0.42;
	const vBars = 10;
	const barFill = 0.5;

	const padding = size * padFrac;
	const hGap = Math.max(0.5, size * 0.025);
	const totalHGap = hGap * (hRows - 1);
	const availH = size - padding * 2 - totalHGap;
	const bandH = availH / hRows;
	const fullW = size - padding * 2;
	const barR = Math.max(0.3, Math.min(size * 0.012, 2));
	const cyanRows = hRows / 2;

	const rects = [];

	for (let band = 0; band < hRows; band++) {
		const by = padding + band * (bandH + hGap);
		const isFull = band < fullTop || band >= hRows - fullBottom;
		const bandW = isFull ? fullW : fullW * armWidth;
		const color = band < cyanRows ? CYAN : PINK;
		const hex = `rgb(${color.r},${color.g},${color.b})`;

		const barsInBand = isFull
			? vBars
			: Math.max(2, Math.round(vBars * armWidth));
		const slotW = bandW / barsInBand;
		const bw = slotW * barFill;

		for (let i = 0; i < barsInBand; i++) {
			const bx = padding + i * slotW;
			if (bx + bw > padding + bandW + 0.5) continue;

			rects.push(
				`<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${bw.toFixed(2)}" height="${bandH.toFixed(2)}" rx="${barR.toFixed(2)}" fill="${hex}"/>`,
			);
		}
	}

	const bgRect = bg
		? `<rect width="${size}" height="${size}" fill="${bg}"/>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bgRect}${rects.join("")}</svg>`;
}

// App icons get extra padding so the C mark is smaller with a nice border
const APP_ICON_PADDING = 0.18;

async function main() {
	console.log("Generating Conduit icons...\n");

	// ── Favicons (transparent background, tight padding) ──────────────────

	const svgFavicon = generateSVG(32); // transparent, default padding
	const svgPath = join(STATIC_DIR, "favicon.svg");
	writeFileSync(svgPath, svgFavicon);
	console.log(`  ✓ favicon.svg (transparent)`);

	for (const { name, size } of FAVICON_OUTPUTS) {
		const svg = generateSVG(size); // transparent, default padding
		const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
		writeFileSync(join(STATIC_DIR, name), pngBuffer);
		console.log(`  ✓ ${name} (${size}×${size}, transparent)`);
	}

	// ICO (contains 16, 32, 48) — transparent, default padding
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

	// ── App icons (dark background, generous padding) ─────────────────────

	for (const { name, size } of APP_ICON_OUTPUTS) {
		const svg = generateSVG(size, { bg: BG_COLOR, padding: APP_ICON_PADDING });
		const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
		writeFileSync(join(STATIC_DIR, name), pngBuffer);
		console.log(`  ✓ ${name} (${size}×${size}, dark bg)`);
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
