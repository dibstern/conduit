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
import { isClaudeResumeRefused } from "../provider/event-sink-errors.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";
import { harnessForModelProvider } from "../provider/turn-settings.js";

/** Resolve the same launch inputs as a send without admitting a turn. */
export const preWarmSession = (sessionId: string, resolvedAccount?: Account) =>
	OrchestrationEngineTag.pipe(
		Effect.flatMap((engine) =>
			engine.preparePreWarmSessionEffect(
				sessionId,
				Effect.gen(function* () {
					const readQuery = yield* ReadQueryEffectTag;
					const initialSession = yield* readQuery.getSession(sessionId);
					if (!initialSession) return;
					const registry = yield* ProviderRegistryTag;
					const providerId =
						yield* engine.getProviderForSessionEffect(sessionId);
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
					if (
						model &&
						harnessForModelProvider(model.providerID) !== account.driver
					)
						return;
					const providerState = yield* ProviderStateEffectTag;
					const agentService = yield* AgentServiceTag;
					const agent = yield* agentService.getActiveAgent(sessionId);
					const variant = yield* getVariant(sessionId);
					const contextWindow = yield* getContextWindow(sessionId);
					const state = yield* providerState.getState(sessionId);
					const folders = yield* resolveSessionFolders(initialSession);
					const call = yield* engine.resolveCallContextEffect({
						sessionId,
						account,
						workspaceRoot: folders.workspaceRoot,
						extraFolders: folders.extraFolders,
						prepareShellEnv: true,
						requireRoutableAccount: true,
					});
					const prepareTurn = yield* makePrepareTurn({
						configDir: account.folder,
						folderSource: "account",
						agent,
						workspaceRoot: folders.workspaceRoot,
					});
					let prepared = yield* prepareTurn(sessionId, account.id);
					const permissionMode = yield* getPermissionMode(sessionId);
					// Skip preparation if the session disappeared or changed provider.
					const session = yield* readQuery.getSession(sessionId);
					if (
						!session ||
						(yield* engine.getProviderForSessionEffect(sessionId)) !==
							providerId
					)
						return;
					for (let attempt = 0; attempt < 2; attempt++) {
						const warmed = yield* Effect.result(
							instance.preWarmSessionEffect({
								sessionId,
								...folders,
								account,
								...call,
								providerState: state,
								instanceId: account.id,
								nativeThread: prepared.nativeThread,
								resumeSessionId: prepared.resumeSessionId,
								resumeSessionAt: prepared.resumeSessionAt,
								forkSession: prepared.forkSession,
								clearInheritedGoal: prepared.clearInheritedGoal,
								...(model
									? {
											model: {
												providerId: model.providerID,
												modelId: model.modelID,
											},
										}
									: {}),
								permissionMode,
								...(session.side_thread === 1 ? { sideThread: true } : {}),
								configDir: prepared.configDir,
								folderSource: "account",
								...(agent ? { agent } : {}),
								...(variant ? { variant } : {}),
								...(contextWindow ? { contextWindow } : {}),
							}),
						);
						if (warmed._tag === "Success") return;
						if (
							attempt > 0 ||
							!prepared.clearInheritedGoal ||
							!isClaudeResumeRefused(warmed.failure)
						)
							return yield* Effect.fail(warmed.failure);
						// A rejected warm fork must not be retried by the following send.
						yield* providerState.saveUpdates(sessionId, [
							{ key: `claude.forkRefused:${account.id}`, value: "true" },
						]);
						prepared = yield* prepareTurn(sessionId, account.id);
					}
				}),
			),
		),
	);
