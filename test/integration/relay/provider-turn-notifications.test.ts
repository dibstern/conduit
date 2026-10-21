import { Effect, Layer, PubSub } from "effect";
import { SqlClient } from "effect/sql";
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

it("persists Claude content for a session without a session.created event", async () => {
	const layer = makeProviderRuntimeIngestionLive().pipe(
		Layer.provideMerge(makePersistenceEffectLayer(":memory:", "test-project")),
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			expect(
				yield* sql`SELECT id FROM sessions WHERE id = 'first-seen'`,
			).toEqual([]);
			yield* ingestion.ingest(
				providerRuntimeEvent("message.created", "first-seen", {
					messageId: "first-message",
					sessionId: "first-seen",
					role: "assistant",
				}),
			);
			yield* ingestion.ingest(
				providerRuntimeEvent("text.delta", "first-seen", {
					messageId: "first-message",
					partId: "first-part",
					text: "First content",
				}),
			);
			yield* ingestion.drain();
			expect(
				yield* sql`SELECT id, project_id, provider, title FROM sessions WHERE id = 'first-seen'`,
			).toEqual([
				{
					id: "first-seen",
					project_id: "test-project",
					provider: "claude",
					title: "Untitled",
				},
			]);
			expect(
				yield* sql`SELECT id, session_id, role, text FROM messages WHERE session_id = 'first-seen'`,
			).toEqual([
				{
					id: "first-message",
					session_id: "first-seen",
					role: "assistant",
					text: "First content",
				},
			]);
			expect(
				yield* sql`SELECT id, message_id, type, text FROM message_parts WHERE message_id = 'first-message'`,
			).toEqual([
				{
					id: "first-part",
					message_id: "first-message",
					type: "text",
					text: "First content",
				},
			]);
			const events = yield* sql<{
				event_id: string;
				type: string;
				provider: string;
				data: string;
			}>`SELECT event_id, type, provider, data FROM events WHERE session_id = 'first-seen' ORDER BY sequence`;
			expect(
				events.map((row) => ({ ...row, data: JSON.parse(row.data) })),
			).toEqual([
				{
					event_id: "evt_message.created",
					type: "message.created",
					provider: "claude",
					data: {
						messageId: "first-message",
						sessionId: "first-seen",
						role: "assistant",
					},
				},
				{
					event_id: "evt_text.delta",
					type: "text.delta",
					provider: "claude",
					data: {
						messageId: "first-message",
						partId: "first-part",
						text: "First content",
					},
				},
			]);
		}).pipe(Effect.scoped, Effect.provide(layer)),
	);
});

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
			return [
				...(yield* PubSub.takeUpTo(subscribed, Number.POSITIVE_INFINITY)),
			];
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
