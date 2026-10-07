import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type {
	PermissionResolvedPayload,
	QuestionResolvedPayload,
} from "../../contracts/stored-event.js";
import type { PendingInteractionService } from "../../domain/relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestion } from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createRelayEventSink } from "../relay-event-sink.js";
import type { PermissionResponse } from "../types.js";

/** Restore live waiters without appending interactions already in the store. */
export const makeRecoveredClaudeEventSink = (options: {
	readonly sessionId: string;
	readonly sql: SqlClient.SqlClient;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly pending: PendingInteractionService;
	readonly onRegistered: (requestId: string) => Effect.Effect<unknown>;
}) => {
	const { sessionId, sql, ingestion, pending } = options;
	return createRelayEventSink({
		sessionId,
		providerId: "claude",
		ingestion: {
			ingest: (event) =>
				Effect.gen(function* () {
					if (
						event.type === "permission.asked" ||
						event.type === "permission.resolved" ||
						event.type === "question.asked" ||
						event.type === "question.resolved"
					) {
						const id = (event.data as { id?: string }).id;
						if (id) {
							const existing =
								yield* sql`SELECT 1 FROM events WHERE session_id = ${sessionId} AND type = ${event.type} AND json_extract(data, '$.id') = ${id} LIMIT 1`;
							if (existing.length > 0)
								// A replay still needs its cursor committed, even when the ask
								// was restored separately from the sequenced output stream.
								return yield* ingestion.ingestBatch([], {
									publishToBus: false,
									publishToRelay: false,
								});
						}
					}
					return yield* ingestion.ingest(event);
				}),
		},
		pendingInteractions: {
			beginPermissionRequest: (request) =>
				Effect.gen(function* () {
					const waiter = yield* pending.beginPermissionRequest(request);
					const resolved = yield* sql<{
						data: string;
					}>`SELECT data FROM events WHERE session_id = ${sessionId} AND type = 'permission.resolved' AND json_extract(data, '$.id') = ${request.requestId} ORDER BY sequence DESC LIMIT 1`;
					if (resolved[0]) {
						const stored = JSON.parse(
							resolved[0].data,
						) as PermissionResolvedPayload;
						const replies = yield* sql<{
							response_json: string;
						}>`SELECT response_json FROM claude_runner_permission_replies WHERE session_id = ${sessionId} AND request_id = ${request.requestId}`;
						const response = replies[0]
							? (JSON.parse(replies[0].response_json) as PermissionResponse)
							: { decision: stored.decision };
						yield* pending.resolvePermissionRequest(
							request.requestId,
							response,
						);
					}
					yield* options.onRegistered(request.requestId);
					return waiter;
				}).pipe(Effect.orDie),
			resolvePermissionRequest: (id, response) =>
				pending.resolvePermissionRequest(id, response),
			beginQuestionRequest: (request) =>
				Effect.gen(function* () {
					const waiter = yield* pending.beginQuestionRequest(request);
					const resolved = yield* sql<{
						data: string;
					}>`SELECT data FROM events WHERE session_id = ${sessionId} AND type = 'question.resolved' AND json_extract(data, '$.id') = ${request.requestId} ORDER BY sequence DESC LIMIT 1`;
					if (resolved[0]) {
						const response = JSON.parse(
							resolved[0].data,
						) as QuestionResolvedPayload;
						yield* pending.resolveQuestionRequest(
							request.requestId,
							response.answers,
						);
					}
					yield* options.onRegistered(request.requestId);
					return waiter;
				}).pipe(Effect.orDie),
			resolveQuestionRequest: (id, answers) =>
				pending.resolveQuestionRequest(id, answers),
			cancelSessionInteractions: (reason, interactionOptions) =>
				pending.cancelSessionInteractions(
					sessionId,
					reason,
					interactionOptions,
				),
		},
	});
};
