// ─── Relay Event Sink ────────────────────────────────────────────────────────
// Translates adapter-emitted CanonicalEvents into RelayMessages and pushes
// them straight to WebSocket clients. Used for the in-process Claude SDK path
// (ClaudeAdapter) where there is no SSE stream to piggy-back on. Permissions
// and questions are bridged through the same path so the UI receives the
// familiar RelayMessage shapes.

import { createLogger } from "../logger.js";
import type { CanonicalEvent, StoredEvent } from "../persistence/events.js";
import type { PermissionId } from "../shared-types.js";
import { tagWithSessionId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";
import { createDeferred, type Deferred } from "./deferred.js";
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

export interface RelayEventSinkPersist {
	readonly eventStore: { append(event: CanonicalEvent): StoredEvent };
	readonly projectionRunner: { projectEvent(event: StoredEvent): void };
	readonly ensureSession: (sessionId: string) => void;
}

export interface RelayEventSinkDeps {
	readonly sessionId: string;
	readonly send: (msg: RelayMessage) => void;
	/** Optional: clear processing timeout when the turn finishes (done/error). */
	readonly clearTimeout?: () => void;
	/** Optional: reset processing timeout on any activity. */
	readonly resetTimeout?: () => void;
	/** Optional: persist events to SQLite for session history survival. */
	readonly persist?: RelayEventSinkPersist;
	/** Optional: permission bridge for tracking pending permissions (enables replay on session switch). */
	readonly permissionBridge?: {
		trackPending(entry: {
			requestId: PermissionId;
			sessionId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
			always: string[];
			timestamp: number;
		}): void;
		/** Clean up the bridge entry when a permission is resolved. */
		onPermissionReplied(requestId: string): boolean;
	};
	/** Optional: question bridge for tracking pending questions (enables replay on session switch). */
	readonly questionBridge?: {
		trackPending(entry: {
			requestId: string;
			sessionId: string;
			questions: Array<{
				question: string;
				header?: string;
				options?: unknown[];
				multiSelect?: boolean;
			}>;
			toolCallId?: string;
			timestamp: number;
		}): void;
		/** Clean up the bridge entry when a question is resolved. */
		onResolved(requestId: string): boolean;
	};
}

export interface RelayEventSink extends EventSink {
	/** Resolve a pending permission request (from UI). */
	resolvePermission(requestId: string, response: PermissionResponse): void;
	/** Resolve a pending question request (from UI). */
	resolveQuestion(requestId: string, answers: Record<string, unknown>): void;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createRelayEventSink(deps: RelayEventSinkDeps): RelayEventSink {
	const { sessionId, send, clearTimeout, resetTimeout, persist } = deps;

	const pendingPermissions = new Map<string, Deferred<PermissionResponse>>();
	const pendingQuestions = new Map<string, Deferred<Record<string, unknown>>>();

	function reset(): void {
		if (resetTimeout) resetTimeout();
	}

	function finish(): void {
		if (clearTimeout) clearTimeout();
	}

	return {
		async push(event: CanonicalEvent): Promise<void> {
			reset();
			// Persist to SQLite when available (before WS send for durability)
			if (persist) {
				try {
					persist.ensureSession(sessionId);
					const stored = persist.eventStore.append(event);
					persist.projectionRunner.projectEvent(stored);
				} catch (err) {
					// Non-fatal — same pattern as dual-write-hook.ts:149.
					// Covers: disk full, DB locked, projection recovery guard, etc.
					log.debug(
						`Persist failed for ${event.type} (session=${sessionId}): ${err instanceof Error ? err.message : err}`,
					);
				}
			}
			const result = translateCanonicalEvent(event);
			if (result.kind === "emit") {
				for (const raw of result.messages) {
					const m = tagWithSessionId(raw, sessionId);
					send(m);
					const isTerminal =
						m.type === "done" || (m.type === "error" && m.code !== "RETRY");
					if (isTerminal) finish();
				}
			}
		},

		async requestPermission(
			request: PermissionRequest,
		): Promise<PermissionResponse> {
			reset();
			// Register with the permission bridge so this permission can be
			// replayed when the user switches sessions and comes back.
			if (deps.permissionBridge) {
				deps.permissionBridge.trackPending({
					requestId: request.requestId as PermissionId,
					sessionId,
					toolName: request.toolName,
					toolInput: request.toolInput as Record<string, unknown>,
					always: request.always ?? [],
					timestamp: Date.now(),
				});
			}
			send({
				type: "permission_request",
				sessionId,
				requestId: request.requestId as PermissionId,
				toolName: request.toolName,
				toolInput: request.toolInput,
				always: request.always ?? [],
			});
			const deferred = createDeferred<PermissionResponse>();
			pendingPermissions.set(request.requestId, deferred);
			return deferred.promise;
		},

		async requestQuestion(
			request: QuestionRequest,
		): Promise<Record<string, unknown>> {
			reset();
			// Register with the question bridge so this question can be
			// replayed when the user switches sessions and comes back.
			if (deps.questionBridge) {
				deps.questionBridge.trackPending({
					requestId: request.requestId,
					sessionId,
					questions: request.questions.map((q) => ({
						question: q.question,
						header: q.header,
						options: q.options,
						multiSelect: q.multiSelect ?? false,
					})),
					timestamp: Date.now(),
				});
			}
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
			const deferred = createDeferred<Record<string, unknown>>();
			pendingQuestions.set(request.requestId, deferred);
			return deferred.promise;
		},

		resolvePermission(requestId: string, response: PermissionResponse): void {
			const deferred = pendingPermissions.get(requestId);
			if (!deferred) {
				log.warn(
					`resolvePermission: no pending request ${requestId} (session=${sessionId})`,
				);
				return;
			}
			pendingPermissions.delete(requestId);
			// Clean up the bridge entry so it is no longer replayed on
			// session switch / reconnect.
			if (deps.permissionBridge) {
				deps.permissionBridge.onPermissionReplied(requestId);
			}
			deferred.resolve(response);
		},

		resolveQuestion(requestId: string, answers: Record<string, unknown>): void {
			const deferred = pendingQuestions.get(requestId);
			if (!deferred) {
				log.warn(
					`resolveQuestion: no pending request ${requestId} (session=${sessionId})`,
				);
				return;
			}
			pendingQuestions.delete(requestId);
			// Clean up the bridge entry so it is no longer replayed on
			// session switch / reconnect.
			if (deps.questionBridge) {
				deps.questionBridge.onResolved(requestId);
			}
			deferred.resolve(answers);
		},
	};
}

// ─── Translation ────────────────────────────────────────────────────────────
// Maps CanonicalEvent (adapter-emitted) → RelayMessage[] (client-facing).
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
