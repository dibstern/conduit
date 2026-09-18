import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import {
	addClient,
	bindClientSession,
	broadcast,
	broadcastPerSessionEvent,
	makeWsHandlerStateLive,
	markClientBootstrapped,
	sendTo,
	sendToSession,
} from "../../../src/lib/domain/relay/Services/ws-handler-service.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";

it("gives every WS delivery of one turn a stable identity, and the next turn a new identity", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES ('s1', 'claude', 'session', 1, 1)`;
			yield* sql`INSERT INTO turns (id, session_id, requested_at) VALUES ('t1', 's1', 1)`;
			const sent: Array<{ alertId?: string }> = [];
			yield* addClient("c1", {
				readyState: 1,
				close() {},
				send(data) {
					sent.push(JSON.parse(data));
				},
			});
			yield* bindClientSession("c1", "s1");
			yield* markClientBootstrapped("c1");
			const done = { type: "done", sessionId: "s1", code: 0 } as const;
			yield* sendTo("c1", done);
			yield* sendToSession("s1", done);
			yield* broadcastPerSessionEvent("s1", done);
			yield* broadcast({
				type: "notification_event",
				sessionId: "s1",
				eventType: "done",
			});
			expect(sent[0]?.alertId).toBeTypeOf("string");
			expect(new Set(sent.map((x) => x.alertId)).size).toBe(1);
			yield* sql`INSERT INTO turns (id, session_id, requested_at) VALUES ('t2', 's1', 2)`;
			yield* broadcast(done);
			expect(sent[4]?.alertId).not.toBe(sent[0]?.alertId);
		}).pipe(
			Effect.provide(
				Layer.merge(
					makePersistenceEffectLayer(":memory:"),
					makeWsHandlerStateLive(),
				),
			),
		),
	);
});

it("anchors alerts without turns on the last message and preserves error identity across paths", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, title, last_message_at, created_at, updated_at) VALUES ('s1', 'opencode', 'session', 100, 1, 1)`;
			const sent: Array<{ alertId?: string }> = [];
			yield* addClient("c1", {
				readyState: 1,
				close() {},
				send(data) {
					sent.push(JSON.parse(data));
				},
			});
			yield* broadcast({
				type: "error",
				sessionId: "s1",
				code: "ERR",
				message: "rate limited",
			});
			yield* broadcast({
				type: "notification_event",
				sessionId: "s1",
				eventType: "error",
				message: "rate limited",
			});
			yield* broadcast({
				type: "error",
				sessionId: "s1",
				code: "ERR",
				message: "disk full",
			});
			expect(sent[0]?.alertId).toBeTypeOf("string");
			expect(sent[1]?.alertId).toBe(sent[0]?.alertId);
			expect(sent[2]?.alertId).not.toBe(sent[0]?.alertId);
			yield* sql`UPDATE sessions SET last_message_at = 200 WHERE id = 's1'`;
			yield* broadcast({
				type: "error",
				sessionId: "s1",
				code: "ERR",
				message: "rate limited",
			});
			expect(sent[3]?.alertId).not.toBe(sent[0]?.alertId);
		}).pipe(
			Effect.provide(
				Layer.merge(
					makePersistenceEffectLayer(":memory:"),
					makeWsHandlerStateLive(),
				),
			),
		),
	);
});
