// ─── Agent Handlers ──────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	LoggerTag,
	OpenCodeAPITag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { Agent } from "../instance/sdk-types.js";
import type { PayloadMap } from "./payloads.js";

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

export const handleGetAgents = (
	clientId: string,
	_payload: PayloadMap["get_agents"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;

		const rawAgents = yield* Effect.tryPromise(() => client.app.agents());
		const agents = filterAgents(rawAgents);
		wsHandler.sendTo(clientId, { type: "agent_list", agents });
	});

export const handleSwitchAgent = (
	clientId: string,
	payload: PayloadMap["switch_agent"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;

		const { agentId } = payload;
		if (agentId) {
			const clientSession = wsHandler.getClientSession(clientId);
			if (clientSession) {
				overrides.setAgent(clientSession, agentId);
			} else {
				log.warn(`client=${clientId} switch_agent with no session — ignoring`);
			}
			const sessionForLog = wsHandler.getClientSession(clientId) ?? "?";
			log.info(
				`client=${clientId} session=${sessionForLog} Switched to: ${agentId}`,
			);
		}
	});
