import { SqlClient } from "effect/sql";
import { Chunk, Effect, Layer, PubSub, Queue } from "effect";
import { expect, it, vi } from "vitest";
import {
	AlertLedgerLive,
	AlertLedgerTag,
} from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import {
	AlertsLive,
	AlertsTag,
} from "../../../src/lib/domain/relay/Services/alerts.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { publishProviderRelayMessage } from "../../../src/lib/relay/project-relay-publisher.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

it.each([
	{ type: "turn.completed", kind: "done", alertId: '["s1","m1","done"]' },
	{
		type: "turn.error",
		kind: "error",
		alertId: '["s1","m1","error","failed"]',
	},
	{ type: "turn.interrupted", kind: "done", alertId: '["s1","m1","done"]' },
] as const)("publishes in-app and push notifications for ingested $type", async (expected) => {
	const sendToAll = vi.fn(async () => ({
		delivered: ["device"],
		failed: [],
		expired: [],
	}));
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	const layer = Layer.unwrap(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const alerts = yield* AlertsTag;
			const ledger = yield* AlertLedgerTag;
			return makeProviderRuntimeIngestionLive({
				relayPublisher: {
					publish: (message) =>
						publishProviderRelayMessage(message, {
							wsHandler: { getClientsForSession: () => [] },
							pushManager: { sendToAll },
							log: createSilentLogger(),
							slug: "project",
						}).pipe(
							Effect.provideService(SqlClient.SqlClient, sql),
							Effect.provideService(AlertsTag, alerts),
							Effect.provideService(AlertLedgerTag, ledger),
						),
				},
			});
		}),
	).pipe(
		Layer.provideMerge(AlertsLive),
		Layer.provide(AlertLedgerLive),
		Layer.provide(persistence),
	);
	const alerts = await Effect.runPromise(
		Effect.gen(function* () {
			const subscribed = yield* PubSub.subscribe(yield* AlertsTag);
			const ingestion = yield* ProviderRuntimeIngestionTag;
			yield* ingestion.ingest(
				providerRuntimeEvent("session.created", "s1", {
					sessionId: "s1",
					title: "Test session",
					provider: "claude",
				}),
			);
			yield* ingestion.ingest(
				providerRuntimeEvent(expected.type, "s1", {
					messageId: "m1",
					error: "failed",
				}),
			);
			return Chunk.toArray(yield* Queue.takeAll(subscribed));
		}).pipe(Effect.scoped, Effect.provide(layer)),
	);
	expect(alerts).toEqual([
		{
			_tag: "alert",
			kind: expected.kind,
			alertId: expected.alertId,
			sessionId: "s1",
			...(expected.type === "turn.error" ? { message: "failed" } : {}),
		},
	]);
	expect(sendToAll).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ alertId: expected.alertId, sessionId: "s1" }),
	);
});
