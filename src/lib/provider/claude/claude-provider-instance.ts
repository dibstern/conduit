import { Effect } from "effect";
import { PROVIDER_SESSION_CAPABILITIES } from "../../contracts/provider-instance.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import type { ProviderInstanceFailure } from "../errors.js";
import type {
	PermissionDecision,
	PreWarmSessionInput,
	ProviderCapabilities,
	ProviderDriver,
	ProviderInstance,
	ProviderNativeSession,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import {
	type ClaudeProviderInstanceDeps,
	type ClaudeProviderRuntime,
	makeClaudeProviderRuntime,
} from "./claude-provider-runtime.js";
import { toSdkPermissionMode } from "./permission-mode-map.js";

export type { ClaudeProviderInstanceDeps } from "./claude-provider-runtime.js";

export class ClaudeProviderInstance implements ProviderInstance {
	readonly providerId = "claude";
	readonly steering = true;
	private readonly runtime: ClaudeProviderRuntime;

	constructor(runtime: ClaudeProviderRuntime) {
		this.runtime = runtime;
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

	getNativeSessionEffect(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined> {
		return this.runtime.getNativeSessionEffect(sessionId);
	}

	preWarmSessionEffect(
		input: PreWarmSessionInput,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.preWarmSessionEffect(input);
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

	applyLiveSettingsEffect(
		sessionId: string,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.applyLiveSettingsEffect(sessionId, settings);
	}

	setPermissionModeEffect(
		sessionId: string,
		mode: SessionPermissionMode,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.setPermissionModeEffect(
			sessionId,
			toSdkPermissionMode(mode),
		);
	}

	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.shutdownEffect({ detachInteractions: true });
	}

	recoverEffect() {
		return this.runtime.recoverEffect;
	}

	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.runtime.endSessionEffect(sessionId);
	}
}

export const ClaudeDriver: ProviderDriver<ClaudeProviderInstanceDeps> = {
	providerId: "claude",
	capabilities: PROVIDER_SESSION_CAPABILITIES.claude,
	create: (deps) =>
		makeClaudeProviderRuntime(deps).pipe(
			Effect.map((runtime) => new ClaudeProviderInstance(runtime)),
		),
};
