import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { formatErrorDetail } from "../../../errors.js";
import { createEventId } from "../../../persistence/events.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import { LoggerTag } from "./services.js";

export type TurnFailureOwner =
	| { readonly runId: string }
	| { readonly inputId: string; readonly runId?: undefined };

/** Silence is visible, but does not prove that native work has ended. */
export const makeSilenceNotice = Effect.gen(function* () {
	const ingestion = yield* ProviderRuntimeIngestionTag;
	const sql = yield* SqlClient.SqlClient;
	const log = yield* LoggerTag;
	return (sessionId: string, runId: string, continuation?: boolean) =>
		Effect.gen(function* () {
			const [run] = yield* sql<{ id: string; continuation: number }>`
				SELECT run.id, EXISTS (SELECT 1 FROM provider_command_outbox command
					WHERE command.run_id = run.id AND json_extract(command.payload_json,
						'$.continuation.cutOffMessageId') IS NOT NULL) AS continuation
				FROM provider_runs reservation JOIN provider_runs run
					ON run.id = COALESCE(reservation.joined_into, reservation.id)
				WHERE reservation.id = ${runId} AND run.session_id = ${sessionId}
					AND run.status = 'running' AND run.started_at IS NOT NULL`;
			if (!run) return;
			yield* ingestion.ingestBatch([
				{
					eventId: createEventId(),
					providerId: "conduit",
					sessionId,
					runId: run.id,
					providerRefs: {},
					rawSource: { kind: "conduit.turn-notice" },
					createdAt: Date.now(),
					type: "turn.notice",
					data: {
						text:
							(continuation ?? run.continuation === 1)
								? "The continuation got no response. Stop it to try again."
								: "No response for 2 minutes. The model may be unavailable or your usage quota may be used up. Stop this turn to try a different model.",
					},
				},
			]);
		}).pipe(
			Effect.asVoid,
			Effect.catch((cause) =>
				Effect.sync(() =>
					log.warn(
						`session=${sessionId} Could not record silence notice: ${formatErrorDetail(cause)}`,
					),
				),
			),
		);
});

/**
 * End a turn that Conduit itself failed: a send that never reached the
 * provider. The failure is a
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
			retryable = false,
		}: {
			beforeCommit?: Effect.Effect<void, SqlError>;
			beforeProject?: Effect.Effect<void, SqlError>;
			settleSession?: boolean;
			retryable?: boolean;
		} = {},
	): Effect.Effect<void> => {
		const runId = owner.runId;
		const inputId = runId === undefined ? owner.inputId : undefined;
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
				retryable,
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
				!runId && inputId && Option.isSome(sql)
					? yield* sql.value<{ run_id: string | null }>`SELECT COALESCE(
				(SELECT run_id FROM provider_command_outbox
				 WHERE session_id = ${sessionId} AND effect_type = 'send_turn' AND command_id = ${inputId}
				 ORDER BY request_sequence DESC LIMIT 1),
				(SELECT run_id FROM turns WHERE session_id = ${sessionId} AND (id = ${inputId}
				 OR user_message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId} AND input_id = ${inputId})))) AS run_id`
					: [];
			const reservedRunId = runId ?? reservation?.run_id ?? undefined;
			const [resolved] =
				reservedRunId && Option.isSome(sql)
					? yield* sql.value<{
							run_id: string;
						}>`SELECT COALESCE(joined_into, id) AS run_id FROM provider_runs
					WHERE session_id = ${sessionId} AND id = ${reservedRunId}`
					: [];
			const effectiveRunId = resolved?.run_id ?? reservedRunId;
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
