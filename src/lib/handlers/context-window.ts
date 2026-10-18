import { Effect, Result as Either } from "effect";
import { LoggerTag } from "../domain/relay/Services/services.js";
import { selectSessionContextWindow } from "../domain/relay/Services/session-model-settings.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	findCatalogModel,
	harnessForModelProvider,
	offeredOptions,
	resolveTurnSettings,
} from "../provider/turn-settings.js";
import { applyLiveSessionSettings, loadModelCatalog } from "./model.js";

export interface SwitchContextWindowInput {
	readonly clientId: string;
	readonly sessionId: string;
	readonly contextWindow: string;
}

export const switchContextWindowForSession = (
	input: SwitchContextWindowInput,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;

		const sessionId = input.sessionId;
		const row = yield* (yield* ReadQueryEffectTag).getSession(sessionId);
		const activeModel =
			row?.model_id && row.model_provider
				? { modelID: row.model_id, providerID: row.model_provider }
				: undefined;
		const harness = harnessForModelProvider(activeModel?.providerID ?? "");
		const catalog = yield* loadModelCatalog(harness, row?.provider ?? harness);
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
		yield* selectSessionContextWindow(sessionId, contextWindow);
		yield* applyLiveSessionSettings(sessionId);

		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched context window to: ${contextWindow || "default"}`,
		);
		return { contextWindow, options };
	});
