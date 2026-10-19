import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type {
	PermissionResolvedPayload,
	QuestionResolvedPayload,
} from "../../contracts/stored-event.js";
import {
	PendingInteractionCancelled,
	type PendingInteractionService,
} from "../../domain/relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestion } from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createEventId } from "../../persistence/events.js";
import {
	createRelayEventSink,
	type RelayEventSinkDeps,
} from "../relay-event-sink.js";
import type { PermissionResponse } from "../types.js";

/** Restore live waiters without appending interactions already in the store. */
export const makeRecoveredEventSink = (options: {
	readonly sessionId: string;
	readonly driverKind?: string;
	readonly sql: SqlClient.SqlClient;
	readonly ingestion: ProviderRuntimeIngestion;
	readonly pending: PendingInteractionService;
	readonly onRegistered: (requestId: string) => Effect.Effect<unknown>;
	/** Without these, an answered question's re-armed timeout fails a live turn. */
	readonly timeoutHooks: Pick<
		RelayEventSinkDeps,
		"clearTimeout" | "resetTimeout"
	>;
}) => {
	const { sessionId, sql, ingestion, pending } = options;
	const sink = createRelayEventSink({
		sessionId,
		providerId: options.driverKind ?? "claude",
		...options.timeoutHooks,
		ingestion,
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
					const [row] = yield* sql<{
						provider_request_id: string | null;
					}>`SELECT provider_request_id FROM pending_approvals WHERE id = ${request.requestId} AND session_id = ${sessionId}`;
					yield* options.onRegistered(
						row?.provider_request_id ?? request.requestId,
					);
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
					const [row] = yield* sql<{
						provider_request_id: string | null;
					}>`SELECT provider_request_id FROM pending_approvals WHERE id = ${request.requestId} AND session_id = ${sessionId}`;
					yield* options.onRegistered(
						row?.provider_request_id ?? request.requestId,
					);
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
	return {
		...sink,
		requestQuestion: (request: Parameters<typeof sink.requestQuestion>[0]) =>
			sink.requestQuestion(request).pipe(
				Effect.tapError((error) => {
					if (
						!(error instanceof PendingInteractionCancelled) ||
						error.recovered ||
						!request.toolUseId
					)
						return Effect.void;
					return Effect.gen(function* () {
						// An uncommitted ask can still have a durable tool snapshot. Its
						// legacy recovery entry must not outlive this failed request.
						const questions = yield* pending.listPendingQuestions(sessionId);
						const recovered = questions.find(
							(question) =>
								question.recovered && question.requestId === request.toolUseId,
						);
						if (!recovered) return;
						yield* pending.cancelSessionInteractions(
							sessionId,
							"Question request failed",
							{ requestIds: new Set([recovered.requestId]) },
						);
						yield* ingestion.ingest({
							eventId: createEventId(),
							type: "tool.completed",
							providerId: options.driverKind ?? "claude",
							sessionId,
							providerRefs: { providerToolUseId: request.toolUseId },
							rawSource: { kind: "relay.recovered-question-failed" },
							createdAt: Date.now(),
							data: {
								partId: recovered.partId ?? request.toolUseId,
								...(recovered.messageId
									? { messageId: recovered.messageId }
									: {}),
								result: null,
								duration: 0,
							},
						});
					}).pipe(
						Effect.catch((cause) =>
							Effect.logWarning(
								"Failed to finish cancelled recovered question",
								cause,
							),
						),
					);
				}),
			),
	};
};
