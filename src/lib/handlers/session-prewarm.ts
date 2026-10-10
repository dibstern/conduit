import { Effect } from "effect";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { resolveSessionFolders } from "../domain/relay/Services/provider-turn-dispatch.js";
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
import { makePrepareTurn } from "../provider/claude/prepare-turn.js";
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
		const prepareTurn = yield* makePrepareTurn({ configDir, agent });
		const prepared = yield* prepareTurn(sessionId, providerId);
		const permissionMode = yield* getPermissionMode(sessionId);
		// Skip preparation if the session disappeared or changed provider.
		const session = yield* readQuery.getSession(sessionId);
		if (
			!session ||
			(yield* engine.getProviderForSessionEffect(sessionId)) !== providerId
		)
			return;
		const folders = yield* resolveSessionFolders(session);
		yield* instance.preWarmSessionEffect({
			sessionId,
			...folders,
			providerState: state,
			instanceId: providerId,
			nativeThread: prepared.nativeThread,
			resumeSessionId: prepared.resumeSessionId,
			...(model
				? { model: { providerId: model.providerID, modelId: model.modelID } }
				: {}),
			permissionMode,
			configDir: prepared.configDir,
			...(agent ? { agent } : {}),
			...(variant ? { variant } : {}),
			...(contextWindow ? { contextWindow } : {}),
		});
	});
