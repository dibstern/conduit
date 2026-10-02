// The skills loaded in the open session. The server is the only classifier:
// this store keeps its last answer and derives the chip's rows from it.

import type { GetSessionSkillsResponse } from "../../contracts/ws-rpc.js";
import { getSessionSkillsRpc } from "../transport/ws-rpc-client.js";
import { getCurrentSlug } from "./router.svelte.js";

type SkillLoad = GetSessionSkillsResponse["loads"][number];

export interface SessionSkillRow {
	readonly name: string;
	readonly loads: readonly SkillLoad[];
	readonly firstAt: number;
	readonly lastAt: number;
	readonly byUser: number;
	readonly byAgent: number;
	readonly turns: readonly number[];
	readonly running: boolean;
}

export const sessionSkillsState = $state<{
	sessionId: string | null;
	loads: readonly SkillLoad[];
}>({ sessionId: null, loads: [] });

let latestRequest = 0;

/** Fetch on session open and at turn end. A failed fetch keeps the last
 *  answer: the server fails rather than return a partial count. */
export async function loadSessionSkills(sessionId: string): Promise<void> {
	const projectSlug = getCurrentSlug();
	if (!projectSlug) return;
	if (sessionSkillsState.sessionId !== sessionId) {
		sessionSkillsState.sessionId = sessionId;
		sessionSkillsState.loads = [];
	}
	const request = ++latestRequest;
	try {
		const { loads } = await getSessionSkillsRpc({ projectSlug, sessionId });
		if (request === latestRequest) sessionSkillsState.loads = loads;
	} catch {
		// Keep the last value; the next turn end retries.
	}
}

/** A live hint that the open session's skills may have changed: a skill tool
 *  ran or finished, a message was sent, or a turn ended. Spare calls are fine;
 *  the server decides what counts. */
export function refreshSessionSkills(sessionId: string): void {
	if (sessionSkillsState.sessionId === sessionId)
		void loadSessionSkills(sessionId);
}

/** One row per skill, in first-use order. */
export function sessionSkillRows(
	loads: readonly SkillLoad[],
): SessionSkillRow[] {
	const byName = new Map<string, SkillLoad[]>();
	for (const load of loads) {
		const group = byName.get(load.name);
		if (group) group.push(load);
		else byName.set(load.name, [load]);
	}
	return [...byName].map(([name, group]) => ({
		name,
		loads: group,
		firstAt: Math.min(...group.map((load) => load.at)),
		lastAt: Math.max(...group.map((load) => load.at)),
		byUser: group.filter((load) => load.invokedBy === "user").length,
		byAgent: group.filter((load) => load.invokedBy === "agent").length,
		turns: [...new Set(group.map((load) => load.turnOrdinal))],
		running: group.some((load) => load.running),
	}));
}
