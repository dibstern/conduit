import { Data } from "effect";
import type { SqlError } from "effect/sql/SqlError";
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
import type { PickRejection } from "./turn-settings.js";

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
	readonly code?: string;
}> {}

/** Native fork/resume cannot safely preserve this turn's context. */
export class ClaudeResumeRefused extends Data.TaggedError(
	"ClaudeResumeRefused",
)<{
	readonly message: string;
	readonly reason:
		| "resume_drops_turn"
		| "goal_clear_unsupported"
		| "fork_transcript_unavailable";
}> {
	readonly code = "claude_resume_refused";
}

export function isClaudeResumeRefused(error: unknown): boolean {
	let cause = error;
	for (let depth = 0; depth < 5; depth++) {
		if (typeof cause === "string")
			return cause.includes("Resume rejected by --resume-drops-turn:");
		if (cause === null || typeof cause !== "object") return false;
		if ("code" in cause && cause.code === "claude_resume_refused") return true;
		if (
			"message" in cause &&
			typeof cause.message === "string" &&
			cause.message.includes("Resume rejected by --resume-drops-turn:")
		)
			return true;
		if (!("cause" in cause)) return false;
		cause = cause.cause;
	}
	return false;
}

/** Match the CLI's stale-resume diagnostic, including SDK stderr tails. */
export function isClaudeResumeFailure(error: unknown): boolean {
	let cause = error;
	for (let depth = 0; depth < 5; depth++) {
		if (
			cause !== null &&
			typeof cause === "object" &&
			"code" in cause &&
			cause.code === "claude_resume_refused"
		)
			return true;
		const message =
			typeof cause === "string"
				? cause
				: cause !== null && typeof cause === "object" && "message" in cause
					? cause.message
					: undefined;
		if (
			typeof message === "string" &&
			(/^No conversation found with session ID/m.test(message) ||
				/Resume rejected by --resume-drops-turn:/m.test(message))
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
	| ClaudeResumeRefused
	| ClaudeSDKDecodeError
	| PickRejection;

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
