import { Schema } from "effect";
import type { AttachmentMime } from "../attachment-data-url.js";

const attachmentRef = Schema.Struct({
	attachmentHash: Schema.String.pipe(
		Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
	),
	mime: Schema.Literals([
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
		"text/plain",
	]),
	name: Schema.optional(Schema.String),
}).pipe(Schema.brand("AttachmentRef"));

export type AttachmentRef = typeof attachmentRef.Type;

// Expose decoding/encoding, without the branded constructor's make API.
export const AttachmentRefSchema: Schema.ConstraintCodec<
	AttachmentRef,
	{
		readonly attachmentHash: string;
		readonly mime: AttachmentMime;
		readonly name?: string | undefined;
	}
> = attachmentRef;
