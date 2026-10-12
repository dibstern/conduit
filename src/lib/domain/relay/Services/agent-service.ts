import { type Cause, Context, Effect, Layer, Option } from "effect";
import type { Account, AccountRef } from "../../../contracts/account.js";
import type { AccountUnroutable } from "../../../contracts/limit-recovery.js";
import {
	type AccountId,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../contracts/provider-instance.js";
import type { Agent } from "../../../instance/sdk-types.js";
import { harnessForModelProvider } from "../../../provider/turn-settings.js";
import type { ProviderAgentInfo } from "../../../provider/types.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { LoggerTag, OrchestrationEngineTag } from "./services.js";
import {
	clearAgent,
	getAgent,
	getDefaultModel,
	OverridesStateTag,
	setAgent,
} from "./session-overrides-state.js";

export interface WireAgent {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly model?: string;
}

export interface AgentProviderScope {
	readonly id: "opencode" | "claude";
	readonly name: "OpenCode" | "Claude";
}

export interface AgentList {
	readonly instanceId?: AccountId;
	readonly providerScope: AgentProviderScope;
	readonly agents: readonly WireAgent[];
	readonly activeAgentId?: string;
}

export interface SwitchAgentInput {
	readonly clientId: string;
	readonly sessionId: string | undefined;
	readonly agentId: string;
}

/**
 * Filter agents for the mode switcher UI.
 *
 * Matches OpenCode's own TUI behavior: show only non-subagent, non-hidden
 * agents (i.e. `mode !== "subagent" && !hidden`). This shows "build", "plan",
 * and any custom agents with mode "primary" or "all".
 *
 * Falls back to a hardcoded blocklist when mode/hidden fields are absent
 * (older OpenCode versions).
 */
const HIDDEN_AGENT_NAMES = new Set([
	"title",
	"compaction",
	"summary",
	"summarize",
	"compact",
]);

export function filterAgents(rawAgents: Agent[]): WireAgent[] {
	return rawAgents
		.map((a) => ({
			id: a.name || a.id || "",
			name: a.name || a.id || "",
			...(a.description != null && { description: a.description }),
			mode: a.mode,
			hidden: a.hidden,
		}))
		.filter((a) => {
			if (!a.id) return false;
			if (a.mode !== undefined || a.hidden !== undefined) {
				return a.mode !== "subagent" && !a.hidden;
			}
			return !HIDDEN_AGENT_NAMES.has(a.id.toLowerCase());
		})
		.map(({ id, name, description }) => ({
			id,
			name,
			...(description != null && { description }),
		}));
}

export function toWireAgents(
	agents: readonly ProviderAgentInfo[],
): WireAgent[] {
	return agents.map((agent) => ({
		id: agent.id,
		name: agent.name,
		...(agent.description ? { description: agent.description } : {}),
		...(agent.model ? { model: agent.model } : {}),
	}));
}

export interface AgentService {
	listAgents(
		activeSessionId: string | undefined,
		accountRef?: AccountRef,
	): Effect.Effect<AgentList, Cause.UnknownException | AccountUnroutable>;
	getActiveAgent(sessionId: string): Effect.Effect<string | undefined>;
	switchAgent(input: SwitchAgentInput): Effect.Effect<void>;
}

export class AgentServiceTag extends Context.Tag("AgentService")<
	AgentServiceTag,
	AgentService
>() {}

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const OPENCODE_PROVIDER_SCOPE: AgentProviderScope = {
	id: "opencode",
	name: "OpenCode",
};

const CLAUDE_PROVIDER_SCOPE: AgentProviderScope = {
	id: "claude",
	name: "Claude",
};

const withActiveAgent = (
	agents: readonly WireAgent[],
	sessionId: string | undefined,
	clearMissing: boolean,
) =>
	Effect.gen(function* () {
		if (!sessionId) return { agents };
		const activeAgentId = yield* getAgent(sessionId);
		if (!activeAgentId) return { agents };
		if (agents.some((agent) => agent.id === activeAgentId)) {
			return { agents, activeAgentId };
		}
		if (clearMissing) {
			yield* clearAgent(sessionId);
		}
		return { agents };
	});

const scopedAgentList = (
	providerScope: AgentProviderScope,
	agents: readonly WireAgent[],
	sessionId: string | undefined,
	instanceId?: AccountId,
	clearMissing = instanceId === undefined,
) =>
	Effect.map(withActiveAgent(agents, sessionId, clearMissing), (result) => ({
		...(instanceId === undefined ? {} : { instanceId }),
		providerScope,
		...result,
	}));

export const AgentServiceLive: Layer.Layer<
	AgentServiceTag,
	never,
	| OpenCodeInstancesTag
	| LoggerTag
	| OverridesStateTag
	| OrchestrationEngineTag
	| AccountDirectory
> = Layer.effect(
	AgentServiceTag,
	Effect.gen(function* () {
		const instances = yield* OpenCodeInstancesTag;
		const log = yield* LoggerTag;
		const overridesRef = yield* OverridesStateTag;
		const engine = yield* OrchestrationEngineTag;
		const directory = yield* AccountDirectory;
		const provideOverrides = <A, E>(
			effect: Effect.Effect<A, E, OverridesStateTag>,
		) => Effect.provideService(effect, OverridesStateTag, overridesRef);

		return {
			listAgents: (activeSessionId, accountRef) =>
				Effect.gen(function* () {
					const boundId =
						accountRef === undefined && activeSessionId
							? yield* engine.getProviderForSessionEffect(activeSessionId)
							: undefined;
					const defaultModel =
						accountRef === undefined && boundId === undefined
							? yield* provideOverrides(getDefaultModel())
							: undefined;
					const account = yield* directory.resolve(
						accountRef ??
							(boundId === undefined
								? {
										_tag: "DriverDefault",
										driver: defaultModel
											? harnessForModelProvider(defaultModel.providerID)
											: "opencode",
									}
								: { _tag: "Id", id: boundId }),
					);
					const instanceId =
						accountRef === undefined && boundId === undefined
							? undefined
							: account.id;
					const clearMissing = accountRef === undefined;
					const listClaudeAgents = (claude: Account) =>
						Effect.gen(function* () {
							const result = yield* Effect.either(
								engine.dispatchEffect({
									type: "discover",
									providerId: "claude",
									account: claude,
								}),
							);
							if (result._tag === "Left")
								log.warn(
									`Failed to discover Claude agents: ${describeError(result.left)}`,
								);
							return yield* provideOverrides(
								scopedAgentList(
									CLAUDE_PROVIDER_SCOPE,
									result._tag === "Right"
										? toWireAgents(result.right.agents ?? [])
										: [],
									activeSessionId,
									instanceId,
									clearMissing,
								),
							);
						});
					if (account.driver === "claude")
						return yield* listClaudeAgents(account);

					const running = yield* instances.ifRunning(
						MANAGED_OPENCODE_ACCOUNT_ID,
					);
					if (Option.isNone(running)) {
						// A stopped instance has no catalog to validate the saved selection against.
						return yield* provideOverrides(
							scopedAgentList(
								OPENCODE_PROVIDER_SCOPE,
								[],
								activeSessionId,
								instanceId,
								false,
							),
						);
					}
					const result = yield* Effect.either(
						Effect.tryPromise(() => running.value.app.agents()),
					);
					if (result._tag === "Right")
						return yield* provideOverrides(
							scopedAgentList(
								OPENCODE_PROVIDER_SCOPE,
								filterAgents(result.right),
								activeSessionId,
								instanceId,
								clearMissing,
							),
						);
					log.warn(
						`Failed to discover OpenCode agents: ${describeError(result.left)}`,
					);
					if (accountRef !== undefined)
						return yield* provideOverrides(
							scopedAgentList(
								OPENCODE_PROVIDER_SCOPE,
								[],
								activeSessionId,
								instanceId,
								clearMissing,
							),
						);
					if (boundId === undefined) {
						log.warn(
							`Failed to discover OpenCode agents; falling back to Claude agents: ${describeError(result.left)}`,
						);
						return yield* listClaudeAgents(
							yield* directory.resolve({
								_tag: "DriverDefault",
								driver: "claude",
							}),
						);
					}
					return yield* Effect.fail(result.left);
				}).pipe(Effect.scoped),
			getActiveAgent: (sessionId) => provideOverrides(getAgent(sessionId)),
			switchAgent: ({ clientId, sessionId, agentId }) =>
				Effect.gen(function* () {
					if (!agentId) return;
					if (sessionId) {
						yield* provideOverrides(setAgent(sessionId, agentId));
					} else {
						log.warn(
							`client=${clientId} agent switch with no session - ignoring`,
						);
					}
					log.info(
						`client=${clientId} session=${sessionId ?? "?"} Switched to: ${agentId}`,
					);
				}),
		};
	}),
);
