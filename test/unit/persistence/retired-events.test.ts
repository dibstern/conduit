// Failure modes: retired rows stop decoding; a retired tool update changes the
// fork's projected tool input; copying history appends retired events again.

import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { readForkSource } from "../../../src/lib/persistence/fork-history.js";

const testLayer = makePersistenceEffectLayer(":memory:", "test-project");

describe("retired stored events", () => {
	it.effect("reads stored rows of all three retired event types", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* EventStoreEffectTag;
			const rows = [
				{
					type: "tool.input_updated",
					data: { messageId: "m", partId: "p", input: "legacy" },
				},
				{ type: "session.read", data: { sessionId: "parent" } },
				{ type: "session.unread", data: { sessionId: "parent" } },
			] as const;
			for (const [version, row] of rows.entries()) {
				yield* sql`INSERT INTO events
					(project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
					VALUES ('test-project', ${`old-${version}`}, 'parent', ${version}, ${row.type},
						${JSON.stringify(row.data)}, '{}', 'claude', 100)`;
			}
			expect(
				(yield* store.readAllBySession("parent")).map(({ type, data }) => ({
					type,
					data,
				})),
			).toEqual(rows);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"preserves the fork read model with a historical tool input update",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const store = yield* EventStoreEffectTag;
				const queries = yield* ReadQueryEffectTag;
				yield* commit([
					canonicalEvent("session.created", "parent", {
						sessionId: "parent",
						title: "Parent",
						provider: "claude",
					}),
					canonicalEvent("message.created", "parent", {
						sessionId: "parent",
						messageId: "m",
						role: "assistant",
					}),
					canonicalEvent("tool.started", "parent", {
						messageId: "m",
						partId: "p",
						callId: "c",
						toolName: "Read",
						input: { tool: "Read", filePath: "/original" },
					}),
					canonicalEvent("tool.completed", "parent", {
						messageId: "m",
						partId: "p",
						result: "done",
						duration: 5,
					}),
					canonicalEvent("turn.completed", "parent", { messageId: "m" }),
				]);
				// Simulate an old store, independently of the current append contract.
				yield* sql`INSERT INTO events
				(project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
				VALUES ('test-project', 'old-tool-input', 'parent', 5, 'tool.input_updated',
					' {"messageId":"m","partId":"p","input":"changed"}', '{}', 'claude', 100)`;
				const source = yield* readForkSource("parent", { sideThread: false });
				yield* commit([
					canonicalEvent("session.created", "fork", {
						sessionId: "fork",
						title: "Fork",
						provider: "claude",
					}),
					...(yield* source.copy("fork")),
				]);
				expect(
					yield* queries.getSessionMessagesWithParts("fork"),
				).toMatchObject([
					{
						id: "m_fork",
						role: "assistant",
						parts: [
							{
								id: "p_fork",
								tool_name: "Read",
								input: JSON.stringify({ tool: "Read", filePath: "/original" }),
								result: '"done"',
							},
						],
					},
				]);
				const forkHistory = yield* store.readAllBySession("fork");
				for (const type of [
					"tool.input_updated",
					"session.read",
					"session.unread",
				])
					expect(forkHistory.map((event) => event.type)).not.toContain(type);
			}).pipe(Effect.provide(testLayer)),
	);
});
