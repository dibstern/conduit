import { Effect } from "effect";
import type { ProviderInstanceFailure } from "../errors.js";
import type {
	PermissionDecision,
	ProviderCapabilities,
	ProviderDriver,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import {
	type ClaudeProviderInstanceDeps,
	ClaudeProviderRuntime,
	makeClaudeProviderRuntime,
	makeUnsafeClaudeProviderRuntime,
} from "./claude-provider-runtime.js";

export type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";

export class ClaudeProviderInstance implements ProviderInstance {
	readonly providerId = "claude";
	private readonly runtime: ClaudeProviderRuntime;

	constructor(runtime: ClaudeProviderRuntime);
	constructor(deps: ClaudeProviderInstanceDeps);
	constructor(input: ClaudeProviderRuntime | ClaudeProviderInstanceDeps) {
		this.runtime =
			input instanceof ClaudeProviderRuntime
				? input
				: makeUnsafeClaudeProviderRuntime(input);
	}

	discoverEffect(): Effect.Effect<
		ProviderCapabilities,
		ProviderInstanceFailure
	> {
		return this.runtime.discoverEffect();
	}

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		return this.runtime.sendTurnEffect(input);
	}

	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.interruptTurnEffect(sessionId);
	}

	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.resolvePermissionEffect(sessionId, requestId, decision);
	}

	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.resolveQuestionEffect(sessionId, requestId, answers);
	}

	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.shutdownEffect();
	}

	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.endSessionEffect(sessionId);
	}
}

export const ClaudeDriver: ProviderDriver<ClaudeProviderInstanceDeps> = {
	providerId: "claude",
	create: (deps) =>
		makeClaudeProviderRuntime(deps).pipe(
			Effect.map((runtime) => new ClaudeProviderInstance(runtime)),
		),
};
