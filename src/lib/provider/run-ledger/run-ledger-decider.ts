import type {
	DecideContext,
	Decision,
	LedgerCommand,
	LedgerView,
	ProviderKind,
} from "./run-ledger-model.js";

declare const stateBrand: unique symbol;
declare const eventBrand: unique symbol;
export type SessionLedgerState = { readonly [stateBrand]: true };
export type LedgerEvent = { readonly [eventBrand]: true };

/** Checkpoint only: no legacy summaries or send chains survive the redesign. */
export function initialSessionLedgerState(
	sessionId: string,
	provider: ProviderKind,
): SessionLedgerState {
	return Object.freeze({
		sessionId,
		provider,
	}) as unknown as SessionLedgerState;
}

/** The Fact Book core lands in 32.2.5 onward. This checkpoint cannot issue work. */
export function decide(
	_state: SessionLedgerState,
	_command: LedgerCommand,
	_ctx: DecideContext,
): Decision<LedgerEvent> {
	return {
		tag: "Rejected",
		diagnostic: "Run Ledger decider pending redesign implementation",
	};
}

/** No entries can be produced by the checkpoint decider. */
export function evolve(
	state: SessionLedgerState,
	_event: LedgerEvent,
): SessionLedgerState {
	return state;
}

export function viewLedger(_state: SessionLedgerState): LedgerView {
	return {
		paused: false,
		inbox: [],
		live: [],
		tasks: { tag: "none" },
		anythingMayAct: false,
		lostWork: [],
		nativeCommands: [],
		interactions: [],
	};
}
