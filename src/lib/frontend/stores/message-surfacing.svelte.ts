import {
	type CategorySet,
	DEFAULT_CATEGORY_SET,
} from "../../contracts/category-set.js";
import {
	DEFAULT_MESSAGE_SURFACING_SETTINGS,
	sessionJevEnabled as jevEnabledFor,
	type MessageSurfacingStatus,
} from "../../contracts/message-surfacing.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { SurfaceLevel } from "../utils/surface-turn.js";
import { loadSurfacingFeedback } from "./surfacing-feedback.svelte.js";

const STORAGE_KEY = "surfacing-level-by-session";
const LIMIT = 100;
let memory: Map<string, SurfaceLevel> | undefined;
const validLevel = (value: unknown): value is SurfaceLevel =>
	value === "final" ||
	value === "key" ||
	value === "balanced" ||
	value === "all";

function overrides(): Map<string, SurfaceLevel> {
	if (memory) return memory;
	memory = new Map();
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			for (const [id, level] of Object.entries(raw))
				if (validLevel(level)) memory.set(id, level);
		}
		while (memory.size > LIMIT) memory.delete(memory.keys().next().value ?? "");
	} catch {
		/* Storage is optional. */
	}
	return memory;
}

export const messageSurfacing = $state<{
	status: MessageSurfacingStatus;
	categorySet: CategorySet;
	revision: number;
}>({
	status: {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		// Summaries stay off until the daemon says otherwise, like Jev.
		summariesEnabled: false,
		active: false,
		key: { source: "none", rejected: false },
	},
	categorySet: DEFAULT_CATEGORY_SET,
	revision: 0,
});

export const sessionJevEnabled = (
	session: Parameters<typeof jevEnabledFor>[0],
	status: MessageSurfacingStatus = messageSurfacing.status,
): boolean => jevEnabledFor(session, status);

let loadVersion = 0;
/** Reconnects fail closed; a partial or stale response cannot enable the UI. */
export async function loadMessageSurfacing(): Promise<void> {
	const version = ++loadVersion;
	try {
		const [status, categorySet] = await Promise.all([
			rpc("GetMessageSurfacing", {}),
			rpc("GetCategorySet", {}),
		]);
		if (version !== loadVersion) return;
		messageSurfacing.categorySet = categorySet;
		messageSurfacing.status = status;
		if (status.key.source !== "none" && !status.key.rejected)
			void loadSurfacingFeedback();
	} catch {
		if (version === loadVersion)
			messageSurfacing.status = {
				...messageSurfacing.status,
				active: false,
				summariesEnabled: false,
				key: { source: "none", rejected: false },
			};
	}
}

export function sessionSurfaceLevel(
	sessionId: string | undefined,
): SurfaceLevel | undefined {
	void messageSurfacing.revision;
	return sessionId ? overrides().get(sessionId) : undefined;
}

export function setSessionSurfaceLevel(
	sessionId: string,
	level: SurfaceLevel | null,
): void {
	const entries = overrides();
	entries.delete(sessionId);
	if (level !== null) entries.set(sessionId, level);
	while (entries.size > LIMIT)
		entries.delete(entries.keys().next().value ?? "");
	messageSurfacing.revision++;
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(Object.fromEntries(entries)),
		);
	} catch {
		/* Retain the in-memory choice. */
	}
}

/** An access refreshes recency, like the files-pane memory. */
export function touchSurfaceSession(sessionId: string): void {
	const level = overrides().get(sessionId);
	if (level !== undefined) setSessionSurfaceLevel(sessionId, level);
}

export async function makeSurfaceDefault(
	sessionId: string,
	level: SurfaceLevel,
): Promise<void> {
	const status = await rpc("UpdateMessageSurfacing", { defaultLevel: level });
	loadVersion++;
	messageSurfacing.status = status;
	setSessionSurfaceLevel(sessionId, null);
}
