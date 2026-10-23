import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import {
	PendingInteractionCancelled,
	type PendingInteractionService,
} from "../../domain/relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestion } from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createEventId } from "../../persistence/events.js";
import {
	createRelayEventSink,
	type RelayEventSinkDeps,
	toEventSinkError,
} from "../relay-event-sink.js";

/** Restore live waiters without appending interactions already in the store. */
export const makeRecoveredEventSink = (options: {
	readonly sessionId: string;
	readonly driverKind: string;
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
		providerId: options.driverKind,
		...options.timeoutHooks,
		ingestion,
		pendingInteractions: {
			beginPermissionRequest: (request) =>
				Effect.gen(function* () {
					const waiter = yield* pending.beginPermissionRequest(request);
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
		withdrawInteraction: (requestId: string, kind: "permission" | "question") =>
			Effect.gen(function* () {
				const [row] = yield* sql<{
					id: string;
					provider_process_id: string | null;
					provider_request_id: string | null;
				}>`SELECT id, provider_process_id, provider_request_id FROM pending_approvals WHERE session_id = ${sessionId} AND type = ${kind} AND status = 'pending' AND (provider_request_id = ${requestId} OR id = ${requestId}) ORDER BY created_at DESC LIMIT 1`;
				if (!row) return;
				const nativeId = row.provider_request_id ?? row.id;
				const event = {
					eventId: createEventId(),
					providerId: options.driverKind,
					sessionId,
					providerRefs: {
						providerRequestId: nativeId,
						...(row.provider_process_id != null && {
							providerProcessId: row.provider_process_id,
						}),
					},
					rawSource: { kind: "runner.interaction-withdrawn" },
					createdAt: Date.now(),
				};
				// Preserve the process and native request identity so ingestion finds
				// the durable card even when no interaction fiber survived attachment.
				yield* ingestion.ingest(
					kind === "permission"
						? {
								...event,
								type: "permission.resolved",
								data: { id: nativeId, decision: "reject" },
							}
						: {
								...event,
								type: "question.resolved",
								data: { id: nativeId, answers: {} },
							},
				);
				yield* pending.cancelSessionInteractions(
					sessionId,
					"Provider resolved request elsewhere",
					{ requestIds: new Set([row.id]) },
				);
			}).pipe(Effect.mapError(toEventSinkError)),
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
							providerId: options.driverKind,
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
