// Every session the server has told us about, and the one door changes come
// through. The session store is a view over this; it holds no copy of its own.
//
// The split against `subscription-state.ts` is deliberate: the applier is pure
// and Svelte-free so it can be driven as a function (ni8.5 T-14), and this
// module is the imperative half that reassigns reactive state — the shape the
// notification reducer established.

import type { Stream } from "effect";
import {
	followSessionBusy,
	followSessionCompaction,
	followSessionRetry,
} from "../stores/chat.svelte.js";
import {
	followSessionModelSettings,
	handlePermissionModeInfo,
} from "../stores/discovery.svelte.js";
import { hydrateSessionGoal, sessionGoals } from "../stores/goal.svelte.js";
import { followSessionResumes } from "../stores/handoff-review.svelte.js";
import type { SavedShell } from "../stores/saved-shell.js";
import {
	forgetSession,
	leaveDeletedSession,
	sessionState,
	settleReadMarks,
} from "../stores/session.svelte.js";
import type { SessionInfo } from "../types.js";
import type { WsRpcSubscriptions } from "./shared-client.js";
import {
	type Change,
	emptySubscription,
	reduce,
	type SubscriptionState,
} from "./subscription-state.js";
import type { FeedStatus } from "./supervise.js";

/**
 * One thing `subscriptions.shell()` delivers, typed off the subscription
 * itself rather than restated.
 */
export type ShellEnvelope = Stream.Stream.Success<
	ReturnType<WsRpcSubscriptions["shell"]>
>;

const identify = (session: SessionInfo): string => session.id;

export const isBusy = (row: Pick<SessionInfo, "status"> | undefined): boolean =>
	row?.status === "busy" || row?.status === "retry";

/** The server ended a turn on this row since `previous` (never for a first sighting). */
export const turnEnded = (
	previous: Pick<SessionInfo, "lastTurnEndVersion"> | undefined,
	next: Pick<SessionInfo, "lastTurnEndVersion">,
): boolean =>
	previous !== undefined &&
	(next.lastTurnEndVersion ?? -1) > (previous.lastTurnEndVersion ?? -1);

// `$state.raw`, not `$state`: the applier replaces the state whole and never
// mutates it, so a deep proxy would cost work to track writes that cannot
// happen.
let applied = $state.raw<SubscriptionState<SessionInfo>>(emptySubscription());
let savedShell = $state.raw<{
	project: string;
	rows: ReadonlyMap<string, SessionInfo>;
} | null>(null);

/** Provisional rows only: no versions, synchronization or live row side effects. */
export function drawSavedShell(record: SavedShell): void {
	if (
		applied.floor !== undefined ||
		applied.versions.size > 0 ||
		applied.settled
	)
		return;
	savedShell = {
		project: record.project,
		rows: new Map(record.rows.map((row) => [row.id, row])),
	};
}

/** An attachment confirms which project's provisional rows may stay on screen. */
export function discardForeignSavedShell(project: string): void {
	if (savedShell?.project !== project) savedShell = null;
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
		return savedShell?.rows ?? applied.rows;
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
 * Takes only the versioned shell envelope.
 */
export function applySessionChange(change: Change<SessionInfo>): void {
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
		hydrateSessionGoal(change.item);
		followViewedSession(change.item);
		// Only a transition moves the phase: an idle write (the user message)
		// must not end the sender's optimistic turn, and a late busy write
		// must not restart one already ended. A turn can start and end between
		// two upserts, so an advanced turn-end version also ends it, unless it
		// names an earlier send than the one waiting.
		const previous = applied.rows.get(change.item.id);
		const busy = isBusy(change.item);
		if (
			busy !== isBusy(previous) ||
			(!busy && turnEnded(previous, change.item))
		)
			followSessionBusy(change.item.id, busy, change.item.lastTurnEndInputId);
		if (change.item.compacting !== applied.rows.get(change.item.id)?.compacting)
			followSessionCompaction(change.item.id, change.item.compacting);
		if (change.item.retrying !== applied.rows.get(change.item.id)?.retrying)
			followSessionRetry(change.item.id, change.item.retrying);
		followSessionResumes(change.item, previous);
	}
	// A root that gained a parent only leaves the list; one that is gone, or a
	// child that is, comes marked deleted, live or on catch-up.
	if (change._tag === "remove" && change.deleted === true) {
		leaveDeletedSession(change.id);
		forgetSession(change.id);
	}
	if (change._tag === "snapshot") {
		for (const id of applied.rows.keys())
			if (!next.rows.has(id)) forgetSession(id);
		for (const row of next.rows.values()) {
			hydrateSessionGoal(row);
			followViewedSession(row);
			// A snapshot (cold start, resume) is absolute.
			followSessionBusy(row.id, isBusy(row));
			followSessionCompaction(row.id, row.compacting);
			followSessionRetry(row.id, row.retrying);
			followSessionResumes(row, applied.rows.get(row.id));
		}
	}
	applied = next;
	savedShell = null;
	settleReadMarks(next.rows);
}

/** Forget the project we were watching. */
export function resetSessionSubscription(): void {
	sessionGoals.clear();
	applied = emptySubscription();
	savedShell = null;
	feedStatus = { _tag: "cold" };
	transportFailureSince = null;
}
