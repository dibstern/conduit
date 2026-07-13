// src/lib/provider/event-sink.ts
// ─── Event Sink Implementation ──────────────────────────────────────────────
// Legacy EventStore test/compatibility adapter. Production provider output is
// routed through ProviderRuntimeIngestion; this class remains for direct
// EventStore/ProjectionRunner unit coverage and older non-relay tests.

import { Deferred, Effect } from "effect";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import { createLogger } from "../logger.js";
import type { EventStore } from "../persistence/event-store.js";
import type { ProjectionRunner } from "../persistence/projection-runner.js";
import {
	emptyProviderRuntimeDomainMapperState,
	type ProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "./provider-runtime-event-to-domain.js";

const log = createLogger("event-sink");

import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

// ─── EventSink Dependencies ─────────────────────────────────────────────────

export interface EventSinkDeps {
	readonly eventStore: EventStore;
	readonly projectionRunner: ProjectionRunner;
	readonly sessionId: string;
	readonly provider: string;
	readonly abortSignal?: AbortSignal;
}

// ─── EventSinkImpl ──────────────────────────────────────────────────────────

export class EventSinkImpl implements EventSink {
	private readonly eventStore: EventStore;
	private readonly projectionRunner: ProjectionRunner;
	private readonly pendingPermissions = new Map<
		string,
		Deferred.Deferred<PermissionResponse, Error>
	>();
	private readonly pendingQuestions = new Map<
		string,
		Deferred.Deferred<Record<string, unknown>, Error>
	>();

	private readonly sessionId: string;
	private readonly provider: string;
	private mapperState: ProviderRuntimeDomainMapperState =
		emptyProviderRuntimeDomainMapperState;

	constructor(deps: EventSinkDeps) {
		this.eventStore = deps.eventStore;
		this.projectionRunner = deps.projectionRunner;
		this.sessionId = deps.sessionId;
		this.provider = deps.provider;
		if (deps.abortSignal) {
			deps.abortSignal.addEventListener("abort", () => this.abort(), {
				once: true,
			});
		}
	}

	/** Ingest a runtime event, append mapped domain events, and project eagerly. */
	push(event: ProviderRuntimeEvent): Effect.Effect<void, unknown> {
		return Effect.sync(() => {
			const result = translateProviderRuntimeEventToDomain(
				event,
				this.mapperState,
			);
			const storedEvents = this.eventStore.appendBatch(result.events);
			this.mapperState = result.state;
			if (storedEvents.length === 1 && storedEvents[0]) {
				this.projectionRunner.projectEvent(storedEvents[0]);
			} else if (storedEvents.length > 1) {
				this.projectionRunner.projectBatch(storedEvents);
			}
		});
	}

	/** Emit permission.asked and wait until the user resolves it. */
	requestPermission(
		request: PermissionRequest,
	): Effect.Effect<PermissionResponse, unknown> {
		return Effect.gen(this, function* () {
			const deferred = yield* Deferred.make<PermissionResponse, Error>();
			this.pendingPermissions.set(request.requestId, deferred);

			yield* this.push(
				permissionAskedRuntimeEvent(this.provider, this.sessionId, request),
			);

			return yield* Deferred.await(deferred).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						this.pendingPermissions.delete(request.requestId);
					}),
				),
			);
		});
	}

	/** Emit question.asked and wait until the user answers. */
	requestQuestion(
		request: QuestionRequest,
	): Effect.Effect<Record<string, unknown>, unknown> {
		return Effect.gen(this, function* () {
			const deferred = yield* Deferred.make<Record<string, unknown>, Error>();
			this.pendingQuestions.set(request.requestId, deferred);

			yield* this.push(
				questionAskedRuntimeEvent(this.provider, this.sessionId, request),
			);

			return yield* Deferred.await(deferred).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						this.pendingQuestions.delete(request.requestId);
					}),
				),
			);
		});
	}

	/**
	 * Resolve a pending permission request. Called by the orchestration layer
	 * when the user makes a decision.
	 */
	resolvePermission(
		requestId: string,
		response: PermissionResponse,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			yield* this.push(
				permissionResolvedRuntimeEvent(
					this.provider,
					this.sessionId,
					requestId,
					response,
				),
			);

			const deferred = this.pendingPermissions.get(requestId);
			if (deferred) {
				this.pendingPermissions.delete(requestId);
				yield* Deferred.succeed(deferred, response).pipe(Effect.ignore);
			} else {
				log.warn(
					`resolvePermission: no pending request for ${requestId} (session=${this.sessionId}) — already resolved or expired`,
				);
			}
		});
	}

	/**
	 * Resolve a pending question request. Called by the orchestration layer
	 * when the user answers.
	 */
	resolveQuestion(
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			yield* this.push(
				questionResolvedRuntimeEvent(
					this.provider,
					this.sessionId,
					requestId,
					answers,
				),
			);

			const deferred = this.pendingQuestions.get(requestId);
			if (deferred) {
				this.pendingQuestions.delete(requestId);
				yield* Deferred.succeed(deferred, answers).pipe(Effect.ignore);
			} else {
				log.warn(
					`resolveQuestion: no pending request for ${requestId} (session=${this.sessionId}) — already resolved or expired`,
				);
			}
		});
	}

	/** Abort all pending requests (e.g. when the turn is interrupted). */
	abort(): void {
		const abortError = new Error("EventSink aborted");
		for (const deferred of this.pendingPermissions.values()) {
			// AbortSignal is a synchronous callback boundary; complete the Effect
			// Deferred directly rather than adding an app-internal runtime bridge.
			Deferred.unsafeDone(deferred, Effect.fail(abortError));
		}
		this.pendingPermissions.clear();
		for (const deferred of this.pendingQuestions.values()) {
			Deferred.unsafeDone(deferred, Effect.fail(abortError));
		}
		this.pendingQuestions.clear();
	}

	/** Number of pending (unresolved) requests. */
	get pendingCount(): number {
		return this.pendingPermissions.size + this.pendingQuestions.size;
	}
}

function permissionAskedRuntimeEvent(
	providerId: string,
	sessionId: string,
	request: PermissionRequest,
): ProviderRuntimeEvent {
	return {
		eventId: `${request.requestId}:permission.asked`,
		type: "permission.asked",
		providerId,
		sessionId,
		turnId: request.turnId,
		providerRefs: {
			providerRequestId: request.requestId,
			providerToolUseId: request.providerItemId,
		},
		rawSource: { kind: "conduit.event-sink.permission" },
		createdAt: Date.now(),
		data: {
			id: request.requestId,
			toolName: request.toolName,
			input: request.toolInput,
		},
	};
}

function permissionResolvedRuntimeEvent(
	providerId: string,
	sessionId: string,
	requestId: string,
	response: PermissionResponse,
): ProviderRuntimeEvent {
	return {
		eventId: `${requestId}:permission.resolved`,
		type: "permission.resolved",
		providerId,
		sessionId,
		providerRefs: { providerRequestId: requestId },
		rawSource: { kind: "conduit.event-sink.permission" },
		createdAt: Date.now(),
		data: {
			id: requestId,
			decision: response.decision,
		},
	};
}

function questionAskedRuntimeEvent(
	providerId: string,
	sessionId: string,
	request: QuestionRequest,
): ProviderRuntimeEvent {
	return {
		eventId: `${request.requestId}:question.asked`,
		type: "question.asked",
		providerId,
		sessionId,
		providerRefs: {
			providerRequestId: request.requestId,
			...(request.toolUseId ? { providerToolUseId: request.toolUseId } : {}),
		},
		rawSource: { kind: "conduit.event-sink.question" },
		createdAt: Date.now(),
		data: {
			id: request.requestId,
			questions: request.questions,
		},
	};
}

function questionResolvedRuntimeEvent(
	providerId: string,
	sessionId: string,
	requestId: string,
	answers: Record<string, unknown>,
): ProviderRuntimeEvent {
	return {
		eventId: `${requestId}:question.resolved`,
		type: "question.resolved",
		providerId,
		sessionId,
		providerRefs: { providerRequestId: requestId },
		rawSource: { kind: "conduit.event-sink.question" },
		createdAt: Date.now(),
		data: {
			id: requestId,
			answers,
		},
	};
}
