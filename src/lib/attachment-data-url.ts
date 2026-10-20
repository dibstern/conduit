export type AttachmentMime =
	| "image/png"
	| "image/jpeg"
	| "image/gif"
	| "image/webp"
	| "text/plain"
	| "application/pdf";

/** Shared per-attachment limit on the encoded payload, excluding the URL header. */
export const MAX_ATTACHMENT_BASE64_BYTES = 5 * 1024 * 1024;

export class AttachmentValidationError extends Error {
	override readonly name = "AttachmentValidationError";
}

/** Decoded size of a base64 payload, without decoding it. */
export function base64ByteLength(data: string): number {
	return (
		Math.floor((data.length * 3) / 4) -
		(data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
	);
}

export function isAttachmentMime(mime: string): mime is AttachmentMime {
	return [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"text/plain",
		"application/pdf",
	].includes(mime);
}

/** The existing `images` wire field carries attachments as base64 data URLs.
 * A MIME name parameter preserves filenames through persistence and queue edits.
 */
export function parseAttachmentDataUrl(value: string): {
	mime: AttachmentMime;
	data: string;
	size: number;
	name?: string;
} {
	const match =
		/^data:([^;,]+)(?:;name=([^;,]*))?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
			value,
		);
	const mime = match?.[1];
	const data = match?.[3];
	if (!mime || data === undefined || !isAttachmentMime(mime)) {
		throw new AttachmentValidationError(
			"Claude and OpenCode both accept plain text, PDF, PNG, JPEG, GIF and WebP.",
		);
	}
	if (data.length > MAX_ATTACHMENT_BASE64_BYTES) {
		throw new AttachmentValidationError(
			"The file is over the 5 MB attachment limit.",
		);
	}
	if (data.length === 0) {
		throw new AttachmentValidationError("The attachment is empty.");
	}
	let decoded: string;
	try {
		decoded = atob(data);
	} catch {
		throw new AttachmentValidationError(
			"The attachment has invalid base64 data.",
		);
	}
	if (mime === "text/plain") {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(
				Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
			);
		} catch {
			throw new AttachmentValidationError(
				"Plain text files must use UTF-8 encoding.",
			);
		}
		if (text.includes("\0")) {
			throw new AttachmentValidationError(
				"The file contains binary data. Choose a UTF-8 plain text file.",
			);
		}
	}
	if (mime === "application/pdf" && !decoded.startsWith("%PDF-")) {
		throw new AttachmentValidationError("The file is not a valid PDF.");
	}
	let name: string | undefined;
	try {
		name = match?.[2] === undefined ? undefined : decodeURIComponent(match[2]);
	} catch {
		throw new AttachmentValidationError("The attachment filename is invalid.");
	}
	return {
		mime,
		data,
		size: decoded.length,
		...(name !== undefined ? { name } : {}),
	};
}

export function validateAttachmentDataUrls(
	values: readonly string[] = [],
): void {
	for (const value of values) parseAttachmentDataUrl(value);
}
