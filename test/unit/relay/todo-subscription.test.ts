import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	type SessionTodos,
	subscribeSessionTodos,
} from "../../../src/lib/domain/relay/Services/todo-subscription.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";

// The todo source reads TodoWrite tool parts out of the message projection, so
// what is under test is a contract with the store: the version the projector
// stamps on the owning message, the advance the commit seam publishes, and the
// query that turns the newest TodoWrite into the session's todo list. Writes go
// through the real commit seam, exactly as shell-subscription.test.ts does.

const makeTodoTestLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-todo-sub-"));
	const cleanup = Layer.scopedDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		makePersistenceEffectLayer(
			join(dir, "events.db"),
			undefined,
			SessionEventBusLive,
		),
		SessionEventBusLive,
		cleanup,
	);
};

let clock = 0;
const at = () => ++clock;

const sessionCreated = (
	sessionId: string,
	provider: "claude" | "opencode" = "claude",
): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{ sessionId, title: sessionId, provider },
		{ provider, createdAt: at() },
	);

/**
 * A TodoWrite call as a provider lands it: started with its input in the
 * canonical `Unknown` envelope, then completed with the provider's output.
 */
const todoWrite = (
	sessionId: string,
	messageId: string,
	raw: Record<string, unknown>,
	result: unknown,
): CanonicalEvent[] => [
	canonicalEvent(
		"tool.started",
		sessionId,
		{
			messageId,
			partId: `${messageId}-todo`,
			toolName: "TodoWrite",
			callId: `${messageId}-call`,
			input: { tool: "Unknown", name: "TodoWrite", raw },
		},
		{ provider: "claude", createdAt: at() },
	),
	canonicalEvent(
		"tool.completed",
		sessionId,
		{ messageId, partId: `${messageId}-todo`, result, duration: 1 },
		{ provider: "claude", createdAt: at() },
	),
];

const textDelta = (sessionId: string, messageId: string): CanonicalEvent =>
	canonicalEvent(
		"text.delta",
		sessionId,
		{ messageId, partId: `${messageId}-text`, text: "thinking aloud" },
		{ provider: "claude", createdAt: at() },
	);

const recoverProjections = Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
	runner.recover(),
);

const commit = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal(events),
	);

const openTodos = (sessionId: string) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionTodos>>();
		yield* Stream.runForEach(subscribeSessionTodos({ sessionId }), (env) =>
			Queue.offer(q, env),
		).pipe(Effect.forkScoped);
		return q;
	});

const takeN = <A>(q: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

const claudeTodos = (...pairs: [string, string][]) => ({
	todos: pairs.map(([content, status]) => ({
		content,
		status,
		activeForm: content,
	})),
});

describe("subscribeSessionTodos", () => {
	it.scoped(
		"todo updates land as ordered upserts after an empty base, and other writes stay silent",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("A")]);
				const q = yield* openTodos("A");
				const [snapshot, synchronized] = yield* takeN(q, 2);
				expect(snapshot).toMatchObject({
					_tag: "snapshot",
					rows: [{ sessionId: "A", items: [] }],
				});
				expect(synchronized).toEqual({ _tag: "synchronized" });

				yield* commit(
					todoWrite(
						"A",
						"m1",
						claudeTodos(["Plan", "in_progress"], ["Build", "pending"]),
						"Todos have been modified successfully.",
					),
				);
				yield* commit([textDelta("A", "m2")]);
				yield* commit(
					todoWrite(
						"A",
						"m3",
						claudeTodos(["Plan", "completed"], ["Build", "in_progress"]),
						"Todos have been modified successfully.",
					),
				);

				const [first, second] = yield* takeN(q, 2);
				expect(first).toMatchObject({
					_tag: "upsert",
					item: {
						sessionId: "A",
						items: [
							{ id: "todo-0", subject: "Plan", status: "in_progress" },
							{ id: "todo-1", subject: "Build", status: "pending" },
						],
					},
				});
				expect(second).toMatchObject({
					_tag: "upsert",
					item: {
						sessionId: "A",
						items: [
							{ subject: "Plan", status: "completed" },
							{ subject: "Build", status: "in_progress" },
						],
					},
				});
				if (first?._tag !== "upsert" || second?._tag !== "upsert")
					throw new Error("expected upserts");
				expect(second.sequence).toBeGreaterThan(first.sequence);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeTodoTestLayer())),
	);

	it.scoped(
		"an OpenCode TodoWrite whose list lives only in its result still lands",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("oc", "opencode")]);
				const q = yield* openTodos("oc");
				yield* takeN(q, 2);
				yield* commit(
					todoWrite(
						"oc",
						"m1",
						{},
						JSON.stringify([
							{
								id: "t1",
								content: "Ship",
								status: "in_progress",
								priority: "high",
							},
						]),
					),
				);
				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "upsert",
					item: {
						sessionId: "oc",
						items: [{ id: "t1", subject: "Ship", status: "in_progress" }],
					},
				});
			}).pipe(Effect.provide(makeTodoTestLayer())),
	);

	it.scoped(
		"the session is the argument: a subscription for B never sees A's todos",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("A"), sessionCreated("B")]);
				const q = yield* openTodos("B");
				yield* takeN(q, 2);
				yield* commit(
					todoWrite("A", "a1", claudeTodos(["A's", "pending"]), "ok"),
				);
				yield* commit(
					todoWrite("B", "b1", claudeTodos(["B's", "pending"]), "ok"),
				);
				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "upsert",
					item: { sessionId: "B", items: [{ subject: "B's" }] },
				});
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeTodoTestLayer())),
	);

	it.scoped("a fresh subscription (a reload) starts from the stored list", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated("A")]);
			yield* commit(
				todoWrite("A", "m1", claudeTodos(["Old", "pending"]), "ok"),
			);
			yield* commit(
				todoWrite("A", "m2", claudeTodos(["New", "in_progress"]), "ok"),
			);
			const q = yield* openTodos("A");
			expect(yield* Queue.take(q)).toMatchObject({
				_tag: "snapshot",
				rows: [
					{
						sessionId: "A",
						items: [{ subject: "New", status: "in_progress" }],
					},
				],
			});
		}).pipe(Effect.provide(makeTodoTestLayer())),
	);
});
