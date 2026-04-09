// src/lib/provider/event-sink.ts
// ─── Event Sink Implementation ──────────────────────────────────────────────
// Wraps EventStore + ProjectionRunner so adapters can push canonical events
// without knowing about SQLite internals. Permission and question requests
// block the adapter's turn loop until the user resolves them.

import type { EventStore } from "../persistence/event-store.js";
import type { CanonicalEvent } from "../persistence/events.js";
import { canonicalEvent } from "../persistence/events.js";
import type { ProjectionRunner } from "../persistence/projection-runner.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

// ─── Deferred ───────────────────────────────────────────────────────────────

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

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
		Deferred<PermissionResponse>
	>();
	private readonly pendingQuestions = new Map<
		string,
		Deferred<Record<string, unknown>>
	>();

	private readonly sessionId: string;
	private readonly provider: string;

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

	/** Append an event to the store and project it eagerly. */
	async push(event: CanonicalEvent): Promise<void> {
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);
	}

	/**
	 * Emit a permission.asked event and block until the user resolves it.
	 * Returns the user's decision (once | always | reject).
	 */
	async requestPermission(
		request: PermissionRequest,
	): Promise<PermissionResponse> {
		// Emit the permission.asked event
		const event = canonicalEvent(
			"permission.asked",
			this.sessionId,
			{
				id: request.requestId,
				sessionId: this.sessionId,
				toolName: request.toolName,
				input: request.toolInput,
			},
			{ provider: this.provider },
		);
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Block until resolved
		const deferred = createDeferred<PermissionResponse>();
		this.pendingPermissions.set(request.requestId, deferred);
		return deferred.promise;
	}

	/**
	 * Emit a question.asked event and block until the user answers.
	 * Returns the user's answers as a key-value map.
	 */
	async requestQuestion(
		request: QuestionRequest,
	): Promise<Record<string, unknown>> {
		// Emit the question.asked event
		const event = canonicalEvent(
			"question.asked",
			this.sessionId,
			{
				id: request.requestId,
				sessionId: this.sessionId,
				questions: request.questions,
			},
			{ provider: this.provider },
		);
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Block until resolved
		const deferred = createDeferred<Record<string, unknown>>();
		this.pendingQuestions.set(request.requestId, deferred);
		return deferred.promise;
	}

	/**
	 * Resolve a pending permission request. Called by the orchestration layer
	 * when the user makes a decision.
	 */
	resolvePermission(requestId: string, response: PermissionResponse): void {
		// Emit the permission.resolved event
		const event = canonicalEvent(
			"permission.resolved",
			this.sessionId,
			{
				id: requestId,
				decision: response.decision,
			},
			{ provider: this.provider },
		);
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Unblock the waiting adapter
		const deferred = this.pendingPermissions.get(requestId);
		if (deferred) {
			this.pendingPermissions.delete(requestId);
			deferred.resolve(response);
		}
	}

	/**
	 * Resolve a pending question request. Called by the orchestration layer
	 * when the user answers.
	 */
	resolveQuestion(requestId: string, answers: Record<string, unknown>): void {
		// Emit the question.resolved event
		const event = canonicalEvent(
			"question.resolved",
			this.sessionId,
			{
				id: requestId,
				answers,
			},
			{ provider: this.provider },
		);
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Unblock the waiting adapter
		const deferred = this.pendingQuestions.get(requestId);
		if (deferred) {
			this.pendingQuestions.delete(requestId);
			deferred.resolve(answers);
		}
	}

	/** Abort all pending requests (e.g. when the turn is interrupted). */
	abort(): void {
		const abortError = new Error("EventSink aborted");
		for (const deferred of this.pendingPermissions.values()) {
			deferred.reject(abortError);
		}
		this.pendingPermissions.clear();
		for (const deferred of this.pendingQuestions.values()) {
			deferred.reject(abortError);
		}
		this.pendingQuestions.clear();
	}

	/** Number of pending (unresolved) requests. */
	get pendingCount(): number {
		return this.pendingPermissions.size + this.pendingQuestions.size;
	}
}
