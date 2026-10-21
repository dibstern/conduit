import { Effect, Layer, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { SessionHandoffDeliveredPayloadSchema } from "../../../contracts/stored-event.js";
import { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { SessionEventBusTag } from "./session-event-bus.js";

/** Native resume state survives only a successfully completed handoff. */
export const HandoffReceiptsLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const persist = yield* ClaudeEventPersistEffectTag;
		const bus = yield* SessionEventBusTag;
		const events = yield* bus.subscribe();
		yield* events.pipe(
			Stream.runForEach((event) => {
				if (!event.runEnded) return Effect.void;
				return Effect.gen(function* () {
					const commands = yield* sql<{
						command_id: string;
						instance_id: string;
						handoff: string;
					}>`
						SELECT o.command_id, COALESCE(json_extract(o.payload_json, '$.instanceId'), o.provider_id) AS instance_id,
						json_extract(o.payload_json, '$.handoff') AS handoff
						FROM provider_command_outbox o JOIN provider_runs r ON r.id = o.run_id
						WHERE o.session_id = ${event.sessionId} AND o.project_key = ${store.projectId}
						AND o.effect_type = 'send_turn' AND o.status = 'completed'
						AND (r.id = ${event.metadata.runId ?? null} OR r.joined_into = ${event.metadata.runId ?? null})
						AND json_type(o.payload_json, '$.handoff') = 'object'`;
					for (const command of commands) {
						const handoff = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(SessionHandoffDeliveredPayloadSchema),
						)(command.handoff);
						yield* persist.persistHandoffDelivered(
							event.sessionId,
							{
								...handoff,
								instanceId: handoff.instanceId ?? command.instance_id,
							},
							command.command_id,
						);
					}
				}).pipe(
					Effect.catch((cause) =>
						Effect.logError(
							"Could not record completed provider handoff",
							cause,
						),
					),
				);
			}),
			Effect.forkScoped,
		);
	}),
);
