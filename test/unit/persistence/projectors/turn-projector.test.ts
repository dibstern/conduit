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
	type TurnModelResolvedPayload,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { TurnProjector } from "../../../../src/lib/persistence/projectors/turn-projector.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import resumedTurnEvents from "../../../fixtures/claude-resumed-turn.json" with {
	type: "json",
};

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
	requested_model: string | null;
	expected_model: string | null;
	actual_model: string | null;
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

	// The persisted state after each recorded event, in fixture order. Only the
	// turn's own results finish it; anything that follows puts it back to work.
	const EXPECTED_STATE = [
		"pending", // 1. the user prompt opens the turn
		"running", // 2. the session goes busy
		"running", // 3. the first assistant message
		"completed", // 4. a result arrives, but Claude is not done
		"completed", // 5. idle
		"running", // 6. busy again, 68ms later
		"running", // 7. a second assistant message, same turn
		"running", // 8. thinking
		"running", // 9. a tool starts
		"running", // 10. the tool finishes
		"completed", // 11. the second execution reports its own result
		"running", // 12. a third assistant message, 15 minutes later
		"running", // 13. still working 45 minutes after the first "completion"
	];

	it("agrees with the Effect turn projector on the production resumed-turn timeline", () => {
		const sessionId = "ses_c2d8cd521bc14f9f8f7700096bbf1d23";
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[sessionId, "claude", "Resumed turn", "idle", now, now],
		);
		expect(resumedTurnEvents).toHaveLength(EXPECTED_STATE.length);
		for (const [index, recorded] of resumedTurnEvents.entries()) {
			// The export omits envelope fields unrelated to the regression.
			const event = {
				...recorded,
				eventId: `recorded-${recorded.sequence}`,
				sessionId,
				streamVersion: index,
				metadata: {},
			} as StoredEvent;
			projector.project(event, db);
			const turns = db.query<TurnRow>("SELECT * FROM turns");
			// No user message follows, so all thirteen events are one turn.
			expect(turns).toHaveLength(1);
			expect(turns[0], `after event ${index + 1}`).toMatchObject({
				id: "52feab57-ed40-4885-b23b-71dcd78209a8",
				state: EXPECTED_STATE[index],
			});
			if (EXPECTED_STATE[index] === "running") {
				// Reopening has to clear the finish too, or every reader that
				// asks "when did this end" still sees a finished turn.
				expect(turns[0], `after event ${index + 1}`).toMatchObject({
					completed_at: null,
				});
			}
			if (event.type === "turn.completed") {
				expect(turns[0]).toMatchObject({
					assistant_message_id: event.data.messageId,
					completed_at: event.createdAt,
					// Cost is cumulative for the whole SDK session, so the latest
					// wins; tokens are per-execution, so the second result adds.
					cost: event.data.cost,
					tokens_in: index === 3 ? 2 : 4,
					tokens_out: index === 3 ? 2 : 3,
				});
			}
		}
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("turn");
		expect(projector.handles).toEqual([
			"message.created",
			"tool.started",
			"session.status",
			"turn.completed",
			"turn.error",
			"turn.interrupted",
			"turn.model_resolved",
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
		it("starts the most recent turn and attaches its assistant_message_id", () => {
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
			expect(row?.state).toBe("running");
			expect(row?.started_at).toBe(now + 100);
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
		it("settles the turn with the latest cost, summed tokens, and completed_at", () => {
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

			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m2",
					role: "assistant",
					sessionId: "s1",
				}),
				db,
			);
			projector.project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "asst_m2",
						cost: 0.05,
						tokens: { input: 100, output: 20 },
					},
					5,
					now + 6000,
				),
				db,
			);
			expect(db.queryOne<TurnRow>("SELECT * FROM turns")).toMatchObject({
				state: "completed",
				assistant_message_id: "asst_m2",
				cost: 0.05,
				tokens_in: 3100,
				tokens_out: 820,
				started_at: now + 100,
				completed_at: now + 6000,
			});
		});

		it("preserves known accounting when usage is omitted and accepts zero values", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "u1",
					role: "user",
					sessionId: "s1",
				}),
				db,
			);
			for (const [index, usage] of [
				{},
				{ cost: 0.5, tokens: { input: 100, output: 20 } },
				{ tokens: { output: 0 } },
				{ cost: 0, tokens: { input: 0 } },
			].entries()) {
				const messageId = `a${index}`;
				projector.project(
					makeStored("message.created", "s1", {
						messageId,
						role: "assistant",
						sessionId: "s1",
					}),
					db,
				);
				projector.project(
					makeStored("turn.completed", "s1", { messageId, ...usage }),
					db,
				);
				expect(db.queryOne<TurnRow>("SELECT * FROM turns")).toMatchObject({
					state: "completed",
					assistant_message_id: messageId,
					cost: index === 0 ? null : index === 3 ? 0 : 0.5,
					tokens_in: index === 0 ? null : 100,
					tokens_out: index === 0 ? null : 20,
				});
			}
		});
	});

	describe.each([
		"completed",
		"error",
		"interrupted",
	])("reopening a %s turn", (state) => {
		it.each([
			"busy",
			"assistant",
			"tool",
		])("reopens on %s and preserves the original start and new attachment", (resume) => {
			db.execute(
				`INSERT INTO turns (id, session_id, state, requested_at, started_at, completed_at, assistant_message_id)
				 VALUES ('older', 's1', 'pending', ?, NULL, NULL, NULL),
				        ('latest', 's1', ?, ?, ?, ?, 'a1')`,
				[now, state, now, now + 1, now + 2],
			);
			const activity =
				resume === "busy"
					? makeStored("session.status", "s1", {
							sessionId: "s1",
							status: "busy",
						})
					: resume === "assistant"
						? makeStored("message.created", "s1", {
								sessionId: "s1",
								messageId: "a2",
								role: "assistant",
							})
						: makeStored("tool.started", "s1", {
								messageId: "a1",
								partId: "p1",
								toolName: "bash",
								callId: "c1",
								input: {},
							});
			projector.project(activity, db);
			expect(
				db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = 'latest'"),
			).toMatchObject({
				state: "running",
				started_at: now + 1,
				completed_at: null,
				assistant_message_id: resume === "assistant" ? "a2" : null,
			});
			projector.project(
				makeStored("message.created", "s1", {
					sessionId: "s1",
					messageId: "a2",
					role: "assistant",
				}),
				db,
			);
			projector.project(
				makeStored("session.status", "s1", { sessionId: "s1", status: "busy" }),
				db,
			);
			expect(
				db.query<TurnRow>(
					"SELECT id, state, assistant_message_id, started_at, completed_at FROM turns ORDER BY rowid",
				),
			).toEqual([
				{
					id: "older",
					state: "pending",
					assistant_message_id: null,
					started_at: null,
					completed_at: null,
				},
				{
					id: "latest",
					state: "running",
					assistant_message_id: "a2",
					started_at: now + 1,
					completed_at: null,
				},
			]);
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

		it("falls back to the latest open turn when messageId matches nothing", () => {
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
			// Turn transitions to running, but the interrupt arrives before the
			// assistant message id is known (e.g. permission rejected mid-turn),
			// so the messageId matches no assistant_message_id.
			projector.project(
				makeStored(
					"session.status",
					"s1",
					{ sessionId: "s1", status: "busy" } satisfies SessionStatusPayload,
					2,
					now + 50,
				),
				db,
			);

			projector.project(
				makeStored(
					"turn.interrupted",
					"s1",
					{
						messageId: "unknown-uuid",
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

		it("fallback leaves other sessions' open turns untouched", () => {
			db.execute(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				["s2", "opencode", "Other", "idle", now, now],
			);
			projector.project(
				makeStored(
					"message.created",
					"s2",
					{
						messageId: "user_s2",
						role: "user",
						sessionId: "s2",
					} satisfies MessageCreatedPayload,
					1,
					now,
				),
				db,
			);

			projector.project(
				makeStored(
					"turn.interrupted",
					"s1",
					{
						messageId: "unknown-uuid",
					} satisfies TurnInterruptedPayload,
					2,
					now + 2000,
				),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_s2",
			]);
			expect(row?.state).toBe("pending");
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

	describe("turn.model_resolved", () => {
		it("updates only the newest open turn and is replay-idempotent", () => {
			db.execute(
				`INSERT INTO turns
				 (id, session_id, state, user_message_id, requested_at)
				 VALUES
				 ('completed', 's1', 'completed', 'completed', ?),
				 ('running', 's1', 'running', 'running', ?),
				 ('pending', 's1', 'pending', 'pending', ?)`,
				[now, now + 1, now + 2],
			);
			const event = makeStored("turn.model_resolved", "s1", {
				requestedModel: "sonnet",
				expectedModel: "claude-sonnet-5[1m]",
				actualModel: "claude-sonnet-5[1m]",
			} satisfies TurnModelResolvedPayload);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at",
				["s1"],
			);
			expect(rows[0]?.actual_model).toBeNull();
			expect(rows[1]?.actual_model).toBeNull();
			expect(rows[2]).toMatchObject({
				requested_model: "sonnet",
				expected_model: "claude-sonnet-5[1m]",
				actual_model: "claude-sonnet-5[1m]",
			});
		});

		it("preserves nullable evidence", () => {
			db.execute(
				`INSERT INTO turns
				 (id, session_id, state, user_message_id, requested_at)
				 VALUES ('pending', 's1', 'pending', 'pending', ?)`,
				[now],
			);

			projector.project(
				makeStored("turn.model_resolved", "s1", {
					actualModel: "claude-opus-4-6",
				} satisfies TurnModelResolvedPayload),
				db,
			);

			const row = db.queryOne<TurnRow>(
				"SELECT * FROM turns WHERE id = 'pending'",
			);
			expect(row).toMatchObject({
				requested_model: null,
				expected_model: null,
				actual_model: "claude-opus-4-6",
			});
		});

		it("updates the newest running turn", () => {
			db.execute(
				`INSERT INTO turns
				 (id, session_id, state, user_message_id, requested_at)
				 VALUES
				 ('older-running', 's1', 'running', 'older-running', ?),
				 ('newest-running', 's1', 'running', 'newest-running', ?)`,
				[now, now + 1],
			);

			projector.project(
				makeStored("turn.model_resolved", "s1", {
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5",
					actualModel: "claude-sonnet-5",
				} satisfies TurnModelResolvedPayload),
				db,
			);

			const rows = db.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at",
				["s1"],
			);
			expect(rows[0]?.actual_model).toBeNull();
			expect(rows[1]).toMatchObject({
				id: "newest-running",
				requested_model: "sonnet",
				expected_model: "claude-sonnet-5",
				actual_model: "claude-sonnet-5",
			});
		});

		it("does not attach evidence when no open turn exists", () => {
			db.execute(
				`INSERT INTO turns
				 (id, session_id, state, user_message_id, requested_at)
				 VALUES ('completed', 's1', 'completed', 'completed', ?)`,
				[now],
			);

			projector.project(
				makeStored("turn.model_resolved", "s1", {
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5",
					actualModel: "claude-sonnet-5",
				} satisfies TurnModelResolvedPayload),
				db,
			);

			const row = db.queryOne<TurnRow>(
				"SELECT * FROM turns WHERE id = 'completed'",
			);
			expect(row?.actual_model).toBeNull();
		});
	});
});
