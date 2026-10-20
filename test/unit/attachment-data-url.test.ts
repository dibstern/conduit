import { describe, expect, it } from "vitest";
import {
	AttachmentValidationError,
	parseAttachmentDataUrl,
} from "../../src/lib/attachment-data-url.js";

// Admission failure modes: oversized payloads bypass the composer, unsupported
// MIME types reach a provider, malformed bytes/names throw opaque errors, and
// binary or invalid UTF-8 is presented as a text document.
describe("attachment admission data", () => {
	const limit = 5 * 1024 * 1024;

	it("accepts the encoded size boundary and rejects the next base64 group", () => {
		expect(
			parseAttachmentDataUrl(`data:image/png;base64,${"A".repeat(limit)}`).data
				.length,
		).toBe(limit);
		expect(() =>
			parseAttachmentDataUrl(`data:image/png;base64,${"A".repeat(limit + 4)}`),
		).toThrow(/5 MB attachment limit/);
	});

	it.each([
		["data:application/zip;base64,YQ==", /both accept/],
		["data:text/plain;base64,", /empty/],
		["data:text/plain;base64,a", /base64/],
		["data:text/plain;base64,====", /both accept|base64/],
		["data:text/plain;name=%ZZ;base64,YQ==", /filename/],
		["data:text/plain;base64,/w==", /UTF-8/],
		["data:text/plain;base64,YQBi", /binary data/],
		["data:application/pdf;base64,YQ==", /valid PDF/],
	])("rejects invalid attachment %s", (url, error) => {
		expect(() => parseAttachmentDataUrl(url)).toThrow(
			AttachmentValidationError,
		);
		expect(() => parseAttachmentDataUrl(url)).toThrow(error);
	});

	it("preserves named UTF-8 text and PDF bytes", () => {
		for (const [mime, name, text] of [
			["text/plain", "source file.ts", "const message = 'café';\n"],
			["application/pdf", "brief.pdf", "%PDF-1.7\nfixture\n%%EOF\n"],
		]) {
			const data = Buffer.from(text ?? "").toString("base64");
			expect(
				parseAttachmentDataUrl(
					`data:${mime};name=${encodeURIComponent(name ?? "")};base64,${data}`,
				),
			).toEqual({ mime, name, data, size: Buffer.byteLength(text ?? "") });
		}
	});
});
