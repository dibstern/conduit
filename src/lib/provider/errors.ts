import { Data } from "effect";

export class ProviderNotRegistered extends Data.TaggedError(
	"ProviderNotRegistered",
)<{
	readonly providerId: string;
}> {
	get message(): string {
		return `No adapter registered for provider: ${this.providerId}`;
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

export class ProviderAdapterFailure extends Data.TaggedError(
	"ProviderAdapterFailure",
)<{
	readonly providerId: string;
	readonly operation: string;
	readonly cause: unknown;
}> {
	get message(): string {
		const inner =
			this.cause instanceof Error ? this.cause.message : String(this.cause);
		return `Provider adapter ${this.operation} failed for provider ${this.providerId}: ${inner}`;
	}
}

export type OrchestrationError =
	| ProviderNotRegistered
	| SessionProviderNotBound
	| DuplicateCommand
	| ProviderAdapterFailure;
