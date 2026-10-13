import { Effect, Sink, Stream } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../account-directory.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../domain/daemon/Services/opencode-instances-service.js";
import { AgentServiceTag } from "../../domain/relay/Services/agent-service.js";
import { ConfigTag } from "../../domain/relay/Services/services.js";
import { switchContextWindowForSession } from "../../handlers/context-window.js";
import {
	getModelsResponse,
	setDefaultModelForRelay,
	setHarnessDefaultForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../../handlers/model.js";
import { getCommandsForSession } from "../../handlers/settings.js";
import { getHiddenEntries } from "../../handlers/visibility.js";
import { isPickRejection } from "../../provider/turn-settings.js";
import type { WsRpcHandlerMap } from "./shared.js";

export const modelsHandlers = {
	GetAgents: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const agentService = yield* AgentServiceTag;
			const result = yield* agentService.listAgents(
				request.sessionId,
				request.instanceId === undefined
					? undefined
					: { _tag: "Id", id: request.instanceId },
			);
			return {
				projectSlug: request.projectSlug,
				...(result.instanceId === undefined
					? {}
					: { instanceId: result.instanceId }),
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
						message: isPickRejection(error)
							? error.message
							: `SwitchContextWindow failed: ${String(error)}`,
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
						message: isPickRejection(error)
							? error.message
							: `SwitchModel failed: ${String(error)}`,
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
						message: isPickRejection(error)
							? error.message
							: `SetDefaultModel failed: ${String(error)}`,
					}),
				),
			),
		),
	SetHarnessDefault: (request) =>
		setHarnessDefaultForRelay(request).pipe(
			Effect.map((state) => ({
				projectSlug: request.projectSlug,
				harness: request.harness,
				state,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: isPickRejection(error)
							? error.message
							: `SetHarnessDefault failed: ${String(error)}`,
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
						message: isPickRejection(error)
							? error.message
							: `SwitchVariant failed: ${String(error)}`,
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
	| "SetHarnessDefault"
	| "SwitchVariant"
	| "GetModels"
>;

export const subscribeDraftModels = (request: {
	readonly projectSlug: string;
	readonly instanceId: string;
}) =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const account = yield* (yield* AccountDirectory).resolve({
				_tag: "Id",
				id: request.instanceId,
			});
			if (account.driver !== "opencode")
				return yield* new WsRpcError({
					message: "Draft model borrowing requires OpenCode",
				});
			const instances = yield* OpenCodeInstancesTag;
			yield* instances.borrow(account.id, config.projectDir);
			// The passive event subscription replays an already-connected stream.
			// Its scope retains the borrow until cancellation or browser disconnect.
			const eventInstanceId =
				account.id === config.openCodeInstanceId
					? MANAGED_OPENCODE_ACCOUNT_ID
					: account.id;
			const inventories = instances
				.events([config.projectDir], account.id)
				.pipe(
					Stream.filter(
						(event) =>
							event._tag === "connected" &&
							event.instanceId === eventInstanceId,
					),
					Stream.mapEffect(() =>
						getModelsResponse({
							...request,
							instanceId: account.id,
							requireCatalog: true,
						}).pipe(
							Effect.map((response) => ({
								...response,
								hiddenModels: getHiddenEntries(config.configDir).hiddenModels,
							})),
						),
					),
				);
			const [first, rest] = yield* Stream.peel(inventories, Sink.take(1)).pipe(
				Effect.timeoutFail({
					duration: "10 seconds",
					onTimeout: () =>
						new WsRpcError({
							message: "Timed out waiting for OpenCode models",
						}),
				}),
			);
			return Stream.concat(Stream.fromChunk(first), rest);
		}),
	).pipe(
		Stream.mapError(
			(error) =>
				new WsRpcError({
					message: `OpenCode model discovery failed: ${String(error)}`,
				}),
		),
	);
