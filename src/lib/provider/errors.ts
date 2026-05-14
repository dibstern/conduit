import { Data } from "effect";

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

export class ProviderInstanceFailure extends Data.TaggedError(
	"ProviderInstanceFailure",
)<{
	readonly providerId: string;
	readonly operation: string;
	readonly cause: unknown;
}> {
	get message(): string {
		const inner =
			this.cause instanceof Error ? this.cause.message : String(this.cause);
		return `Provider instance ${this.operation} failed for provider ${this.providerId}: ${inner}`;
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
	| ProviderInstanceFailure;
