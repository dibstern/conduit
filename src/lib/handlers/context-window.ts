import { Effect } from "effect";
import {
	LoggerTag,
	OrchestrationEngineTag,
} from "../domain/relay/Services/services.js";
import { selectSessionContextWindow } from "../domain/relay/Services/session-model-settings.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	getDefaultModel,
	getModel,
	setDefaultContextWindow,
} from "../domain/relay/Services/session-overrides-state.js";
import type { ContextWindowOption } from "../shared-types.js";
import { applyLiveSessionSettings, isClaudeProvider } from "./model.js";

const loadContextWindowOptions = (modelId: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const engine = yield* OrchestrationEngineTag;

		const capsResult = yield* Effect.either(
			engine.dispatchEffect({
				type: "discover",
				providerId: "claude",
			}),
		);
		if (capsResult._tag === "Left") {
			log.warn(
				`Failed to fetch Claude context window list: ${capsResult.left instanceof Error ? capsResult.left.message : capsResult.left}`,
			);
			return [] as readonly ContextWindowOption[];
		}

		return (
			capsResult.right.models.find((m) => m.id === modelId)
				?.contextWindowOptions ?? []
		);
	});

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
			? yield* getModel(sessionId)
			: yield* getDefaultModel();
		const currentContextWindow = sessionId
			? yield* getContextWindow(sessionId)
			: yield* getDefaultContextWindow();

		const options =
			activeModel && isClaudeProvider(activeModel.providerID)
				? yield* loadContextWindowOptions(activeModel.modelID)
				: ([] as readonly ContextWindowOption[]);

		const requested = input.contextWindow;
		const supported =
			requested === "" || options.some((option) => option.value === requested);
		const nextContextWindow = supported ? requested : currentContextWindow;

		if (supported) {
			if (sessionId) {
				yield* selectSessionContextWindow(sessionId, requested);
				yield* applyLiveSessionSettings(sessionId);
			} else {
				yield* setDefaultContextWindow(requested);
			}
		} else {
			log.warn(
				`client=${input.clientId} session=${sessionId ?? "?"} Ignoring unsupported context window: ${requested}`,
			);
		}

		log.info(
			`client=${input.clientId} session=${sessionId ?? "?"} Switched context window to: ${nextContextWindow || "default"}`,
		);
		return { contextWindow: nextContextWindow, options };
	});
