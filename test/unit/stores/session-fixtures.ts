import {
	applyListDaemonSessionsResponse,
	applySearchResultsResponse,
	handleSessionFamily,
	handleSessionList,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { applySessionChange } from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

export { clearSessionSearch } from "../../../src/lib/frontend/stores/session.svelte.js";

type Row = Pick<SessionInfo, "id" | "title"> & Partial<SessionInfo>;

const completeRows = (rows: readonly Row[]): SessionInfo[] =>
	rows.map((row) => ({ status: "idle", ...row }));

let sequence = 0;

export function seedSessions(rows: readonly Row[]): void {
	const sessions = completeRows(rows);
	handleSessionList({ type: "session_list", roots: true, sessions });
	handleSessionFamily({
		type: "session_family",
		rootId: "",
		sessions,
	});
	applySessionChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
}

export function seedRootSessions(rows: readonly Row[]): void {
	handleSessionList({
		type: "session_list",
		roots: true,
		sessions: completeRows(rows),
	});
}

export function seedFamilySessions(rootId: string, rows: readonly Row[]): void {
	handleSessionFamily({
		type: "session_family",
		rootId,
		sessions: completeRows(rows),
	});
}

export function seedDaemonSessions(
	rows: readonly Row[],
	hasMore = false,
): void {
	applyListDaemonSessionsResponse({
		sessions: completeRows(rows),
		availability: [],
		hasMore,
		nextCursor: null,
	});
}

export function seedSearchResults(rows: readonly Row[], hasMore = false): void {
	applySearchResultsResponse({
		sessions: completeRows(rows),
		availability: [],
		hasMore,
		nextCursor: null,
	});
}
