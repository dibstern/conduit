// SessionAttention against a real SQLite file with the real projectors.
// Ways it can be wrong, listed before it exists:
// - a turn end does not raise last_turn_end_version, or a turn.error does not;
// - markSeen stores an upTo past the latest turn end, so the next turn end
//   is already "seen";
// - markSeen lowers seen_version when a stale report arrives (a tab that
//   rendered an older turn end), resurrecting a dot the user cleared;
// - markSeen stamps and announces when nothing changed, so every pick of a
//   read session fans out a list update;
// - markSeen marks a sub-agent, a session with no turn end, or an unknown id;
// - markUnread does not bring the dot back, or does it without announcing;
// - markUnread is a no-op on a session with no turn end yet (hk9m.7).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import {
	markSeen,
	markUnread,
} from "../../../src/lib/domain/relay/Services/session-attention.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const withPersistence = async (
	body: (
		advances: ReadModelAdvance[],
	) => Effect.Effect<void, unknown, PersistenceEffectContext>,
) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-session-attention-"));
	const advances: ReadModelAdvance[] = [];
	const bus = Layer.succeed(SessionEventBusTag)({
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
	try {
		await Effect.runPromise(
			body(advances).pipe(
				Effect.provide(
					Layer.merge(
						makePersistenceEffectLayer(
							join(dir, "events.db"),
							"test-project",
							createAllEffectProjectors(),
							bus,
						),
						bus,
					),
				),
				Effect.orDie,
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

// Creates root (turn ends at stream versions 4 and 8), a sub-agent child and
// a fork of root (each with a turn end at version 4), and an idle session
// with no turn end.
const seed = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const created = (
		sessionId: string,
		extra: { parentId?: string; forkPointEvent?: string } = {},
	) =>
		canonicalEvent(
			"session.created",
			sessionId,
			{ sessionId, title: sessionId, provider: "claude", ...extra },
			{ provider: "claude" },
		);
	const accepted = (sessionId: string, inputId: string) => [
		canonicalEvent("run.requested", sessionId, {
			runId: `${inputId}-run`,
			inputId,
		}),
		canonicalEvent("message.created", sessionId, {
			sessionId,
			messageId: inputId,
			role: "user",
			inputId,
		}),
		canonicalEvent(
			"run.started",
			sessionId,
			{ inputId, requestedRunId: `${inputId}-run` },
			{ provider: "claude", metadata: { runId: `${inputId}-run` } },
		),
	];
	const completed = (sessionId: string) => [
		...accepted(sessionId, `${sessionId}-a`),
		canonicalEvent(
			"turn.completed",
			sessionId,
			{ messageId: `${sessionId}-a` },
			{ provider: "claude", metadata: { runId: `${sessionId}-a-run` } },
		),
	];
	yield* commit([created("root"), ...completed("root")]);
	yield* commit([
		...accepted("root", "root-b"),
		canonicalEvent(
			"turn.error",
			"root",
			{ messageId: "root-b", error: "boom" },
			{ provider: "claude", metadata: { runId: "root-b-run" } },
		),
	]);
	yield* commit([
		created("child", { parentId: "root" }),
		...completed("child"),
		created("fork", { parentId: "root", forkPointEvent: "root-a" }),
		...completed("fork"),
		created("idle"),
	]);
});

const state = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{
			last: number | null;
			seen: number | null;
			unread: number;
		}>`SELECT last_turn_end_version AS last, seen_version AS seen, unread FROM sessions WHERE id = ${sessionId}`;
		return row;
	});

it("turn.completed and turn.error both raise last_turn_end_version", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			yield* seed;
			expect(yield* state("root")).toEqual({ last: 8, seen: null, unread: 1 });
			expect(yield* state("fork")).toEqual({ last: 4, seen: null, unread: 1 });
			expect(yield* state("child")).toEqual({ last: 4, seen: null, unread: 0 });
		}),
	);
});

// A folded steer splits transcript turns, but the terminal row must still
// settle the send that started the provider turn. A queued send starts its own.
it.each([
	"turn.completed",
	"turn.error",
	"turn.interrupted",
] as const)("%s names the starter through two steers, then names the next queued input", async (type) => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
			const runner = yield* ProjectionRunnerEffectTag;
			const sessionId = "steered";
			yield* commit([
				canonicalEvent("session.created", sessionId, {
					sessionId,
					title: "Steered",
					provider: "claude",
				}),
			]);
			for (const [index, inputId] of ["alpha", "bravo", "charlie"].entries()) {
				yield* commit([
					canonicalEvent("input.admitted", sessionId, {
						sessionId,
						inputId,
						delivery: index ? "steer" : "queue",
						request: { text: inputId, images: [] },
					}),
					canonicalEvent("run.requested", sessionId, {
						runId: `run-${inputId}`,
						inputId,
					}),
					canonicalEvent("input.sent", sessionId, {
						sessionId,
						inputId,
						...(index ? { steer: true } : {}),
					}),
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId: inputId,
						role: "user",
						inputId,
					}),
					canonicalEvent(
						"run.started",
						sessionId,
						{ inputId, requestedRunId: `run-${inputId}` },
						{ provider: "claude", metadata: { runId: "run-alpha" } },
					),
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId: `reply-${inputId}`,
						role: "assistant",
						parentID: inputId,
					}),
				]);
			}
			yield* commit([
				canonicalEvent(
					type,
					sessionId,
					{
						messageId: "reply-charlie",
						...(type === "turn.error" ? { error: "failed" } : {}),
					},
					{ provider: "claude", metadata: { runId: "run-alpha" } },
				),
			]);
			const read = sql<{
				input_id: string | null;
				version: number;
				error_at: number | null;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version, last_turn_error_at AS error_at FROM sessions WHERE id = ${sessionId}`;
			const [ended] = yield* read;
			expect(ended?.input_id).toBe("alpha");
			expect(ended?.version).toBeGreaterThan(0);
			expect(ended?.error_at === null).toBe(type !== "turn.error");

			// Rebuild all projections from the durable log in the real recovery path.
			yield* sql`DELETE FROM sessions`;
			yield* sql`DELETE FROM projector_cursors`;
			yield* runner.recover();
			expect(yield* read).toEqual([ended]);

			yield* commit([
				canonicalEvent("run.requested", sessionId, {
					runId: "run-queued",
					inputId: "queued-input",
				}),
				canonicalEvent("message.created", sessionId, {
					sessionId,
					messageId: "queued",
					role: "user",
					inputId: "queued-input",
				}),
				canonicalEvent(
					"run.started",
					sessionId,
					{ inputId: "queued-input", requestedRunId: "run-queued" },
					{ provider: "claude", metadata: { runId: "run-queued" } },
				),
				canonicalEvent("message.created", sessionId, {
					sessionId,
					messageId: "reply-queued",
					role: "assistant",
					parentID: "queued",
				}),
				canonicalEvent(
					"turn.completed",
					sessionId,
					{ messageId: "reply-queued" },
					{ provider: "claude", metadata: { runId: "run-queued" } },
				),
			]);
			const [queued] = yield* read;
			expect(queued?.input_id).toBe("queued-input");
			expect(queued?.version).toBeGreaterThan(ended?.version ?? 0);
			expect(queued?.error_at).toBeNull();
		}),
	);
});

it.each([
	"",
	"unknown",
])("an interruption with reply id %j leaves the starter unknown", async (messageId) => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
			yield* commit([
				canonicalEvent("session.created", "early", {
					sessionId: "early",
					title: "Early",
					provider: "claude",
				}),
				canonicalEvent("message.created", "early", {
					sessionId: "early",
					messageId: "user",
					role: "user",
					inputId: "starter",
				}),
				canonicalEvent("input.admitted", "early", {
					sessionId: "early",
					inputId: "steer",
					delivery: "steer",
					request: { text: "Steer", images: [] },
				}),
				canonicalEvent("input.sent", "early", {
					sessionId: "early",
					inputId: "steer",
					steer: true,
				}),
				canonicalEvent("message.created", "early", {
					sessionId: "early",
					messageId: "steer",
					role: "user",
					inputId: "steer",
				}),
				canonicalEvent("run.requested", "early", {
					runId: "unplaced-run",
					inputId: "unknown-input",
				}),
				canonicalEvent(
					"turn.interrupted",
					"early",
					{ messageId },
					{ provider: "claude", metadata: { runId: "unplaced-run" } },
				),
			]);
			const [ended] = yield* sql<{
				input_id: string | null;
				version: number;
				error_at: number | null;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version, last_turn_error_at AS error_at FROM sessions WHERE id = 'early'`;
			expect(ended).toEqual({
				input_id: null,
				version: 6,
				error_at: null,
			});
			// Recovery of just the session projector sees already-closed turns and
			// later messages. Neither may change which input this interruption ended.
			yield* commit([
				canonicalEvent("message.created", "early", {
					sessionId: "early",
					messageId: "later",
					role: "user",
					inputId: "later-input",
				}),
			]);
			yield* sql`UPDATE sessions SET last_turn_end_input_id = NULL, last_turn_end_version = NULL WHERE id = 'early'`;
			yield* sql`DELETE FROM projector_cursors WHERE projector_name = 'session'`;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.recover();
			const [replayed] = yield* sql<{
				input_id: string | null;
				version: number;
				error_at: number | null;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version, last_turn_error_at AS error_at FROM sessions WHERE id = 'early'`;
			expect(replayed).toEqual(ended);
		}),
	);
});

it("an interruption before the user echo advances the end version with an unknown starter", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
			yield* commit([
				canonicalEvent("session.created", "early", {
					sessionId: "early",
					title: "Early",
					provider: "claude",
				}),
				canonicalEvent("input.admitted", "early", {
					sessionId: "early",
					inputId: "starter",
					delivery: "queue",
					request: { text: "Start", images: [] },
				}),
				canonicalEvent("input.sent", "early", {
					sessionId: "early",
					inputId: "starter",
				}),
				canonicalEvent("input.admitted", "early", {
					sessionId: "early",
					inputId: "queued",
					delivery: "queue",
					request: { text: "Later", images: [] },
				}),
				canonicalEvent("run.requested", "early", {
					runId: "unaccepted-run",
					inputId: "starter",
				}),
				canonicalEvent(
					"turn.interrupted",
					"early",
					{ messageId: "" },
					{ provider: "claude", metadata: { runId: "unaccepted-run" } },
				),
			]);
			const read = sql<{
				input_id: string | null;
				version: number;
				error_at: number | null;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version, last_turn_error_at AS error_at FROM sessions WHERE id = 'early'`;
			const [ended] = yield* read;
			expect(ended).toEqual({
				input_id: null,
				version: 5,
				error_at: null,
			});
			// The queued handoff does not turn the older interruption into its end.
			yield* commit([
				canonicalEvent("input.sent", "early", {
					sessionId: "early",
					inputId: "queued",
				}),
				canonicalEvent("message.created", "early", {
					sessionId: "early",
					messageId: "queued-user",
					role: "user",
					inputId: "queued",
				}),
			]);
			expect(yield* read).toEqual([ended]);
			yield* sql`DELETE FROM sessions`;
			yield* sql`DELETE FROM projector_cursors`;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.recover();
			expect(yield* read).toEqual([ended]);
		}),
	);
});

it("a steered turn with an unknown starter does not name an older input", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
			yield* commit([
				canonicalEvent("session.created", "unknown", {
					sessionId: "unknown",
					title: "Unknown",
					provider: "claude",
				}),
				canonicalEvent("message.created", "unknown", {
					sessionId: "unknown",
					messageId: "older",
					role: "user",
					inputId: "older-input",
				}),
				canonicalEvent("turn.completed", "unknown", {
					userMessageId: "older",
					messageId: "older-reply",
				}),
				canonicalEvent("run.requested", "unknown", {
					runId: "unplaced-run",
					inputId: "unknown-starter",
				}),
				canonicalEvent("message.created", "unknown", {
					sessionId: "unknown",
					messageId: "unknown-starter",
					role: "user",
				}),
				canonicalEvent("input.admitted", "unknown", {
					sessionId: "unknown",
					inputId: "steer",
					delivery: "steer",
					request: { text: "Steer", images: [] },
				}),
				canonicalEvent("input.sent", "unknown", {
					sessionId: "unknown",
					inputId: "steer",
					steer: true,
				}),
				canonicalEvent("message.created", "unknown", {
					sessionId: "unknown",
					messageId: "steer",
					role: "user",
					inputId: "steer",
				}),
				canonicalEvent(
					"turn.completed",
					"unknown",
					{ userMessageId: "steer", messageId: "reply" },
					{ provider: "claude", metadata: { runId: "unplaced-run" } },
				),
			]);
			const [ended] = yield* sql<{
				input_id: string | null;
				version: number;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version FROM sessions WHERE id = 'unknown'`;
			expect(ended).toEqual({ input_id: null, version: 8 });
		}),
	);
});

it("a steer placed after the preceding turn ended starts its own turn", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
			yield* commit([
				canonicalEvent("session.created", "late", {
					sessionId: "late",
					title: "Late",
					provider: "claude",
				}),
				canonicalEvent("run.requested", "late", {
					runId: "alpha-run",
					inputId: "alpha-input",
				}),
				canonicalEvent("message.created", "late", {
					sessionId: "late",
					messageId: "alpha",
					role: "user",
					inputId: "alpha-input",
				}),
				canonicalEvent(
					"run.started",
					"late",
					{ inputId: "alpha-input", requestedRunId: "alpha-run" },
					{ provider: "claude", metadata: { runId: "alpha-run" } },
				),
				canonicalEvent("input.admitted", "late", {
					sessionId: "late",
					inputId: "bravo",
					delivery: "steer",
					request: { text: "Bravo", images: [] },
				}),
				canonicalEvent("input.sent", "late", {
					sessionId: "late",
					inputId: "bravo",
					steer: true,
				}),
				canonicalEvent("run.requested", "late", {
					runId: "bravo-run",
					inputId: "bravo",
				}),
				canonicalEvent(
					"turn.completed",
					"late",
					{ userMessageId: "alpha", messageId: "reply-alpha" },
					{ provider: "claude", metadata: { runId: "alpha-run" } },
				),
				canonicalEvent("message.created", "late", {
					sessionId: "late",
					messageId: "bravo",
					role: "user",
					inputId: "bravo",
				}),
				canonicalEvent(
					"run.started",
					"late",
					{ inputId: "bravo", requestedRunId: "bravo-run" },
					{ provider: "claude", metadata: { runId: "bravo-run" } },
				),
				canonicalEvent(
					"turn.completed",
					"late",
					{ userMessageId: "bravo", messageId: "reply-bravo" },
					{ provider: "claude", metadata: { runId: "bravo-run" } },
				),
			]);
			const [ended] = yield* sql<{
				input_id: string;
				version: number;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version FROM sessions WHERE id = 'late'`;
			expect(ended).toEqual({ input_id: "bravo", version: 10 });
		}),
	);
});

it("session-only recovery does not use a steer's echo from after the interruption", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const sql = yield* SqlClient.SqlClient;
			yield* commit([
				canonicalEvent("session.created", "future", {
					sessionId: "future",
					title: "Future",
					provider: "claude",
				}),
				canonicalEvent("input.admitted", "future", {
					sessionId: "future",
					inputId: "alpha",
					delivery: "queue",
					request: { text: "Alpha", images: [] },
				}),
				canonicalEvent("input.sent", "future", {
					sessionId: "future",
					inputId: "alpha",
				}),
				canonicalEvent("message.created", "future", {
					sessionId: "future",
					messageId: "alpha",
					role: "user",
					inputId: "alpha",
				}),
				canonicalEvent("input.admitted", "future", {
					sessionId: "future",
					inputId: "bravo",
					delivery: "steer",
					request: { text: "Bravo", images: [] },
				}),
				canonicalEvent("input.sent", "future", {
					sessionId: "future",
					inputId: "bravo",
					steer: true,
				}),
				canonicalEvent("run.requested", "future", {
					runId: "unplaced-run",
					inputId: "unknown-input",
				}),
				canonicalEvent(
					"turn.interrupted",
					"future",
					{ messageId: "" },
					{ provider: "claude", metadata: { runId: "unplaced-run" } },
				),
				canonicalEvent("message.created", "future", {
					sessionId: "future",
					messageId: "bravo",
					role: "user",
					inputId: "bravo",
				}),
			]);
			const read = sql<{
				input_id: string | null;
				version: number;
				error_at: number | null;
			}>`SELECT last_turn_end_input_id AS input_id, last_turn_end_version AS version, last_turn_error_at AS error_at FROM sessions WHERE id = 'future'`;
			const ended = [{ input_id: null, version: 7, error_at: null }];
			expect(yield* read).toEqual(ended);
			yield* sql`UPDATE sessions SET last_turn_end_input_id = NULL, last_turn_end_version = NULL WHERE id = 'future'`;
			yield* sql`DELETE FROM projector_cursors WHERE projector_name = 'session'`;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.recover();
			expect(yield* read).toEqual(ended);
		}),
	);
});

it("markSeen caps at the latest turn end and announces the row once", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			advances.length = 0;
			expect(yield* markSeen("root", 99)).toBe(true);
			expect(yield* state("root")).toEqual({ last: 8, seen: 8, unread: 0 });
			expect(advances.map((advance) => advance.sessionIds)).toEqual([["root"]]);

			expect(yield* markSeen("root", 8)).toBe(false);
			expect(advances).toHaveLength(1);
		}),
	);
});

it("markSeen never lowers seen_version", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			expect(yield* markSeen("root", 4)).toBe(true);
			expect(yield* state("root")).toEqual({ last: 8, seen: 4, unread: 1 });
			expect(yield* markSeen("root", 8)).toBe(true);
			advances.length = 0;
			expect(yield* markSeen("root", 4)).toBe(false);
			expect(yield* state("root")).toEqual({ last: 8, seen: 8, unread: 0 });
			expect(advances).toEqual([]);
		}),
	);
});

it("markSeen is a quiet no-op for a sub-agent, an idle session and an unknown id, and works on a fork", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			advances.length = 0;
			expect(yield* markSeen("child", 4)).toBe(false);
			expect(yield* markSeen("idle", 1)).toBe(false);
			expect(yield* markSeen("missing", 1)).toBe(false);
			expect(yield* state("child")).toEqual({ last: 4, seen: null, unread: 0 });
			expect(advances).toEqual([]);

			expect(yield* markSeen("fork", 4)).toBe(true);
			expect(yield* state("fork")).toEqual({ last: 4, seen: 4, unread: 0 });
		}),
	);
});

it("markUnread puts seen one below the latest turn end and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			yield* markSeen("root", 8);
			advances.length = 0;
			expect(yield* markUnread("root")).toBe(true);
			expect(yield* state("root")).toEqual({ last: 8, seen: 7, unread: 1 });
			expect(advances.map((advance) => advance.sessionIds)).toEqual([["root"]]);
			expect(yield* markUnread("root")).toBe(false);
			expect(yield* markUnread("child")).toBe(false);
		}),
	);
});

it("markUnread on a session with no turn end shows a dot until it is seen", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			yield* seed;
			expect(yield* markUnread("idle")).toBe(true);
			expect(yield* state("idle")).toEqual({ last: null, seen: -2, unread: 1 });
			expect(yield* markSeen("idle", 0)).toBe(true);
			expect(yield* state("idle")).toEqual({ last: null, seen: -1, unread: 0 });
		}),
	);
});
