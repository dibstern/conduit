// The skills loaded in the open session. The server is the only classifier:
// this store keeps its last answer and derives the chip's rows from it.

import type { GetSessionSkillsResponse } from "../../contracts/ws-rpc.js";
import { getSessionSkillsRpc } from "../transport/ws-rpc-client.js";
import { getCurrentSlug } from "./router.svelte.js";
import { sessionViewLoaded } from "./transcript.svelte.js";

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
const pendingRequests = new Map<
	string,
	{
		request: number;
		loaded: Promise<boolean> | undefined;
		running: boolean;
		repeat: boolean;
		promise: Promise<void>;
	}
>();

/** Fetch on session open and at turn end. A failed fetch keeps the last
 *  answer: the server fails rather than return a partial count. */
export function loadSessionSkills(sessionId: string): Promise<void> {
	const projectSlug = getCurrentSlug();
	if (!projectSlug) return Promise.resolve();
	if (sessionSkillsState.sessionId !== sessionId) {
		sessionSkillsState.sessionId = sessionId;
		sessionSkillsState.loads = [];
	}
	const request = ++latestRequest;
	const loaded = sessionViewLoaded(projectSlug, sessionId);
	const key = JSON.stringify([projectSlug, sessionId]);
	const existing = pendingRequests.get(key);
	if (existing) {
		existing.request = request;
		existing.loaded = loaded;
		// Hints while the transcript is loading belong to its first fetch.
		existing.repeat ||= existing.running;
		return existing.promise;
	}
	const pending = {
		request,
		loaded,
		running: false,
		repeat: false,
		promise: Promise.resolve(),
	};
	pendingRequests.set(key, pending);
	pending.promise = (async () => {
		try {
			do {
				pending.repeat = false;
				pending.running = false;
				let loaded = pending.loaded;
				while (loaded) {
					const current = await loaded;
					if (loaded !== pending.loaded) {
						loaded = pending.loaded;
						continue;
					}
					if (!current) return;
					break;
				}
				const request = pending.request;
				if (request !== latestRequest) return;
				pending.running = true;
				try {
					const { loads } = await getSessionSkillsRpc({
						sessionId,
					});
					if (request === latestRequest) sessionSkillsState.loads = loads;
				} catch {
					// Keep the last value; the next turn end retries.
				}
			} while (pending.repeat && pending.request === latestRequest);
		} finally {
			pendingRequests.delete(key);
		}
	})();
	return pending.promise;
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
