// Failure modes: replay drops referenced or unswept blobs; absent blob bytes pass
// parity; missing derived uses pass parity; uses on the wrong row pass parity;
// operational uses are compared against replayed owners; operational rows name
// missing blobs without a parity failure.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	initializeReplayStore,
	replayProjectionStore,
	verifyReplayParity,
} from "../../../src/lib/persistence/replay-parity.js";

describe("Replay parity attachment integrity", () => {
	const stores: { directory: string; db: DatabaseSync }[] = [];
	const hash = "a".repeat(64);
	const operationalHash = "b".repeat(64);
	const missingHash = "f".repeat(64);
	const ref = { attachmentHash: hash, mime: "image/png" };

	afterEach(() => {
		for (const { directory, db } of stores.splice(0)) {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	async function sourceStore() {
		const directory = mkdtempSync(join(tmpdir(), "conduit-attachment-parity-"));
		const filename = join(directory, "events.db");
		await Effect.runPromise(initializeReplayStore(filename));
		const db = new DatabaseSync(filename);
		// Corruption cases deliberately remove blobs still named by stored rows.
		db.exec("PRAGMA foreign_keys = OFF");
		stores.push({ directory, db });
		const insertBlob = db.prepare(
			"INSERT INTO attachment_blobs (hash, mime, size, bytes, created_at) VALUES (?, 'image/png', 5, ?, 1)",
		);
		insertBlob.run(hash, Buffer.from("image"));
		// An unused blob is valid until the next offline sweep.
		insertBlob.run(operationalHash, Buffer.from("other"));
		const events = [
			canonicalEvent("session.created", "session", {
				sessionId: "session",
				title: "Attachments",
				provider: "opencode",
			}),
			canonicalEvent("message.snapshot", "session", {
				messageId: "message",
				digest: "attachment-snapshot",
				message: {
					id: "message",
					sessionID: "session",
					role: "user",
					parts: [{ id: "part", type: "file", source: ref, mime: ref.mime }],
				},
			}),
		];
		const insert = db.prepare(
			`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at, project_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture')`,
		);
		for (const [index, event] of events.entries())
			insert.run(
				event.eventId,
				event.sessionId,
				index + 1,
				event.type,
				JSON.stringify(event.data),
				JSON.stringify(event.metadata),
				event.provider,
				event.createdAt,
			);
		await Effect.runPromise(
			replayProjectionStore(filename, ["session"], { projectId: "fixture" }),
		);
		return db;
	}

	function addOperationalReference(
		db: DatabaseSync,
		table: string,
		named: string,
	) {
		const payload = JSON.stringify({ attachmentHash: named });
		if (table === "draft_attachments") {
			db.prepare(
				`INSERT INTO draft_attachments (id, draft_key, position, name, state, hash, created_at)
				 VALUES ('draft-image', 'draft', 0, 'image.png', 'live', ?, 1)`,
			).run(named);
		} else if (table === "pending_inputs") {
			db.prepare(
				`INSERT INTO pending_inputs (input_id, session_id, text, request, images, state, admitted_at, version)
				 VALUES ('input', 'session', '', ?, ?, 'queued', 1, 1)`,
			).run(payload, payload);
		} else {
			db.prepare(
				`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
				 provider_id, effect_type, payload_json, requested_at, updated_at)
				 VALUES (1, 'command', 'fixture', 'session', 'opencode', 'send_turn', ?, 1, 1)`,
			).run(payload);
		}
	}

	it("seeds blob bytes before replay and preserves the unswept blob set", async () => {
		const db = await sourceStore();
		const report = await Effect.runPromise(verifyReplayParity(db));
		expect(report.diffs).toEqual([]);
		expect(report.counts.tables["attachment_blobs"]).toEqual({
			expected: 2,
			actual: 2,
		});
		expect(
			report.counts.tables["attachment references"]?.expected,
		).toBeGreaterThan(0);
	});

	it("reports a named hash whose blob is missing", async () => {
		const db = await sourceStore();
		db.prepare("DELETE FROM attachment_blobs WHERE hash = ?").run(hash);
		const report = await Effect.runPromise(verifyReplayParity(db));
		expect(
			report.diffs.some(({ fields }) => fields.includes("missing_blob")),
		).toBe(true);
	});

	it("reports a missing derived use", async () => {
		const db = await sourceStore();
		db.prepare(
			"DELETE FROM attachment_uses WHERE source_table = 'events'",
		).run();
		const report = await Effect.runPromise(verifyReplayParity(db));
		expect(
			report.diffs.some(({ table }) => table === "attachment references"),
		).toBe(true);
	});

	it("compares row identity even when column and hash counts agree", async () => {
		const db = await sourceStore();
		db.prepare(
			"UPDATE attachment_uses SET source_row_key = 'wrong-event' WHERE source_table = 'events'",
		).run();
		const report = await Effect.runPromise(verifyReplayParity(db));
		expect(
			report.diffs.filter(({ table }) => table === "attachment references"),
		).toHaveLength(2);
	});

	it.each([
		"draft_attachments",
		"pending_inputs",
		"provider_command_outbox",
	])("checks %s blobs separately from replayed uses", async (table) => {
		const db = await sourceStore();
		addOperationalReference(db, table, operationalHash);
		const valid = await Effect.runPromise(verifyReplayParity(db));
		expect(
			valid.diffs.filter(({ table: name }) => name.startsWith("attachment")),
		).toEqual([]);
		if (table === "draft_attachments")
			db.prepare("UPDATE draft_attachments SET hash = ?").run(missingHash);
		else
			db.prepare(
				`UPDATE ${table} SET ${table === "pending_inputs" ? "request" : "payload_json"} = ?`,
			).run(JSON.stringify({ attachmentHash: missingHash }));
		const invalid = await Effect.runPromise(verifyReplayParity(db));
		expect(
			invalid.diffs.some(({ fields }) => fields.includes("missing_blob")),
		).toBe(true);
	});
});
