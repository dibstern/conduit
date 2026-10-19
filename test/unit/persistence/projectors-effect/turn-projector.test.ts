// test/unit/persistence/projectors-effect/turn-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	createEventId,
	type MessageCreatedPayload,
	type SessionStatusPayload,
	type StoredEvent,
	type TurnCompletedPayload,
	type TurnErrorPayload,
	type TurnInterruptedPayload,
} from "../../../../src/lib/persistence/events.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../../helpers/effect-projection-harness.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		projectId: "test-project",
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
	let harness: EffectProjectionHarness;
	let projector: EffectProjector;
	let replayNextProjection: boolean;
	const now = Date.now();

	beforeEach(async () => {
		replayNextProjection = false;
		const effectProjector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "turn",
		);
		if (!effectProjector) throw new Error("Turn projector not found");
		projector = {
			...effectProjector,
			project: (event, context) => {
				const effectiveContext = replayNextProjection
					? { ...context, replaying: true }
					: context;
				replayNextProjection = false;
				return effectProjector.project(event, effectiveContext);
			},
		};
		harness = makeEffectProjectionHarness([projector]);

		// Pre-insert a session so FK constraints don't block inserts
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(event: StoredEvent, replaying = false): Promise<void> {
		replayNextProjection = replaying;
		await harness.reproject([event]);
	}

	async function queryOne<T extends object>(
		statement: string,
		params: readonly (string | number | null)[] = [],
	): Promise<T | undefined> {
		return (await harness.query<T>(statement, params))[0];
	}

	describe("user message.created", () => {
		it("inserts a new turn with state=pending and user_message_id", async () => {
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

			await project(event);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
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
		it("starts the most recent turn and attaches its assistant_message_id", async () => {
			// User message creates the turn
			await project(
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
			);

			// Assistant message arrives
			await project(
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
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.assistant_message_id).toBe("asst_m1");
			expect(row?.state).toBe("running");
			expect(row?.started_at).toBe(now + 100);
		});

		it("does not create a new turn for assistant messages", async () => {
			await project(
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
			);

			await project(
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
			);

			const rows = await harness.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.status (busy)", () => {
		it("transitions the most recent pending turn to running with started_at", async () => {
			await project(
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
			);

			await project(
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
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("running");
			expect(row?.started_at).toBe(now + 200);
		});

		it("settles a prompt still waiting for its reply on idle", async () => {
			await project(
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
			);

			await project(
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
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("completed");
			expect(row?.started_at).toBeNull();
			expect(row?.completed_at).toBe(now + 200);
		});

		// A result naming no reply this turn owns leaves only idle to close it;
		// left open, the inbox reads the session as busy and queues every send.
		it("settles a replied turn its result never named on idle, and a later reply reopens it", async () => {
			const timeline: StoredEvent[] = [
				makeStored("message.created", "s1", {
					messageId: "u1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload),
				makeStored("message.created", "s1", {
					messageId: "a1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload),
				makeStored("turn.completed", "s1", {
					messageId: "unowned",
				} satisfies TurnCompletedPayload),
				makeStored("session.status", "s1", {
					sessionId: "s1",
					status: "idle",
				} satisfies SessionStatusPayload),
				makeStored("message.created", "s1", {
					messageId: "a2",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload),
			].map((event, index) => ({
				...event,
				sequence: index + 1,
				streamVersion: index,
				createdAt: now + index * 100,
			}));
			const states: string[] = [];
			for (const event of timeline) {
				await project(event);
				states.push((await turnStates())["u1"] ?? "");
			}

			expect(states).toEqual([
				"pending",
				"running",
				"running",
				"completed",
				"running",
			]);
		});
	});

	describe("turn.completed", () => {
		it.each([
			false,
			true,
		])("does not count a late completion for a backfilled assistant again (replay=%s)", async (replaying) => {
			await harness.query(
				"INSERT INTO messages (id, session_id, role, is_streaming, rest_digest, created_at, updated_at) VALUES ('a1', 's1', 'assistant', 0, 'digest', ?, ?)",
				[now, now],
			);
			await harness.query(
				"INSERT INTO turns (id, session_id, state, user_message_id, assistant_message_id, requested_at, tokens_in, tokens_out) VALUES ('u1', 's1', 'completed', 'u1', 'a1', ?, 10, 5)",
				[now],
			);
			await project(
				makeStored("turn.completed", "s1", {
					messageId: "a1",
					tokens: { input: 10, output: 5 },
				}),
				replaying,
			);
			expect(
				await queryOne<TurnRow>("SELECT * FROM turns WHERE id = 'u1'"),
			).toMatchObject({
				tokens_in: 10,
				tokens_out: 5,
			});
		});

		// Claude starts a new assistant message when the SDK folds an input (a
		// background task's notification) into the running turn, and its result
		// names that newest reply. Left open, the turn reads as busy, so the inbox
		// queues the next idle send instead of handing it off.
		it("settles a turn whose result names its second assistant reply", async () => {
			// The message projector runs first and writes these rows in production.
			await harness.query(
				"INSERT INTO messages (id, session_id, role, is_streaming, created_at, updated_at) VALUES ('a1', 's1', 'assistant', 0, ?, ?), ('a2', 's1', 'assistant', 0, ?, ?)",
				[now, now, now, now],
			);
			const events = [
				makeStored("message.created", "s1", {
					messageId: "u1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload),
				makeStored("session.status", "s1", {
					sessionId: "s1",
					status: "busy",
				} satisfies SessionStatusPayload),
				makeStored("message.created", "s1", {
					messageId: "a1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload),
				makeStored("message.created", "s1", {
					messageId: "a2",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload),
				makeStored("turn.completed", "s1", {
					messageId: "a2",
				} satisfies TurnCompletedPayload),
			];
			for (const [index, event] of events.entries())
				await project({
					...event,
					sequence: index + 1,
					streamVersion: index,
					createdAt: now + index * 100,
				});

			expect(await turnStates()).toEqual({ u1: "completed" });
		});

		it("settles the turn with the latest cost, summed tokens, and completed_at", async () => {
			// Full lifecycle
			await project(
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
			);

			await project(
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
			);

			await project(
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
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("completed");
			expect(row?.cost).toBeCloseTo(0.042);
			expect(row?.tokens_in).toBe(3000);
			expect(row?.tokens_out).toBe(800);
			expect(row?.completed_at).toBe(now + 5000);

			await project(
				makeStored("message.created", "s1", {
					messageId: "asst_m2",
					role: "assistant",
					sessionId: "s1",
				}),
			);
			await project(
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
			);
			expect(await queryOne<TurnRow>("SELECT * FROM turns")).toMatchObject({
				state: "completed",
				assistant_message_id: "asst_m2",
				cost: 0.05,
				tokens_in: 3100,
				tokens_out: 820,
				started_at: now + 100,
				completed_at: now + 6000,
			});
		});

		it("preserves known accounting when usage is omitted and accepts zero values", async () => {
			await project(
				makeStored("message.created", "s1", {
					messageId: "u1",
					role: "user",
					sessionId: "s1",
				}),
			);
			for (const [index, usage] of [
				{},
				{ cost: 0.5, tokens: { input: 100, output: 20 } },
				{ tokens: { output: 0 } },
				{ cost: 0, tokens: { input: 0 } },
			].entries()) {
				const messageId = `a${index}`;
				await project(
					makeStored("message.created", "s1", {
						messageId,
						role: "assistant",
						sessionId: "s1",
					}),
				);
				await project(
					makeStored("turn.completed", "s1", { messageId, ...usage }),
				);
				expect(await queryOne<TurnRow>("SELECT * FROM turns")).toMatchObject({
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
		])("reopens on %s and preserves the original start and new attachment", async (resume) => {
			await harness.query(
				`INSERT INTO turns (id, session_id, state, requested_at, started_at, completed_at, assistant_message_id)
				 VALUES ('older', 's1', 'pending', ?, NULL, NULL, NULL),
				        ('latest', 's1', ?, ?, ?, ?, 'a1')`,
				[now, state, now, now + 1, now + 2],
			);
			// The tool belongs to the turn's reply; one no turn owns cannot reopen it.
			await harness.query(
				"INSERT INTO messages (id, session_id, role, turn_id, created_at, updated_at) VALUES ('a1', 's1', 'assistant', 'latest', ?, ?)",
				[now + 1, now + 1],
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
								input: { tool: "Bash", command: "true" },
							});
			await project(activity);
			expect(
				await queryOne<TurnRow>("SELECT * FROM turns WHERE id = 'latest'"),
			).toMatchObject({
				state: "running",
				started_at: now + 1,
				completed_at: null,
				assistant_message_id: resume === "assistant" ? "a2" : null,
			});
			await project(
				makeStored("message.created", "s1", {
					sessionId: "s1",
					messageId: "a2",
					role: "assistant",
				}),
			);
			await project(
				makeStored("session.status", "s1", { sessionId: "s1", status: "busy" }),
			);
			expect(
				await harness.query<TurnRow>(
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
		it("marks the turn as errored", async () => {
			await project(
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
			);

			await project(
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
			);

			await project(
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
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("error");
			expect(row?.completed_at).toBe(now + 3000);
		});

		it("ends the running turn when messageId matches nothing, leaving settled turns alone", async () => {
			await projectSteered();
			await project(
				makeStored(
					"session.status",
					"s1",
					{ sessionId: "s1", status: "busy" } satisfies SessionStatusPayload,
					4,
					now + 150,
				),
			);
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "", error: "boom" } satisfies TurnErrorPayload,
					5,
					now + 3000,
				),
			);

			expect(await turnStates()).toEqual({
				user_m1: "completed",
				user_m2: "error",
			});
		});
	});

	/** user_m1 running, then user_m2 steered in: its message closes user_m1. */
	const projectSteered = async () => {
		await project(
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
		);
		await project(
			makeStored(
				"session.status",
				"s1",
				{ sessionId: "s1", status: "busy" } satisfies SessionStatusPayload,
				2,
				now + 50,
			),
		);
		await project(
			makeStored(
				"message.created",
				"s1",
				{
					messageId: "user_m2",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				3,
				now + 100,
			),
		);
	};

	const turnStates = async () =>
		Object.fromEntries(
			(
				await harness.query<{ id: string; state: string }>(
					"SELECT id, state FROM turns ORDER BY id",
				)
			).map((row) => [row.id, row.state]),
		);

	describe("turn.interrupted", () => {
		it("marks the turn as interrupted", async () => {
			await project(
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
			);

			await project(
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
			);

			await project(
				makeStored(
					"turn.interrupted",
					"s1",
					{
						messageId: "asst_m1",
					} satisfies TurnInterruptedPayload,
					3,
					now + 2000,
				),
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("interrupted");
			expect(row?.completed_at).toBe(now + 2000);
		});

		it("falls back to the session's open turn when messageId matches nothing", async () => {
			await project(
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
			);
			// Turn transitions to running, but the interrupt arrives before the
			// assistant message id is known (e.g. permission rejected mid-turn),
			// so the messageId matches no assistant_message_id.
			await project(
				makeStored(
					"session.status",
					"s1",
					{ sessionId: "s1", status: "busy" } satisfies SessionStatusPayload,
					2,
					now + 50,
				),
			);

			await project(
				makeStored(
					"turn.interrupted",
					"s1",
					{
						messageId: "unknown-uuid",
					} satisfies TurnInterruptedPayload,
					3,
					now + 2000,
				),
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("interrupted");
			expect(row?.completed_at).toBe(now + 2000);
		});

		it("fallback leaves other sessions' open turns untouched", async () => {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				["s2", "opencode", "Other", "idle", now, now],
			);
			await project(
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
			);

			await project(
				makeStored(
					"turn.interrupted",
					"s1",
					{
						messageId: "unknown-uuid",
					} satisfies TurnInterruptedPayload,
					2,
					now + 2000,
				),
			);

			const row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_s2",
			]);
			expect(row?.state).toBe("pending");
		});

		it("stops the open turn when the id is empty, leaving settled turns alone", async () => {
			await projectSteered();
			await project(
				makeStored(
					"turn.interrupted",
					"s1",
					{ messageId: "" } satisfies TurnInterruptedPayload,
					4,
					now + 2000,
				),
			);

			expect(await turnStates()).toEqual({
				user_m1: "completed",
				user_m2: "interrupted",
			});
		});
	});

	describe("full turn lifecycle", () => {
		it("tracks a complete turn from user message to completion", async () => {
			// 1. User sends message -> turn created
			await project(
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
			);

			let row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("pending");

			// 2. Session goes busy -> turn starts running
			await project(
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
			);

			row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.state).toBe("running");
			expect(row?.started_at).toBe(now + 50);

			// 3. Assistant message arrives
			await project(
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
			);

			row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
				"user_m1",
			]);
			expect(row?.assistant_message_id).toBe("asst_m1");

			// 4. Turn completes
			await project(
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
			);

			row = await queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", [
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
		it("tracks each turn independently", async () => {
			// Turn 1
			await project(
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
			);
			await project(
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
			);
			await project(
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
			);

			// Turn 2
			await project(
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
			);
			await project(
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
			);
			await project(
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
			);

			const rows = await harness.query<TurnRow>(
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
