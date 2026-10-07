import {
	applyFamilyChange,
	applyListDaemonSessionsResponse,
	applySearchResultsResponse,
	resetSessionFamily,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { applySessionChange as applyFeedChange } from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import type { Change } from "../../../src/lib/frontend/transport/subscription-state.js";
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

const sequenced = (change: TestChange): Change<SessionInfo> => {
	if (change._tag === "synchronized") return change;
	const version = change.sequence ?? ++sequence;
	sequence = Math.max(sequence, version);
	return { ...change, sequence: version };
};

export function applySessionChange(change: TestChange): void {
	applyFeedChange(sequenced(change));
}

/** A family feed change, sequenced like the shell's. */
export function applyFamilyFeedChange(change: TestChange): void {
	applyFamilyChange(sequenced(change));
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
	seedFamilySessions(rows);
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
}

/** A fresh family feed: its snapshot, then `synchronized`. */
export function seedFamilySessions(rows: readonly Row[]): void {
	resetSessionFamily();
	applyFamilyChange({
		_tag: "snapshot",
		rows: completeRows(rows),
		sequence: ++sequence,
	});
	applyFamilyChange({ _tag: "synchronized" });
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
