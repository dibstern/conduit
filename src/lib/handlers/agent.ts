// ─── Agent Handlers ──────────────────────────────────────────────────────────

import type { Agent } from "../instance/sdk-types.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

/**
 * Filter agents for the mode switcher UI.
 *
 * Matches OpenCode's own TUI behavior: show only non-subagent, non-hidden
 * agents (i.e., `mode !== "subagent" && !hidden`). This shows "build", "plan",
 * and any custom agents with mode "primary" or "all".
 *
 * Falls back to a hardcoded blocklist when mode/hidden fields are absent
 * (older OpenCode versions).
 */
const HIDDEN_AGENT_NAMES = new Set([
	"title",
	"compaction",
	"summary",
	"summarize",
	"compact",
]);

export function filterAgents(
	rawAgents: Agent[],
): Array<{ id: string; name: string; description?: string }> {
	return rawAgents
		.map((a) => ({
			id: a.name || a.id || "",
			name: a.name || a.id || "",
			...(a.description != null && { description: a.description }),
			mode: a.mode,
			hidden: a.hidden,
		}))
		.filter((a) => {
			if (!a.id) return false;
			// Use mode/hidden when available (proper filtering)
			if (a.mode !== undefined || a.hidden !== undefined) {
				return a.mode !== "subagent" && !a.hidden;
			}
			// Fallback: blocklist for older OpenCode versions
			return !HIDDEN_AGENT_NAMES.has(a.id.toLowerCase());
		})
		.map(({ id, name, description }) => ({
			id,
			name,
			...(description != null && { description }),
		}));
}

export async function handleGetAgents(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_agents"],
): Promise<void> {
	const rawAgents = await deps.client.app.agents();
	const agents = filterAgents(rawAgents);
	deps.wsHandler.sendTo(clientId, { type: "agent_list", agents });
}

export async function handleSwitchAgent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_agent"],
): Promise<void> {
	const { agentId } = payload;
	if (agentId) {
		const clientSession = deps.wsHandler.getClientSession(clientId);
		if (clientSession) {
			deps.overrides.setAgent(clientSession, agentId);
		} else {
			deps.log.warn(
				`client=${clientId} switch_agent with no session — ignoring`,
			);
		}
		deps.log.info(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Switched to: ${agentId}`,
		);
	}
}
