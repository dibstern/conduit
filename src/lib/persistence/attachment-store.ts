import { createHash } from "node:crypto";
import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import {
	type AttachmentMime,
	AttachmentValidationError,
	parseAttachmentDataUrl,
} from "../attachment-data-url.js";
import {
	type AttachmentRef,
	AttachmentRefSchema,
} from "../contracts/attachment-ref.js";

export class AttachmentMissing extends Data.TaggedError("AttachmentMissing")<{
	readonly hash: string;
}> {}

export interface AttachmentStore {
	readonly put: (
		dataUrl: string,
	) => Effect.Effect<AttachmentRef, AttachmentValidationError | SqlError>;
	readonly get: (
		hash: string,
	) => Effect.Effect<
		{ bytes: Uint8Array; mime: AttachmentMime },
		AttachmentMissing | SqlError
	>;
}

const decodeRef = Schema.decodeUnknownSync(AttachmentRefSchema);

export const makeAttachmentStore = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const put = Effect.fn("AttachmentStore.put")(function* (dataUrl: string) {
		const parsed = yield* Effect.try({
			try: () => parseAttachmentDataUrl(dataUrl),
			catch: (cause) =>
				cause instanceof AttachmentValidationError
					? cause
					: new AttachmentValidationError(String(cause)),
		});
		const bytes = Buffer.from(parsed.data, "base64");
		const hash = createHash("sha256")
			.update(parsed.mime)
			.update("\0")
			.update(bytes)
			.digest("hex");
		yield* sql`INSERT OR IGNORE INTO attachment_blobs (hash, mime, size, bytes, created_at)
			VALUES (${hash}, ${parsed.mime}, ${bytes.length}, ${bytes}, ${Date.now()})`;
		return decodeRef({
			attachmentHash: hash,
			mime: parsed.mime,
			...(parsed.name !== undefined ? { name: parsed.name } : {}),
		});
	});
	const get = Effect.fn("AttachmentStore.get")(function* (hash: string) {
		const [blob] = yield* sql<{
			bytes: Uint8Array;
			mime: AttachmentMime;
		}>`SELECT bytes, mime FROM attachment_blobs WHERE hash = ${hash}`;
		if (!blob) return yield* new AttachmentMissing({ hash });
		return { bytes: Buffer.from(blob.bytes), mime: blob.mime };
	});
	return { put, get } satisfies AttachmentStore;
});

/** Only the daemon's offline storage phase calls this; building a store never does. */
export const sweepAttachments = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`DELETE FROM attachment_blobs
		WHERE NOT EXISTS (SELECT 1 FROM attachment_uses WHERE hash = attachment_blobs.hash)
		AND NOT EXISTS (SELECT 1 FROM draft_attachments WHERE state = 'live' AND hash = attachment_blobs.hash)`;
});

/** Synchronous diagnostics for replay parity, which uses a private SQLite copy. */
export function readAttachmentUses(db: {
	prepare: (sql: string) => { all: () => unknown };
}) {
	return Schema.decodeUnknownSync(
		Schema.Array(
			Schema.Struct({
				sourceTable: Schema.String,
				sourceColumn: Schema.String,
				sourceRowKey: Schema.String,
				hash: Schema.String,
			}),
		),
	)(
		db
			.prepare(`SELECT source_table AS sourceTable, source_column AS sourceColumn,
		source_row_key AS sourceRowKey, hash FROM attachment_uses
		ORDER BY source_table, source_column, source_row_key, hash`)
			.all(),
	);
}
