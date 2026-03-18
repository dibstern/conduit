// ─── Session Resolution ──────────────────────────────────────────────────────
// Single helper for resolving which session a client message targets.
// Returns the per-client session from the session registry. No global fallback.

import type { HandlerDeps } from "./types.js";

/**
 * Resolve the session ID for a client's message.
 * Returns the per-client session (from SessionRegistry via wsHandler).
 */
export function resolveSession(
	deps: HandlerDeps,
	clientId: string,
): string | undefined {
	return deps.wsHandler.getClientSession(clientId);
}

/**
 * Resolve session for logging contexts where undefined should display as "?".
 */
export function resolveSessionForLog(
	deps: HandlerDeps,
	clientId: string,
): string {
	return resolveSession(deps, clientId) ?? "?";
}
