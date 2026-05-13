// ─── Reload Handler ──────────────────────────────────────────────────────────
// User-facing action: end the provider's session-level state so the next
// prompt picks up newly-added skills/commands from disk. Also refreshes the
// models and commands lists so the client's command palette stays current.

import { Effect } from "effect";
import {
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { handleGetModels } from "./model.js";
import type { PayloadMap } from "./payloads.js";
import { handleGetCommands } from "./settings.js";

export const handleReloadProviderSession = (
	clientId: string,
	_payload: PayloadMap["reload_provider_session"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const activeId = wsHandler.getClientSession(clientId);
		if (!activeId) {
			wsHandler.sendTo(
				clientId,
				new RelayError("No active session to reload", {
					code: "NO_SESSION",
				}).toSystemError(),
			);
			return;
		}

		log.info(
			`client=${clientId} session=${activeId} Reloading provider session`,
		);

		// Try to end the orchestration engine session (optional service)
		const engineResult = yield* Effect.either(
			Effect.gen(function* () {
				const engine = yield* OrchestrationEngineTag;
				yield* engine.dispatchEffect({
					type: "end_session",
					sessionId: activeId,
				});
			}),
		);
		if (engineResult._tag === "Left") {
			log.warn(`endSession failed: ${formatErrorDetail(engineResult.left)}`);
		}

		// Refresh models and commands
		yield* handleGetModels(clientId, {});
		yield* handleGetCommands(clientId, {});

		wsHandler.sendTo(clientId, {
			type: "provider_session_reloaded",
			sessionId: activeId,
		});
	});
