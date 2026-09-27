/**
 * Where a turn is in its lifecycle.
 *
 * The invariant: a turn is finished only if nothing followed its completion.
 * `settled` is not terminal — later work returns the turn to `running`.
 */
export type TurnPhase = "pending" | "running" | "settled";

/** The latest thing that happened to a turn. */
export type TurnSignal =
	| "prompt"
	| "busy"
	| "activity"
	| "result"
	| "error"
	| "interrupt";

const PHASE_BY_SIGNAL = {
	prompt: "pending",
	busy: "running",
	activity: "running",
	result: "settled",
	error: "settled",
	interrupt: "settled",
} as const satisfies Record<TurnSignal, TurnPhase>;

/**
 * Phase is a function of the latest signal alone.
 *
 * There is deliberately no previous-phase parameter. Callers cannot write
 * "once settled, stay settled" because they have no prior phase to branch on,
 * which is the bug this module exists to make unrepresentable: a provider can
 * report a result and then keep working, and the turn has to follow.
 */
export function phaseAfter(signal: TurnSignal): TurnPhase {
	return PHASE_BY_SIGNAL[signal];
}

/**
 * The same rule in the read-model's own words.
 *
 * The `turns.state` column predates `TurnPhase` and keeps the settlement
 * reason, so `settled` splits three ways here. Both turn projectors write that
 * column and both go through this function, so neither can drift into
 * latching a turn on its own.
 */
export function persistedTurnState(signal: TurnSignal) {
	const phase = phaseAfter(signal);
	if (phase !== "settled") return phase;
	// Preserve the settlement reason in the existing read-model vocabulary.
	return signal === "error"
		? "error"
		: signal === "interrupt"
			? "interrupted"
			: "completed";
}
