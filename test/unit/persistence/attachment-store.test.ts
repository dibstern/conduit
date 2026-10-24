/*
 * Failure modes, recorded before tests or implementation (conduit-test-mryl.1):
 * - Same MIME and bytes deduplicate; different MIME separates identical bytes.
 * - Every indexed column adds, moves and removes uses on insert/update/delete.
 * - Duplicate hashes in one document create one use; sibling columns stay intact.
 * - Cascaded session deletion removes projected uses; retained events still count.
 * - Transactional part replacement never deletes bytes between writes.
 * - Unknown hashes and documents without the reserved key write without uses.
 * - Sweep frees unreferenced blobs, keeping each indexed reference and live Draft.
 * - Removed/sent tombstones hold no bytes, never expire, and protect claimed Drafts.
 * - Missing get, malformed/unsupported/empty/over-limit URLs fail; names survive.
 * - Fork copies keep bytes after original event/part deletion, until copies go.
 * - Catalogue helper rejects refs outside the indexed columns, including new tables.
 * - Every schema TEXT column is explicitly classified as indexed or cannot hold refs.
 * - Generic store/layer builds, importer connections and runtime project registration
 *   never sweep; daemon offline startup does, after imports and before consumers.
 * - Import copies blobs first with deduplication and rebuilds uses, never copies them.
 * - Replay seeds blobs, compares full replayable identities, rejects missing blobs/uses,
 *   and separately checks operational references (covered in existing parity tests).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { MAX_ATTACHMENT_BASE64_BYTES } from "../../../src/lib/attachment-data-url.js";
import { AttachmentRefSchema } from "../../../src/lib/contracts/attachment-ref.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { makeDaemonSharedStoreLayer } from "../../../src/lib/domain/daemon/Layers/daemon-shared-store-layer.js";
import {
	AttachmentStoreLive,
	AttachmentStoreTag,
} from "../../../src/lib/domain/persistence/Services/attachment-store.js";
import { releaseInputDraftClaims } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import { sweepAttachments } from "../../../src/lib/persistence/attachment-store.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	makePersistenceStoreLayer,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { createEventId } from "../../../src/lib/persistence/events.js";
import { inputDraftClaimMarker } from "../../../src/lib/persistence/input-drafts.js";
import { assertAttachmentCatalogue } from "../../helpers/attachment-catalogue.js";

const dataUrl = "data:image/png;base64,YXR0YWNobWVudA==";
const otherUrl = "data:image/png;base64,b3RoZXI=";
const layer = AttachmentStoreLive.pipe(
	Layer.provideMerge(makePersistenceEffectLayer(":memory:", "test-project")),
);
const indexed = [
	[
		"events",
		"data",
		"event_id",
		"ref",
		"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES ('ref', 'session', 1, 'custom', '{}', 'opencode', 1)",
	],
	[
		"messages",
		"rest_payload",
		"id",
		"ref",
		"INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('ref', 'session', 'user', 1, 1)",
	],
	[
		"message_parts",
		"metadata",
		"id",
		"ref",
		"INSERT INTO message_parts (id, message_id, type, sort_order, created_at, updated_at) VALUES ('ref', 'message', 'file', 0, 1, 1)",
	],
	[
		"message_parts",
		"rest_payload",
		"id",
		"ref",
		"INSERT INTO message_parts (id, message_id, type, sort_order, created_at, updated_at) VALUES ('ref', 'message', 'file', 0, 1, 1)",
	],
	[
		"pending_inputs",
		"request",
		"input_id",
		"ref",
		"INSERT INTO pending_inputs (input_id, session_id, text, request, state, admitted_at, version) VALUES ('ref', 'session', '', '{}', 'queued', 1, 1)",
	],
	[
		"pending_inputs",
		"images",
		"input_id",
		"ref",
		"INSERT INTO pending_inputs (input_id, session_id, text, request, state, admitted_at, version) VALUES ('ref', 'session', '', '{}', 'queued', 1, 1)",
	],
	[
		"provider_command_outbox",
		"payload_json",
		"request_sequence",
		"1",
		"INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, requested_at, updated_at) VALUES (1, 'cmd', 'test-project', 'session', 'opencode', 'send_turn', '{}', 1, 1)",
	],
] as const;

const seed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, provider, project_id, created_at, updated_at) VALUES ('session', 'opencode', 'test-project', 1, 1)`;
	yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('message', 'session', 'user', 1, 1)`;
});

describe("attachment store", () => {
	it.effect(
		"deduplicates MIME and bytes, separates MIME, preserves names and raw bytes",
		() =>
			Effect.gen(function* () {
				const store = yield* AttachmentStoreTag;
				const sql = yield* SqlClient.SqlClient;
				const first = yield* store.put(dataUrl);
				expect(yield* store.put(dataUrl)).toEqual(first);
				const named = yield* store.put(
					dataUrl.replace(";base64", ";name=my%20photo.png;base64"),
				);
				expect(named).toEqual({ ...first, name: "my photo.png" });
				const jpeg = yield* store.put(
					dataUrl.replace("image/png", "image/jpeg"),
				);
				expect(jpeg.attachmentHash).not.toBe(first.attachmentHash);
				expect(first.attachmentHash).toMatch(/^[0-9a-f]{64}$/);
				expect(yield* store.get(first.attachmentHash)).toEqual({
					bytes: Buffer.from("attachment"),
					mime: "image/png",
				});
				expect(
					yield* sql`SELECT size, typeof(bytes) AS storage FROM attachment_blobs ORDER BY mime`,
				).toEqual([
					{ size: 10, storage: "blob" },
					{ size: 10, storage: "blob" },
				]);
				expect(
					Schema.decodeUnknownSync(AttachmentRefSchema)(
						JSON.parse(JSON.stringify(named)),
					),
				).toEqual(named);
				expect(() =>
					Schema.decodeUnknownSync(AttachmentRefSchema)({
						attachmentHash: "invalid",
						mime: "image/png",
					}),
				).toThrow();
			}).pipe(Effect.provide(layer)),
	);

	for (const invalid of [
		"not a data url",
		"data:image/svg+xml;base64,YQ==",
		"data:image/png;base64,",
		"data:image/png;base64,A",
		"data:image/png;name=%ZZ;base64,YQ==",
		`data:image/png;base64,${"A".repeat(MAX_ATTACHMENT_BASE64_BYTES + 4)}`,
	]) {
		it.effect(`rejects invalid attachment ${invalid.slice(0, 42)}`, () =>
			Effect.gen(function* () {
				const store = yield* AttachmentStoreTag;
				const sql = yield* SqlClient.SqlClient;
				expect((yield* Effect.result(store.put(invalid)))._tag).toBe("Failure");
				expect(yield* sql`SELECT hash FROM attachment_blobs`).toEqual([]);
			}).pipe(Effect.provide(layer)),
		);
	}
	it.effect("reports AttachmentMissing through get", () =>
		Effect.gen(function* () {
			const store = yield* AttachmentStoreTag;
			expect(
				yield* store
					.get("0".repeat(64))
					.pipe(
						Effect.catchTag("AttachmentMissing", (error) =>
							Effect.succeed(error._tag),
						),
					),
			).toBe("AttachmentMissing");
		}).pipe(Effect.provide(layer)),
	);

	for (const [table, column, key, rowKey, insert] of indexed) {
		it.effect(
			`${table}.${column} indexes insert/update/delete, duplicates, absent keys and unknown hashes`,
			() =>
				Effect.gen(function* () {
					const store = yield* AttachmentStoreTag;
					const sql = yield* SqlClient.SqlClient;
					yield* seed;
					const first = yield* store.put(dataUrl);
					const second = yield* store.put(otherUrl);
					const payload = JSON.stringify({ nested: [first, first] });
					// Put the ref in the INSERT itself to exercise the insert trigger.
					const insertWithRef = insert.replace("'{}'", "?");
					if (
						column === "data" ||
						column === "request" ||
						column === "payload_json"
					) {
						yield* sql.unsafe(insertWithRef, [payload]);
					} else {
						const closing = insert.lastIndexOf(")");
						const values = insert.indexOf(") VALUES");
						yield* sql.unsafe(
							`${insert.slice(0, values)}, ${column}${insert.slice(values, closing)}, ?)`,
							[payload],
						);
					}
					const uses = () =>
						sql<{
							hash: string;
							source_column: string;
							source_row_key: string;
						}>`SELECT hash, source_column, source_row_key FROM attachment_uses WHERE source_table = ${table}`;
					expect(yield* uses()).toEqual([
						{
							hash: first.attachmentHash,
							source_column: column,
							source_row_key: rowKey,
						},
					]);
					yield* sweepAttachments;
					expect((yield* store.get(first.attachmentHash)).mime).toBe(
						"image/png",
					);
					// Re-put the unreferenced replacement, which the sweep just freed.
					yield* store.put(otherUrl);
					yield* sql.unsafe(
						`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`,
						[JSON.stringify(second), rowKey],
					);
					expect((yield* uses()).map(({ hash }) => hash)).toEqual([
						second.attachmentHash,
					]);
					// Updates remove the old use but do not delete its bytes.
					expect((yield* store.get(first.attachmentHash)).bytes).toEqual(
						Buffer.from("attachment"),
					);
					yield* sql.unsafe(
						`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`,
						[JSON.stringify({ attachmentHash: "missing" }), rowKey],
					);
					expect(yield* uses()).toEqual([]);
					yield* sql.unsafe(
						`UPDATE ${table} SET ${column} = '{}' WHERE ${key} = ?`,
						[rowKey],
					);
					expect(yield* uses()).toEqual([]);
					yield* sql.unsafe(
						`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`,
						[JSON.stringify(first), rowKey],
					);
					yield* sql.unsafe(`DELETE FROM ${table} WHERE ${key} = ?`, [rowKey]);
					expect(yield* uses()).toEqual([]);
					yield* sweepAttachments;
					expect(
						(yield* Effect.result(store.get(first.attachmentHash)))._tag,
					).toBe("Failure");
					expect(
						(yield* Effect.result(store.get(second.attachmentHash)))._tag,
					).toBe("Failure");
				}).pipe(Effect.provide(layer)),
		);
	}

	for (const [table, left, right, insert] of [
		["message_parts", "metadata", "rest_payload", indexed[2][4]],
		["pending_inputs", "request", "images", indexed[4][4]],
	] as const) {
		it.effect(`${table} preserves sibling column references`, () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* AttachmentStoreTag;
				yield* seed;
				const ref = yield* store.put(dataUrl);
				yield* sql.unsafe(insert);
				yield* sql.unsafe(`UPDATE ${table} SET ${left} = ?, ${right} = ?`, [
					JSON.stringify(ref),
					JSON.stringify(ref),
				]);
				yield* sql.unsafe(`UPDATE ${table} SET ${left} = '{}'`);
				expect(
					yield* sql`SELECT source_column FROM attachment_uses WHERE source_table = ${table}`,
				).toEqual([{ source_column: right }]);
				yield* sweepAttachments;
				expect((yield* store.get(ref.attachmentHash)).mime).toBe(ref.mime);
			}).pipe(Effect.provide(layer)),
		);
	}

	it.effect(
		"projected session deletion cascades uses while retained events keep bytes",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const store = yield* AttachmentStoreTag;
				const ref = yield* store.put(dataUrl);
				yield* sql.unsafe(indexed[2][4]);
				yield* sql`UPDATE message_parts SET metadata = ${JSON.stringify(ref)}`;
				yield* sql.unsafe(indexed[0][4]);
				yield* sql`UPDATE events SET data = ${JSON.stringify(ref)}`;
				const events = yield* EventStoreEffectTag;
				const deleted = yield* events.append({
					eventId: createEventId(),
					sessionId: "session",
					type: "session.deleted",
					data: { sessionId: "session" },
					metadata: {},
					provider: "opencode",
					createdAt: 2,
				});
				yield* runner.projectBatch([deleted]);
				expect(yield* sql`SELECT source_table FROM attachment_uses`).toEqual([
					{ source_table: "events" },
				]);
				yield* sweepAttachments;
				expect((yield* store.get(ref.attachmentHash)).mime).toBe(ref.mime);
				yield* sql`DELETE FROM events`;
				yield* sweepAttachments;
				expect((yield* Effect.result(store.get(ref.attachmentHash)))._tag).toBe(
					"Failure",
				);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"part replacement in one transaction and fork copies keep bytes independently",
		() =>
			Effect.gen(function* () {
				yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const store = yield* AttachmentStoreTag;
				const ref = yield* store.put(dataUrl);
				yield* sql.unsafe(indexed[2][4]);
				yield* sql`UPDATE message_parts SET rest_payload = ${JSON.stringify(ref)}`;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`DELETE FROM message_parts WHERE id = 'ref'`;
						expect((yield* store.get(ref.attachmentHash)).mime).toBe(ref.mime);
						yield* sql.unsafe(indexed[2][4]);
						yield* sql`UPDATE message_parts SET rest_payload = ${JSON.stringify(ref)}`;
					}),
				);
				yield* sweepAttachments;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('fork', 'opencode', 1, 1)`;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at) VALUES ('fork-message', 'fork', 'user', 1, 1)`;
				yield* sql`INSERT INTO message_parts (id, message_id, type, sort_order, created_at, updated_at, rest_payload) SELECT 'fork-part', 'fork-message', type, sort_order, created_at, updated_at, rest_payload FROM message_parts WHERE id = 'ref'`;
				yield* sql.unsafe(indexed[0][4]);
				yield* sql`UPDATE events SET data = ${JSON.stringify(ref)}`;
				yield* sql`DELETE FROM events`;
				yield* sql`DELETE FROM message_parts WHERE id = 'ref'`;
				expect(
					yield* sql`SELECT source_table, source_row_key FROM attachment_uses`,
				).toEqual([
					{ source_table: "message_parts", source_row_key: "fork-part" },
				]);
				yield* sweepAttachments;
				expect((yield* store.get(ref.attachmentHash)).mime).toBe(ref.mime);
				yield* sql`DELETE FROM message_parts WHERE id = 'fork-part'`;
				yield* sweepAttachments;
				expect((yield* Effect.result(store.get(ref.attachmentHash)))._tag).toBe(
					"Failure",
				);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"live Drafts keep bytes, tombstones keep claimed Drafts without keeping bytes or expiring",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* AttachmentStoreTag;
				const ref = yield* store.put(dataUrl);
				for (const state of ["live", "removed", "sent"] as const) {
					yield* sql`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at, promoted_session_id) VALUES (${state}, 'test-project', 'draft', '', 0, ${inputDraftClaimMarker})`;
					yield* sql`INSERT INTO draft_attachments (id, draft_key, position, name, hash, state, created_at) VALUES (${state}, ${state}, 0, 'file', ${state === "live" ? ref.attachmentHash : null}, ${state}, 0)`;
				}
				yield* releaseInputDraftClaims();
				expect(
					yield* sql`SELECT draft_key, promoted_session_id FROM input_drafts ORDER BY draft_key`,
				).toEqual(
					["live", "removed", "sent"].map((draft_key) => ({
						draft_key,
						promoted_session_id: null,
					})),
				);
				yield* sweepAttachments;
				expect((yield* store.get(ref.attachmentHash)).mime).toBe(ref.mime);
				yield* sql`UPDATE draft_attachments SET state = 'sent', hash = NULL WHERE id = 'live'`;
				yield* sweepAttachments;
				expect((yield* Effect.result(store.get(ref.attachmentHash)))._tag).toBe(
					"Failure",
				);
				expect(
					yield* sql`SELECT id FROM draft_attachments ORDER BY id`,
				).toHaveLength(3);
				expect(
					(yield* Effect.result(
						sql`UPDATE draft_attachments SET hash = ${ref.attachmentHash} WHERE id = 'removed'`,
					))._tag,
				).toBe("Failure");
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"catalogue checks all TEXT columns, including unexpected tables",
		() =>
			Effect.gen(function* () {
				yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const store = yield* AttachmentStoreTag;
				const ref = yield* store.put(dataUrl);
				yield* sql.unsafe(indexed[0][4]);
				yield* sql`UPDATE events SET data = ${JSON.stringify(ref)}`;
				expect(yield* assertAttachmentCatalogue).toEqual([]);
				yield* sql`UPDATE events SET metadata = ${JSON.stringify(ref)}`;
				expect(yield* assertAttachmentCatalogue).toEqual(["events.metadata"]);
				yield* sql`CREATE TABLE future_payload (payload TEXT)`;
				yield* sql`INSERT INTO future_payload VALUES (${JSON.stringify(ref)})`;
				expect(yield* assertAttachmentCatalogue).toEqual([
					"events.metadata",
					"future_payload.payload",
				]);
			}).pipe(Effect.provide(layer)),
	);

	it.effect(
		"generic layers never sweep; daemon offline startup sweeps before consumers",
		() =>
			Effect.gen(function* () {
				const dir = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "attachment-startup-"))),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const filename = join(dir, "events.db");
				const ref = yield* Effect.gen(function* () {
					return yield* (yield* AttachmentStoreTag).put(dataUrl);
				}).pipe(
					Effect.provide(
						AttachmentStoreLive.pipe(
							Layer.provide(makePersistenceStoreLayer(filename)),
						),
					),
				);
				yield* Effect.gen(function* () {
					expect(
						(yield* (yield* AttachmentStoreTag).get(ref.attachmentHash)).mime,
					).toBe(ref.mime);
				}).pipe(
					Effect.provide(
						AttachmentStoreLive.pipe(
							Layer.provide(makePersistenceStoreLayer(filename)),
						),
					),
				);
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`SELECT hash FROM attachment_blobs`).toEqual([]);
				}).pipe(
					Effect.provide(
						makeDaemonSharedStoreLayer(dir, defaultDaemonConfig()),
					),
				);
			}).pipe(Effect.scoped),
	);
});
