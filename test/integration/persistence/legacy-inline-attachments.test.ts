// Failure modes are recorded before implementation in the mryl.11 report.
// This exercises real SQLite, migrations, private-copy import and index triggers.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { makeAttachmentStore } from "../../../src/lib/persistence/attachment-store.js";
import { makePersistenceStoreLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	importProjectStore,
	seedDaemonStore,
} from "../../../src/lib/persistence/migrations/daemon-store-import.js";
import { normaliseInlineAttachments } from "../../../src/lib/persistence/migrations/normalise-inline-attachments.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import {
	assertAttachmentCatalogue,
	indexedAttachmentColumns,
} from "../../helpers/attachment-catalogue.js";
import {
	createProjectStoreFixture,
	sourceChecksums,
	writeImportArtifact,
} from "../../helpers/daemon-store-import-manifest.js";
import {
	createLegacyInlineAttachmentStore,
	legacyImageBytes,
	legacyImageRef,
	legacyImageUrl,
} from "../../helpers/legacy-inline-attachment-store.js";

it.each([
	false,
	true,
])("normalises all legacy attachment columns on a private copy (seed=%s)", async (seed) => {
	const root = mkdtempSync(join(tmpdir(), "conduit-inline-import-"));
	const evidence: Record<string, unknown> = { passed: false, seed };
	try {
		const source = await createLegacyInlineAttachmentStore(
			root,
			"inline-source",
		);
		const before = sourceChecksums(source.sourcePath);
		const configDir = join(root, "daemon");
		mkdirSync(configDir);
		if (!seed) {
			const initial = await createProjectStoreFixture(root, "initial", {
				transcript: { prompt: "seed", reply: "done" },
			});
			await Effect.runPromise(seedDaemonStore(configDir, initial));
		}
		const identities = (filename: string) => {
			const db = new DatabaseSync(filename, { readOnly: true });
			try {
				return db
					.prepare(
						`SELECT ${seed ? "sequence," : ""} event_id, stream_version, type, metadata, provider, created_at FROM events WHERE session_id = ? ORDER BY stream_version`,
					)
					.all(source.sessionId);
			} finally {
				db.close();
			}
		};
		const originalIdentities = identities(source.sourcePath);
		const result = await Effect.runPromise(
			seed
				? seedDaemonStore(configDir, source)
				: importProjectStore(configDir, source),
		);
		expect(result.outcome).toBe(seed ? "seeded" : "imported");
		expect(result.attachmentNormalisation).toEqual({
			rowsChanged: {
				"events.data": 3,
				"messages.rest_payload": 1,
				"message_parts.metadata": 1,
				"message_parts.rest_payload": 1,
				"pending_inputs.request": 1,
				"pending_inputs.images": 1,
				"provider_command_outbox.payload_json": 6,
			},
			rowsSkipped: 0,
		});
		const destination = daemonStorePath(configDir);
		expect(identities(destination)).toEqual(originalIdentities);
		const db = new DatabaseSync(destination, { readOnly: true });
		try {
			for (const qualified of indexedAttachmentColumns) {
				const [table, column] = qualified.split(".");
				expect(
					db
						.prepare(
							`SELECT rowid FROM ${table} WHERE instr(${column}, 'data:') > 0`,
						)
						.all(),
					qualified,
				).toEqual([]);
				expect(
					db
						.prepare(
							"SELECT 1 FROM attachment_uses WHERE source_table = ? AND source_column = ? AND hash = ?",
						)
						.get(table ?? "", column ?? "", legacyImageRef.attachmentHash),
					qualified,
				).toBeDefined();
				const ownerKey =
					table === "events"
						? "event_id"
						: table === "pending_inputs"
							? "input_id"
							: table === "provider_command_outbox"
								? "request_sequence"
								: "id";
				expect(
					db
						.prepare(`SELECT owner.${ownerKey}, j.value FROM ${table} owner, json_tree(owner.${column}) j
						WHERE j.key = 'attachmentHash' AND (
						NOT EXISTS (SELECT 1 FROM attachment_blobs b WHERE b.hash = j.value)
						OR NOT EXISTS (SELECT 1 FROM attachment_uses u WHERE u.source_table = ? AND u.source_column = ?
						AND u.source_row_key = CAST(owner.${ownerKey} AS TEXT) AND u.hash = j.value))`)
						.all(table ?? "", column ?? ""),
					qualified,
				).toEqual([]);
			}
			const blob = db
				.prepare("SELECT hash, mime, size, bytes FROM attachment_blobs")
				.all();
			expect(blob).toHaveLength(1);
			expect(blob[0]).toMatchObject({
				hash: legacyImageRef.attachmentHash,
				mime: "image/png",
				size: legacyImageBytes.length,
			});
			expect(Buffer.from(blob[0]?.["bytes"] as Uint8Array)).toEqual(
				legacyImageBytes,
			);
			const outbox = db
				.prepare(
					"SELECT status, payload_json FROM provider_command_outbox ORDER BY request_sequence",
				)
				.all();
			for (const row of outbox) {
				const payload: unknown = JSON.parse(String(row["payload_json"]));
				expect(payload).toMatchObject(
					["completed", "failed", "cancelled"].includes(String(row["status"]))
						? { text: "Legacy queued image" }
						: { images: [legacyImageRef] },
				);
				if (
					["completed", "failed", "cancelled"].includes(String(row["status"]))
				)
					expect(payload).not.toHaveProperty("images");
			}
			evidence["outbox"] = outbox;
			evidence["uses"] = db
				.prepare(
					"SELECT * FROM attachment_uses ORDER BY source_table, source_column, source_row_key",
				)
				.all();
			evidence["blob"] = {
				hash: legacyImageRef.attachmentHash,
				bytes: legacyImageBytes.length,
			};
		} finally {
			db.close();
		}
		expect(
			await Effect.runPromise(importProjectStore(configDir, source)),
		).toMatchObject({ outcome: "skipped" });
		const summary = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* normaliseInlineAttachments(
					sql,
					yield* makeAttachmentStore,
				);
			}).pipe(
				Effect.provide(makePersistenceStoreLayer(destination)),
				Effect.scoped,
			),
		);
		expect(Object.values(summary.rowsChanged)).toEqual(
			indexedAttachmentColumns.map(() => 0),
		);
		expect(summary.rowsSkipped).toBe(0);
		const catalogue = await Effect.runPromise(
			assertAttachmentCatalogue.pipe(
				Effect.provide(makePersistenceStoreLayer(destination)),
				Effect.scoped,
			),
		);
		expect(catalogue).toEqual([]);
		expect(sourceChecksums(source.sourcePath)).toEqual(before);
		evidence["sourceChecksums"] = {
			before,
			after: sourceChecksums(source.sourcePath),
		};
		evidence["catalogue"] = catalogue;
		evidence["repeatSummary"] = summary;
		evidence["passed"] = true;
	} finally {
		writeImportArtifact(
			`test-results/draft-attachments/import-inline-${seed ? "seed" : "existing"}.json`,
			evidence,
		);
		rmSync(root, { recursive: true, force: true });
	}
});

it("visits every page and nonpositive rowid, keeps modern refs and remote sources, and counts one new blob", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-inline-pages-"));
	try {
		const source = await createLegacyInlineAttachmentStore(
			root,
			"inline-pages",
		);
		const db = new DatabaseSync(source.sourcePath);
		try {
			db.exec(
				"UPDATE pending_inputs SET rowid = -1; UPDATE provider_command_outbox SET request_sequence = 0 WHERE status = 'pending'",
			);
			for (let index = 0; index < 102; index++)
				db.prepare(`INSERT INTO pending_inputs (input_id, session_id, text, images, request, state, admitted_at, version)
					VALUES (?, ?, '', ?, ?, 'queued', 1100, 0)`).run(
					`page-${index}`,
					source.sessionId,
					JSON.stringify([legacyImageUrl, legacyImageRef]),
					JSON.stringify({
						text: "",
						images: [legacyImageRef, legacyImageUrl],
					}),
				);
			db.prepare(
				"UPDATE message_parts SET metadata = ? WHERE type = 'file'",
			).run(
				JSON.stringify({ mime: "image/png", url: "file:///tmp/remote.png" }),
			);
		} finally {
			db.close();
		}
		const summary = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* normaliseInlineAttachments(
					sql,
					yield* makeAttachmentStore,
				);
			}).pipe(
				Effect.provide(makePersistenceStoreLayer(source.sourcePath)),
				Effect.scoped,
			),
		);
		expect(summary).toMatchObject({
			rowsSkipped: 0,
			rowsChanged: {
				"pending_inputs.request": 103,
				"pending_inputs.images": 103,
				"provider_command_outbox.payload_json": 6,
			},
		});
		const read = new DatabaseSync(source.sourcePath, { readOnly: true });
		try {
			expect(
				JSON.parse(
					String(
						read
							.prepare(
								"SELECT images FROM pending_inputs WHERE input_id = 'page-101'",
							)
							.get()?.["images"],
					),
				),
			).toEqual([legacyImageRef, legacyImageRef]);
			expect(
				JSON.parse(
					String(
						read
							.prepare("SELECT metadata FROM message_parts WHERE type = 'file'")
							.get()?.["metadata"],
					),
				),
			).toEqual({
				mime: "image/png",
				source: { url: "file:///tmp/remote.png" },
			});
			expect(
				read
					.prepare(
						"SELECT request_sequence FROM provider_command_outbox WHERE instr(payload_json, 'data:') > 0",
					)
					.all(),
			).toEqual([]);
		} finally {
			read.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("propagates SQL failures and rolls back offline rewrites and blob inserts", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-inline-rollback-"));
	try {
		const source = await createLegacyInlineAttachmentStore(
			root,
			"inline-rollback",
		);
		const db = new DatabaseSync(source.sourcePath);
		try {
			db.exec(
				"CREATE TRIGGER reject_normalisation BEFORE UPDATE OF request ON pending_inputs BEGIN SELECT RAISE(ABORT, 'normalisation write proof'); END",
			);
		} finally {
			db.close();
		}
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* normaliseInlineAttachments(
					sql,
					yield* makeAttachmentStore,
				);
			}).pipe(
				Effect.provide(makePersistenceStoreLayer(source.sourcePath)),
				Effect.scoped,
				Effect.result,
			),
		);
		expect(result._tag).toBe("Failure");
		const read = new DatabaseSync(source.sourcePath, { readOnly: true });
		try {
			expect(read.prepare("SELECT hash FROM attachment_blobs").all()).toEqual(
				[],
			);
			expect(
				read
					.prepare("SELECT event_id FROM events WHERE instr(data, 'data:') > 0")
					.all(),
			).toHaveLength(3);
			expect(
				read
					.prepare(
						"SELECT request_sequence FROM provider_command_outbox WHERE instr(payload_json, 'data:') > 0",
					)
					.all(),
			).toHaveLength(6);
		} finally {
			read.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("recovers an unprojected legacy file and snapshot after normalising their events", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-inline-recovery-"));
	try {
		const source = await createLegacyInlineAttachmentStore(
			root,
			"inline-recovery",
			{ unprojected: true },
		);
		const before = sourceChecksums(source.sourcePath);
		const configDir = join(root, "daemon");
		mkdirSync(configDir);
		expect(
			await Effect.runPromise(seedDaemonStore(configDir, source)),
		).toMatchObject({ outcome: "seeded" });
		const db = new DatabaseSync(daemonStorePath(configDir), { readOnly: true });
		try {
			expect(db.prepare("SELECT * FROM projection_failures").all()).toEqual([]);
			expect(
				JSON.parse(
					String(
						db
							.prepare("SELECT metadata FROM message_parts WHERE id = ?")
							.get(`${source.sessionId}_attached`)?.["metadata"],
					),
				),
			).toMatchObject({ source: legacyImageRef });
			expect(
				db
					.prepare(
						"SELECT id FROM message_parts WHERE instr(rest_payload, 'data:') > 0",
					)
					.all(),
			).toEqual([]);
		} finally {
			db.close();
		}
		expect(sourceChecksums(source.sourcePath)).toEqual(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("counts invalid rows without partial rewrites, preserves unrelated data and reports deduplicated blobs", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-inline-invalid-"));
	try {
		const source = await createLegacyInlineAttachmentStore(
			root,
			"inline-invalid",
		);
		const db = new DatabaseSync(source.sourcePath);
		const badRequest = JSON.stringify({
			text: "bad",
			images: [legacyImageUrl, "data:image/png;base64,!"],
		});
		try {
			db.prepare(
				"UPDATE pending_inputs SET request = ?, images = '{invalid' WHERE input_id = ?",
			).run(badRequest, `${source.sessionId}_input`);
			db.prepare(
				"UPDATE provider_command_outbox SET payload_json = ? WHERE status IN ('completed', 'failed', 'cancelled')",
			).run(JSON.stringify({ text: "terminal", images: ["data:invalid"] }));
			db.prepare(
				"UPDATE message_parts SET metadata = ? WHERE type = 'text'",
			).run(JSON.stringify({ toolOutput: legacyImageUrl }));
		} finally {
			db.close();
		}
		const summary = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const attachments = yield* makeAttachmentStore;
				yield* attachments.put(legacyImageUrl);
				return yield* normaliseInlineAttachments(sql, attachments);
			}).pipe(
				Effect.provide(makePersistenceStoreLayer(source.sourcePath)),
				Effect.scoped,
			),
		);
		expect(summary.rowsSkipped).toBe(2);
		expect(summary.rowsChanged).toMatchObject({
			"events.data": 3,
			"messages.rest_payload": 1,
			"message_parts.metadata": 1,
			"message_parts.rest_payload": 1,
			"pending_inputs.request": 0,
			"pending_inputs.images": 0,
			"provider_command_outbox.payload_json": 6,
		});
		const read = new DatabaseSync(source.sourcePath, { readOnly: true });
		try {
			expect(
				read.prepare("SELECT request, images FROM pending_inputs").get(),
			).toEqual({ request: badRequest, images: "{invalid" });
			expect(
				read
					.prepare(
						"SELECT metadata FROM message_parts WHERE type = 'text' LIMIT 1",
					)
					.get(),
			).toEqual({ metadata: JSON.stringify({ toolOutput: legacyImageUrl }) });
		} finally {
			read.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
