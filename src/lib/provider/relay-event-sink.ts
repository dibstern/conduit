// Translates provider-emitted ProviderRuntimeEvents into Conduit domain events,
// persists them when configured, and maintains processing timeouts.
// Used for the in-process Claude SDK path where there is no SSE stream to
// piggy-back on. Permissions and questions persist through the same path.
// Production ProviderTurnService fail-closes Claude output unless
// ProviderRuntimeIngestion is present; the local translation branch here remains
// for focused translator and compatibility tests.

import { SqlError } from "@effect/sql/SqlError";
import { Cause, Effect, Exit, Option } from "effect";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import {
	PendingInteractionCancelled,
	type PendingPermissionRequestInput,
} from "../domain/relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createLogger } from "../logger.js";
import { ClaudeEventPersistEffectError } from "../persistence/effect/claude-event-persist-effect.js";
import { EventStoreError } from "../persistence/effect/event-store-effect.js";
import { ProjectionRunnerError } from "../persistence/effect/projection-runner-effect.js";
import { PersistenceError } from "../persistence/errors.js";
import { type CanonicalEvent, createEventId } from "../persistence/events.js";
import type { PermissionId, SessionPermissionMode } from "../shared-types.js";
import { currentClaudeRunnerPermissionReply } from "./claude/claude-runner-receipts.js";
import { MissingPendingInteractions } from "./errors.js";
import {
	type EventSinkError,
	EventSinkIngestionError,
	type EventSinkPersistenceError,
} from "./event-sink-errors.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "./provider-runtime-event-to-domain.js";
import { providerRefsFromRuntimeData } from "./provider-runtime-refs.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

const log = createLogger("relay-event-sink");

export interface EffectRelayEventSinkPersist {
	readonly persistEvent: (
		event: CanonicalEvent,
	) => Effect.Effect<void, EventSinkPersistenceError>;
	readonly persistEvents?: (
		events: readonly CanonicalEvent[],
	) => Effect.Effect<void, EventSinkPersistenceError>;
}

export type RelayEventSinkPersist = EffectRelayEventSinkPersist;

export interface RelayEventSinkDeps {
	readonly sessionId: string;
	readonly providerId?: string;
	/** Optional: clear processing timeout when the turn finishes (done/error). */
	readonly clearTimeout?: () => void;
	/** Optional: reset processing timeout on any activity. */
	readonly resetTimeout?: () => void;
	/**
	 * Optional hook for a permission mode the SDK reported as actually in force.
	 * The durable event and the client message both ride the normal translation
	 * path; this is the third place conduit keeps a mode -- the relay's live
	 * per-session override, which the next turn reads.
	 */
	readonly applyReportedPermissionMode?: (
		mode: SessionPermissionMode,
	) => Effect.Effect<void, Error>;
	/** Optional: persist events to SQLite for session history survival. */
	readonly persist?: RelayEventSinkPersist;
	/** Optional durable runtime ingestion owner. When present, push() delegates provider output to this path. */
	readonly ingestion?: Pick<ProviderRuntimeIngestion, "ingest">;
	/** Effect-owned pending interaction state. Required when permission/question methods are used. */
	readonly pendingInteractions?: {
		beginPermissionRequest(
			entry: PendingPermissionRequestInput,
		): Effect.Effect<{
			readonly awaitResponse: Effect.Effect<
				PermissionResponse,
				PendingInteractionCancelled
			>;
		}>;
		resolvePermissionRequest(
			requestId: string,
			response: PermissionResponse,
		): Effect.Effect<boolean | undefined>;
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
		}): Effect.Effect<{
			readonly awaitAnswers: Effect.Effect<
				Record<string, unknown>,
				PendingInteractionCancelled
			>;
		}>;
		resolveQuestionRequest(
			requestId: string,
			answers: Record<string, unknown>,
		): Effect.Effect<boolean | undefined>;
		cancelSessionInteractions?(
			reason: string,
			options?: { readonly recoverQuestions?: boolean },
		): Effect.Effect<void>;
	};
}

export type RelayEventSink = EventSink;

export function createRelayEventSink(deps: RelayEventSinkDeps): RelayEventSink {
	const { sessionId, clearTimeout, resetTimeout, persist } = deps;
	let mapperState = emptyProviderRuntimeDomainMapperState;
	let detachingInteractions = false;

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

	const applyReportedPermissionMode = (
		event: ProviderRuntimeEvent,
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			const apply = deps.applyReportedPermissionMode;
			if (!apply) return;
			const mode = (event.data as { mode?: unknown }).mode;
			if (typeof mode !== "string") return;
			const result = yield* Effect.either(apply(mode as SessionPermissionMode));
			if (result._tag === "Left") {
				log.warn(
					`Failed to apply SDK-reported permission mode ${mode} (session=${sessionId}): ${result.left instanceof Error ? result.left.message : result.left}`,
				);
			}
		});

	// Persist a runtime event. Unlike push(),
	// this is not activity: asks and their answers go through here so that a
	// turn blocked on the human keeps its inactivity timeout stopped.
	const deliver = (event: ProviderRuntimeEvent): Effect.Effect<void, unknown> =>
		Effect.gen(function* () {
			if (deps.ingestion) {
				yield* deps.ingestion.ingest(event);
				if (isTerminalRuntimeEvent(event)) {
					yield* Effect.sync(finish);
				}
				return;
			}
			const result = translateProviderRuntimeEventToDomain(event, mapperState);
			mapperState = result.state;

			// Attempt persistence; failures are logged and timeout handling continues.
			// Real persistence implements persistEvents for atomic multi-event mappings;
			// older tests and adapters can still provide persistEvent.
			// A compaction's "started" notice and a retry are transient status (C1) on the
			// shell row. A compaction's outcome, completed or failed, persists so the divider or
			// the failure notice survives a reload.
			const persistentEvents = result.events.filter(
				(domainEvent) =>
					!(
						domainEvent.type === "session.compaction" &&
						domainEvent.data.state === "started"
					) &&
					!(
						domainEvent.type === "session.status" &&
						domainEvent.data.status === "retry"
					),
			);
			if (persist && persistentEvents.length > 0) {
				if (persist.persistEvents) {
					const persistResult = yield* Effect.either(
						persist.persistEvents(persistentEvents),
					);
					if (persistResult._tag === "Left") {
						yield* Effect.sync(() => {
							const err = persistResult.left;
							log.error(
								`Persist failed for runtime event ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
							);
						});
					}
				} else {
					for (const domainEvent of persistentEvents) {
						const persistResult = yield* Effect.either(
							persist.persistEvent(domainEvent),
						);
						if (persistResult._tag === "Left") {
							yield* Effect.sync(() => {
								const err = persistResult.left;
								log.error(
									`Persist failed for ${domainEvent.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
								);
							});
						}
					}
				}
			}

			if (isTerminalRuntimeEvent(event)) yield* Effect.sync(finish);
		});

	// Asks and their resolutions are canonical events, as they are for
	// OpenCode: the store is what wakes a snoozed session and what the snooze
	// guard reads. A failed write degrades that, so it is logged, not fatal to
	// a prompt the user can still answer.
	const recordInteraction = (
		type:
			| "permission.asked"
			| "permission.resolved"
			| "question.asked"
			| "question.resolved",
		data: Record<string, unknown>,
	): Effect.Effect<void> =>
		deliver({
			eventId: createEventId(),
			type,
			providerId: deps.providerId ?? "claude",
			sessionId,
			providerRefs: providerRefsFromRuntimeData(type, data),
			rawSource: { kind: "relay.event-sink" },
			createdAt: Date.now(),
			data,
		}).pipe(
			Effect.catchAll((cause) =>
				Effect.sync(() => {
					log.warn(
						`Failed to record ${type} ${String(data["id"])} (session=${sessionId}): ${cause instanceof Error ? cause.message : cause}`,
					);
				}),
			),
		);

	const sink: RelayEventSink = {
		// Without the finish, a client connecting before the status poller
		// sees idle is told the finished turn is still processing.
		noteActivity: (event) =>
			isTerminalRuntimeEvent(event) ? finish() : reset(),
		detachInteractions: () =>
			Effect.sync(() => {
				detachingInteractions = true;
			}),
		push(event: ProviderRuntimeEvent): Effect.Effect<void, EventSinkError> {
			return Effect.gen(function* () {
				yield* Effect.sync(reset);
				// Ahead of the ingestion short-circuit: the live override has to
				// track the SDK on the durable path too, and it is relay state
				// rather than an event, so ingestion never sees it.
				if (event.type === "session.permission_mode_changed") {
					yield* applyReportedPermissionMode(event);
				}
				if (deps.ingestion) {
					yield* deps.ingestion
						.ingest(event)
						.pipe(Effect.mapError(toEventSinkError));
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

				// Attempt persistence; failures are logged and timeout handling continues.
				// Real persistence implements persistEvents for atomic multi-event mappings;
				// older tests and adapters can still provide persistEvent.
				// A compaction's "started" notice and a retry are transient status (C1) on the
				// shell row. A compaction's outcome, completed or failed, persists so the divider or
				// the failure notice survives a reload.
				const persistentEvents = result.events.filter(
					(domainEvent) =>
						!(
							domainEvent.type === "session.compaction" &&
							domainEvent.data.state === "started"
						) &&
						!(
							domainEvent.type === "session.status" &&
							domainEvent.data.status === "retry"
						),
				);
				if (persist && persistentEvents.length > 0) {
					if (persist.persistEvents) {
						const persistResult = yield* Effect.either(
							persist.persistEvents(persistentEvents),
						);
						if (persistResult._tag === "Left") {
							yield* Effect.sync(() => {
								const err = persistResult.left;
								log.error(
									`Persist failed for runtime event ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
								);
							});
						}
					} else {
						for (const domainEvent of persistentEvents) {
							const persistResult = yield* Effect.either(
								persist.persistEvent(domainEvent),
							);
							if (persistResult._tag === "Left") {
								yield* Effect.sync(() => {
									const err = persistResult.left;
									log.error(
										`Persist failed for ${domainEvent.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
									);
								});
							}
						}
					}
				}

				if (isTerminalRuntimeEvent(event)) yield* Effect.sync(finish);
			});
		},

		requestPermission(
			request: PermissionRequest,
		): Effect.Effect<
			PermissionResponse,
			MissingPendingInteractions | PendingInteractionCancelled
		> {
			return Effect.gen(function* () {
				// The turn now blocks on the human. Stop the inactivity timeout
				// instead of restarting it, or it fires a bogus PROCESSING_TIMEOUT
				// while the prompt is still on screen. The handler restarts it once
				// the user responds (restartProcessingTimeout in handlers/permissions).
				yield* Effect.sync(finish);
				// Approval policy is delegated to the Claude Agent SDK via
				// `permissionMode` at query creation, so an ask reaching here has
				// already survived the SDK's own auto-approval. Re-deciding it
				// locally would be a second enforcement point guessing at a tool
				// taxonomy the SDK owns.
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
					...(request.permissionReason != null
						? { permissionReason: request.permissionReason }
						: {}),
				});
				const ask = Effect.gen(function* () {
					// Browsers see the card through the approvals subscription, so
					// the record carries everything the card shows.
					yield* recordInteraction("permission.asked", {
						id: request.requestId,
						sessionId,
						toolName: request.toolName,
						input: request.toolInput,
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
						...(request.permissionReason != null
							? { permissionReason: request.permissionReason }
							: {}),
					});
					return yield* pending.awaitResponse;
				});
				// Relay disposal detaches its waiter. Cancellation or failure
				// resolves the request as a rejection.
				return yield* ask.pipe(
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							if (detachingInteractions && Exit.isFailure(exit)) return;
							if (Exit.isFailure(exit)) {
								yield* pendingInteractions.resolvePermissionRequest(
									request.requestId,
									{
										decision: "reject",
									},
								);
							}
							yield* recordInteraction("permission.resolved", {
								id: request.requestId,
								decision: Exit.isSuccess(exit) ? exit.value.decision : "reject",
							}).pipe(
								Effect.locally(
									currentClaudeRunnerPermissionReply,
									Exit.isSuccess(exit)
										? {
												sessionId,
												requestId: request.requestId,
												response: exit.value,
											}
										: undefined,
								),
							);
						}),
					),
				);
			});
		},

		requestQuestion(
			request: QuestionRequest,
		): Effect.Effect<
			Record<string, unknown>,
			MissingPendingInteractions | PendingInteractionCancelled
		> {
			return Effect.gen(function* () {
				// Same as requestPermission: awaiting the user is not inactivity.
				yield* Effect.sync(finish);
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
				const askedQuestions = request.questions.map((q) => ({
					question: q.question,
					header: q.header,
					options: q.options,
					multiSelect: q.multiSelect ?? false,
					custom: q.custom ?? true,
				}));
				const ask = Effect.gen(function* () {
					yield* recordInteraction("question.asked", {
						id: request.requestId,
						sessionId,
						questions: askedQuestions,
						...(request.toolUseId != null
							? { toolUseId: request.toolUseId }
							: {}),
						...(deps.providerId != null ? { providerId: deps.providerId } : {}),
					});
					return yield* pending.awaitAnswers;
				});
				// Relay disposal and questions kept for recovery leave the ask pending.
				// Other exits resolve it here.
				return yield* ask.pipe(
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							if (detachingInteractions && Exit.isFailure(exit)) return;
							if (Exit.isSuccess(exit)) {
								return yield* recordInteraction("question.resolved", {
									id: request.requestId,
									answers: exit.value,
								});
							}
							const failure = Cause.failureOption(exit.cause);
							const keptForRecovery =
								Option.isSome(failure) &&
								failure.value instanceof PendingInteractionCancelled &&
								failure.value.recovered === true;
							if (keptForRecovery) return;
							yield* pendingInteractions.resolveQuestionRequest(
								request.requestId,
								{},
							);
							return yield* recordInteraction("question.resolved", {
								id: request.requestId,
								answers: {},
							});
						}),
					),
				);
			});
		},

		resolvePermission(
			requestId: string,
			response: PermissionResponse,
		): Effect.Effect<void> {
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
		): Effect.Effect<void> {
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

		cancelSessionInteractions(
			reason: string,
			options?: { readonly recoverQuestions?: boolean },
		): Effect.Effect<void> {
			if (deps.pendingInteractions?.cancelSessionInteractions) {
				return deps.pendingInteractions.cancelSessionInteractions(
					reason,
					options,
				);
			}
			return Effect.void;
		},
	};
	return sink;
}

export function toEventSinkError(cause: unknown): EventSinkError {
	if (
		cause instanceof PersistenceError ||
		cause instanceof EventStoreError ||
		cause instanceof ClaudeEventPersistEffectError ||
		cause instanceof ProjectionRunnerError ||
		cause instanceof SqlError ||
		cause instanceof MissingPendingInteractions ||
		cause instanceof PendingInteractionCancelled
	)
		return cause;
	return new EventSinkIngestionError({ cause });
}

function isTerminalRuntimeEvent(event: ProviderRuntimeEvent): boolean {
	return (
		event.type === "turn.completed" ||
		event.type === "turn.interrupted" ||
		event.type === "turn.error"
	);
}
