// ─── Model Handlers ──────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";
import { fixupConfigFile } from "./fixup-config-file.js";
import type { PayloadMap } from "./payloads.js";

/**
 * Determines if a provider ID refers to the in-process Claude SDK adapter
 * (not OpenCode's "anthropic" provider which proxies to Anthropic via
 * OpenCode's own REST API). Only the literal "claude" provider ID
 * routes through the ClaudeAdapter — all other providers (including
 * "anthropic") route through OpenCodeAdapter.
 */
export function isClaudeProvider(providerId: string): boolean {
	return providerId === "claude";
}

/** Helper: resolve session from WebSocketHandler context. */
const resolveSessionFromContext = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		return wsHandler.getClientSession(clientId);
	});

export const handleGetModels = (
	clientId: string,
	_payload: PayloadMap["get_models"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;

		const providerResult = yield* Effect.tryPromise(() =>
			client.provider.list(),
		);
		const connectedSet = new Set(providerResult.connected);
		const providers = providerResult.providers
			.map((p) => ({
				id: p.id || p.name || "",
				name: p.name || p.id || "",
				configured: connectedSet.has(p.id) || connectedSet.has(p.name),
				models: (p.models ?? []).map((m) => ({
					id: m.id,
					name: m.name || m.id,
					provider: p.id || p.name || "",
					...(m.limit && { limit: m.limit }),
					...(m.variants &&
						Object.keys(m.variants).length > 0 && {
							variants: Object.keys(m.variants),
						}),
				})),
			}))
			.filter((p) => p.configured);

		// Merge Claude in-process models when the orchestration engine is available.
		const engineResult = yield* Effect.either(
			Effect.gen(function* () {
				const engine = yield* OrchestrationEngineTag;
				const claudeCaps = yield* Effect.tryPromise(() =>
					engine.dispatch({ type: "discover", providerId: "claude" }),
				);
				return claudeCaps;
			}),
		);
		if (engineResult._tag === "Right" && engineResult.right.models.length > 0) {
			for (const p of providers) {
				if (p.id === "anthropic") {
					p.name = "Anthropic - opencode";
				}
			}
			providers.push({
				id: "claude",
				name: "Anthropic - claude",
				configured: true,
				models: engineResult.right.models.map((m) => ({
					id: m.id,
					name: m.name,
					provider: "claude",
					...(m.limit ? { limit: m.limit } : {}),
				})),
			});
		}

		wsHandler.sendTo(clientId, { type: "model_list", providers });

		// Send model_info: prefer session's model, fall back to relay-side selection
		let sentModelInfo = false;
		const activeId = yield* resolveSessionFromContext(clientId);
		if (activeId) {
			const sessionResult = yield* Effect.either(
				Effect.tryPromise(() => client.session.get(activeId)),
			);
			if (sessionResult._tag === "Right" && sessionResult.right.modelID) {
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: sessionResult.right.modelID,
					provider: sessionResult.right.providerID ?? "",
				});
				sentModelInfo = true;
			} else if (sessionResult._tag === "Left") {
				log.warn(
					`client=${clientId} session=${activeId ?? "?"} Failed to get session model info: ${formatErrorDetail(sessionResult.left)}`,
				);
				wsHandler.sendTo(
					clientId,
					RelayError.fromCaught(
						sessionResult.left,
						"MODEL_ERROR",
						"Failed to get session model info",
					).toMessage(activeId),
				);
			}
		}
		if (!sentModelInfo) {
			const fallbackModel = activeId
				? overrides.getModel(activeId)
				: overrides.defaultModel;
			if (fallbackModel) {
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: fallbackModel.modelID,
					provider: fallbackModel.providerID,
				});
			}
		}

		// Send variant_info for the current model so clients get refreshed state
		const currentVariant = activeId
			? overrides.getVariant(activeId)
			: overrides.defaultVariant;
		const activeModelForVariant = activeId
			? overrides.getModel(activeId)
			: overrides.defaultModel;
		let variantList: string[] = [];
		if (activeModelForVariant) {
			for (const p of providers) {
				const m = p.models.find(
					(mod) => mod.id === activeModelForVariant.modelID,
				);
				if (m?.variants) {
					variantList = m.variants;
					break;
				}
			}
		}
		wsHandler.sendTo(clientId, {
			type: "variant_info",
			variant: currentVariant,
			variants: variantList,
		});
	});

export const handleSwitchModel = (
	clientId: string,
	payload: PayloadMap["switch_model"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { modelId, providerId } = payload;
		if (modelId && providerId) {
			const clientSession = wsHandler.getClientSession(clientId);
			if (clientSession) {
				overrides.setModel(clientSession, {
					providerID: providerId,
					modelID: modelId,
				});
				// Bind session to the correct provider adapter
				const engineResult = yield* Effect.either(
					Effect.gen(function* () {
						const engine = yield* OrchestrationEngineTag;
						const providerAdapterId = isClaudeProvider(providerId)
							? "claude"
							: "opencode";
						engine.bindSession(clientSession, providerAdapterId);
					}),
				);
				// engineResult ignored — orchestration engine is optional
				void engineResult;
				wsHandler.sendToSession(clientSession, {
					type: "model_info",
					model: modelId,
					provider: providerId,
				});
			} else {
				log.warn(`client=${clientId} switch_model with no session — ignoring`);
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: modelId,
					provider: providerId,
				});
			}
			log.info(
				`client=${clientId} session=${wsHandler.getClientSession(clientId) ?? "?"} Switched to: ${modelId} (${providerId})`,
			);

			// Restore persisted variant for the new model and send variant_info
			const modelKey = `${providerId}/${modelId}`;
			let availableVariants: string[] = [];
			const provListResult = yield* Effect.either(
				Effect.tryPromise(() => client.provider.list()),
			);
			if (provListResult._tag === "Right") {
				for (const p of provListResult.right.providers) {
					const m = (p.models ?? []).find((mod) => mod.id === modelId);
					if (m?.variants) {
						availableVariants = Object.keys(m.variants);
						break;
					}
				}
			}

			const settings = loadRelaySettings(config.configDir);
			const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
			const validVariant =
				persistedVariant && availableVariants.includes(persistedVariant)
					? persistedVariant
					: "";

			if (clientSession) {
				overrides.setVariant(clientSession, validVariant);
				wsHandler.sendToSession(clientSession, {
					type: "variant_info",
					variant: validVariant,
					variants: availableVariants,
				});
			} else {
				wsHandler.sendTo(clientId, {
					type: "variant_info",
					variant: validVariant,
					variants: availableVariants,
				});
			}
		}
	});

export const handleSetDefaultModel = (
	clientId: string,
	payload: PayloadMap["set_default_model"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { provider, model } = payload;
		if (!provider || !model) return;

		const modelSpec = `${provider}/${model}`;
		const override = { providerID: provider, modelID: model };
		overrides.setDefaultModel(override);
		saveRelaySettings({ defaultModel: modelSpec }, config.configDir);

		// Also persist to OpenCode's project config
		const updateResult = yield* Effect.either(
			Effect.tryPromise(async () => {
				await client.config.update({ model: modelSpec });
				await fixupConfigFile(config.projectDir, log);
			}),
		);
		if (updateResult._tag === "Left") {
			log.warn("Failed to persist default model to OpenCode config");
		}

		wsHandler.broadcast({ type: "model_info", model, provider });
		wsHandler.broadcast({ type: "default_model_info", model, provider });
		log.info(`client=${clientId} Set default: ${model} (${provider})`);

		// Send variant_info for the new default model
		const provListResult = yield* Effect.either(
			Effect.tryPromise(() => client.provider.list()),
		);
		if (provListResult._tag === "Right") {
			let availableVariants: string[] = [];
			for (const p of provListResult.right.providers) {
				const m = (p.models ?? []).find((mod) => mod.id === model);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
			const settings = loadRelaySettings(config.configDir);
			const modelKey = `${provider}/${model}`;
			const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
			const validVariant =
				persistedVariant && availableVariants.includes(persistedVariant)
					? persistedVariant
					: "";
			overrides.defaultVariant = validVariant;
			wsHandler.broadcast({
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
			});
		}
	});

export const handleSwitchVariant = (
	clientId: string,
	payload: PayloadMap["switch_variant"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		const { variant } = payload;
		const sessionId = yield* resolveSessionFromContext(clientId);
		if (sessionId) {
			overrides.setVariant(sessionId, variant);
		} else {
			overrides.defaultVariant = variant;
		}

		// Resolve active model
		const activeModel = sessionId
			? overrides.getModel(sessionId)
			: overrides.defaultModel;

		// Persist variant preference
		if (activeModel) {
			const modelKey = `${activeModel.providerID}/${activeModel.modelID}`;
			saveRelaySettings(
				{ defaultVariants: { [modelKey]: variant } },
				config.configDir,
			);
		}

		// Send variant_info
		let availableVariants: string[] = [];
		if (activeModel) {
			const provListResult = yield* Effect.either(
				Effect.tryPromise(() => client.provider.list()),
			);
			if (provListResult._tag === "Right") {
				for (const p of provListResult.right.providers) {
					const m = (p.models ?? []).find(
						(mod) => mod.id === activeModel.modelID,
					);
					if (m?.variants) {
						availableVariants = Object.keys(m.variants);
						break;
					}
				}
			} else {
				log.warn(
					`Failed to fetch variant list: ${provListResult.left instanceof Error ? provListResult.left.message : provListResult.left}`,
				);
			}
		}
		if (sessionId) {
			wsHandler.sendToSession(sessionId, {
				type: "variant_info",
				variant,
				variants: availableVariants,
			});
		} else {
			wsHandler.sendTo(clientId, {
				type: "variant_info",
				variant,
				variants: availableVariants,
			});
		}
		log.info(
			`client=${clientId} session=${sessionId ?? "?"} Switched variant to: ${variant || "default"}`,
		);
	});
