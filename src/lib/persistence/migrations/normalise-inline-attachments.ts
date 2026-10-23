import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import {
	AttachmentValidationError,
	parseAttachmentDataUrl,
} from "../../attachment-data-url.js";
import {
	type AttachmentRef,
	AttachmentRefSchema,
	AttachmentSourceSchema,
} from "../../contracts/attachment-ref.js";
import type { AttachmentStore } from "../attachment-store.js";

const columns = [
	["events", "data"],
	["messages", "rest_payload"],
	["message_parts", "metadata"],
	["message_parts", "rest_payload"],
	["pending_inputs", "request"],
	["pending_inputs", "images"],
	["provider_command_outbox", "payload_json"],
] as const;

export interface AttachmentNormalisationSummary {
	readonly rowsChanged: Readonly<Record<string, number>>;
	/** Unparseable/undecodable column values, including invalid attachments. */
	readonly rowsSkipped: number;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AttachmentValidationError(
			"Expected an attachment payload object",
		);
	return value as Record<string, unknown>;
}

/** Only attachment fields are visited; tool output and ordinary text stay opaque. */
function rewrite(
	value: unknown,
	table: (typeof columns)[number][0],
	column: string,
	type: string,
	status: string,
	resolve: (dataUrl: string) => unknown,
): unknown {
	const images = (value: unknown) => {
		if (!Array.isArray(value))
			throw new AttachmentValidationError("Expected images array");
		return value.map((image: unknown) => {
			if (typeof image === "string") return resolve(image);
			if (Schema.is(AttachmentRefSchema)(image)) return image;
			throw new AttachmentValidationError(
				"Invalid stored attachment reference",
			);
		});
	};
	const request = (value: unknown) => {
		const payload = record(value);
		return "images" in payload
			? { ...payload, images: images(payload["images"]) }
			: payload;
	};
	const file = (value: unknown) => {
		const payload = record(value);
		const source = payload["source"];
		if (Schema.is(AttachmentSourceSchema)(source)) {
			const { url: _url, ...rest } = payload;
			return rest;
		}
		const url = source === undefined ? payload["url"] : record(source)["url"];
		if (typeof url !== "string")
			throw new AttachmentValidationError("Invalid stored file source");
		const { url: _url, ...rest } = payload;
		return { ...rest, source: /^\s*data:/i.test(url) ? resolve(url) : { url } };
	};
	const message = (value: unknown) => {
		const payload = record(value);
		if (!("parts" in payload)) return payload;
		if (!Array.isArray(payload["parts"]))
			throw new AttachmentValidationError("Expected message parts array");
		return {
			...payload,
			parts: payload["parts"].map((part: unknown) =>
				record(part)["type"] === "file" ? file(part) : part,
			),
		};
	};
	if (table === "pending_inputs")
		return column === "images" ? images(value) : request(value);
	if (table === "provider_command_outbox") {
		const payload = record(value);
		if (["completed", "failed", "cancelled"].includes(status)) {
			const { images: _images, ...rest } = payload;
			return rest;
		}
		return request(payload);
	}
	if (table === "messages") return message(value);
	if (table === "message_parts") return type === "file" ? file(value) : value;
	if (type === "file.attached") return file(value);
	const payload = record(value);
	if (type === "message.snapshot")
		return { ...payload, message: message(payload["message"]) };
	if (type.startsWith("input.") && "request" in payload)
		return { ...payload, request: request(payload["request"]) };
	return value;
}

/**
 * Data migration only: run on a private copy or an offline store, after schema
 * migrations and before projection recovery. The store may target a different
 * database, as it does when importing into an existing daemon store.
 * A skipped count is per column value, so sibling columns can still migrate.
 */
export const normaliseInlineAttachments = Effect.fn(
	"normaliseInlineAttachments",
)(function* (
	sql: SqlClient.SqlClient,
	attachments: AttachmentStore,
): Effect.fn.Return<
	AttachmentNormalisationSummary,
	AttachmentValidationError | SqlError
> {
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			const rowsChanged: Record<string, number> = {
				"events.data": 0,
				"messages.rest_payload": 0,
				"message_parts.metadata": 0,
				"message_parts.rest_payload": 0,
				"pending_inputs.request": 0,
				"pending_inputs.images": 0,
				"provider_command_outbox.payload_json": 0,
			};
			let rowsSkipped = 0;
			for (const [table, column] of columns) {
				let after: number | undefined;
				while (true) {
					const batch = yield* sql<{
						row_key: number;
						payload: string;
						type: string;
						status: string;
					}>`
						SELECT rowid AS row_key, ${sql(column)} AS payload,
						${table === "events" || table === "message_parts" ? sql("type") : sql.literal("''")} AS type,
						${table === "provider_command_outbox" ? sql("status") : sql.literal("''")} AS status
						FROM ${sql(table)} WHERE ${after === undefined ? sql.literal("1") : sql`rowid > ${after}`}
						AND ${sql(column)} IS NOT NULL ORDER BY rowid LIMIT 100`;
					if (batch.length === 0) break;
					for (const row of batch) {
						after = row.row_key;
						// Validate the entire value before put, including when blobs live in
						// another database and cannot share this transaction's rollback.
						const prepared = yield* Effect.try({
							try: () => {
								const value: unknown = JSON.parse(row.payload);
								const urls = new Set<string>();
								rewrite(value, table, column, row.type, row.status, (url) => {
									parseAttachmentDataUrl(url);
									urls.add(url);
									return url;
								});
								return { value, urls };
							},
							catch: (cause) => new AttachmentValidationError(String(cause)),
						}).pipe(Effect.result);
						if (prepared._tag === "Failure") {
							rowsSkipped++;
							continue;
						}
						const { value, urls } = prepared.success;
						const refs = new Map<string, AttachmentRef>();
						for (const url of urls) refs.set(url, yield* attachments.put(url));
						const next = JSON.stringify(
							rewrite(value, table, column, row.type, row.status, (url) =>
								refs.get(url),
							),
						);
						if (next === JSON.stringify(value)) continue;
						yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${next} WHERE rowid = ${row.row_key}`;
						const qualified = `${table}.${column}`;
						rowsChanged[qualified] = (rowsChanged[qualified] ?? 0) + 1;
					}
				}
			}
			return { rowsChanged, rowsSkipped };
		}),
	);
});
