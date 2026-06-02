// ─── Relay Event Sink ────────────────────────────────────────────────────────
// Translates provider-emitted ProviderRuntimeEvents into Conduit domain events,
// persists them when configured, then pushes RelayMessages to WebSocket clients.
// Used for the in-process Claude SDK path where there is no SSE stream to
// piggy-back on. Permissions and questions are routed through the same path so
// the UI receives the familiar RelayMessage shapes.

import { Effect } from "effect";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createLogger } from "../logger.js";
import type { CanonicalEvent } from "../persistence/events.js";
import { translateDomainEventToRelay } from "../relay/domain-event-to-relay.js";
import type { PermissionId } from "../shared-types.js";
import { tagWithSessionId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";
import { MissingPendingInteractions } from "./errors.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "./provider-runtime-event-to-domain.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

const log = createLogger("relay-event-sink");

// ─── Deps ───────────────────────────────────────────────────────────────────

export interface EffectRelayEventSinkPersist {
	readonly persistEvent: (
		event: CanonicalEvent,
	) => Effect.Effect<void, unknown>;
	readonly persistEvents?: (
		events: readonly CanonicalEvent[],
	) => Effect.Effect<void, unknown>;
}

export type RelayEventSinkPersist = EffectRelayEventSinkPersist;

export interface RelayEventSinkDeps {
	readonly sessionId: string;
	readonly providerId?: string;
	readonly send: (msg: RelayMessage) => void;
	/** Optional: clear processing timeout when the turn finishes (done/error). */
	readonly clearTimeout?: () => void;
	/** Optional: reset processing timeout on any activity. */
	readonly resetTimeout?: () => void;
	/** Optional: persist events to SQLite for session history survival. */
	readonly persist?: RelayEventSinkPersist;
	/** Optional durable runtime ingestion owner. When present, push() delegates provider output to this path. */
	readonly ingestion?: Pick<ProviderRuntimeIngestion, "ingest">;
	/** Effect-owned pending interaction state. Required when permission/question methods are used. */
	readonly pendingInteractions?: {
		beginPermissionRequest(entry: {
			requestId: PermissionId;
			sessionId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
			always: string[];
		}): Effect.Effect<
			{ readonly awaitResponse: Effect.Effect<PermissionResponse, unknown> },
			unknown
		>;
		resolvePermissionRequest(
			requestId: string,
			response: PermissionResponse,
		): Effect.Effect<boolean | undefined, unknown>;
		beginQuestionRequest(entry: {
			requestId: string;
			sessionId: string;
			questions: Array<{
				question: string;
				header?: string;
				options?: unknown[];
				multiSelect?: boolean;
			}>;
			toolCallId?: string;
			providerId?: string;
		}): Effect.Effect<
			{
				readonly awaitAnswers: Effect.Effect<Record<string, unknown>, unknown>;
			},
			unknown
		>;
		resolveQuestionRequest(
			requestId: string,
			answers: Record<string, unknown>,
		): Effect.Effect<boolean | undefined, unknown>;
		cancelSessionInteractions?(reason: string): Effect.Effect<void, unknown>;
	};
}

export type RelayEventSink = EventSink;

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRelayEventSink(deps: RelayEventSinkDeps): RelayEventSink {
	const { sessionId, send, clearTimeout, resetTimeout, persist } = deps;
	let mapperState = emptyProviderRuntimeDomainMapperState;

	function reset(): void {
		if (resetTimeout) resetTimeout();
	}

	function finish(): void {
		if (clearTimeout) clearTimeout();
	}

	function missingPendingInteractions(
		operation: "requestPermission" | "requestQuestion",
	): MissingPendingInteractions {
		return new MissingPendingInteractions({
			operation,
			sessionId,
		});
	}

	return {
		push(event: ProviderRuntimeEvent): Effect.Effect<void, unknown> {
			return Effect.gen(function* () {
				yield* Effect.sync(reset);
				if (deps.ingestion) {
					yield* deps.ingestion.ingest(event);
					if (isTerminalRuntimeEvent(event)) {
						yield* Effect.sync(finish);
					}
					return;
				}
				const result = translateProviderRuntimeEventToDomain(
					event,
					mapperState,
				);
				mapperState = result.state;

				// Persist to SQLite when available (before WS send for durability).
				// Real persistence implements persistEvents for atomic multi-event mappings;
				// older tests and adapters can still provide persistEvent.
				if (persist && result.events.length > 0) {
					if (persist.persistEvents) {
						const persistResult = yield* Effect.either(
							persist.persistEvents(result.events),
						);
						if (persistResult._tag === "Left") {
							yield* Effect.sync(() => {
								const err = persistResult.left;
								log.debug(
									`Persist failed for runtime event ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
								);
							});
						}
					} else {
						for (const domainEvent of result.events) {
							const persistResult = yield* Effect.either(
								persist.persistEvent(domainEvent),
							);
							if (persistResult._tag === "Left") {
								yield* Effect.sync(() => {
									const err = persistResult.left;
									log.debug(
										`Persist failed for ${domainEvent.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
									);
								});
							}
						}
					}
				}

				for (const domainEvent of result.events) {
					yield* Effect.sync(() => {
						const translated = translateDomainEventToRelay(domainEvent);
						if (translated.kind === "emit") {
							for (const raw of translated.messages) {
								const m = tagWithSessionId(
									raw,
									domainEvent.sessionId || sessionId,
								);
								send(m);
								const isTerminal =
									m.type === "done" ||
									(m.type === "error" && m.code !== "RETRY");
								if (isTerminal) finish();
							}
						}
					});
				}
			});
		},

		requestPermission(
			request: PermissionRequest,
		): Effect.Effect<PermissionResponse, unknown> {
			return Effect.gen(function* () {
				yield* Effect.sync(reset);
				const pendingInteractions = deps.pendingInteractions;
				if (!pendingInteractions) {
					return yield* Effect.fail(
						missingPendingInteractions("requestPermission"),
					);
				}
				const pending = yield* pendingInteractions.beginPermissionRequest({
					requestId: request.requestId as PermissionId,
					sessionId,
					toolName: request.toolName,
					toolInput: request.toolInput as Record<string, unknown>,
					always: request.always ?? [],
					...(request.permissionSuggestions != null
						? { permissionSuggestions: request.permissionSuggestions }
						: {}),
					...(request.permissionTitle != null
						? { permissionTitle: request.permissionTitle }
						: {}),
					...(request.permissionDisplayName != null
						? { permissionDisplayName: request.permissionDisplayName }
						: {}),
					...(request.permissionDescription != null
						? { permissionDescription: request.permissionDescription }
						: {}),
				});
				yield* Effect.sync(() => {
					send({
						type: "permission_request",
						sessionId,
						requestId: request.requestId as PermissionId,
						toolName: request.toolName,
						toolInput: request.toolInput,
						always: request.always ?? [],
						...(request.permissionSuggestions != null
							? { permissionSuggestions: [...request.permissionSuggestions] }
							: {}),
						...(request.permissionTitle != null
							? { permissionTitle: request.permissionTitle }
							: {}),
						...(request.permissionDisplayName != null
							? { permissionDisplayName: request.permissionDisplayName }
							: {}),
						...(request.permissionDescription != null
							? { permissionDescription: request.permissionDescription }
							: {}),
					});
				});
				return yield* pending.awaitResponse;
			});
		},

		requestQuestion(
			request: QuestionRequest,
		): Effect.Effect<Record<string, unknown>, unknown> {
			return Effect.gen(function* () {
				yield* Effect.sync(reset);
				const pendingInteractions = deps.pendingInteractions;
				if (!pendingInteractions) {
					return yield* Effect.fail(
						missingPendingInteractions("requestQuestion"),
					);
				}
				const questions = request.questions.map((q) => ({
					question: q.question,
					header: q.header,
					options: q.options,
					multiSelect: q.multiSelect ?? false,
				}));
				const pending = yield* pendingInteractions.beginQuestionRequest({
					requestId: request.requestId,
					sessionId,
					questions,
					...(request.toolUseId != null
						? { toolCallId: request.toolUseId }
						: {}),
					...(deps.providerId != null ? { providerId: deps.providerId } : {}),
				});
				yield* Effect.sync(() => {
					send({
						type: "ask_user",
						sessionId,
						toolId: request.requestId,
						questions: request.questions.map((q) => ({
							question: q.question,
							header: q.header,
							options: q.options,
							multiSelect: q.multiSelect ?? false,
							custom: q.custom ?? true,
						})),
						...(request.toolUseId != null
							? { toolUseId: request.toolUseId }
							: {}),
						...(deps.providerId != null ? { providerId: deps.providerId } : {}),
					});
				});
				return yield* pending.awaitAnswers;
			});
		},

		resolvePermission(
			requestId: string,
			response: PermissionResponse,
		): Effect.Effect<void, unknown> {
			return Effect.gen(function* () {
				if (!deps.pendingInteractions) {
					yield* Effect.sync(() => {
						log.warn(
							`resolvePermission: no pending interaction port for ${requestId} (session=${sessionId})`,
						);
					});
					return;
				}
				yield* deps.pendingInteractions.resolvePermissionRequest(
					requestId,
					response,
				);
			});
		},

		resolveQuestion(
			requestId: string,
			answers: Record<string, unknown>,
		): Effect.Effect<void, unknown> {
			return Effect.gen(function* () {
				if (!deps.pendingInteractions) {
					yield* Effect.sync(() => {
						log.warn(
							`resolveQuestion: no pending interaction port for ${requestId} (session=${sessionId})`,
						);
					});
					return;
				}
				yield* deps.pendingInteractions.resolveQuestionRequest(
					requestId,
					answers,
				);
			});
		},

		cancelSessionInteractions(reason: string): Effect.Effect<void, unknown> {
			if (deps.pendingInteractions?.cancelSessionInteractions) {
				return deps.pendingInteractions.cancelSessionInteractions(reason);
			}
			return Effect.void;
		},
	};
}

function isTerminalRuntimeEvent(event: ProviderRuntimeEvent): boolean {
	return (
		event.type === "turn.completed" ||
		event.type === "turn.interrupted" ||
		event.type === "turn.error"
	);
}
