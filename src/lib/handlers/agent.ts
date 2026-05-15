// ─── Agent Handlers ──────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	AgentServiceTag,
	filterAgents,
	toWireAgents,
	type WireAgent,
} from "../domain/relay/Services/agent-service.js";
import { WebSocketHandlerTag } from "../domain/relay/Services/services.js";
import type { RelayMessage } from "../types.js";

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
	_payload: Record<string, never>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const agentService = yield* AgentServiceTag;
		const activeSessionId = wsHandler.getClientSession(clientId);
		const result = yield* agentService.listAgents(activeSessionId);
		wsHandler.sendTo(clientId, toAgentListMessage(result));
	});
