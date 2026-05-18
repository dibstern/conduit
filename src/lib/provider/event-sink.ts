// src/lib/provider/event-sink.ts
// ─── Event Sink Implementation ──────────────────────────────────────────────
// Wraps EventStore + ProjectionRunner so provider instances can push canonical events
// without knowing about SQLite internals. Permission and question requests
// block the provider instance's turn loop until the user resolves them.

import { Deferred, Effect } from "effect";
import {
	isProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../contracts/providers/provider-runtime-event.js";
import { createLogger } from "../logger.js";
import type { EventStore } from "../persistence/event-store.js";
import type { CanonicalEvent } from "../persistence/events.js";
import type { ProjectionRunner } from "../persistence/projection-runner.js";
import { ProviderRuntimeEventStore } from "../persistence/provider-runtime-event-store.js";

const log = createLogger("event-sink");

import { makeProviderRuntimeEvent } from "./provider-runtime-event-sink.js";
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
	private readonly providerRuntimeEventStore: ProviderRuntimeEventStore;
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

	constructor(deps: EventSinkDeps) {
		this.eventStore = deps.eventStore;
		this.providerRuntimeEventStore = new ProviderRuntimeEventStore(
			deps.eventStore,
		);
		this.projectionRunner = deps.projectionRunner;
		this.sessionId = deps.sessionId;
		this.provider = deps.provider;
		if (deps.abortSignal) {
			deps.abortSignal.addEventListener("abort", () => this.abort(), {
				once: true,
			});
		}
	}

	/** Append an event to the store and project it eagerly. */
	push(
		event: ProviderRuntimeEvent | CanonicalEvent,
	): Effect.Effect<void, unknown> {
		return Effect.sync(() => {
			const stored = isProviderRuntimeEvent(event)
				? this.providerRuntimeEventStore.append(event)
				: this.eventStore.append(event);
			this.projectionRunner.projectEvent(stored);
		});
	}

	/** Emit permission.asked and wait until the user resolves it. */
	requestPermission(
		request: PermissionRequest,
	): Effect.Effect<PermissionResponse, unknown> {
		return Effect.gen(this, function* () {
			const deferred = yield* Deferred.make<PermissionResponse, Error>();
			this.pendingPermissions.set(request.requestId, deferred);

			const event = makeProviderRuntimeEvent(
				"permission.asked",
				this.sessionId,
				{
					id: request.requestId,
					sessionId: this.sessionId,
					toolName: request.toolName,
					input: request.toolInput,
				},
				{
					providerId: this.provider,
					turnId: request.turnId,
					providerRefs: {
						providerRequestId: request.requestId,
						providerToolUseId: request.providerItemId,
					},
					rawSource: { kind: `${this.provider}-event-sink` },
				},
			);
			yield* this.push(event);

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

			const event = makeProviderRuntimeEvent(
				"question.asked",
				this.sessionId,
				{
					id: request.requestId,
					sessionId: this.sessionId,
					questions: request.questions,
				},
				{
					providerId: this.provider,
					providerRefs: {
						providerRequestId: request.requestId,
						...(request.toolUseId != null
							? { providerToolUseId: request.toolUseId }
							: {}),
					},
					rawSource: { kind: `${this.provider}-event-sink` },
				},
			);
			yield* this.push(event);

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
			// Emit the permission.resolved event
			const event = makeProviderRuntimeEvent(
				"permission.resolved",
				this.sessionId,
				{
					id: requestId,
					decision: response.decision,
				},
				{
					providerId: this.provider,
					providerRefs: { providerRequestId: requestId },
					rawSource: { kind: `${this.provider}-event-sink` },
				},
			);
			yield* this.push(event);

			// Unblock the waiting provider instance
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
			// Emit the question.resolved event
			const event = makeProviderRuntimeEvent(
				"question.resolved",
				this.sessionId,
				{
					id: requestId,
					answers,
				},
				{
					providerId: this.provider,
					providerRefs: { providerRequestId: requestId },
					rawSource: { kind: `${this.provider}-event-sink` },
				},
			);
			yield* this.push(event);

			// Unblock the waiting provider instance
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
