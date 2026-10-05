import { type Deferred, Effect, HashMap, Option, Ref } from "effect";
import type { ClaudeProviderInstance } from "../../src/lib/provider/claude/claude-provider-instance.js";
import type {
	ClaudeProviderRuntime,
	ClaudeProviderRuntimeState,
} from "../../src/lib/provider/claude/claude-provider-runtime.js";
import { addTurnWaiter } from "../../src/lib/provider/claude/claude-runtime-turn.js";
import type { ClaudeSessionContext } from "../../src/lib/provider/claude/types.js";
import type { TurnResult } from "../../src/lib/provider/types.js";

function stateRefFor(
	instance: ClaudeProviderInstance,
): Ref.Ref<ClaudeProviderRuntimeState> {
	const runtime = (instance as unknown as { runtime: ClaudeProviderRuntime })
		.runtime;
	return (
		runtime as unknown as {
			runner: { stateRef: Ref.Ref<ClaudeProviderRuntimeState> };
		}
	).runner.stateRef;
}

export function setClaudeRuntimeSessionForTest(
	instance: ClaudeProviderInstance,
	sessionId: string,
	ctx: ClaudeSessionContext,
): void {
	Effect.runSync(
		Ref.update(stateRefFor(instance), (state) => ({
			...state,
			sessions: HashMap.set(state.sessions, sessionId, ctx),
		})),
	);
}

export function getClaudeRuntimeSessionForTest<
	T extends ClaudeSessionContext = ClaudeSessionContext,
>(instance: ClaudeProviderInstance, sessionId: string): T | undefined {
	return Effect.runSync(
		Ref.get(stateRefFor(instance)).pipe(
			Effect.map((state) =>
				Option.getOrUndefined(HashMap.get(state.sessions, sessionId)),
			),
		),
	) as T | undefined;
}

export function hasClaudeRuntimeSessionForTest(
	instance: ClaudeProviderInstance,
	sessionId: string,
): boolean {
	return Effect.runSync(
		Ref.get(stateRefFor(instance)).pipe(
			Effect.map((state) => HashMap.has(state.sessions, sessionId)),
		),
	);
}

export function getClaudeRuntimeSessionCountForTest(
	instance: ClaudeProviderInstance,
): number {
	return Effect.runSync(
		Ref.get(stateRefFor(instance)).pipe(
			Effect.map((state) => HashMap.size(state.sessions)),
		),
	);
}

export function setClaudeRuntimeTurnWaitersForTest(
	instance: ClaudeProviderInstance,
	sessionId: string,
	waiters: ReadonlyArray<Deferred.Deferred<TurnResult, Error>>,
): void {
	Effect.runSync(
		Ref.update(stateRefFor(instance), (state) => ({
			...state,
			turnWaiters: HashMap.set(
				state.turnWaiters,
				sessionId,
				new Map(
					waiters.map((deferred, index) => [
						`test-waiter-${index}`,
						{ deferred, started: false },
					]),
				),
			),
		})),
	);
}

/** Registers a sent input the way a mid-turn handoff will (ticket .7). */
export function addClaudeRuntimeTurnWaiterForTest(
	instance: ClaudeProviderInstance,
	sessionId: string,
	inputId: string,
	deferred: Deferred.Deferred<TurnResult, Error>,
): void {
	Effect.runSync(
		addTurnWaiter(stateRefFor(instance), sessionId, inputId, {
			deferred,
			started: false,
		}),
	);
}

export function hasClaudeRuntimeTurnWaitersForTest(
	instance: ClaudeProviderInstance,
	sessionId: string,
): boolean {
	return Effect.runSync(
		Ref.get(stateRefFor(instance)).pipe(
			Effect.map((state) => HashMap.has(state.turnWaiters, sessionId)),
		),
	);
}
