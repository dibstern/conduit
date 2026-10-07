import { Effect } from "effect";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import { formatErrorDetail } from "../../../errors.js";
import { createEventId } from "../../../persistence/events.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import { LoggerTag } from "./services.js";

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
	const log = yield* LoggerTag;
	return (
		sessionId: string,
		error: string,
		code: string,
	): Effect.Effect<void> => {
		const errorId = createEventId();
		const event = (
			eventId: string,
			type: ProviderRuntimeEvent["type"],
			data: Record<string, unknown>,
		): ProviderRuntimeEvent => ({
			eventId,
			type,
			providerId: "conduit",
			sessionId,
			providerRefs: {},
			rawSource: { kind: "conduit.turn-failure" },
			createdAt: Date.now(),
			data,
		});
		return ingestion
			.ingestBatch([
				// Its own id: no assistant message of this turn may exist, and the
				// mapper would otherwise fall back to the previous turn's.
				event(errorId, "turn.error", { messageId: errorId, error, code }),
				event(createEventId(), "session.status", { sessionId, status: "idle" }),
			])
			.pipe(
				Effect.asVoid,
				Effect.catchAll((cause) =>
					Effect.sync(() => {
						log.warn(
							`session=${sessionId} Could not record turn failure: ${formatErrorDetail(cause)}`,
						);
					}),
				),
			);
	};
});
