import { Effect } from "effect";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import {
	ConfigTag,
	OrchestrationEngineTag,
} from "../domain/relay/Services/services.js";
import {
	getContextWindow,
	getModel,
	getPermissionMode,
	getVariant,
} from "../domain/relay/Services/session-overrides-state.js";
import { ProviderStateEffectTag } from "../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";

/** Resolve the same launch inputs as a send without admitting a turn. */
export const preWarmSession = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		if (!(yield* readQuery.getSession(sessionId))) return;
		const config = yield* ConfigTag;
		const engine = yield* OrchestrationEngineTag;
		const registry = yield* ProviderRegistryTag;
		const providerId = yield* engine.getProviderForSessionEffect(sessionId);
		if (!providerId) return;
		const daemonConfig = loadDaemonConfig(config.configDir);
		const driverId = resolveProviderRoutingDriver(daemonConfig, providerId);
		if (driverId !== "claude") return;
		const instance = registry.getInstance(driverId);
		if (!instance?.preWarmSessionEffect) return;

		const model = yield* getModel(sessionId);
		if (
			model &&
			resolveProviderRoutingDriver(daemonConfig, model.providerID) !== "claude"
		)
			return;
		const providerState = yield* ProviderStateEffectTag;
		const agentService = yield* AgentServiceTag;
		const agent = yield* agentService.getActiveAgent(sessionId);
		const variant = yield* getVariant(sessionId);
		const contextWindow = yield* getContextWindow(sessionId);
		const configDir = resolveClaudeInstanceConfigDir(daemonConfig, providerId);
		const state = yield* providerState.getState(sessionId);
		const permissionMode = yield* getPermissionMode(sessionId);
		// Skip preparation if the session disappeared or changed provider.
		if (
			!(yield* readQuery.getSession(sessionId)) ||
			(yield* engine.getProviderForSessionEffect(sessionId)) !== providerId
		)
			return;
		yield* instance.preWarmSessionEffect({
			sessionId,
			workspaceRoot: config.projectDir ?? "",
			providerState: state,
			...(model
				? { model: { providerId: model.providerID, modelId: model.modelID } }
				: {}),
			permissionMode,
			...(configDir === undefined ? {} : { configDir }),
			...(agent ? { agent } : {}),
			...(variant ? { variant } : {}),
			...(contextWindow ? { contextWindow } : {}),
		});
	});
