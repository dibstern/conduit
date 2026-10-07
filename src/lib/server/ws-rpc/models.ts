import { Effect } from "effect";
import { ProviderInstanceIdSchema } from "../../contracts/provider-instance.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import {
	loadDaemonConfig,
	resolveInstanceDriver,
} from "../../daemon/config-persistence.js";
import { AgentServiceTag } from "../../domain/relay/Services/agent-service.js";
import {
	ConfigTag,
	OrchestrationEngineTag,
} from "../../domain/relay/Services/services.js";
import { switchContextWindowForSession } from "../../handlers/context-window.js";
import {
	getModelsResponse,
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../../handlers/model.js";
import { getCommandsForSession } from "../../handlers/settings.js";
import { getHiddenEntries } from "../../handlers/visibility.js";
import type { WsRpcHandlerMap } from "./shared.js";

export const modelsHandlers = {
	GetAgents: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const agentService = yield* AgentServiceTag;
			const instanceId =
				request.instanceId === undefined
					? undefined
					: ProviderInstanceIdSchema.make(request.instanceId);
			const daemonConfig =
				instanceId === undefined ? null : loadDaemonConfig(config.configDir);
			const instanceDriver =
				instanceId === undefined || daemonConfig === null
					? undefined
					: resolveInstanceDriver(daemonConfig, instanceId);
			const result = yield* agentService.listAgents(
				request.sessionId,
				instanceId,
				instanceDriver,
			);
			// A session's agents come from the instance it is bound to.
			const resultInstanceId =
				result.instanceId ??
				(request.sessionId === undefined
					? undefined
					: yield* (yield* OrchestrationEngineTag).getProviderForSessionEffect(
							request.sessionId,
						));
			return {
				projectSlug: request.projectSlug,
				...(resultInstanceId === undefined
					? {}
					: { instanceId: resultInstanceId }),
				providerScope: result.providerScope,
				agents: result.agents,
				...(result.activeAgentId != null
					? { activeAgentId: result.activeAgentId }
					: {}),
				hiddenAgents: getHiddenEntries(config.configDir).hiddenAgents,
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetAgents failed: ${String(error)}`,
					}),
				),
			),
		),
	GetCommands: (request) =>
		getCommandsForSession(request.sessionId).pipe(
			Effect.map((commands) => ({
				projectSlug: request.projectSlug,
				commands,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetCommands failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchAgent: (request) =>
		Effect.gen(function* () {
			const agentService = yield* AgentServiceTag;
			yield* agentService.switchAgent({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				agentId: request.agentId,
			});
			return { ok: true as const };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchAgent failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchContextWindow: (request) =>
		switchContextWindowForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			contextWindow: request.contextWindow,
		}).pipe(
			Effect.map((result) => ({ projectSlug: request.projectSlug, ...result })),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchContextWindow failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchModel: (request) =>
		switchModelForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			modelId: request.modelId,
			providerId: request.providerId,
		}).pipe(
			Effect.map((result) => ({ projectSlug: request.projectSlug, ...result })),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchModel failed: ${String(error)}`,
					}),
				),
			),
		),
	SetDefaultModel: (request) =>
		setDefaultModelForRelay({
			clientId: request.originId ?? "rpc",
			model: request.model,
			provider: request.provider,
		}).pipe(
			Effect.map((result) => ({ projectSlug: request.projectSlug, ...result })),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetDefaultModel failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchVariant: (request) =>
		switchVariantForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			variant: request.variant,
		}).pipe(
			Effect.map((result) => ({ projectSlug: request.projectSlug, ...result })),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchVariant failed: ${String(error)}`,
					}),
				),
			),
		),
	GetModels: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const response = yield* getModelsResponse({
				projectSlug: request.projectSlug,
				...(request.sessionId != null ? { sessionId: request.sessionId } : {}),
				...(request.instanceId != null
					? { instanceId: request.instanceId }
					: {}),
			});
			return {
				...response,
				hiddenModels: getHiddenEntries(config.configDir).hiddenModels,
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetModels failed: ${String(error)}`,
					}),
				),
			),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetAgents"
	| "GetCommands"
	| "SwitchAgent"
	| "SwitchContextWindow"
	| "SwitchModel"
	| "SetDefaultModel"
	| "SwitchVariant"
	| "GetModels"
>;
