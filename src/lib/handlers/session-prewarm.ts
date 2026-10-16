import { Effect } from "effect";
import type { Account } from "../contracts/account.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { resolveSessionFolders } from "../domain/relay/Services/provider-turn-dispatch.js";
import { OrchestrationEngineTag } from "../domain/relay/Services/services.js";
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
import { harnessForModelProvider } from "../provider/turn-settings.js";

/** Resolve the same launch inputs as a send without admitting a turn. */
export const preWarmSession = (sessionId: string, resolvedAccount?: Account) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		if (!(yield* readQuery.getSession(sessionId))) return;
		const engine = yield* OrchestrationEngineTag;
		const registry = yield* ProviderRegistryTag;
		const providerId = yield* engine.getProviderForSessionEffect(sessionId);
		if (!providerId) return;
		const account =
			resolvedAccount ??
			(yield* (yield* AccountDirectory).resolve({
				_tag: "Id",
				id: providerId,
			}));
		if (
			!PROVIDER_DRIVERS[account.driver].supportsNativeResume ||
			!("folder" in account)
		)
			return;
		const instance = registry.getInstance(account.driver);
		if (!instance?.preWarmSessionEffect) return;

		const model = yield* getModel(sessionId);
		if (model && harnessForModelProvider(model.providerID) !== account.driver)
			return;
		const providerState = yield* ProviderStateEffectTag;
		const agentService = yield* AgentServiceTag;
		const agent = yield* agentService.getActiveAgent(sessionId);
		const variant = yield* getVariant(sessionId);
		const contextWindow = yield* getContextWindow(sessionId);
		const state = yield* providerState.getState(sessionId);
		const prepareTurn = yield* makePrepareTurn({
			configDir: account.folder,
			folderSource: "account",
			agent,
		});
		const prepared = yield* prepareTurn(sessionId, account.id);
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
			instanceId: account.id,
			nativeThread: prepared.nativeThread,
			resumeSessionId: prepared.resumeSessionId,
			...(model
				? { model: { providerId: model.providerID, modelId: model.modelID } }
				: {}),
			permissionMode,
			configDir: prepared.configDir,
			folderSource: "account",
			...(agent ? { agent } : {}),
			...(variant ? { variant } : {}),
			...(contextWindow ? { contextWindow } : {}),
		});
	});
