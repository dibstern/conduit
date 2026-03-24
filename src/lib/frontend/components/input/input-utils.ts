import { wsSend } from "../../stores/ws.svelte.js";
import { onFileBrowser } from "../../stores/ws-listeners.js";
import { formatFileSize } from "../../utils/format.js";

// ─── Image resize ───────────────────────────────────────────────────────────
// Anthropic's API enforces a 5 MB limit on the base64 string (not the decoded
// bytes). A 3.75 MB raw image already exceeds this after base64 encoding.
// Phone photos routinely hit this, so we auto-resize on the client.

/** 5 MiB — Anthropic API hard limit on the base64 string length. */
const MAX_BASE64_BYTES = 5 * 1024 * 1024;

/** Maximum resize attempts before giving up. */
const MAX_RESIZE_ATTEMPTS = 6;

/** Get the byte length of the base64 payload inside a data-URL. */
function base64Length(dataUrl: string): number {
	const base64 = dataUrl.split(",")[1];
	return base64?.length ?? 0;
}

/** Load an Image element from a data-URL. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Failed to load image for resizing"));
		img.src = dataUrl;
	});
}

export interface ResizeResult {
	dataUrl: string;
	/** True when the image was downscaled to fit under the API limit. */
	resized: boolean;
}

/** Extract the MIME type from a data-URL (e.g. "data:image/gif;base64,..." → "image/gif"). */
function dataUrlMime(dataUrl: string): string {
	const match = dataUrl.match(/^data:([^;,]+)/);
	return match?.[1] ?? "application/octet-stream";
}

/** Formats that canvas cannot re-encode or that would lose critical content (animation). */
const NON_RESIZABLE_MIMES = new Set(["image/gif"]);

/**
 * If the decoded image exceeds MAX_IMAGE_BYTES, progressively downscale via
 * a canvas until it fits.  Returns the (possibly unchanged) data-URL and a
 * flag indicating whether a resize occurred.
 *
 * GIFs are not resizable (canvas would flatten animation to a single frame),
 * so oversized GIFs are rejected outright.
 *
 * @throws {Error} if the image cannot be shrunk below the limit.
 */
export async function resizeImageIfNeeded(
	dataUrl: string,
): Promise<ResizeResult> {
	const b64Len = base64Length(dataUrl);
	if (b64Len <= MAX_BASE64_BYTES) {
		return { dataUrl, resized: false };
	}

	const mime = dataUrlMime(dataUrl);
	if (NON_RESIZABLE_MIMES.has(mime)) {
		throw new Error(
			`GIF exceeds the 5 MB encoded size limit (~3.75 MB on disk) and cannot be automatically resized. Use a smaller GIF.`,
		);
	}

	const img = await loadImage(dataUrl);

	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2D context unavailable");

	// Start with a scale estimated from the ratio, then shrink further
	// on each iteration if needed.
	let scale = Math.sqrt(MAX_BASE64_BYTES / b64Len) * 0.85;
	let quality = 0.85;

	for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt++) {
		const w = Math.round(img.naturalWidth * scale);
		const h = Math.round(img.naturalHeight * scale);
		if (w < 1 || h < 1) break;

		canvas.width = w;
		canvas.height = h;
		ctx.drawImage(img, 0, 0, w, h);

		const result = canvas.toDataURL("image/jpeg", quality);
		if (base64Length(result) <= MAX_BASE64_BYTES) {
			return { dataUrl: result, resized: true };
		}

		// Reduce aggressively for next attempt
		scale *= 0.7;
		quality = Math.max(0.4, quality - 0.1);
	}

	throw new Error("Image is too large and could not be resized below 5 MB");
}

export function fetchFileContent(
	path: string,
): Promise<{ content: string; binary?: boolean }> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

		const unsub = onFileBrowser((msg) => {
			if (
				msg.type === "file_content" &&
				(msg as { path: string }).path === path
			) {
				clearTimeout(timeout);
				unsub();
				const result: { content: string; binary?: boolean } = {
					content: (msg as { content: string }).content,
				};
				const binaryVal = (msg as { binary?: boolean }).binary;
				if (binaryVal !== undefined) {
					result.binary = binaryVal;
				}
				resolve(result);
			}
		});

		wsSend({ type: "get_file_content", path });
	});
}

export function fetchDirectoryListing(path: string): Promise<string> {
	const requestPath = path.replace(/\/$/, "");
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("timeout")), 5000);

		const unsub = onFileBrowser((msg) => {
			if (
				msg.type === "file_list" &&
				(msg as { path: string }).path === requestPath
			) {
				clearTimeout(timeout);
				unsub();
				const entries = (
					msg as {
						entries: Array<{ name: string; type: string; size?: number }>;
					}
				).entries;
				const listing = entries
					.map((e) =>
						e.type === "directory"
							? `${e.name}/ (directory)`
							: `${e.name} (${formatFileSize(e.size ?? 0)}, file)`,
					)
					.join("\n");
				resolve(listing);
			}
		});

		wsSend({ type: "get_file_list", path: requestPath });
	});
}
