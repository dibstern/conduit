// Compiled by pnpm check. Refs come from decoding or the store, not a constructor.
import { Schema } from "effect";
import {
	type AttachmentRef,
	AttachmentRefSchema,
} from "../../../src/lib/contracts/attachment-ref.js";

const plain = { attachmentHash: "a".repeat(64), mime: "image/png" } as const;
// @ts-expect-error A plain object cannot manufacture a branded ref.
const forged: AttachmentRef = plain;
void forged;

// @ts-expect-error The exported schema does not expose the brand constructor.
void AttachmentRefSchema.make;
// @ts-expect-error Nor can callers construct refs through the Effect constructor.
void AttachmentRefSchema.makeEffect;

// Stored-row schemas and decoding remain available.
const nested = Schema.Struct({ attachment: AttachmentRefSchema });
const decode: (input: unknown) => AttachmentRef =
	Schema.decodeUnknownSync(AttachmentRefSchema);
void nested;
void decode;
