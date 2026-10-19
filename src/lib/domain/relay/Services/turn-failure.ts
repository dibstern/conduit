import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { formatErrorDetail } from "../../../errors.js";
import { createEventId } from "../../../persistence/events.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import { LoggerTag } from "./services.js";

export type TurnFailureOwner =
	| { readonly runId: string; readonly inputId?: string }
	| { readonly inputId: string; readonly runId?: undefined };

/**
 * End a turn that Conduit itself failed: a send that never reached the
 * provider, or a turn that went silent past its timeout. The failure is a
 * canonical `turn.error`, so the transcript shows it and keeps it across a
 * reload. The idle status settles the shell row, the client's busy signal.
 *
 * Only for failures Conduit owns. A provider that fails a turn it was handed
 * records its own `turn.error`, so calling this too would show it twice.
 *
 * Resolved up front so a timeout callback, which runs with no services, can
 * call it.
 */
export const makeFailTurn = Effect.gen(function* () {
	const ingestion = yield* ProviderRuntimeIngestionTag;
	const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
	const log = yield* LoggerTag;
	return (
		sessionId: string,
		error: string,
		code: string,
		owner: TurnFailureOwner,
		{
			beforeCommit,
			beforeProject,
			settleSession = true,
		}: {
			beforeCommit?: Effect.Effect<void, SqlError>;
			beforeProject?: Effect.Effect<void, SqlError>;
			settleSession?: boolean;
		} = {},
	): Effect.Effect<void> => {
		const { runId, inputId: userMessageId } = owner;
		const errorId = createEventId();
		const event = <K extends ProviderRuntimeEvent["type"]>(
			eventId: string,
			type: K,
			data: Record<string, unknown>,
		) => ({
			eventId,
			type,
			providerId: "conduit",
			sessionId,
			providerRefs: {},
			rawSource: { kind: "conduit.turn-failure" },
			createdAt: Date.now(),
			data,
		});
		const events = [
			// Its own id: no assistant message of this turn may exist, and the
			// mapper would otherwise fall back to the previous turn's.
			event(errorId, "turn.error", {
				messageId: errorId,
				error,
				code,
				...(userMessageId ? { userMessageId } : {}),
			}),
			...(settleSession
				? [
						event(createEventId(), "session.status", {
							sessionId,
							status: "idle",
						}),
					]
				: []),
		];
		return Effect.gen(function* () {
			const [reservation] =
				!runId && userMessageId && Option.isSome(sql)
					? yield* sql.value<{ run_id: string | null }>`SELECT COALESCE(
				(SELECT json_extract(payload_json, '$.runId') FROM provider_command_outbox
				 WHERE session_id = ${sessionId} AND effect_type = 'send_turn' AND command_id = ${userMessageId}
				 ORDER BY request_sequence DESC LIMIT 1),
				(SELECT run_id FROM turns WHERE session_id = ${sessionId} AND (id = ${userMessageId}
				 OR user_message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId} AND input_id = ${userMessageId})))) AS run_id`
					: [];
			const reservedRunId = runId ?? reservation?.run_id ?? undefined;
			const [acceptance] =
				reservedRunId && Option.isSome(sql)
					? yield* sql.value<{
							run_id: string;
						}>`SELECT json_extract(metadata, '$.runId') AS run_id
					FROM events WHERE session_id = ${sessionId} AND type = 'run.started'
					AND json_extract(data, '$.requestedRunId') = ${reservedRunId} ORDER BY sequence LIMIT 1`
					: [];
			const effectiveRunId = acceptance?.run_id ?? reservedRunId;
			const ownedEvents = events.map((event) =>
				effectiveRunId ? { ...event, runId: effectiveRunId } : event,
			);
			return yield* (
				beforeCommit || beforeProject
					? ingestion.ingestBatch(ownedEvents, {
							...(beforeCommit ? { beforeCommit } : {}),
							...(beforeProject ? { beforeProject } : {}),
						})
					: ingestion.ingestBatch(ownedEvents)
			).pipe(
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.sync(() => {
						log.warn(
							`session=${sessionId} Could not record turn failure: ${formatErrorDetail(cause)}`,
						);
					}),
				),
			);
		}).pipe(Effect.catch(() => Effect.void));
	};
});
