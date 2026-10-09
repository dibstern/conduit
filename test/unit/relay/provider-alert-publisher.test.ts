import { SqlClient } from "@effect/sql";
import { Chunk, Effect, PubSub, Queue } from "effect";
import { expect, it, vi } from "vitest";
import type { Alert } from "../../../src/lib/contracts/ws-rpc.js";
import {
	AlertLedgerTag,
	makeAlertLedger,
} from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import {
	AlertsLive,
	AlertsTag,
} from "../../../src/lib/domain/relay/Services/alerts.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { translateDomainEventToRelay } from "../../../src/lib/relay/domain-event-to-relay.js";
import { publishProviderRelayMessage } from "../../../src/lib/relay/relay-stack.js";
import { tagWithSessionId } from "../../../src/lib/shared-types.js";

it("pushes canonical terminal alerts, preserves replay identity, and suppresses subagent completion", async () => {
	const sendToAll = vi.fn(async () => ({
		delivered: ["device"],
		failed: [],
		expired: [],
	}));
	const alerts = await Effect.runPromise(
		Effect.gen(function* () {
			const subscribed = yield* PubSub.subscribe(yield* AlertsTag);
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, title, provider, created_at, updated_at) VALUES ('s1', 's1', 'claude', 1, 1)`;
			yield* sql`INSERT INTO sessions (id, title, provider, created_at, updated_at, parent_id) VALUES ('child', 'child', 'claude', 1, 1, 's1')`;
			const ledger = yield* makeAlertLedger;
			const deps = {
				wsHandler: {
					getClientsForSession: () => [],
				},
				pushManager: { sendToAll },
				log: createSilentLogger(),
				slug: "project",
			};
			for (const [sessionId, messageId] of [
				["s1", "m1"],
				["s1", "m2"],
				["s1", "m1"],
				["child", "m3"],
			] as const) {
				const result = translateDomainEventToRelay(
					canonicalEvent("turn.completed", sessionId, { messageId }),
				);
				if (result.kind !== "emit")
					throw new Error("expected terminal messages");
				for (const msg of result.messages)
					yield* publishProviderRelayMessage(
						tagWithSessionId(msg, sessionId),
						deps,
					).pipe(Effect.provideService(AlertLedgerTag, ledger));
			}
			return Chunk.toArray(yield* Queue.takeAll(subscribed));
		}).pipe(
			Effect.scoped,
			Effect.provide(AlertsLive),
			Effect.provide(makePersistenceEffectLayer(":memory:")),
		),
	);
	expect(sendToAll).toHaveBeenCalledTimes(2);
	expect(sendToAll).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({ alertId: '["s1","m1","done"]' }),
	);
	expect(sendToAll).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({ alertId: '["s1","m2","done"]' }),
	);
	expect(alerts).toContainEqual(
		expect.objectContaining<Partial<Alert>>({
			_tag: "alert",
			kind: "done",
			alertId: '["s1","m1","done"]',
			sessionId: "s1",
		}),
	);
	// Subagent completion is suppressed in-app as well as on push.
	expect(alerts.map((alert) => alert.sessionId)).not.toContain("child");
});
