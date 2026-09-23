// ─── Compaction Backfill ────────────────────────────────────────────────────
// Every completed compaction stored before the projector claimed the event type
// is recoverable from its payload. Migration 0013 reconstructs those rows; this
// pins its shape against the projector's and its behaviour on a second run.

import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import {
	BACKFILL_COMPACTION_MESSAGES_MIGRATION,
	readMigrationSql,
	schemaMigrations,
} from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

const BACKFILL_SQL = readMigrationSql(BACKFILL_COMPACTION_MESSAGES_MIGRATION);
const priorMigrations = schemaMigrations.filter((m) => m.id < 13);

const SESSION = "sess-backfill";
const T0 = 1_700_000_000_000;

interface PartRow {
	id: string;
	message_id: string;
	text: string;
	metadata: string | null;
	sort_order: number;
}

describe("0013 compaction backfill", () => {
	let client: SqliteClient;

	const seed = () => {
		client = SqliteClient.memory();
		runMigrations(client, [...priorMigrations]);
		client.execute(
			"INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES (?, 'claude', 'Backfill', ?, ?)",
			[SESSION, T0, T0],
		);
	};

	const appendCompaction = (
		sequence: number,
		data: Record<string, unknown>,
		createdAt = T0,
	) => {
		client.execute(
			`INSERT INTO events (sequence, event_id, session_id, stream_version, type, data, provider, created_at)
			 VALUES (?, ?, ?, ?, 'session.compaction', ?, 'claude', ?)`,
			[
				sequence,
				`evt-${sequence}`,
				SESSION,
				sequence,
				JSON.stringify(data),
				createdAt,
			],
		);
	};

	const addMessage = (id: string, createdAt: number) => {
		client.execute(
			"INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, 'assistant', 'hi', 0, ?, ?)",
			[id, SESSION, createdAt, createdAt],
		);
	};

	const backfill = () => client.exec(BACKFILL_SQL);

	const parts = () =>
		client.query<PartRow>(
			"SELECT id, message_id, text, metadata, sort_order FROM message_parts WHERE type = 'compaction' ORDER BY id",
		);

	afterEach(() => {
		client?.close();
	});

	it("reconstructs a completed compaction from its stored payload", () => {
		seed();
		appendCompaction(7, {
			sessionId: SESSION,
			state: "completed",
			detail: "Context compacted",
			preTokens: 120_000,
			postTokens: 30_000,
		});

		backfill();

		const messages = client.query<{ id: string; role: string }>(
			"SELECT id, role FROM messages",
		);
		expect(messages).toEqual([{ id: "compaction-7", role: "assistant" }]);

		const [part] = parts();
		expect(part?.id).toBe("compaction-part-7");
		expect(part?.message_id).toBe("compaction-7");
		expect(part?.text).toBe("Context compacted");
		expect(part?.sort_order).toBe(0);
		expect(JSON.parse(part?.metadata ?? "null")).toEqual({
			preTokens: 120_000,
			postTokens: 30_000,
		});
	});

	it("changes nothing on a second run", () => {
		seed();
		appendCompaction(3, {
			sessionId: SESSION,
			state: "completed",
			detail: "once",
		});

		backfill();
		backfill();

		expect(parts()).toHaveLength(1);
		expect(
			client.query("SELECT id FROM messages WHERE id LIKE 'compaction-%'"),
		).toHaveLength(1);
	});

	it("lands each compaction where it happened in the transcript", () => {
		seed();
		addMessage("msg-a", T0 + 1_000);
		addMessage("msg-b", T0 + 3_000);
		addMessage("msg-c", T0 + 5_000);
		appendCompaction(
			11,
			{ sessionId: SESSION, state: "completed", detail: "between b and c" },
			T0 + 4_000,
		);

		backfill();

		const order = client
			.query<{ id: string }>(
				"SELECT id FROM messages ORDER BY created_at ASC, id ASC",
			)
			.map((r) => r.id);
		expect(order).toEqual(["msg-a", "msg-b", "compaction-11", "msg-c"]);
	});

	it("omits token fields the provider never reported", () => {
		seed();
		appendCompaction(4, {
			sessionId: SESSION,
			state: "completed",
			detail: "no tokens",
		});
		appendCompaction(5, {
			sessionId: SESSION,
			state: "completed",
			detail: "pre only",
			preTokens: 9,
		});

		backfill();

		expect(parts().map((p) => JSON.parse(p.metadata ?? "null"))).toEqual([
			{},
			{ preTokens: 9 },
		]);
	});

	it("skips events that are not completed compactions", () => {
		seed();
		appendCompaction(1, {
			sessionId: SESSION,
			state: "started",
			detail: "starting",
		});
		appendCompaction(2, {
			sessionId: SESSION,
			state: "failed",
			detail: "failed",
		});

		backfill();

		expect(parts()).toHaveLength(0);
	});

	it("skips payloads missing required fields rather than half-writing them", () => {
		seed();
		appendCompaction(20, { sessionId: SESSION, state: "completed" });
		appendCompaction(21, { state: "completed", detail: "no session" });

		backfill();

		expect(
			client.query("SELECT id FROM messages WHERE id LIKE 'compaction-%'"),
		).toHaveLength(0);
		expect(parts()).toHaveLength(0);
	});

	it("skips compactions whose session has since been deleted", () => {
		seed();
		appendCompaction(30, {
			sessionId: "sess-gone",
			state: "completed",
			detail: "orphan",
		});

		backfill();

		expect(parts()).toHaveLength(0);
	});
});
