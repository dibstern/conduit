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
} from "../stores/chat.svelte.js";
import {
	followSessionModelSettings,
	handlePermissionModeInfo,
} from "../stores/discovery.svelte.js";
import { hydrateSessionGoal, sessionGoals } from "../stores/goal.svelte.js";
import { forgetSession, sessionState } from "../stores/session.svelte.js";
import { sessionActivityBridge } from "../stores/session-activity.svelte.js";
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

const isBusy = (row: SessionInfo | undefined): boolean =>
	row?.status === "busy" || row?.status === "retry";

// `$state.raw`, not `$state`: the applier replaces the state whole and never
// mutates it, so a deep proxy would cost work to track writes that cannot
// happen.
let applied = $state.raw<SubscriptionState<SessionInfo>>(emptySubscription());

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
	/** Every session the server has told us about, keyed by id. */
	get rows(): ReadonlyMap<string, SessionInfo> {
		return applied.rows;
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
	const receivedSequence = sessionActivityBridge.observe();
	// Only accepted shell changes retire activity. A duplicate or stale
	// envelope must not affect client state independently of the row applier.
	if (change._tag === "upsert") {
		sessionActivityBridge.retire(change.item.id, receivedSequence, "row");
		hydrateSessionGoal(change.item);
		followViewedSession(change.item);
		// Only a transition moves the phase: an idle write (the user message)
		// must not end the sender's optimistic turn, and a late busy write
		// must not restart one `done` already ended.
		const busy = isBusy(change.item);
		if (busy !== isBusy(applied.rows.get(change.item.id)))
			followSessionBusy(change.item.id, busy);
		if (change.item.compacting !== applied.rows.get(change.item.id)?.compacting)
			followSessionCompaction(change.item.id, change.item.compacting);
	}
	if (change._tag === "remove") {
		sessionActivityBridge.retire(change.id, receivedSequence, "remove");
		forgetSession(change.id);
	}
	if (change._tag === "snapshot") {
		for (const id of new Set([
			...applied.rows.keys(),
			...sessionActivityBridge.pending.keys(),
		])) {
			if (!next.rows.has(id)) {
				sessionActivityBridge.retire(id, receivedSequence, "omission");
				if (applied.rows.has(id)) forgetSession(id);
			}
		}
		for (const row of next.rows.values()) {
			sessionActivityBridge.retire(row.id, receivedSequence, "row");
			hydrateSessionGoal(row);
			followViewedSession(row);
			// A snapshot (cold start, resume) is absolute.
			followSessionBusy(row.id, isBusy(row));
			followSessionCompaction(row.id, row.compacting);
		}
	}
	applied = next;
}

/** Forget the project we were watching. */
export function resetSessionSubscription(): void {
	sessionActivityBridge.clear();
	sessionGoals.clear();
	applied = emptySubscription();
	feedStatus = { _tag: "cold" };
	transportFailureSince = null;
}
