// test/unit/persistence/projectors/turn-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type MessageCreatedPayload,
	type SessionStatusPayload,
	type StoredEvent,
	type TurnCompletedPayload,
	type TurnErrorPayload,
	type TurnInterruptedPayload,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { TurnProjector } from "../../../../src/lib/persistence/projectors/turn-projector.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface TurnRow {
	id: string;
	session_id: string;
	state: string;
	user_message_id: string | null;
	assistant_message_id: string | null;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	requested_at: number;
	started_at: number | null;
	completed_at: number | null;
}

describe("TurnProjector", () => {
	let db: SqliteClient;
	let projector: TurnProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new TurnProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("turn");
		expect(projector.handles).toEqual([
			"message.created",
			"session.status",
			"turn.completed",
			"turn.error",
			"turn.interrupted",
		]);
	});

	describe("user message.created", () => {
		it("inserts a new turn with state=pending and user_message_id", () => {
			const event = makeStored(
				"message.created",
				"s1",
				{
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
				now,
			);

			projector.project(event, db);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row).toBeDefined();
			expect(row?.id).toBe("user_m1");
			expect(row?.session_id).toBe("s1");
			expect(row?.state).toBe("pending");
			expect(row?.user_message_id).toBe("user_m1");
			expect(row?.assistant_message_id).toBeNull();
			expect(row?.requested_at).toBe(now);
			expect(row?.started_at).toBeNull();
			expect(row?.completed_at).toBeNull();
		});
	});

	describe("assistant message.created", () => {
		it("updates the most recent pending/running turn with assistant_message_id", () => {
			// User message creates the turn
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			// Assistant message arrives
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					2,
					now + 100,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.assistant_message_id).toBe("asst_m1");
		});

		it("does not create a new turn for assistant messages", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					2,
					now + 100,
				),
				db,
			);

			const rows = db.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.status (busy)", () => {
		it("transitions the most recent pending turn to running with started_at", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"session.status",
					"s1",
					{
						sessionId: "s1",
						status: "busy",
					} satisfies SessionStatusPayload,
					2,
					now + 200,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("running");
			expect(row?.started_at).toBe(now + 200);
		});

		it("ignores non-busy status changes", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"session.status",
					"s1",
					{
						sessionId: "s1",
						status: "idle",
					} satisfies SessionStatusPayload,
					2,
					now + 200,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("pending");
			expect(row?.started_at).toBeNull();
		});
	});

	describe("turn.completed", () => {
		it("finalizes the turn with cost, tokens, and completed_at", () => {
			// Full lifecycle
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					2,
					now + 100,
				),
				db,
			);

			projector.project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "asst_m1",
						cost: 0.042,
						tokens: { input: 3000, output: 800 },
					} satisfies TurnCompletedPayload,
					3,
					now + 5000,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("completed");
			expect(row?.cost).toBeCloseTo(0.042);
			expect(row?.tokens_in).toBe(3000);
			expect(row?.tokens_out).toBe(800);
			expect(row?.completed_at).toBe(now + 5000);
		});
	});

	describe("turn.error", () => {
		it("marks the turn as errored", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					2,
					now + 100,
				),
				db,
			);

			projector.project(
				makeStored(
					"turn.error",
					"s1",
					{
						messageId: "asst_m1",
						error: "rate_limit_exceeded",
						code: "429",
					} satisfies TurnErrorPayload,
					3,
					now + 3000,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("error");
			expect(row?.completed_at).toBe(now + 3000);
		});
	});

	describe("turn.interrupted", () => {
		it("marks the turn as interrupted", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					2,
					now + 100,
				),
				db,
			);

			projector.project(
				makeStored(
					"turn.interrupted",
					"s1",
					{
						messageId: "asst_m1",
					} satisfies TurnInterruptedPayload,
					3,
					now + 2000,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("interrupted");
			expect(row?.completed_at).toBe(now + 2000);
		});
	});

	describe("full turn lifecycle", () => {
		it("tracks a complete turn from user message to completion", () => {
			// 1. User sends message -> turn created
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			let row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("pending");

			// 2. Session goes busy -> turn starts running
			projector.project(
				makeStored(
					"session.status",
					"s1",
					{
						sessionId: "s1",
						status: "busy",
					} satisfies SessionStatusPayload,
					2,
					now + 50,
				),
				db,
			);

			row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("running");
			expect(row?.started_at).toBe(now + 50);

			// 3. Assistant message arrives
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					3,
					now + 100,
				),
				db,
			);

			row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.assistant_message_id).toBe("asst_m1");

			// 4. Turn completes
			projector.project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "asst_m1",
						cost: 0.1,
						tokens: {
							input: 5000,
							output: 1200,
							cacheRead: 300,
							cacheWrite: 100,
						},
					} satisfies TurnCompletedPayload,
					4,
					now + 10000,
				),
				db,
			);

			row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("completed");
			expect(row?.cost).toBeCloseTo(0.1);
			expect(row?.tokens_in).toBe(5000);
			expect(row?.tokens_out).toBe(1200);
			expect(row?.completed_at).toBe(now + 10000);
		});
	});

	describe("multiple turns in one session", () => {
		it("tracks each turn independently", () => {
			// Turn 1
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					2,
					now + 100,
				),
				db,
			);
			projector.project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "asst_m1",
						cost: 0.01,
						tokens: { input: 100, output: 50 },
					} satisfies TurnCompletedPayload,
					3,
					now + 5000,
				),
				db,
			);

			// Turn 2
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "user_m2",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					4,
					now + 6000,
				),
				db,
			);
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "asst_m2",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					5,
					now + 6100,
				),
				db,
			);
			projector.project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "asst_m2",
						cost: 0.02,
						tokens: { input: 200, output: 100 },
					} satisfies TurnCompletedPayload,
					6,
					now + 11000,
				),
				db,
			);

			const rows = db.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at",
				["s1"],
			);
			expect(rows).toHaveLength(2);
			expect(rows[0]?.id).toBe("user_m1");
			expect(rows[0]?.state).toBe("completed");
			expect(rows[1]?.id).toBe("user_m2");
			expect(rows[1]?.state).toBe("completed");
		});
	});
});
