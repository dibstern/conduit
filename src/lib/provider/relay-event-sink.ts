// ─── Relay Event Sink ────────────────────────────────────────────────────────
// Translates provider-emitted ProviderRuntimeEvents into Conduit domain events,
// persists them when configured, then pushes RelayMessages to WebSocket clients.
// Used for the in-process Claude SDK path where there is no SSE stream to
// piggy-back on. Permissions and questions are routed through the same path so
// the UI receives the familiar RelayMessage shapes.
// Production ProviderTurnService fail-closes Claude output unless
// ProviderRuntimeIngestion is present; the local translation branch here remains
// for focused translator and compatibility tests.

import { Effect } from "effect";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import type { ProviderRuntimeIngestion } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createLogger } from "../logger.js";
import type { CanonicalEvent } from "../persistence/events.js";
import { translateDomainEventToRelay } from "../relay/domain-event-to-relay.js";
import type { PermissionId, SessionPermissionMode } from "../shared-types.js";
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
	/**
	 * Optional hook for a permission mode the SDK reported as actually in force.
	 * The durable event and the client message both ride the normal translation
	 * path; this is the third place conduit keeps a mode -- the relay's live
	 * per-session override, which the next turn reads.
	 */
	readonly applyReportedPermissionMode?: (
		mode: SessionPermissionMode,
	) => Effect.Effect<void, unknown>;
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

	const sink: RelayEventSink = {
		noteActivity: reset,
		push(event: ProviderRuntimeEvent): Effect.Effect<void, unknown> {
			return Effect.gen(function* () {
				yield* Effect.sync(reset);
				// Ahead of the ingestion short-circuit: the live override has to
				// track the SDK on the durable path too, and it is relay state
				// rather than an event, so ingestion never sees it.
				if (event.type === "session.permission_mode_changed") {
					yield* applyReportedPermissionMode(event);
				}
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
				// Compaction notices are UI-only EXCEPT the terminal "completed"
				// boundary, which persists as a synthetic marker so the "Context
				// compacted" divider survives a page reload. All states still go on
				// the wire below (the send loop iterates the unfiltered result.events).
				const persistentEvents = result.events.filter(
					(domainEvent) =>
						domainEvent.type !== "session.compaction" ||
						domainEvent.data.state === "completed",
				);
				if (persist && persistentEvents.length > 0) {
					if (persist.persistEvents) {
						const persistResult = yield* Effect.either(
							persist.persistEvents(persistentEvents),
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
						for (const domainEvent of persistentEvents) {
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
	return sink;
}

function isTerminalRuntimeEvent(event: ProviderRuntimeEvent): boolean {
	return (
		event.type === "turn.completed" ||
		event.type === "turn.interrupted" ||
		event.type === "turn.error"
	);
}
