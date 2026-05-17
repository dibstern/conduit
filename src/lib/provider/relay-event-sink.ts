// ─── Relay Event Sink ────────────────────────────────────────────────────────
// Translates provider-emitted CanonicalEvents into RelayMessages and pushes
// them straight to WebSocket clients. Used for the in-process Claude SDK path
// (ClaudeProviderInstance) where there is no SSE stream to piggy-back on. Permissions
// and questions are routed through the same path so the UI receives the
// familiar RelayMessage shapes.

import { Effect } from "effect";
import { createLogger } from "../logger.js";
import type { CanonicalEvent } from "../persistence/events.js";
import type { PermissionId } from "../shared-types.js";
import { tagWithSessionId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";
import { MissingPendingInteractions } from "./errors.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

const log = createLogger("relay-event-sink");

// ─── Translation Result ───────────────────────────────────────────────────

type TranslationResult =
	| {
			kind: "emit";
			messages: import("../shared-types.js").UntaggedRelayMessage[];
	  }
	| { kind: "silent"; reason: string };

function emit(
	...messages: import("../shared-types.js").UntaggedRelayMessage[]
): TranslationResult {
	return { kind: "emit", messages };
}

function silent(reason: string): TranslationResult {
	return { kind: "silent", reason };
}

// ─── Deps ───────────────────────────────────────────────────────────────────

export interface EffectRelayEventSinkPersist {
	readonly persistEvent: (
		event: CanonicalEvent,
	) => Effect.Effect<void, unknown>;
}

export type RelayEventSinkPersist = EffectRelayEventSinkPersist;

export interface RelayEventSinkDeps {
	readonly sessionId: string;
	readonly send: (msg: RelayMessage) => void;
	/** Optional: clear processing timeout when the turn finishes (done/error). */
	readonly clearTimeout?: () => void;
	/** Optional: reset processing timeout on any activity. */
	readonly resetTimeout?: () => void;
	/** Optional: persist events to SQLite for session history survival. */
	readonly persist?: RelayEventSinkPersist;
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
		push(event: CanonicalEvent): Effect.Effect<void, never> {
			return Effect.gen(function* () {
				yield* Effect.sync(reset);
				// Persist to SQLite when available (before WS send for durability)
				if (persist) {
					const persistResult = yield* Effect.either(
						persist.persistEvent(event),
					);
					if (persistResult._tag === "Left") {
						// Non-fatal — same pattern as dual-write-hook.ts:149.
						// Covers: disk full, DB locked, projection recovery guard, etc.
						yield* Effect.sync(() => {
							const err = persistResult.left;
							log.debug(
								`Persist failed for ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
							);
						});
					}
				}
				yield* Effect.sync(() => {
					const result = translateCanonicalEvent(event);
					if (result.kind === "emit") {
						for (const raw of result.messages) {
							const m = tagWithSessionId(raw, event.sessionId || sessionId);
							send(m);
							const isTerminal =
								m.type === "done" || (m.type === "error" && m.code !== "RETRY");
							if (isTerminal) finish();
						}
					}
				});
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
				});
				yield* Effect.sync(() => {
					send({
						type: "permission_request",
						sessionId,
						requestId: request.requestId as PermissionId,
						toolName: request.toolName,
						toolInput: request.toolInput,
						always: request.always ?? [],
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

// ─── Translation ────────────────────────────────────────────────────────────
// Maps CanonicalEvent (provider-emitted) → RelayMessage[] (client-facing).
// An event may produce zero, one, or many relay messages.

function translateCanonicalEvent(event: CanonicalEvent): TranslationResult {
	switch (event.type) {
		case "text.delta":
			return emit({
				type: "delta",
				text: event.data.text,
				messageId: event.data.messageId,
			});

		case "thinking.start":
			return emit({ type: "thinking_start", messageId: event.data.messageId });

		case "thinking.delta":
			return emit({
				type: "thinking_delta",
				text: event.data.text,
				messageId: event.data.messageId,
			});

		case "thinking.end":
			return emit({ type: "thinking_stop", messageId: event.data.messageId });

		case "tool.started": {
			const { toolName, callId, input, messageId } = event.data;
			return emit(
				{ type: "tool_start", id: callId, name: toolName, messageId },
				{
					type: "tool_executing",
					id: callId,
					name: toolName,
					input: isRecord(input) ? input : undefined,
					messageId,
				},
			);
		}

		case "tool.running":
			if (event.data.metadata) {
				return emit({
					type: "tool_executing",
					id: event.data.partId,
					name: "Task",
					input: undefined,
					metadata: event.data.metadata,
					messageId: event.data.messageId,
				});
			}
			return silent(
				"ToolRunningPayload carries no callId; partId anchor already covered by tool.started",
			);

		case "tool.input_updated":
			return silent("Historical event — no longer emitted after Phase 2");

		case "tool.completed": {
			const { partId, result, messageId } = event.data;
			return emit({
				type: "tool_result",
				id: partId,
				content: typeof result === "string" ? result : stringify(result),
				is_error: false,
				messageId,
			});
		}

		case "turn.completed": {
			const { tokens, cost, duration } = event.data;
			return emit(
				{
					type: "result",
					usage: {
						input: tokens?.input ?? 0,
						output: tokens?.output ?? 0,
						cache_read: tokens?.cacheRead ?? 0,
						cache_creation: tokens?.cacheWrite ?? 0,
					},
					cost: cost ?? 0,
					duration: duration ?? 0,
					sessionId: event.sessionId,
				} satisfies RelayMessage,
				{ type: "done", code: 0 },
			);
		}

		case "turn.error": {
			const { error, code } = event.data;
			return emit(
				{ type: "error", code: code ?? "TURN_ERROR", message: error },
				{ type: "done", code: 1 },
			);
		}

		case "turn.interrupted":
			return emit({ type: "done", code: 1 });

		case "session.status":
			if (event.data.status === "retry") {
				const reason =
					typeof event.metadata.correlationId === "string"
						? event.metadata.correlationId
						: "Retrying";
				return emit({ type: "error", code: "RETRY", message: reason });
			}
			return silent(
				"prompt handler owns lifecycle; terminal done/error covers completion",
			);

		case "message.created":
		case "session.created":
		case "session.renamed":
		case "session.provider_changed":
			return silent("persistence-only event; no UI surface in relay");

		case "permission.asked":
		case "permission.resolved":
		case "question.asked":
		case "question.resolved":
			return silent(
				"handled via requestPermission/requestQuestion side-channel",
			);

		default:
			return silent("unhandled event type");
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringify(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
