// ─── Agent Handlers ──────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	AgentServiceTag,
	filterAgents,
	toWireAgents,
	type WireAgent,
} from "../effect/agent-service.js";
import { WebSocketHandlerTag } from "../effect/services.js";
import type { RelayMessage } from "../types.js";
import type { PayloadMap } from "./payloads.js";

export { filterAgents, toWireAgents };

function toAgentListMessage({
	agents,
	activeAgentId,
}: {
	readonly agents: readonly WireAgent[];
	readonly activeAgentId?: string;
}): Extract<RelayMessage, { type: "agent_list" }> {
	return {
		type: "agent_list",
		agents: [...agents],
		...(activeAgentId ? { activeAgentId } : {}),
	};
}

export const handleGetAgents = (
	clientId: string,
	_payload: PayloadMap["get_agents"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const agentService = yield* AgentServiceTag;
		const activeSessionId = wsHandler.getClientSession(clientId);
		const result = yield* agentService.listAgents(activeSessionId);
		wsHandler.sendTo(clientId, toAgentListMessage(result));
	});

export const handleSwitchAgent = (
	clientId: string,
	payload: PayloadMap["switch_agent"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const agentService = yield* AgentServiceTag;

		yield* agentService.switchAgent({
			clientId,
			sessionId: wsHandler.getClientSession(clientId),
			agentId: payload.agentId,
		});
	});
