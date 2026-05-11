// ─── Agent Handlers ──────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { Agent } from "../instance/sdk-types.js";
import type { ProviderAgentInfo } from "../provider/types.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { RelayMessage } from "../types.js";
import type { PayloadMap } from "./payloads.js";

/**
 * Filter agents for the mode switcher UI.
 *
 * Matches OpenCode's own TUI behavior: show only non-subagent, non-hidden
 * agents (i.e., `mode !== "subagent" && !hidden`). This shows "build", "plan",
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

export function filterAgents(
	rawAgents: Agent[],
): Array<{ id: string; name: string; description?: string }> {
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
			// Use mode/hidden when available (proper filtering)
			if (a.mode !== undefined || a.hidden !== undefined) {
				return a.mode !== "subagent" && !a.hidden;
			}
			// Fallback: blocklist for older OpenCode versions
			return !HIDDEN_AGENT_NAMES.has(a.id.toLowerCase());
		})
		.map(({ id, name, description }) => ({
			id,
			name,
			...(description != null && { description }),
		}));
}

export function claudeAgentMatchesModel(
	agent: ProviderAgentInfo,
	modelId: string | undefined,
): boolean {
	if (!agent.model) return true;
	if (!modelId) return true;
	const normalizedAgentModel = agent.model.toLowerCase();
	const normalizedModelId = modelId.toLowerCase();
	return (
		normalizedModelId === normalizedAgentModel ||
		normalizedModelId.includes(normalizedAgentModel)
	);
}

export function toWireAgents(
	agents: readonly ProviderAgentInfo[],
): Array<{ id: string; name: string; description?: string }> {
	return agents.map((agent) => ({
		id: agent.id,
		name: agent.name,
		...(agent.description ? { description: agent.description } : {}),
	}));
}

export function makeAgentListMessage(
	agents: Array<{ id: string; name: string; description?: string }>,
	sessionId: string | undefined,
	overrides: SessionOverrides | undefined,
): Extract<RelayMessage, { type: "agent_list" }> {
	const activeAgentId =
		sessionId && overrides ? overrides.getAgent(sessionId) : undefined;
	if (!activeAgentId) return { type: "agent_list", agents };
	if (agents.some((agent) => agent.id === activeAgentId)) {
		return { type: "agent_list", agents, activeAgentId };
	}
	if (sessionId && typeof overrides?.clearAgent === "function") {
		overrides.clearAgent(sessionId);
	}
	return { type: "agent_list", agents };
}

export const handleGetAgents = (
	clientId: string,
	_payload: PayloadMap["get_agents"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const activeSessionId = wsHandler.getClientSession(clientId);
		const overridesOption = yield* Effect.serviceOption(SessionOverridesTag);
		const overrides =
			overridesOption._tag === "Some" ? overridesOption.value : undefined;
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const activeProviderId =
			activeSessionId &&
			engineOption._tag === "Some" &&
			typeof engineOption.value.getProviderForSession === "function"
				? engineOption.value.getProviderForSession(activeSessionId)
				: undefined;

		if (activeProviderId === "claude" && engineOption._tag === "Some") {
			const result = yield* Effect.either(
				Effect.tryPromise(() =>
					engineOption.value.dispatch({
						type: "discover",
						providerId: "claude",
					}),
				),
			);
			if (result._tag === "Left") {
				const logOption = yield* Effect.serviceOption(LoggerTag);
				if (logOption._tag === "Some") {
					logOption.value.warn(
						`Failed to discover Claude agents: ${result.left instanceof Error ? result.left.message : result.left}`,
					);
				}
				wsHandler.sendTo(
					clientId,
					makeAgentListMessage([], activeSessionId, overrides),
				);
				return;
			}
			const activeModelId =
				activeSessionId && overrides
					? overrides.getModel(activeSessionId)?.modelID
					: undefined;
			const agents = toWireAgents(
				(result.right.agents ?? []).filter((agent) =>
					claudeAgentMatchesModel(agent, activeModelId),
				),
			);
			wsHandler.sendTo(
				clientId,
				makeAgentListMessage(agents, activeSessionId, overrides),
			);
			return;
		}

		const rawAgents = yield* Effect.tryPromise(() => client.app.agents());
		const agents = filterAgents(rawAgents);
		wsHandler.sendTo(
			clientId,
			makeAgentListMessage(agents, activeSessionId, overrides),
		);
	});

export const handleSwitchAgent = (
	clientId: string,
	payload: PayloadMap["switch_agent"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;

		const { agentId } = payload;
		if (agentId) {
			const clientSession = wsHandler.getClientSession(clientId);
			if (clientSession) {
				overrides.setAgent(clientSession, agentId);
			} else {
				log.warn(`client=${clientId} switch_agent with no session — ignoring`);
			}
			const sessionForLog = wsHandler.getClientSession(clientId) ?? "?";
			log.info(
				`client=${clientId} session=${sessionForLog} Switched to: ${agentId}`,
			);
		}
	});
