import { randomUUID } from "node:crypto";
import type { SessionGoalChangedPayload } from "../contracts/stored-event.js";
import type { CanonicalEvent } from "../persistence/events.js";
import {
	type ConfirmedGoal,
	confirmGoal,
	type GoalAction,
	type GoalPhase,
	type GoalTracker,
	goalPhase,
	NO_GOAL,
	recoverGoal,
	requestGoalAction,
} from "../provider/goal-tracker.js";
import type { NativeCommandView } from "../provider/run-ledger/run-ledger-model.js";

/**
 * A goal dropped with no end is Claude's active goal going away, which confirms nothing
 * (CONTRACT.md 8.6, 2963: it is not an input); only the clear's reply or record ends it.
 */
const confirmedOf = (facts: SessionGoalChangedPayload): ConfirmedGoal | null =>
	facts.goal
		? facts.limit
			? { tag: "Limited", condition: facts.goal.condition, limit: facts.limit }
			: {
					tag: facts.pausedReason === undefined ? "Active" : "Paused",
					condition: facts.goal.condition,
				}
		: facts.ended === "met" && facts.endedGoal
			? { tag: "Met", condition: facts.endedGoal.condition }
			: facts.ended === undefined
				? null
				: { tag: "Cleared" };

/**
 * Each session's goal tracker (CONTRACT.md 8.1): the action the browser asked for, the provider's
 * confirmations, and the Run Ledger's view of each action's send, from which the phase is derived.
 * In memory; at startup the daemon rebuilds each pending action from the store (82tn.32.44).
 * Queued sends are recovery's resends and, where the provider reads its goal natively (Codex's
 * thread/goal/get), the re-read an unconfirmed action takes (8.5); a re-read carries no action.
 */
export function makeSessionGoals() {
	const sessions = new Map<
		string,
		{
			readonly goal: GoalTracker;
			readonly sends: readonly NativeCommandView[];
			/** Arrival order of goal changes, the order of the provider's reads (8.6). */
			readonly seen: number;
			/** The provider can re-read its goal when an action goes unconfirmed (8.5). */
			readonly nativeReads: boolean;
		}
	>();
	/** Sends queued under new ids until the project dispatches them. */
	const resends = new Map<string, { id: string; action?: GoalAction }[]>();
	const queue = (sessionId: string, action?: GoalAction) => {
		const id = randomUUID();
		resends.set(sessionId, [
			...(resends.get(sessionId) ?? []),
			{ id, ...(action ? { action } : {}) },
		]);
		return id;
	};
	const entryOf = (sessionId: string) =>
		sessions.get(sessionId) ?? {
			goal: NO_GOAL,
			sends: [],
			seen: 0,
			nativeReads: false,
		};
	const phaseOf = (sessionId: string): GoalPhase | undefined => {
		const entry = sessions.get(sessionId);
		if (entry === undefined) return undefined;
		const { pending } = entry.goal;
		const phase = goalPhase(
			entry.goal,
			pending.tag === "Pending"
				? entry.sends.find(({ commandId }) => commandId === pending.id)
				: undefined,
		);
		// The confirmed status itself rides the row's goal state.
		return phase.tag === "Confirmed" && phase.failed === undefined
			? undefined
			: phase;
	};
	/** Applies one change; true when the phase it shows moved. */
	const update = (
		sessionId: string,
		next: (entry: ReturnType<typeof entryOf>) => ReturnType<typeof entryOf>,
	): boolean => {
		const before = JSON.stringify(phaseOf(sessionId));
		sessions.set(sessionId, next(entryOf(sessionId)));
		return JSON.stringify(phaseOf(sessionId)) !== before;
	};
	return {
		phaseOf,
		/** 8.6: a new action supersedes the pending one. */
		request: (
			sessionId: string,
			id: string,
			action: GoalAction,
			nativeReads = false,
		) =>
			update(sessionId, (entry) => ({
				...entry,
				nativeReads,
				goal: requestGoalAction(entry.goal, id, action),
			})),
		/** The ledger refused to issue it, so nothing will answer it. */
		drop: (sessionId: string, id: string) =>
			update(sessionId, (entry) =>
				entry.goal.pending.tag === "Pending" && entry.goal.pending.id === id
					? { ...entry, goal: { ...entry.goal, pending: { tag: "None" } } }
					: entry,
			),
		/**
		 * The arm's committed native command view (8.5). When the process died after the pending
		 * action was sent, recovery resends it first under a new id unless the confirmed status
		 * already matches (8.4, 8.6). CONTRACT.md 8.6 (2939) reconciles the transcript first; here
		 * the confirmed status is the latest applied read, and later reads still apply by order.
		 */
		sends: (sessionId: string, sends: readonly NativeCommandView[]) =>
			// A queued resend counts as a move, so the project is woken to dispatch it.
			update(sessionId, (entry) => {
				const { pending } = entry.goal;
				const tagOf = (views: readonly NativeCommandView[]) =>
					pending.tag === "Pending"
						? views.find((send) => send.commandId === pending.id)?.tag
						: undefined;
				// 8.5 (CONTRACT.md 2937): when the deadline fires, the tracker re-reads native state.
				if (
					entry.nativeReads &&
					tagOf(sends) === "Unconfirmed" &&
					tagOf(entry.sends) !== "Unconfirmed"
				)
					queue(sessionId);
				const died =
					pending.tag === "Pending" &&
					sends.some(
						(send) =>
							send.commandId === pending.id &&
							send.tag === "Failed" &&
							send.code === "process_lost",
					);
				if (!died) return { ...entry, sends };
				const { goal, resend } = recoverGoal(entry.goal);
				if (resend === undefined) return { ...entry, goal, sends };
				return {
					...entry,
					goal: requestGoalAction(
						goal,
						queue(sessionId, resend.action),
						resend.action,
					),
					sends,
				};
			}) || resends.has(sessionId),
		/** Takes the resends recovery queued for a session. */
		takeResends(sessionId: string) {
			const taken = resends.get(sessionId) ?? [];
			resends.delete(sessionId);
			return taken;
		},
		/** Follow the ingested events; returns the sessions whose phase moved. */
		observe(events: readonly CanonicalEvent[]): string[] {
			const moved = new Set<string>();
			for (const event of events) {
				if (event.type !== "session.goal_changed") continue;
				const { replyTo } = event.data;
				const status = confirmedOf(event.data);
				if (status === null) continue;
				if (
					update(event.sessionId, (entry) => {
						const goal = confirmGoal(
							entry.goal,
							replyTo === undefined
								? { kind: "read", status, order: entry.seen + 1 }
								: { kind: "reply", replyTo, status, order: entry.seen + 1 },
						);
						const { pending } = goal;
						// Gap, CONTRACT.md 8.5 (2937) and 8.6 (2948): the re-read an unconfirmed action takes
						// is its only answer. Nearest reading: a read already matching the action settles it.
						const unconfirmed =
							replyTo === undefined &&
							pending.tag === "Pending" &&
							entry.sends.some(
								(send) =>
									send.commandId === pending.id && send.tag === "Unconfirmed",
							);
						return {
							...entry,
							seen: entry.seen + 1,
							goal: unconfirmed ? recoverGoal(goal).goal : goal,
						};
					})
				)
					moved.add(event.sessionId);
			}
			return [...moved];
		},
	};
}
