// A turn's text parts are numbered, and their request found, in the order the
// store wrote the messages (conduit-test-lczrn.1).
// Failure modes: equal-time replies whose ids sort against write order number
// their parts in id or part order; a user message written after the reply at
// the same time becomes the reply's request.
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { DEFAULT_CATEGORY_SET } from "../../../src/lib/contracts/category-set.js";
import type { MessageSurfacingStatus } from "../../../src/lib/contracts/message-surfacing.js";
import { CategorySet } from "../../../src/lib/domain/daemon/Services/category-set.js";
import { MessageSurfacingSettings } from "../../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import { makeMessageSurfacing } from "../../../src/lib/domain/relay/Services/message-surfacing.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const status: MessageSurfacingStatus = {
	enabled: true,
	summariesEnabled: true,
	active: true,
	defaultLevel: "balanced",
	turnsOpen: "auto",
	recap: { model: "sonnet", when: "on-request" },
	tuningModel: "opus",
	key: { source: "stored", rejected: false },
};
const posted: unknown[] = [];
const layer = Layer.mergeAll(
	makePersistenceEffectLayer(":memory:", "test-project"),
	Layer.succeed(CategorySet, {
		current: () => Effect.succeed(DEFAULT_CATEGORY_SET),
		criteriaAtVersion: () => Effect.die("unused"),
		replace: () => Effect.die("unused"),
	}),
	Layer.succeed(MessageSurfacingSettings, {
		get: Effect.succeed(status),
		update: () => Effect.die("unused"),
		post: (body) =>
			Effect.sync(() => {
				posted.push(body);
				const ids = DEFAULT_CATEGORY_SET.categories
					.filter(({ retired }) => !retired)
					.map(({ id }) => id);
				return Response.json({
					answers: {
						category: {
							probabilities: Object.fromEntries([
								["routine", 1],
								...ids.map((id) => [id, 0]),
							]),
						},
					},
				});
			}),
	}),
);

describe("message surfacing", () => {
	it.live("numbers parts and finds the request in write order", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// Replies written z then a at one time; a later prompt at that time.
			yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 'Surfacing', 'busy', 1, 1)`;
			yield* sql`INSERT INTO turns (id, session_id, state, requested_at) VALUES ('turn', 's', 'running', 1)`;
			yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at, ordinal) VALUES
				('user-1', 's', NULL, 'user', 'Fix the issue', 1, 1, 1),
				('assistant-z', 's', 'turn', 'assistant', '', 2, 2, 2),
				('assistant-a', 's', 'turn', 'assistant', '', 2, 2, 3),
				('user-0', 's', NULL, 'user', 'Later ask', 2, 2, 4)`;
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES
				('z-text', 'assistant-z', 'text', 'From z', 5, 2, 2),
				('a-text', 'assistant-a', 'text', 'From a', 1, 2, 2)`;
			const surfacing = yield* makeMessageSurfacing;
			yield* surfacing.observe([
				canonicalEvent("text.delta", "s", {
					messageId: "assistant-a",
					partId: "a-text",
					text: "From a",
				}),
				canonicalEvent("tool.started", "s", {
					messageId: "assistant-a",
					partId: "a-tool",
					toolName: "Read",
					callId: "call",
					input: { tool: "Read", filePath: "/a" },
				}),
			]);
			const [surfaced] = yield* sql<{ ordinal: number }>`
				SELECT json_extract(data, '$.ordinal') AS ordinal FROM events
				WHERE type = 'text.surfaced'`.pipe(
				Effect.filterOrFail((rows) => rows.length > 0),
				Effect.retry(Schedule.spaced("10 millis")),
				Effect.timeout("5 seconds"),
			);
			expect(surfaced?.ordinal).toBe(2);
			expect(posted).toMatchObject([{ state: { request: "Fix the issue" } }]);
		}).pipe(Effect.scoped, Effect.provide(layer)),
	);
});
