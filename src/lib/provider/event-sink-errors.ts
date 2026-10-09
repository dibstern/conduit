import type { SqlError } from "@effect/sql/SqlError";
import { Data } from "effect";
import type { PendingInteractionCancelled } from "../domain/relay/Services/pending-interaction-service.js";
import type {
	ClaudeEventPersistEffectError,
	ClaudeSessionLifecycleError,
} from "../persistence/effect/claude-event-persist-effect.js";
import type { EventStoreError } from "../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerError } from "../persistence/effect/projection-runner-effect.js";
import type { PersistenceError } from "../persistence/errors.js";
import type { ClaudeSDKDecodeError } from "./claude/claude-sdk-validation.js";
import type { MissingPendingInteractions } from "./errors.js";
import type { ProviderSideEffectInteractionUnsupported } from "./orchestration-side-effect-reactor.js";

/** An ingestion implementation failed with an error outside its declared store errors. */
export class EventSinkIngestionError extends Data.TaggedError(
	"EventSinkIngestionError",
)<{ readonly cause: unknown }> {
	get message(): string {
		return this.cause instanceof Error
			? this.cause.message
			: String(this.cause);
	}
}

export class ClaudeBoundaryError extends Data.TaggedError(
	"ClaudeBoundaryError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {
	get message(): string {
		return this.cause instanceof Error
			? this.cause.message
			: String(this.cause);
	}
}

export class ClaudeRuntimeError extends Data.TaggedError("ClaudeRuntimeError")<{
	readonly message: string;
}> {}

/** Match the CLI's stale-resume diagnostic, including SDK stderr tails. */
export function isClaudeResumeFailure(error: unknown): boolean {
	let cause = error;
	for (let depth = 0; depth < 5; depth++) {
		const message =
			typeof cause === "string"
				? cause
				: cause !== null && typeof cause === "object" && "message" in cause
					? cause.message
					: undefined;
		if (
			typeof message === "string" &&
			/^No conversation found with session ID/m.test(message)
		)
			return true;
		if (cause === null || typeof cause !== "object" || !("cause" in cause))
			return false;
		cause = cause.cause;
	}
	return false;
}

export type ClaudeAdapterError =
	| EventSinkError
	| ClaudeBoundaryError
	| ClaudeRuntimeError
	| ClaudeSDKDecodeError;

export type EventSinkPersistenceError =
	| PersistenceError
	| EventStoreError
	| ClaudeEventPersistEffectError
	| ClaudeSessionLifecycleError
	| ProjectionRunnerError
	| SqlError;

export type EventSinkError =
	| EventSinkPersistenceError
	| EventSinkIngestionError
	| MissingPendingInteractions
	| PendingInteractionCancelled
	| ProviderSideEffectInteractionUnsupported;
