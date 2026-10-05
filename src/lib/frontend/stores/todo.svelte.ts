// The viewed session's todo list, fed by its SubscribeSessionTodos stream.
// Provides reactive state for the TodoOverlay component.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { TodoItem } from "../types.js";

// This store has no client half: the list is whatever the server says the
// viewed session's newest TodoWrite left behind.

export const todoState = $state({
	items: [] as TodoItem[],
});

let viewed: { project: string; sessionId: string | null } | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/**
 * Show `sessionId`'s todo list: subscribe for that session (an explicit
 * argument, never the ambient selection) and follow it until the view moves.
 * `null` stops following and clears the list.
 */
export function viewTodos(project: string, sessionId: string | null): void {
	if (viewed?.project === project && viewed.sessionId === sessionId) return;
	viewed = { project, sessionId };
	const currentGeneration = ++generation;
	todoState.items = [];
	const old = fiber;
	fiber = null;
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || !sessionId) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								Stream.suspend(() => subscriptions.todos({ sessionId })),
								() => undefined,
							),
							(envelope) =>
								Effect.sync(() => {
									if (currentGeneration !== generation) return;
									const row =
										envelope._tag === "snapshot"
											? envelope.rows.find((r) => r.sessionId === sessionId)
											: envelope._tag === "upsert"
												? envelope.item
												: undefined;
									if (row?.sessionId === sessionId)
										todoState.items = [...row.items];
								}),
						),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}

/** Clear todo state (for project/session switch). */
export function clearTodoState(): void {
	todoState.items = [];
}
