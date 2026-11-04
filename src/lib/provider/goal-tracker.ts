import type { NativeCommandView } from "./run-ledger/run-ledger-model.js";

/**
 * The goal tracker (CONTRACT.md 8.1, 8.6): the confirmed status, the pending action and the order
 * of the last applied native read. Displayed phases (Clearing, queued by Claude, not confirmed) are
 * derived by `goalPhase` from the pending action and its send in the Run Ledger; none is stored.
 * Counters stay in the session's goal projection. The tracker runs no timer (8.5).
 */
export type ConfirmedGoal =
	| {
			readonly tag: "Active" | "Paused" | "Limited" | "Met";
			readonly condition: string;
	  }
	| { readonly tag: "Cleared" };

export type GoalAction =
	| { readonly kind: "set"; readonly condition: string }
	| { readonly kind: "clear" | "pause" | "resume" };

// CONTRACT.md 8.6 (2948) names Pending by id only. The action rides with the id so the derived
// phase and recovery's condition compare need no second lookup into the native command's text.
export type PendingGoalAction =
	| { readonly tag: "None" }
	| {
			readonly tag: "Pending";
			readonly id: string;
			readonly action: GoalAction;
	  };

export interface GoalTracker {
	readonly confirmed: ConfirmedGoal;
	readonly pending: PendingGoalAction;
	/** The order (transcript byte offset or native revision) of the last applied observation. */
	readonly order: number;
}

/**
 * A reply correlated by the provider to the action it answers (Claude: input UUID), or a native
 * status read. Both carry an order; `status: null` is a read that found no goal record.
 */
export type GoalObservation =
	| {
			readonly kind: "reply";
			readonly replyTo: string;
			readonly status: ConfirmedGoal;
			readonly order: number;
	  }
	| {
			readonly kind: "read";
			readonly status: ConfirmedGoal | null;
			readonly order: number;
	  };

export type GoalPhase =
	| {
			readonly tag: "Confirmed";
			readonly status: ConfirmedGoal;
			/** The pending action's delivery failed; the confirmed status shows again (8.1). */
			readonly failed?: { readonly action: GoalAction; readonly code: string };
	  }
	| {
			readonly tag: "Pending";
			readonly action: GoalAction;
			/** Queued: "queued by Claude". Unconfirmed: "not confirmed", with Retry (8.5). */
			readonly send: "Sent" | "Queued" | "Unconfirmed";
	  };

/** The native command a goal action is (8.6 Claude: `/goal <condition>`, `/goal clear`). */
export const goalCommandText = (action: GoalAction): string =>
	action.kind === "set" ? `/goal ${action.condition}` : `/goal ${action.kind}`;

export const NO_GOAL: GoalTracker = {
	confirmed: { tag: "Cleared" },
	pending: { tag: "None" },
	order: -1,
};

/** A new action supersedes the pending one (8.6). */
export function requestGoalAction(
	goal: GoalTracker,
	id: string,
	action: GoalAction,
): GoalTracker {
	return { ...goal, pending: { tag: "Pending", id, action } };
}

export function confirmGoal(
	goal: GoalTracker,
	observation: GoalObservation,
): GoalTracker {
	if (observation.status === null || observation.order <= goal.order)
		return goal;
	if (observation.kind === "read")
		return { ...goal, confirmed: observation.status, order: observation.order };
	// Only a reply to the current pending action counts; a superseded or uncorrelated one changes nothing.
	return goal.pending.tag === "Pending" &&
		goal.pending.id === observation.replyTo
		? {
				confirmed: observation.status,
				pending: { tag: "None" },
				order: observation.order,
			}
		: goal;
}

const satisfies = (status: ConfirmedGoal, action: GoalAction): boolean => {
	switch (action.kind) {
		case "set":
			return status.tag === "Active" && status.condition === action.condition;
		case "clear":
			return status.tag === "Cleared";
		case "pause":
			return status.tag === "Paused";
		case "resume":
			return status.tag === "Active";
	}
};

/**
 * After the process died before confirming, the tracker reloads native state and resends first,
 * only if the confirmed status (condition included) does not already match (8.4, 8.6).
 */
export function recoverGoal(goal: GoalTracker): {
	readonly goal: GoalTracker;
	readonly resend?: { readonly id: string; readonly action: GoalAction };
} {
	const { pending } = goal;
	if (pending.tag === "None") return { goal };
	return satisfies(goal.confirmed, pending.action)
		? { goal: { ...goal, pending: { tag: "None" } } }
		: { goal, resend: { id: pending.id, action: pending.action } };
}

export function goalPhase(
	goal: GoalTracker,
	send:
		| (Pick<NativeCommandView, "commandId" | "tag"> & {
				readonly code?: string;
		  })
		| undefined,
): GoalPhase {
	const { pending } = goal;
	if (pending.tag === "None")
		return { tag: "Confirmed", status: goal.confirmed };
	const tag = send?.commandId === pending.id ? send.tag : "Sent";
	switch (tag) {
		case "Failed":
		case "Cancelled":
			return {
				tag: "Confirmed",
				status: goal.confirmed,
				failed: {
					action: pending.action,
					code: tag === "Failed" ? (send?.code ?? "failed") : "cancelled",
				},
			};
		case "Queued":
		case "Unconfirmed":
			return { tag: "Pending", action: pending.action, send: tag };
		default:
			return { tag: "Pending", action: pending.action, send: "Sent" };
	}
}
