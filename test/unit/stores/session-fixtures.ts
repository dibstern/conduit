import {
	applyListDaemonSessionsResponse,
	applySearchResultsResponse,
	handleSessionFamily,
	pruneSessionLists,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { applySessionChange as applyFeedChange } from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

export { clearSessionSearch } from "../../../src/lib/frontend/stores/session.svelte.js";

type Row = Pick<SessionInfo, "id" | "title"> & Partial<SessionInfo>;

const completeRows = (rows: readonly Row[]): SessionInfo[] =>
	rows.map((row) => ({ status: "idle", ...row }));

let sequence = 0;

type TestChange =
	| {
			readonly _tag: "snapshot";
			readonly rows: readonly SessionInfo[];
			readonly sequence?: number;
	  }
	| {
			readonly _tag: "upsert";
			readonly item: SessionInfo;
			readonly sequence?: number;
	  }
	| { readonly _tag: "remove"; readonly id: string; readonly sequence?: number }
	| { readonly _tag: "synchronized" };

export function applySessionChange(change: TestChange): void {
	if (change._tag === "synchronized") {
		applyFeedChange(change);
		return;
	}
	const version = change.sequence ?? ++sequence;
	sequence = Math.max(sequence, version);
	switch (change._tag) {
		case "snapshot":
			applyFeedChange({
				_tag: "snapshot",
				rows: change.rows,
				sequence: version,
			});
			break;
		case "upsert":
			applyFeedChange({ _tag: "upsert", item: change.item, sequence: version });
			break;
		case "remove":
			applyFeedChange({ _tag: "remove", id: change.id, sequence: version });
			break;
	}
}

export function seedSessions(rows: readonly Row[]): void {
	const sessions = completeRows(rows);
	applyFeedChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applyFeedChange({ _tag: "synchronized" });
}

export function seedSessionsWithFamily(rows: readonly Row[]): void {
	seedSessions(rows);
	handleSessionFamily({
		type: "session_family",
		rootId: "",
		sessions: completeRows(rows),
	});
}

export function seedRootSessions(rows: readonly Row[]): void {
	seedSessions(rows);
}

export function applySessionSnapshot(
	rows: readonly SessionInfo[],
	scope: "complete" | "partial",
): void {
	if (scope === "partial") {
		for (const row of rows)
			applyFeedChange({ _tag: "upsert", sequence: ++sequence, item: row });
	} else applyFeedChange({ _tag: "snapshot", sequence: ++sequence, rows });
}

export function applySessionUpsert(row: SessionInfo): void {
	applyFeedChange({ _tag: "upsert", sequence: ++sequence, item: row });
}

export function applySessionRemoved(id: string): void {
	applyFeedChange({ _tag: "remove", sequence: ++sequence, id });
	pruneSessionLists(id);
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
