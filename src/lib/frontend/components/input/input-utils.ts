import {
	AttachmentValidationError,
	isAttachmentMime,
	MAX_ATTACHMENT_BASE64_BYTES,
	parseAttachmentDataUrl,
} from "../../../attachment-data-url.js";
import {
	getCurrentSessionId,
	getCurrentSlug,
} from "../../stores/router.svelte.js";
import { rpc } from "../../transport/ws-rpc-client.js";
import { formatFileSize } from "../../utils/format.js";

// Anthropic's API enforces a 5 MB limit on the base64 string (not the decoded
// bytes). A 3.75 MB raw image already exceeds this after base64 encoding.
// Phone photos routinely hit this, so we auto-resize on the client.

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
	if (b64Len <= MAX_ATTACHMENT_BASE64_BYTES) {
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
	let scale = Math.sqrt(MAX_ATTACHMENT_BASE64_BYTES / b64Len) * 0.85;
	let quality = 0.85;

	for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt++) {
		const width = Math.round(img.naturalWidth * scale);
		const height = Math.round(img.naturalHeight * scale);
		if (width < 1 || height < 1) break;

		canvas.width = width;
		canvas.height = height;
		ctx.drawImage(img, 0, 0, width, height);

		const result = canvas.toDataURL("image/jpeg", quality);
		if (base64Length(result) <= MAX_ATTACHMENT_BASE64_BYTES) {
			return { dataUrl: result, resized: true };
		}

		// Reduce aggressively for next attempt
		scale *= 0.7;
		quality = Math.max(0.4, quality - 0.1);
	}

	throw new Error("Image is too large and could not be resized below 5 MB");
}

/** Re-encode an image format the providers do not share (BMP, AVIF, SVG...) as PNG. */
async function toPngDataUrl(dataUrl: string): Promise<string> {
	const img = await loadImage(dataUrl).catch(() => {
		throw new AttachmentValidationError(
			"This image format could not be read. Choose a PNG, JPEG, GIF or WebP image.",
		);
	});
	const canvas = document.createElement("canvas");
	canvas.width = img.naturalWidth;
	canvas.height = img.naturalHeight;
	canvas.getContext("2d")?.drawImage(img, 0, 0);
	return canvas.toDataURL("image/png");
}

/** The MIME a picked file is sent as. Untyped and textual files are tried as
 *  UTF-8 text; parseAttachmentDataUrl then rejects what is not. */
function attachmentMime(file: File): string {
	const mime = file.type.toLowerCase().split(";")[0] ?? "";
	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	// Browsers type some source files as non-text (.ts as video/mp2t, .sh as application/x-sh).
	if (
		/^(txt|md|markdown|csv|json|xml|ya?ml|log|[cm]?[jt]sx?|py|rb|rs|go|java|c|h|cpp|hpp|sh|sql|css|html)$/.test(
			extension,
		)
	)
		return "text/plain";
	if (!mime || mime === "application/octet-stream") {
		if (extension === "pdf") return "application/pdf";
		if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
		if (["png", "gif", "webp"].includes(extension)) return `image/${extension}`;
		return "text/plain";
	}
	if (
		mime.startsWith("text/") ||
		[
			"application/json",
			"application/xml",
			"application/javascript",
			"application/yaml",
			"application/x-yaml",
		].includes(mime)
	)
		return "text/plain";
	return mime;
}

/** Prepare a picked file as a named data URL for the shared attachment path. */
export async function prepareFileAttachment(file: File): Promise<ResizeResult> {
	const mime = attachmentMime(file);
	if (!isAttachmentMime(mime) && !mime.startsWith("image/")) {
		throw new AttachmentValidationError(
			"Claude and OpenCode both accept plain text, PDF, PNG, JPEG, GIF and WebP.",
		);
	}
	if (file.size === 0)
		throw new AttachmentValidationError("The file is empty.");
	if (
		!mime.startsWith("image/") &&
		Math.ceil(file.size / 3) * 4 > MAX_ATTACHMENT_BASE64_BYTES
	) {
		throw new AttachmentValidationError(
			"The file is over the 5 MB attachment limit.",
		);
	}
	const original = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			typeof reader.result === "string"
				? resolve(reader.result)
				: reject(new AttachmentValidationError("Could not read the file."));
		reader.onerror = () =>
			reject(
				new AttachmentValidationError(
					"Could not read the file. Try selecting it again.",
				),
			);
		reader.onabort = () =>
			reject(new AttachmentValidationError("Reading the file was cancelled."));
		reader.readAsDataURL(file);
	});
	let dataUrl = `data:${mime};base64,${original.slice(original.indexOf(",") + 1)}`;
	if (!isAttachmentMime(mime)) dataUrl = await toPngDataUrl(dataUrl);
	const prepared = dataUrl.startsWith("data:image/")
		? await resizeImageIfNeeded(dataUrl)
		: { dataUrl, resized: false };
	// The name rides in the URL so queues, retries and Side Threads keep it.
	const named = prepared.dataUrl.replace(
		";base64,",
		`;name=${encodeURIComponent(file.name)};base64,`,
	);
	parseAttachmentDataUrl(named);
	return { ...prepared, dataUrl: named };
}

export function fetchFileContent(
	path: string,
	slug = getCurrentSlug(),
): Promise<{ content: string; binary?: boolean }> {
	if (!slug)
		return Promise.reject(new AttachmentValidationError("No project selected"));
	const sessionId = getCurrentSessionId();
	return rpc("GetFileContent", {
		...(sessionId ? { sessionId } : { projectSlug: slug }),
		path,
	}).then((response) => ({
		content: response.content,
		...(response.binary != null ? { binary: response.binary } : {}),
	}));
}

export function fetchDirectoryListing(
	path: string,
	slug = getCurrentSlug(),
): Promise<string> {
	const requestPath = path.replace(/\/$/, "");
	if (!slug)
		return Promise.reject(new AttachmentValidationError("No project selected"));
	const sessionId = getCurrentSessionId();
	return rpc("GetFileList", {
		...(sessionId ? { sessionId } : { projectSlug: slug }),
		path: requestPath,
	}).then((response) =>
		response.entries
			.map((e) =>
				e.type === "directory"
					? `${e.name}/ (directory)`
					: `${e.name} (${formatFileSize(e.size ?? 0)}, file)`,
			)
			.join("\n"),
	);
}
