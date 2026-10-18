import { mkdirSync, writeFileSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { expect, it, vi } from "vitest";
import type { ReadModelAdvance } from "../../../../src/lib/contracts/read-model-advance.js";
import { Usage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { ContinuationTag } from "../../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { SessionEventBusTag } from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../../src/lib/domain/relay/Services/session-inbox.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { makeTestHandlerLayer } from "../../../helpers/mock-factories.js";

// Failure modes: startup dispatches another project's queued inputs; a foreign
// advance wakes this runtime; overflow recovers foreign queues with the local ones.
it("keeps inbox startup, advance and overflow drains within the bound project", async () => {
	const dispatched: string[] = [];
	const results: { read: string; titles: string[]; passed: boolean }[] = [];
	const advances = await Effect.runPromise(
		Queue.unbounded<ReadModelAdvance & { readonly dropped?: boolean }>(),
	);
	const persistence = makePersistenceEffectLayer(":memory:", "project-a");
	const deps = Layer.mergeAll(
		makeTestHandlerLayer({ persistenceLayer: persistence }),
		Layer.succeed(SessionEventBusTag, {
			publish: () => Effect.void,
			publishAdvance: (advance) =>
				Queue.offer(advances, advance).pipe(Effect.asVoid),
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeAdvances: () => Effect.succeed(Stream.fromQueue(advances)),
		}),
		Layer.succeed(Usage, {
			readings: Stream.empty,
			latest: () => Effect.succeed(undefined),
			refresh: () => Effect.succeed([]),
			turnEnded: () => Effect.void,
			pickFailover: () => Effect.succeed(undefined),
		}),
		Layer.succeed(ContinuationTag, {
			requestContinuation: () => Effect.void,
			intakeLimit: () => Effect.succeed(false),
			dismissCutOff: () => Effect.void,
			cancelContinuation: () => Effect.void,
			sweepDueContinuations: () => Effect.void,
			queueLimitPolicy: () => Effect.void,
			runLimitPolicies: Effect.never,
		}),
		Layer.effect(
			ProviderTurnServiceTag,
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return {
					holdUserTurnsForAccountSwitch: () => Effect.void,
					prepareTurnSession: () => Effect.succeed("opencode"),
					turnFences: () => ({ stopping: false, switching: false }),
					fenceLifts: Effect.succeed(Stream.never),
					beginStop: () => Effect.succeed(Effect.void),
					sendTurn: (input) =>
						Effect.sync(() => {
							dispatched.push(input.sessionId);
						}).pipe(
							Effect.zipRight(
								sql`UPDATE pending_inputs SET state = 'removed' WHERE input_id = ${input.commandId}`,
							),
							Effect.orDie,
							Effect.asVoid,
						),
				};
			}),
		).pipe(Layer.provide(persistence)),
	);
	const runtime = ManagedRuntime.make(
		SessionInboxLive.pipe(Layer.provideMerge(deps)),
	);
	const record = (read: string, expected: string[]) => {
		const titles = dispatched
			.map((id) => (id === "a" ? "Alpha" : "Beta"))
			.sort();
		results.push({
			read,
			titles,
			passed: JSON.stringify(titles) === JSON.stringify(expected),
		});
		expect(titles).toEqual(expected);
	};
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				yield* commit(
					["a", "b"].flatMap((id) => [
						canonicalEvent("session.created", id, {
							sessionId: id,
							title: id === "a" ? "Alpha" : "Beta",
							provider: "opencode",
						}),
						canonicalEvent("input.admitted", id, {
							sessionId: id,
							inputId: `${id}-startup`,
							delivery: "queue",
							request: { text: "queued" },
						}),
					]),
				);
				yield* sql`UPDATE sessions SET project_id = 'project-b' WHERE id = 'b'`;
				const inbox = yield* SessionInboxTag;
				yield* inbox.start;
			}),
		);
		await vi.waitFor(() => expect(dispatched).toContain("a"));
		await runtime.runPromise(Effect.sleep("10 millis"));
		record("startup", ["Alpha"]);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO pending_inputs (input_id, session_id, text, state, request, admitted_at, version)
				VALUES ('a-live', 'a', 'live', 'queued', '{"text":"live"}', 1, 1)`;
			}),
		);
		const foreign = {
			version: 10,
			projectIds: ["project-b"],
			sessionIds: ["a", "b"],
			removedSessionIds: [],
			collections: ["inputs"],
		} satisfies ReadModelAdvance;
		await Effect.runPromise(Queue.offer(advances, foreign));
		await runtime.runPromise(Effect.sleep("10 millis"));
		record("foreign advance", ["Alpha"]);
		await Effect.runPromise(
			Queue.offer(advances, { ...foreign, dropped: true }),
		);
		await vi.waitFor(() =>
			expect(dispatched.filter((id) => id === "a")).toHaveLength(2),
		);
		await runtime.runPromise(Effect.sleep("10 millis"));
		record("overflow", ["Alpha", "Alpha"]);
	} finally {
		await runtime.dispose();
		await Effect.runPromise(Queue.shutdown(advances));
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn3-scoped-runtime-reads.json",
			`${JSON.stringify(results, null, 2)}\n`,
		);
	}
});
