import type { SqlError } from "@effect/sql/SqlError";
import { Data } from "effect";
import type { PendingInteractionCancelled } from "../domain/relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestionRequired } from "../domain/relay/Services/provider-turn-dispatch.js";
import type { ClaudeEventPersistEffectError } from "../persistence/effect/claude-event-persist-effect.js";
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

export type ClaudeAdapterError =
	| EventSinkError
	| ClaudeBoundaryError
	| ClaudeRuntimeError
	| ClaudeSDKDecodeError;

export type EventSinkPersistenceError =
	| PersistenceError
	| EventStoreError
	| ClaudeEventPersistEffectError
	| ProjectionRunnerError
	| SqlError;

export type EventSinkError =
	| EventSinkPersistenceError
	| EventSinkIngestionError
	| MissingPendingInteractions
	| PendingInteractionCancelled
	| ProviderRuntimeIngestionRequired
	| ProviderSideEffectInteractionUnsupported;
