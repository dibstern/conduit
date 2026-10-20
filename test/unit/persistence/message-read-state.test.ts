// Failure modes: the flag is lost after reopening SQLite or after a projector
// replay deletes and recreates its part; a write tells no subscriber, or a
// no-op write announces again; marking a message moves the sidebar's seen
// marker; a non-text, unknown, foreign-session or foreign-project part can be
// marked; an explicit unread does not persist; unsurfaced parts start carrying
// a read flag on the wire; session deletion leaves annotations behind; a
// conduit-side fork does not start with its parent's flags, or later writes
// leak between parent and fork.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import {
	inheritRead,
	setRead,
} from "../../../src/lib/domain/relay/Services/session-attention.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";

const root = mkdtempSync(join(tmpdir(), "conduit-message-read-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = async (
	filename: string,
	body: (
		advances: ReadModelAdvance[],
	) => Effect.Effect<void, unknown, PersistenceEffectContext>,
) => {
	const advances: ReadModelAdvance[] = [];
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance: ReadModelAdvance) =>
			Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	});
	await Effect.runPromise(
		body(advances).pipe(
			Effect.provide(
				Layer.merge(
					makePersistenceEffectLayer(
						join(root, filename),
						"test-project",
						undefined,
						bus,
					),
					bus,
				),
			),
		),
	);
};
const verdict = (sessionId: string, messageId: string, partId: string) =>
	canonicalEvent(
		"text.surfaced",
		sessionId,
		{
			messageId,
			partId,
			ordinal: 1,
			categorySetVersion: 1,
			model: "jev",
			probabilities: null,
		},
		{ provider: "conduit" },
	);
const seed = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	for (const [sid, suffix, forkedFrom] of [
		["parent", "", undefined],
		["fork", "_fork", "parent"],
		["other", "_other", undefined],
	] as const) {
		yield* commit([
			canonicalEvent("session.created", sid, {
				sessionId: sid,
				title: sid,
				provider: "claude",
				...(forkedFrom && { forkedFrom }),
			}),
			canonicalEvent("message.created", sid, {
				sessionId: sid,
				messageId: `m${suffix}`,
				role: "assistant",
			}),
			canonicalEvent("text.delta", sid, {
				messageId: `m${suffix}`,
				partId: `p${suffix}`,
				text: "Finding",
			}),
			canonicalEvent("text.delta", sid, {
				messageId: `m${suffix}`,
				partId: `unjudged${suffix}`,
				text: "Not surfaced",
			}),
			verdict(sid, `m${suffix}`, `p${suffix}`),
			canonicalEvent("turn.completed", sid, { messageId: `m${suffix}` }),
		]);
	}
});
const flags = (sessionId: string) =>
	Effect.gen(function* () {
		const read = yield* ReadQueryEffectTag;
		const page = yield* read.readSessionTranscriptPage(sessionId, {
			limit: 50,
			previewTools: true,
		});
		return messageRowsToHistory(page.messages, {
			pageSize: 50,
		}).messages.flatMap((message) => message.parts ?? []);
	});
const readOf = (sessionId: string, partId: string) =>
	flags(sessionId).pipe(
		Effect.map(
			(parts) => parts.find((part) => part.id === partId)?.surfacingRead,
		),
	);

it("stamps the part and message, leaves the sidebar alone, and survives reopening", async () => {
	try {
		await run("durable.db", (advances) =>
			Effect.gen(function* () {
				yield* seed;
				const sql = yield* SqlClient.SqlClient;
				const sidebar =
					yield* sql`SELECT id, seen_version, unread, version FROM sessions ORDER BY id`;
				const before =
					(yield* (yield* ReadQueryEffectTag).readSessionTranscript("parent"))
						.version;
				expect(yield* readOf("parent", "p")).toBe(false);
				expect(
					(yield* flags("parent")).find((part) => part.id === "unjudged"),
				).not.toHaveProperty("surfacingRead");
				advances.length = 0;
				expect(yield* setRead(["p"], true, "parent")).toBe(true);
				expect(
					yield* sql`SELECT id, seen_version, unread, version FROM sessions ORDER BY id`,
				).toEqual(sidebar);
				expect(advances.map((advance) => advance.sessionIds)).toEqual([
					["parent"],
				]);
				const delta = yield* (yield* ReadQueryEffectTag).readSessionTranscript(
					"parent",
					{ after: before },
				);
				expect(
					messageRowsToHistory(delta.messages, {
						pageSize: 50,
					}).messages[0]?.parts?.find((part) => part.id === "p")?.surfacingRead,
				).toBe(true);
				expect(yield* setRead(["p"], true, "parent")).toBe(false);
				expect(advances).toHaveLength(1);
				expect(yield* readOf("fork", "p_fork")).toBe(false);
			}),
		);
		await run("durable.db", () =>
			Effect.gen(function* () {
				expect(yield* readOf("parent", "p")).toBe(true);
				expect(yield* setRead(["p"], false, "parent")).toBe(true);
				expect(yield* readOf("parent", "p")).toBe(false);
			}),
		);
		await run("durable.db", () =>
			Effect.gen(function* () {
				expect(yield* readOf("parent", "p")).toBe(false);
			}),
		);
	} finally {
		rmSync(join(root, "durable.db"), { force: true });
	}
});

it("keeps the flag through snapshot replay and recovery, and drops it with the session", async () => {
	await run("snapshot-replay.db", () =>
		Effect.gen(function* () {
			yield* seed;
			const commit = yield* makeCommitAndSignal;
			for (const partIds of [["p"], ["p", "p2"]]) {
				yield* commit([
					canonicalEvent(
						"message.snapshot",
						"parent",
						{
							messageId: "m",
							message: {
								id: "m",
								sessionID: "parent",
								role: "assistant",
								time: { created: 100 },
								parts: partIds.map((id) => ({ id, type: "text", text: id })),
							},
							digest: partIds.join(","),
						},
						{ metadata: { rawSource: "opencode.rest" } },
					),
				]);
			}
			yield* commit([verdict("parent", "m", "p2")]);
			expect(yield* setRead(["p2"], true, "parent")).toBe(true);
			expect(yield* readOf("parent", "p2")).toBe(true);
			const snapshots = (yield* (yield* EventStoreEffectTag).readBySession(
				"parent",
			)).filter((event) => event.type === "message.snapshot");
			expect(snapshots).toHaveLength(2);
			const [firstSnapshot] = snapshots;
			if (!firstSnapshot) throw new Error("expected the first snapshot");
			const runner = yield* ProjectionRunnerEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const annotations =
				yield* sql`SELECT * FROM message_part_read_state ORDER BY session_id, part_id`;
			// The first snapshot deletes p2; the annotation must not go with it.
			yield* runner.projectEvent(firstSnapshot);
			expect(yield* sql`SELECT id FROM message_parts WHERE id = 'p2'`).toEqual(
				[],
			);
			expect(
				yield* sql`SELECT * FROM message_part_read_state ORDER BY session_id, part_id`,
			).toEqual(annotations);
			yield* sql`UPDATE projector_cursors SET last_applied_seq = 0`;
			expect((yield* runner.recover()).totalReplayed).toBeGreaterThan(0);
			expect(yield* readOf("parent", "p2")).toBe(true);
			yield* sql`DELETE FROM sessions WHERE id = 'parent'`;
			expect(
				yield* sql`SELECT part_id FROM message_part_read_state WHERE session_id = 'parent'`,
			).toEqual([]);
		}),
	);
});

it("marks only the session's own text parts in its own project", async () => {
	await run("scope.db", (advances) =>
		Effect.gen(function* () {
			yield* seed;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE sessions SET project_id = 'foreign-project' WHERE id = 'other'`;
			yield* (yield* makeCommitAndSignal)([
				canonicalEvent("tool.started", "parent", {
					messageId: "m",
					partId: "tool",
					toolName: "Bash",
					callId: "call",
					input: { tool: "Bash", command: "ls" },
				}),
			]);
			advances.length = 0;
			for (const [parts, sid] of [
				[["p_other"], "parent"],
				[["p_other"], "other"],
				[["p_fork"], "parent"],
				[["tool"], "parent"],
				[["missing"], "parent"],
				[["p"], "missing"],
			] as const)
				expect(yield* setRead(parts, true, sid)).toBe(false);
			expect(advances).toEqual([]);
			expect(yield* sql`SELECT * FROM message_part_read_state`).toEqual([]);
		}),
	);
});

it("starts a conduit-side fork with its parent's flags, then keeps them apart", async () => {
	await run("fork.db", () =>
		Effect.gen(function* () {
			yield* seed;
			yield* setRead(["p"], true, "parent");
			yield* inheritRead("parent", "fork");
			expect(yield* readOf("fork", "p_fork")).toBe(true);
			yield* setRead(["p_fork"], false, "fork");
			expect(yield* readOf("fork", "p_fork")).toBe(false);
			expect(yield* readOf("parent", "p")).toBe(true);
		}),
	);
});
