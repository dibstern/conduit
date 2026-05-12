import { type Cause, Context, Effect, Layer } from "effect";
import type { Agent } from "../instance/sdk-types.js";
import type { ProviderAgentInfo } from "../provider/types.js";
import {
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
} from "./services.js";
import {
	clearAgent,
	getAgent,
	OverridesStateTag,
	setAgent,
} from "./session-overrides-state.js";

export interface WireAgent {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly model?: string;
}

export interface AgentList {
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
	): Effect.Effect<AgentList, Cause.UnknownException>;
	getActiveAgent(sessionId: string): Effect.Effect<string | undefined>;
	switchAgent(input: SwitchAgentInput): Effect.Effect<void>;
}

export class AgentServiceTag extends Context.Tag("AgentService")<
	AgentServiceTag,
	AgentService
>() {}

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const withActiveAgent = (
	agents: readonly WireAgent[],
	sessionId: string | undefined,
) =>
	Effect.gen(function* () {
		if (!sessionId) return { agents };
		const activeAgentId = yield* getAgent(sessionId);
		if (!activeAgentId) return { agents };
		if (agents.some((agent) => agent.id === activeAgentId)) {
			return { agents, activeAgentId };
		}
		yield* clearAgent(sessionId);
		return { agents };
	});

export const AgentServiceLive: Layer.Layer<
	AgentServiceTag,
	never,
	OpenCodeAPITag | LoggerTag | OverridesStateTag
> = Layer.effect(
	AgentServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const log = yield* LoggerTag;
		const overridesRef = yield* OverridesStateTag;
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const provideOverrides = <A, E>(
			effect: Effect.Effect<A, E, OverridesStateTag>,
		) => Effect.provideService(effect, OverridesStateTag, overridesRef);

		return {
			listAgents: (activeSessionId) =>
				Effect.gen(function* () {
					const activeProviderId =
						activeSessionId &&
						engineOption._tag === "Some" &&
						typeof engineOption.value.getProviderForSession === "function"
							? engineOption.value.getProviderForSession(activeSessionId)
							: undefined;

					if (activeProviderId === "claude" && engineOption._tag === "Some") {
						const result = yield* Effect.either(
							engineOption.value.dispatchEffect({
								type: "discover",
								providerId: "claude",
							}),
						);
						if (result._tag === "Left") {
							log.warn(
								`Failed to discover Claude agents: ${describeError(result.left)}`,
							);
							return yield* provideOverrides(
								withActiveAgent([], activeSessionId),
							);
						}
						return yield* provideOverrides(
							withActiveAgent(
								toWireAgents(result.right.agents ?? []),
								activeSessionId,
							),
						);
					}

					const rawAgents = yield* Effect.tryPromise(() => client.app.agents());
					return yield* provideOverrides(
						withActiveAgent(filterAgents(rawAgents), activeSessionId),
					);
				}),
			getActiveAgent: (sessionId) => provideOverrides(getAgent(sessionId)),
			switchAgent: ({ clientId, sessionId, agentId }) =>
				Effect.gen(function* () {
					if (!agentId) return;
					if (sessionId) {
						yield* provideOverrides(setAgent(sessionId, agentId));
					} else {
						log.warn(
							`client=${clientId} switch_agent with no session - ignoring`,
						);
					}
					log.info(
						`client=${clientId} session=${sessionId ?? "?"} Switched to: ${agentId}`,
					);
				}),
		};
	}),
);
