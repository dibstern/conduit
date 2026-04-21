// ─── Reload Handler ──────────────────────────────────────────────────────────
// User-facing action: end the provider's session-level state so the next
// prompt picks up newly-added skills/commands from disk. Also refreshes the
// models and commands lists so the client's command palette stays current.

import { formatErrorDetail, RelayError } from "../errors.js";
import { handleGetModels } from "./model.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession } from "./resolve-session.js";
import { handleGetCommands } from "./settings.js";
import type { HandlerDeps } from "./types.js";

export async function handleReloadProviderSession(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["reload_provider_session"],
): Promise<void> {
	const activeId = resolveSession(deps, clientId);
	if (!activeId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("No active session to reload", {
				code: "NO_SESSION",
			}).toSystemError(),
		);
		return;
	}

	deps.log.info(
		`client=${clientId} session=${activeId} Reloading provider session`,
	);

	if (deps.orchestrationEngine) {
		try {
			await deps.orchestrationEngine.dispatch({
				type: "end_session",
				sessionId: activeId,
			});
		} catch (err) {
			// Don't abort -- still refresh lists so the client isn't stuck.
			deps.log.warn(`endSession failed: ${formatErrorDetail(err)}`);
		}
	}

	// Refresh both models (triggers fresh Claude discover()) and commands so the
	// client's command palette picks up new skills/commands from disk.
	await handleGetModels(deps, clientId, {});
	await handleGetCommands(deps, clientId, {});

	deps.wsHandler.sendTo(clientId, {
		type: "provider_session_reloaded",
		sessionId: activeId,
	});
}
