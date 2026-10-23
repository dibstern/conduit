import { correlate, publicSends } from "./run-ledger-correlation.js";
import { openDeadlines } from "./run-ledger-deadlines.js";
import { correlatedCommand, localCommand } from "./run-ledger-dispatch.js";
import { inbox, inputView, pruneInputs } from "./run-ledger-input-records.js";
import {
	activeRun,
	type SessionLedgerState as LedgerState,
	runInputs,
	type Work,
} from "./run-ledger-internal.js";
import type {
	DecideContext,
	Decision,
	LedgerCommand,
	LedgerView,
	ProviderKind,
} from "./run-ledger-model.js";
import { advance } from "./run-ledger-queue.js";
import { receipt } from "./run-ledger-transmissions.js";

declare const stateBrand: unique symbol;
declare const eventBrand: unique symbol;
export type SessionLedgerState = { readonly [stateBrand]: true };
export type LedgerEvent = { readonly [eventBrand]: true };

export function initialSessionLedgerState(
	sessionId: string,
	provider: ProviderKind,
): SessionLedgerState {
	return {
		sessionId,
		provider,
		runs: new Map(),
		inputs: new Map(),
		sends: new Map(),
		paused: false,
		inactive: false,
		nextOrder: 0,
	} as unknown as SessionLedgerState;
}

export function decide(
	snapshot: SessionLedgerState,
	command: LedgerCommand,
	ctx: DecideContext,
): Decision<LedgerEvent> {
	try {
		const state = snapshot as unknown as LedgerState;
		const correlation = correlate(state, command);
		if (correlation?.tag === "rejected")
			return { tag: "Rejected", diagnostic: correlation.diagnostic };
		const work: Work = { state, ctx, effects: [], ended: [] };
		if (correlation?.tag === "correlated") {
			if (correlation.input.receipt) receipt(work, correlation.input);
			else correlatedCommand(work, correlation.input);
		} else if (!correlation) localCommand(work, command);
		if (work.diagnostic)
			return { tag: "Rejected", diagnostic: work.diagnostic };
		if (correlation?.tag !== "stale") {
			if (
				(!correlation || !correlation.input.receipt) &&
				(command.verb !== "settle" ||
					"token" in command.settlement ||
					(command.settlement.kind === "alarm_fired" && work.state !== state))
			)
				advance(work);
			pruneInputs(work);
		}
		const alarmAt = openDeadlines(work.state)[0]?.at;
		return {
			tag: "Accepted",
			events:
				work.state === state
					? []
					: [{ state: work.state } as unknown as LedgerEvent],
			effects: work.effects,
			ended: work.ended,
			...(alarmAt === undefined ? {} : { alarmAt }),
		};
	} catch {
		return {
			tag: "Rejected",
			diagnostic: "Unable to decide command with the supplied context",
		};
	}
}

export function evolve(
	_state: SessionLedgerState,
	event: LedgerEvent,
): SessionLedgerState {
	return (event as unknown as { readonly state: LedgerState })
		.state as unknown as SessionLedgerState;
}

export function viewLedger(snapshot: SessionLedgerState): LedgerView {
	const state = snapshot as unknown as LedgerState;
	const run = activeRun(state);
	return {
		paused: state.paused,
		...(run
			? {
					active: {
						runId: run.runId,
						tag: run.tag,
						deadline: run.deadline,
						...(run.tag === "Interrupting" ? { by: run.by } : {}),
						inputs: runInputs(state, run.runId).map((ref) =>
							inputView(state, ref),
						),
						interactions: run.interactions.flatMap((item) =>
							item.tag === "Resolved"
								? []
								: [
										item.tag === "Pending"
											? {
													tag: item.tag,
													interactionId: item.interactionId,
													kind: item.kind,
												}
											: {
													tag: item.tag,
													interactionId: item.interactionId,
													kind: item.kind,
													delivery: item.delivery,
												},
									],
						),
					},
				}
			: {}),
		inbox: inbox(state).map((ref) => inputView(state, ref)),
		live: publicSends(state),
	};
}
