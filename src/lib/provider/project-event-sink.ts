// Translates provider-emitted ProviderRuntimeEvents into Conduit domain events,
// persists them when configured, and maintains processing timeouts.
// Used for the in-process Claude SDK path where there is no SSE stream to
// piggy-back on. Permissions and questions persist through the same path.
// Production ProviderTurnService fail-closes Claude output unless
// ProviderRuntimeIngestion is present; the local translation branch here remains
// for focused translator and compatibility tests.

import { randomUUID } from "node:crypto";
import { Effect, Exit, Option, Schema } from "effect";
import { SqlError } from "effect/sql/SqlError";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import { RunnerWriteOrigin } from "../contracts/stored-event.js";
import {
	PendingInteractionCancelled,
	type PendingPermissionRequestInput,
} from "../domain/project-services/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestion } from "../domain/project-services/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../effect/failure-classification.js";
import { createLogger } from "../logger.js";
import { AttachmentMissing } from "../persistence/attachment-store.js";
import { ClaudeEventPersistEffectError } from "../persistence/effect/claude-event-persist-effect.js";
import { guardCurrentWrite } from "../persistence/effect/commit-and-signal.js";
import { EventStoreError } from "../persistence/effect/event-store-effect.js";
import { ProjectionRunnerError } from "../persistence/effect/projection-runner-effect.js";
import { PersistenceError } from "../persistence/errors.js";
import { type CanonicalEvent, createEventId } from "../persistence/events.js";
import {
	type PermissionId,
	type SessionPermissionMode,
	SessionPermissionModeSchema,
} from "../shared-types.js";
import { isRecord } from "../utils.js";
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
import {
	currentRunnerOutput,
	currentRunnerPermissionReply,
	currentRunnerProcessId,
} from "./runner/runner-receipts.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

const log = createLogger("project-event-sink");

export interface ProjectEventSinkPersist {
	readonly persistEvent: (
		event: CanonicalEvent,
	) => Effect.Effect<void, EventSinkPersistenceError>;
	readonly persistEvents?: (
		events: readonly CanonicalEvent[],
	) => Effect.Effect<void, EventSinkPersistenceError>;
}

export interface ProjectEventSinkDeps {
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
	readonly persist?: ProjectEventSinkPersist;
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

export function createProjectEventSink(deps: ProjectEventSinkDeps): EventSink {
	const { sessionId, clearTimeout, resetTimeout, persist } = deps;
	let mapperState = emptyProviderRuntimeDomainMapperState;
	let detachingInteractions = false;
	const localProcessId = randomUUID();
	const promptIds = new Map<string, string>();

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
			const mode = Schema.decodeUnknownOption(SessionPermissionModeSchema)(
				isRecord(event.data) ? event.data["mode"] : undefined,
			);
			if (Option.isNone(mode)) return;
			const result = yield* Effect.result(guardCurrentWrite(apply(mode.value)));
			if (result._tag === "Failure") {
				log.warn(
					`Failed to apply SDK-reported permission mode ${mode.value} (session=${sessionId}): ${result.failure instanceof Error ? result.failure.message : result.failure}`,
				);
			}
		});

	// Persist a runtime event. Unlike push(),
	// this is not activity: asks and their answers go through here so that a
	// turn blocked on the human keeps its inactivity timeout stopped.
	const deliver = (
		event: ProviderRuntimeEvent,
		onPrompt?: (id: string) => Effect.Effect<void>,
	): Effect.Effect<void, unknown> =>
		Effect.gen(function* () {
			if (deps.ingestion) {
				yield* guardCurrentWrite(deps.ingestion.ingest(event, onPrompt));
				if (isTerminalRuntimeEvent(event)) {
					yield* guardCurrentWrite(finish);
				}
				return;
			}
			const result = translateProviderRuntimeEventToDomain(event, mapperState);

			// Register a waiter only after its ask has been persisted.
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
					yield* guardCurrentWrite(persist.persistEvents(persistentEvents));
				} else {
					for (const domainEvent of persistentEvents) {
						yield* guardCurrentWrite(persist.persistEvent(domainEvent));
					}
				}
			}
			yield* guardCurrentWrite(() => {
				mapperState = result.state;
			});
			for (const domain of result.events) {
				if (
					domain.type === "permission.asked" ||
					domain.type === "question.asked"
				)
					yield* guardCurrentWrite(onPrompt?.(domain.data.id) ?? Effect.void);
			}

			if (isTerminalRuntimeEvent(event)) yield* guardCurrentWrite(finish);
		});

	// Asks and their resolutions are canonical events, as they are for
	// OpenCode: the store is what wakes a snoozed session and what the snooze
	// guard reads. A failed ask is logged and leaves no waiter registered.
	const recordInteraction = (
		type:
			| "permission.asked"
			| "permission.resolved"
			| "question.asked"
			| "question.resolved",
		data: Record<string, unknown>,
		onPrompt?: (id: string) => Effect.Effect<void>,
		runId?: string,
	): Effect.Effect<void> =>
		Effect.gen(function* () {
			const receipt = yield* currentRunnerOutput;
			const processId = yield* currentRunnerProcessId;
			yield* deliver(
				{
					eventId: createEventId(),
					type,
					providerId: deps.providerId ?? "claude",
					sessionId,
					providerRefs: {
						...providerRefsFromRuntimeData(type, data),
						providerProcessId: receipt?.runnerId ?? processId ?? localProcessId,
					},
					rawSource: { kind: "relay.event-sink" },
					...(receipt ? { [RunnerWriteOrigin]: receipt.runnerId } : {}),
					createdAt: Date.now(),
					data,
					...(runId ? { runId } : {}),
				},
				onPrompt,
			);
		}).pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					log.warn(
						`Failed to record ${type} ${String(data["id"])} (session=${sessionId}): ${cause instanceof Error ? cause.message : cause}`,
					);
				}),
			),
		);

	const sink: EventSink = {
		// Without the finish, a client connecting before the status poller
		// sees idle is told the finished turn is still processing.
		noteActivity: (event) =>
			isTerminalRuntimeEvent(event) ? finish() : reset(),
		detachInteractions: () =>
			guardCurrentWrite(() => {
				detachingInteractions = true;
			}).pipe(Effect.asVoid),
		push(event: ProviderRuntimeEvent): Effect.Effect<void, EventSinkError> {
			return Effect.gen(function* () {
				if (Option.isNone(yield* guardCurrentWrite(reset))) return;
				// Ahead of the ingestion short-circuit: the live override has to
				// track the SDK on the durable path too, and it is relay state
				// rather than an event, so ingestion never sees it.
				if (event.type === "session.permission_mode_changed") {
					yield* applyReportedPermissionMode(event);
				}
				if (deps.ingestion) {
					yield* guardCurrentWrite(
						deps.ingestion
							.ingest(event)
							.pipe(Effect.mapError(toEventSinkError)),
					);
					if (isTerminalRuntimeEvent(event)) {
						yield* guardCurrentWrite(finish);
					}
					return;
				}
				const result = translateProviderRuntimeEventToDomain(
					event,
					mapperState,
				);
				yield* guardCurrentWrite(() => {
					mapperState = result.state;
				});

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
						const persistResult = yield* Effect.result(
							guardCurrentWrite(persist.persistEvents(persistentEvents)),
						);
						if (persistResult._tag === "Failure") {
							yield* Effect.sync(() => {
								const err = persistResult.failure;
								log.error(
									`Persist failed for runtime event ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
								);
							});
						}
					} else {
						for (const domainEvent of persistentEvents) {
							const persistResult = yield* Effect.result(
								guardCurrentWrite(persist.persistEvent(domainEvent)),
							);
							if (persistResult._tag === "Failure") {
								yield* Effect.sync(() => {
									const err = persistResult.failure;
									log.error(
										`Persist failed for ${domainEvent.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
									);
								});
							}
						}
					}
				}

				if (isTerminalRuntimeEvent(event)) yield* guardCurrentWrite(finish);
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
				yield* guardCurrentWrite(finish);
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
				let conduitId: string | undefined;
				let awaitResponse: Effect.Effect<
					PermissionResponse,
					PendingInteractionCancelled
				> = Effect.fail(
					new PendingInteractionCancelled({
						requestId: request.requestId,
						sessionId,
						reason: "Permission request was not persisted",
					}),
				);
				const ask = Effect.gen(function* () {
					// Browsers see the card through the approvals subscription, so
					// the record carries everything the card shows.
					yield* recordInteraction(
						"permission.asked",
						{
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
						},
						(id) =>
							Effect.gen(function* () {
								if (
									Option.isNone(
										yield* guardCurrentWrite(() => {
											conduitId = id;
											promptIds.set(request.requestId, id);
										}),
									)
								)
									return;
								const pending = yield* guardCurrentWrite(
									pendingInteractions.beginPermissionRequest({
										requestId: id as PermissionId,
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
									}),
								);
								if (Option.isSome(pending))
									awaitResponse = pending.value.awaitResponse;
							}),
						request.runId,
					);
					return yield* awaitResponse;
				});
				// Relay disposal detaches its waiter. Cancellation or failure
				// resolves the request as a rejection.
				return yield* ask.pipe(
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							if (detachingInteractions && Exit.isFailure(exit)) return;
							if (Exit.isFailure(exit) && conduitId) {
								yield* guardCurrentWrite(
									pendingInteractions.resolvePermissionRequest(conduitId, {
										decision: "reject",
									}),
								);
							}
							yield* recordInteraction(
								"permission.resolved",
								{
									id: request.requestId,
									decision: Exit.isSuccess(exit)
										? exit.value.decision
										: "reject",
								},
								undefined,
								request.runId,
							).pipe(
								Effect.provideService(
									currentRunnerPermissionReply,
									Exit.isSuccess(exit) && conduitId
										? {
												sessionId,
												requestId: conduitId,
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
				yield* guardCurrentWrite(finish);
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
					...(q.isOther != null && { isOther: q.isOther }),
					...(q.isSecret != null && { isSecret: q.isSecret }),
				}));
				let conduitId: string | undefined;
				let awaitAnswers: Effect.Effect<
					Record<string, unknown>,
					PendingInteractionCancelled
				> = Effect.fail(
					new PendingInteractionCancelled({
						requestId: request.requestId,
						sessionId,
						reason: "Question request was not persisted",
					}),
				);
				const askedQuestions = request.questions.map((q) => ({
					question: q.question,
					header: q.header,
					options: q.options,
					multiSelect: q.multiSelect ?? false,
					custom: q.custom ?? true,
					...(q.isOther != null && { isOther: q.isOther }),
					...(q.isSecret != null && { isSecret: q.isSecret }),
				}));
				const ask = Effect.gen(function* () {
					yield* recordInteraction(
						"question.asked",
						{
							id: request.requestId,
							sessionId,
							questions: askedQuestions,
							...(request.toolUseId != null
								? { toolUseId: request.toolUseId }
								: {}),
							...(deps.providerId != null
								? { providerId: deps.providerId }
								: {}),
						},
						(id) =>
							Effect.gen(function* () {
								if (
									Option.isNone(
										yield* guardCurrentWrite(() => {
											conduitId = id;
											promptIds.set(request.requestId, id);
										}),
									)
								)
									return;
								const pending = yield* guardCurrentWrite(
									pendingInteractions.beginQuestionRequest({
										requestId: id,
										sessionId,
										questions,
										...(request.toolUseId != null
											? { toolCallId: request.toolUseId }
											: {}),
										...(deps.providerId != null
											? { providerId: deps.providerId }
											: {}),
									}),
								);
								if (Option.isSome(pending))
									awaitAnswers = pending.value.awaitAnswers;
							}),
						request.runId,
					);
					return yield* awaitAnswers;
				});
				// Relay disposal and questions kept for recovery leave the ask pending.
				// Other exits resolve it here.
				return yield* ask.pipe(
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							if (detachingInteractions && Exit.isFailure(exit)) return;
							if (Exit.isSuccess(exit)) {
								return yield* recordInteraction(
									"question.resolved",
									{
										id: request.requestId,
										// Keep the live reply intact; every durable consumer gets this copy.
										answers: Object.fromEntries(
											Object.entries(exit.value).map(([index, answer]) => [
												index,
												request.questions[Number(index)]?.isSecret
													? "[redacted]"
													: answer,
											]),
										),
									},
									undefined,
									request.runId,
								);
							}
							const failure = Failure.firstFailure(exit.cause);
							const keptForRecovery =
								Option.isSome(failure) &&
								failure.value instanceof PendingInteractionCancelled &&
								failure.value.recovered === true;
							if (keptForRecovery) return;
							if (conduitId)
								yield* guardCurrentWrite(
									pendingInteractions.resolveQuestionRequest(conduitId, {}),
								);
							return yield* recordInteraction(
								"question.resolved",
								{
									id: request.requestId,
									answers: {},
								},
								undefined,
								request.runId,
							);
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
				yield* guardCurrentWrite(
					deps.pendingInteractions.resolvePermissionRequest(
						promptIds.get(requestId) ?? requestId,
						response,
					),
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
				yield* guardCurrentWrite(
					deps.pendingInteractions.resolveQuestionRequest(
						promptIds.get(requestId) ?? requestId,
						answers,
					),
				);
			});
		},

		cancelSessionInteractions(
			reason: string,
			options?: { readonly recoverQuestions?: boolean },
		): Effect.Effect<void> {
			if (deps.pendingInteractions?.cancelSessionInteractions) {
				return guardCurrentWrite(
					deps.pendingInteractions.cancelSessionInteractions(reason, options),
				).pipe(Effect.asVoid);
			}
			return Effect.void;
		},
	};
	return sink;
}

export function toEventSinkError(cause: unknown): EventSinkError {
	if (
		cause instanceof AttachmentMissing ||
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
