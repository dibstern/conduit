// ─── Agent Handlers ──────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	type ProviderInstanceId,
	ProviderInstanceIdSchema,
} from "../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveInstanceDriver,
} from "../daemon/config-persistence.js";
import {
	type AgentList,
	AgentServiceTag,
	filterAgents,
	toWireAgents,
	type WireAgent,
} from "../domain/relay/Services/agent-service.js";
import {
	ConfigTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import type { RelayMessage } from "../types.js";

export { filterAgents, toWireAgents };

function toAgentListMessage({
	instanceId,
	providerScope,
	agents,
	activeAgentId,
}: {
	readonly instanceId?: ProviderInstanceId;
	readonly providerScope: AgentList["providerScope"];
	readonly agents: readonly WireAgent[];
	readonly activeAgentId?: string;
}): Extract<RelayMessage, { type: "agent_list" }> {
	return {
		type: "agent_list",
		...(instanceId === undefined ? {} : { instanceId }),
		providerScope,
		agents: [...agents],
		...(activeAgentId ? { activeAgentId } : {}),
	};
}

export const handleGetAgents = (
	clientId: string,
	payload: { readonly instanceId?: string } = {},
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const agentService = yield* AgentServiceTag;
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const activeSessionId = wsHandler.getClientSession(clientId);
		const instanceId =
			payload.instanceId === undefined
				? undefined
				: ProviderInstanceIdSchema.make(payload.instanceId);
		const daemonConfig =
			instanceId === undefined || configOption._tag === "None"
				? null
				: loadDaemonConfig(configOption.value.configDir);
		const instanceDriver =
			instanceId === undefined || daemonConfig === null
				? undefined
				: resolveInstanceDriver(daemonConfig, instanceId);
		const result = yield* agentService.listAgents(
			activeSessionId,
			instanceId,
			instanceDriver,
		);
		wsHandler.sendTo(clientId, toAgentListMessage(result));
	});
