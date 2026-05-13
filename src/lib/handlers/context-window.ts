// ─── Context Window Handlers ────────────────────────────────────────────────

import { Effect } from "effect";
import {
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	getDefaultModel,
	getModel,
	setContextWindow,
	setDefaultContextWindow,
} from "../effect/session-overrides-state.js";
import type { ContextWindowOption } from "../shared-types.js";
import { isClaudeProvider } from "./model.js";
import type { PayloadMap } from "./payloads.js";

const resolveSessionFromContext = (clientId: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		return wsHandler.getClientSession(clientId);
	});

const loadContextWindowOptions = (modelId: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		if (engineOption._tag === "None") {
			return [] as readonly ContextWindowOption[];
		}

		const capsResult = yield* Effect.either(
			engineOption.value.dispatchEffect({
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

export const handleSwitchContextWindow = (
	clientId: string,
	payload: PayloadMap["switch_context_window"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const sessionId = yield* resolveSessionFromContext(clientId);
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

		const requested = payload.contextWindow;
		const supported =
			requested === "" || options.some((option) => option.value === requested);
		const nextContextWindow = supported ? requested : currentContextWindow;

		if (supported) {
			if (sessionId) {
				yield* setContextWindow(sessionId, requested);
			} else {
				yield* setDefaultContextWindow(requested);
			}
		} else {
			log.warn(
				`client=${clientId} session=${sessionId ?? "?"} Ignoring unsupported context window: ${requested}`,
			);
		}

		const message = {
			type: "context_window_info" as const,
			contextWindow: nextContextWindow,
			options,
		};
		if (sessionId) {
			wsHandler.sendToSession(sessionId, message);
		} else {
			wsHandler.sendTo(clientId, message);
		}

		log.info(
			`client=${clientId} session=${sessionId ?? "?"} Switched context window to: ${nextContextWindow || "default"}`,
		);
	});
