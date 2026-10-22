import { Data } from "effect";
import { OpenCodeUnavailable } from "../domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";

export class ProviderNotRegistered extends Data.TaggedError(
	"ProviderNotRegistered",
)<{
	readonly providerId: string;
}> {
	get message(): string {
		return `No provider instance registered for provider: ${this.providerId}`;
	}
}

export class SessionProviderNotBound extends Data.TaggedError(
	"SessionProviderNotBound",
)<{
	readonly sessionId: string;
}> {
	get message(): string {
		return `No provider bound to session: ${this.sessionId}`;
	}
}

export class DuplicateCommand extends Data.TaggedError("DuplicateCommand")<{
	readonly commandId: string;
}> {
	get message(): string {
		return `Duplicate command: ${this.commandId}`;
	}
}

export class MissingCommandId extends Data.TaggedError("MissingCommandId")<{
	readonly commandType: string;
}> {
	get message(): string {
		return `Missing commandId for mutating provider command: ${this.commandType}`;
	}
}

export class ProviderInstanceFailure extends Data.TaggedError(
	"ProviderInstanceFailure",
)<{
	readonly providerId: string;
	readonly operation: string;
	readonly cause: unknown;
	readonly code?:
		| "auth_required"
		| "provider_process_gone"
		| "provider_process_unavailable"
		| "runner_detached"
		| "project_inactive"
		| "project_unavailable";
}> {
	/** Classify the native adapter failure; unknown errors must not hold controls. */
	get retryable(): boolean {
		return this.code === undefined && isTransientProviderError(this.cause);
	}

	get retryAfter(): string | undefined {
		return this.cause instanceof ProviderInstanceFailure ||
			this.cause instanceof OpenCodeApiError
			? this.cause.retryAfter
			: undefined;
	}

	get message(): string {
		const inner =
			this.cause instanceof Error ? this.cause.message : String(this.cause);
		return `Provider instance ${this.operation} failed for provider ${this.providerId}: ${inner}`;
	}
}

function isTransientProviderError(cause: unknown): boolean {
	if (cause instanceof ProviderInstanceFailure) return cause.retryable;
	if (cause instanceof OpenCodeApiError)
		return (
			cause.responseStatus === 408 ||
			cause.responseStatus === 429 ||
			(cause.responseStatus >= 500 && cause.responseStatus < 600)
		);
	if (cause instanceof OpenCodeConnectionError) return true;
	if (cause instanceof OpenCodeUnavailable)
		return (
			cause.code !== "provider_process_gone" && cause.reason === "unreachable"
		);
	if (cause === null || typeof cause !== "object") return false;
	if ("retryable" in cause && cause.retryable === false) return false;
	if ("code" in cause) {
		switch (cause.code) {
			case "provider_process_gone":
			case "provider_process_unavailable":
			case "runner_quarantined":
				return false;
			case "ECONNREFUSED":
			case "ECONNRESET":
			case "ECONNABORTED":
			case "EPIPE":
			case "ENOTFOUND":
			case "EAI_AGAIN":
			case "ETIMEDOUT":
			case "ENETUNREACH":
			case "EHOSTUNREACH":
			case "UND_ERR_CONNECT_TIMEOUT":
			case "UND_ERR_HEADERS_TIMEOUT":
			case "UND_ERR_BODY_TIMEOUT":
			case "UND_ERR_SOCKET":
			case "runner_idle_exit":
			case "runner_recovery_abandoned":
			case "runner_detached":
				return true;
		}
	}
	// SessionFailure preserves these fields across the Claude/Cursor runner wire.
	return (
		("retryable" in cause && cause.retryable === true) ||
		("name" in cause && cause.name === "TimeoutError") ||
		("operation" in cause &&
			cause.operation === "runner socket" &&
			"message" in cause &&
			(cause.message === "Runner socket closed" ||
				cause.message === "Socket is closed")) ||
		("operation" in cause &&
			cause.operation === "runner hello" &&
			"message" in cause &&
			cause.message === "Runner handshake timed out") ||
		("cause" in cause && isTransientProviderError(cause.cause))
	);
}

export class CommandIdGenerationFailed extends Data.TaggedError(
	"CommandIdGenerationFailed",
)<{
	readonly commandId: string;
	readonly cause: unknown;
}> {
	get message(): string {
		return `Command id generation failed for command ${this.commandId}`;
	}
}

export class CommandFingerprintMismatch extends Data.TaggedError(
	"CommandFingerprintMismatch",
)<{
	readonly commandId: string;
}> {
	get message(): string {
		return `Command ${this.commandId} reused with a different effective dispatch fingerprint`;
	}
}

export class StaleCommandRejected extends Data.TaggedError(
	"StaleCommandRejected",
)<{
	readonly commandId: string;
	readonly scopeKind: string;
	readonly scopeId: string;
}> {
	get message(): string {
		return `Command ${this.commandId} rejected: ${this.scopeKind} ${this.scopeId} is tombstoned`;
	}
}

export class MissingPendingInteractions extends Data.TaggedError(
	"MissingPendingInteractions",
)<{
	readonly operation: "requestPermission" | "requestQuestion";
	readonly sessionId: string;
}> {
	get message(): string {
		return `RelayEventSink requires pendingInteractions for ${this.operation} in session ${this.sessionId}`;
	}
}

export type OrchestrationError =
	| ProviderNotRegistered
	| SessionProviderNotBound
	| DuplicateCommand
	| MissingCommandId
	| ProviderInstanceFailure
	| CommandIdGenerationFailed
	| CommandFingerprintMismatch
	| StaleCommandRejected;
