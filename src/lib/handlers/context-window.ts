import { Effect, Either } from "effect";
import { LoggerTag } from "../domain/relay/Services/services.js";
import { selectSessionContextWindow } from "../domain/relay/Services/session-model-settings.js";
import {
	getDefaultModel,
	getModel,
	setDefaultContextWindow,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	findCatalogModel,
	harnessForModelProvider,
	offeredOptions,
	resolveTurnSettings,
} from "../provider/turn-settings.js";
import { applyLiveSessionSettings, loadModelCatalog } from "./model.js";

export interface SwitchContextWindowInput {
	readonly clientId: string;
	readonly sessionId?: string | undefined;
	readonly contextWindow: string;
}

export const switchContextWindowForSession = (
	input: SwitchContextWindowInput,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;

		const sessionId = input.sessionId;
		const activeModel = sessionId
			? ((yield* getModel(sessionId)) ?? (yield* getDefaultModel()))
			: yield* getDefaultModel();
		const harness = harnessForModelProvider(activeModel?.providerID ?? "");
		const catalog = yield* loadModelCatalog(harness);
		const resolved = resolveTurnSettings(
			{
				harness,
				model: {
					providerId: activeModel?.providerID ?? "",
					modelId: activeModel?.modelID ?? "",
				},
				effort: "",
				contextWindow: input.contextWindow,
			},
			catalog,
		);
		if (Either.isLeft(resolved)) return yield* resolved.left;
		const model = findCatalogModel(harness, resolved.right.model, catalog);
		const options = model ? [...offeredOptions(model).contextWindows] : [];
		const contextWindow = resolved.right.contextWindow;
		if (sessionId) {
			yield* selectSessionContextWindow(sessionId, contextWindow);
			yield* applyLiveSessionSettings(sessionId);
		} else {
			yield* setDefaultContextWindow(contextWindow);
		}

		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched context window to: ${contextWindow || "default"}`,
		);
		return { contextWindow, options };
	});
