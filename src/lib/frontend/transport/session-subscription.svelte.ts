// ─── The shell subscription's map ────────────────────────────────────────────
// Every session the server has told us about, and the one door changes come
// through. The session store is a view over this; it holds no copy of its own.
//
// The split against `subscription-state.ts` is deliberate: the applier is pure
// and Svelte-free so it can be driven as a function (ni8.5 T-14), and this
// module is the imperative half that reassigns reactive state — the shape the
// notification reducer established.

import type { Stream } from "effect";
import type { SessionInfo } from "../types.js";
import type { WsRpcSubscriptions } from "./shared-client.js";
import {
	type Change,
	emptySubscription,
	reduce,
	type SubscriptionState,
} from "./subscription-state.js";

/**
 * One thing `subscriptions.shell()` delivers, typed off the subscription
 * itself rather than restated. ni8.5.20 plugs that stream into
 * `applySessionChange`; until it does, the annotation is what proves the
 * envelope still fits the applier.
 */
export type ShellEnvelope = Stream.Stream.Success<
	ReturnType<WsRpcSubscriptions["shell"]>
>;

const identify = (session: SessionInfo): string => session.id;

// `$state.raw`, not `$state`: the applier replaces the state whole and never
// mutates it, so a deep proxy would cost work to track writes that cannot
// happen.
let applied = $state.raw<SubscriptionState<SessionInfo>>(emptySubscription());

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
};

/**
 * Apply one change to the session map. The only writer.
 *
 * Takes the wire envelope, and — until ni8.5.20 retires the legacy WebSocket
 * delta arm — the same changes without a sequence, so both delivery paths land
 * in one map through one applier.
 */
export function applySessionChange(change: Change<SessionInfo>): void {
	applied = reduce(applied, change, identify);
}

/** Forget the project we were watching. */
export function resetSessionSubscription(): void {
	applied = emptySubscription();
}
