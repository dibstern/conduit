// Every session the server has told us about, and the one door changes come
// through. The session store is a view over this; it holds no copy of its own.
//
// The split against `subscription-state.ts` is deliberate: the applier is pure
// and Svelte-free so it can be driven as a function (ni8.5 T-14), and this
// module is the imperative half that reassigns reactive state — the shape the
// notification reducer established.

import type { Stream } from "effect";
import {
	followSessionCompaction,
	followSessionRetry,
	followSessionTurn,
} from "../stores/chat.svelte.js";
import {
	followSessionModelSettings,
	handlePermissionModeInfo,
} from "../stores/discovery.svelte.js";
import { hydrateSessionGoal, sessionGoals } from "../stores/goal.svelte.js";
import { followSessionResumes } from "../stores/handoff-review.svelte.js";
import { applyShellProjects } from "../stores/project.svelte.js";
import type { SavedShell } from "../stores/saved-shell.js";
import {
	forgetSession,
	leaveDeletedSession,
	sessionState,
	settleReadMarks,
} from "../stores/session.svelte.js";
import {
	applyTurnRow,
	deleteTurn,
	rebaseTurns,
} from "../stores/turn.svelte.js";
import type { SessionInfo } from "../types.js";
import type { WsRpcSubscriptions } from "./shared-client.js";
import {
	emptySubscription,
	reduce,
	type SubscriptionState,
} from "./subscription-state.js";
import type { FeedStatus } from "./supervise.js";

/**
 * One thing `subscriptions.shell()` delivers, typed off the subscription
 * itself rather than restated.
 */
export type ShellEnvelope = Stream.Success<
	ReturnType<WsRpcSubscriptions["shell"]>
>;

const identify = (session: SessionInfo): string => session.id;

// `$state.raw`, not `$state`: the applier replaces the state whole and never
// mutates it, so a deep proxy would cost work to track writes that cannot
// happen.
let applied = $state.raw<SubscriptionState<SessionInfo>>(emptySubscription());
let savedShell = $state.raw<ReadonlyMap<string, SessionInfo> | null>(null);

/** Provisional rows only: no versions, synchronization or live row side effects. */
export function drawSavedShell(record: SavedShell): void {
	if (
		applied.floor !== undefined ||
		applied.versions.size > 0 ||
		applied.settled
	)
		return;
	savedShell = new Map(record.rows.map((row) => [row.id, row]));
}

let feedStatus = $state<FeedStatus>({ _tag: "cold" });
let transportFailureSince = $state<number | null>(null);

export function setShellFeedStatus(status: FeedStatus): void {
	feedStatus = status;
	if (status._tag === "cold") transportFailureSince = null;
}

export function noteTransportDrop(): void {
	transportFailureSince ??= Date.now();
}

/** Settled reactive state. Envelope vocabulary does not travel past here. */
export const sessionSubscription = {
	/** Confirmed rows only; saved shell rows never place a session. */
	get liveRows(): ReadonlyMap<string, SessionInfo> {
		return applied.rows;
	},
	/** Live rows, or the device's provisional rows before the first snapshot. */
	get rows(): ReadonlyMap<string, SessionInfo> {
		return savedShell ?? applied.rows;
	},
	/** Whether the server has said we hold everything. ni8.5.20/T-11 keys the
	 *  switching state off this. */
	get settled(): boolean {
		return applied.settled;
	},
	get status(): FeedStatus {
		return transportFailureSince === null
			? feedStatus
			: {
					_tag: "failing",
					since: transportFailureSince,
					lastError: "Connection lost",
				};
	},
};

/**
 * Apply one change to the session map. The only writer.
 *
 * Project frames update project metadata without changing the row cursor.
 */
export function applySessionChange(change: ShellEnvelope): void {
	if (change._tag === "projects") {
		applyShellProjects(change);
		return;
	}
	if (change._tag === "synchronized") transportFailureSince = null;
	const next = reduce(applied, change, identify);
	if (next === applied) return;
	// The viewed session's approval mode and model settings follow its row, so
	// a switch made in another tab, or by the provider, lands in this tab's pickers.
	const followViewedSession = (row: SessionInfo) => {
		if (row.id !== sessionState.currentId) return;
		const previous = applied.rows.get(row.id);
		if (
			row.permissionMode !== undefined &&
			row.permissionMode !== previous?.permissionMode
		)
			handlePermissionModeInfo({ mode: row.permissionMode });
		followSessionModelSettings(row, previous);
	};
	if (change._tag === "upsert") {
		applyTurnRow(change.item);
		hydrateSessionGoal(change.item);
		followViewedSession(change.item);
		const previous = applied.rows.get(change.item.id);
		followSessionTurn(change.item.id, change.item, previous);
		if (change.item.compacting !== applied.rows.get(change.item.id)?.compacting)
			followSessionCompaction(change.item.id, change.item.compacting);
		if (change.item.retrying !== applied.rows.get(change.item.id)?.retrying)
			followSessionRetry(change.item.id, change.item.retrying);
		followSessionResumes(change.item, previous);
	}
	// An archived root or one that gained a parent only leaves the list; one that is gone, or a
	// child that is, comes marked deleted, live or on catch-up.
	if (change._tag === "remove" && change.deleted === true) {
		deleteTurn(change.id);
		leaveDeletedSession(change.id);
		forgetSession(change.id);
	}
	if (change._tag === "snapshot") {
		if (applied.floor !== undefined)
			rebaseTurns([...applied.rows.keys(), ...next.rows.keys()]);
		// Snapshot omissions can be archives. Only an explicit deletion may clear
		// chat state; the independent family subscription still owns open sessions.
		for (const row of next.rows.values()) {
			applyTurnRow(row);
			hydrateSessionGoal(row);
			followViewedSession(row);
			followSessionTurn(row.id, row, applied.rows.get(row.id));
			followSessionCompaction(row.id, row.compacting);
			followSessionRetry(row.id, row.retrying);
			followSessionResumes(row, applied.rows.get(row.id));
		}
	}
	applied = next;
	savedShell = null;
	settleReadMarks(next.rows);
}

/** Clear the daemon shell when resetting the browser's session state. */
export function resetSessionSubscription(): void {
	sessionGoals.clear();
	applied = emptySubscription();
	savedShell = null;
	feedStatus = { _tag: "cold" };
	transportFailureSince = null;
}
