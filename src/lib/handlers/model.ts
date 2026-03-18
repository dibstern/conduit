// ─── Model Handlers ──────────────────────────────────────────────────────────

import { formatErrorDetail, RelayError } from "../errors.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";
import { fixupConfigFile } from "./fixup-config-file.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession, resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetModels(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_models"],
): Promise<void> {
	const providerResult = await deps.client.listProviders();
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
	deps.wsHandler.sendTo(clientId, { type: "model_list", providers });

	// Send model_info: prefer session's model, fall back to relay-side selection
	let sentModelInfo = false;
	const activeId = resolveSession(deps, clientId);
	if (activeId) {
		try {
			const session = await deps.client.getSession(activeId);
			if (session.modelID) {
				deps.wsHandler.sendTo(clientId, {
					type: "model_info",
					model: session.modelID,
					provider: session.providerID ?? "",
				});
				sentModelInfo = true;
			}
		} catch (err) {
			deps.log.warn(
				`client=${clientId} session=${activeId ?? "?"} Failed to get session model info: ${formatErrorDetail(err)}`,
			);
			deps.wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					err,
					"MODEL_ERROR",
					"Failed to get session model info",
				).toMessage(),
			);
		}
	}
	if (!sentModelInfo) {
		const fallbackModel = activeId
			? deps.overrides.getModel(activeId)
			: deps.overrides.defaultModel;
		if (fallbackModel) {
			deps.wsHandler.sendTo(clientId, {
				type: "model_info",
				model: fallbackModel.modelID,
				provider: fallbackModel.providerID,
			});
		}
	}

	// Send variant_info for the current model so clients get refreshed state
	const currentVariant = activeId
		? deps.overrides.getVariant(activeId)
		: deps.overrides.defaultVariant;
	const activeModelForVariant = activeId
		? deps.overrides.getModel(activeId)
		: deps.overrides.defaultModel;
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
	deps.wsHandler.sendTo(clientId, {
		type: "variant_info",
		variant: currentVariant,
		variants: variantList,
	});
}

export async function handleSwitchModel(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_model"],
): Promise<void> {
	const { modelId, providerId } = payload;
	if (modelId && providerId) {
		const clientSession = deps.wsHandler.getClientSession(clientId);
		if (clientSession) {
			deps.overrides.setModel(clientSession, {
				providerID: providerId,
				modelID: modelId,
			});
			deps.wsHandler.sendToSession(clientSession, {
				type: "model_info",
				model: modelId,
				provider: providerId,
			});
		} else {
			// No session assigned — log a warning but don't write to the
			// global sentinel. Setting the global model would poison all
			// sessions (the exact bug that causes "model_not_supported"
			// errors across every session).
			deps.log.warn(
				`client=${clientId} switch_model with no session — ignoring`,
			);
			deps.wsHandler.sendTo(clientId, {
				type: "model_info",
				model: modelId,
				provider: providerId,
			});
		}
		deps.log.info(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Switched to: ${modelId} (${providerId})`,
		);

		// Restore persisted variant for the new model and send variant_info
		const modelKey = `${providerId}/${modelId}`;
		let availableVariants: string[] = [];
		try {
			const providerResult = await deps.client.listProviders();
			for (const p of providerResult.providers) {
				const m = (p.models ?? []).find((mod) => mod.id === modelId);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
		} catch {
			// Silently ignore — variant info is best-effort
		}

		// Look up persisted variant, validate against available list
		const settings = loadRelaySettings(deps.config.configDir);
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant =
			persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";

		// Set variant for the session (skip if no session — matches model guard above)
		if (clientSession) {
			deps.overrides.setVariant(clientSession, validVariant);
			deps.wsHandler.sendToSession(clientSession, {
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
			});
		} else {
			deps.wsHandler.sendTo(clientId, {
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
			});
		}
	}
}

export async function handleSetDefaultModel(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_default_model"],
): Promise<void> {
	const { provider, model } = payload;
	if (!provider || !model) return;

	const modelSpec = `${provider}/${model}`;
	const override = { providerID: provider, modelID: model };
	deps.overrides.setDefaultModel(override);
	saveRelaySettings({ defaultModel: modelSpec }, deps.config.configDir);

	// Also persist to OpenCode's project config (opencode.jsonc) so the
	// setting survives independently of the relay's own settings file.
	try {
		await deps.client.updateConfig({ model: modelSpec });
		await fixupConfigFile(deps.config.projectDir, deps.log);
	} catch {
		deps.log.warn("Failed to persist default model to OpenCode config");
	}

	deps.wsHandler.broadcast({ type: "model_info", model, provider });
	deps.wsHandler.broadcast({
		type: "default_model_info",
		model,
		provider,
	});
	deps.log.info(`client=${clientId} Set default: ${model} (${provider})`);

	// Send variant_info for the new default model
	try {
		const providerResult = await deps.client.listProviders();
		let availableVariants: string[] = [];
		for (const p of providerResult.providers) {
			const m = (p.models ?? []).find((mod) => mod.id === model);
			if (m?.variants) {
				availableVariants = Object.keys(m.variants);
				break;
			}
		}
		const settings = loadRelaySettings(deps.config.configDir);
		const modelKey = `${provider}/${model}`;
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant =
			persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";
		deps.overrides.defaultVariant = validVariant;
		deps.wsHandler.broadcast({
			type: "variant_info",
			variant: validVariant,
			variants: availableVariants,
		});
	} catch {
		// variant_info is best-effort
	}
}

export async function handleSwitchVariant(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_variant"],
): Promise<void> {
	const { variant } = payload;
	const sessionId = resolveSession(deps, clientId);
	if (sessionId) {
		deps.overrides.setVariant(sessionId, variant);
	} else {
		// No session — set the global default variant so new sessions inherit it
		deps.overrides.defaultVariant = variant;
	}

	// Resolve active model — per-session first, then global default
	const activeModel = sessionId
		? deps.overrides.getModel(sessionId)
		: deps.overrides.defaultModel;

	// Persist variant preference for this model
	if (activeModel) {
		const modelKey = `${activeModel.providerID}/${activeModel.modelID}`;
		saveRelaySettings(
			{ defaultVariants: { [modelKey]: variant } },
			deps.config.configDir,
		);
	}

	// Send variant_info to all clients viewing this session
	// so other tabs stay in sync
	let availableVariants: string[] = [];
	if (activeModel) {
		try {
			const providerResult = await deps.client.listProviders();
			for (const p of providerResult.providers) {
				const m = (p.models ?? []).find(
					(mod) => mod.id === activeModel.modelID,
				);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
		} catch (err) {
			deps.log.warn(
				`Failed to fetch variant list: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	if (sessionId) {
		deps.wsHandler.sendToSession(sessionId, {
			type: "variant_info",
			variant,
			variants: availableVariants,
		});
	} else {
		deps.wsHandler.sendTo(clientId, {
			type: "variant_info",
			variant,
			variants: availableVariants,
		});
	}
	deps.log.info(
		`client=${clientId} session=${sessionId ?? "?"} Switched variant to: ${variant || "default"}`,
	);
}
