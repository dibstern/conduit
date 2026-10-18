import { channel } from "node:diagnostics_channel";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { subscribeApprovals } from "../../../src/lib/domain/relay/Services/approvals-subscription.js";
import type { ReadModelRead } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { subscribeSessionDetail } from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeSessionFamily } from "../../../src/lib/domain/relay/Services/session-family-subscription.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { subscribeSessionTodos } from "../../../src/lib/domain/relay/Services/todo-subscription.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
} from "../../helpers/mock-factories.js";

// The todo source reads TodoWrite tool parts out of the message projection, so
// what is under test is a contract with the store: the version the projector
// stamps on the owning message, the advance the commit seam publishes, and the
// query that turns the newest TodoWrite into the session's todo list. Writes go
// through the real commit seam, exactly as shell-subscription.test.ts does.

const makeTodoTestLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-todo-sub-"));
	const cleanup = Layer.effectDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
		makePersistenceEffectLayer(
			join(dir, "events.db"),
			"test-project",
			undefined,
			SessionEventBusLive,
		),
		SessionEventBusLive,
		Layer.effect(SessionActivityTag, makeSessionActivity),
		Layer.succeed(ConfigTag)(makeMockConfig({ slug: "test-project" })),
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

const openSubscription = <A, E, R>(source: Stream.Stream<A, E, R>) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<A>();
		yield* Stream.runForEach(source, (env) => Queue.offer(q, env)).pipe(
			Effect.forkScoped,
		);
		return q;
	});

const openTodos = (sessionId: string) =>
	openSubscription(subscribeSessionTodos({ sessionId }));

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
	it.live(
		"two staggered subscribers share todo windows and text deltas only read their collections",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("fanout")]);
				yield* commit(
					todoWrite(
						"fanout",
						"todo-before",
						claudeTodos(["Plan", "pending"]),
						"ok",
					),
				);
				const reads: ReadModelRead[] = [];
				const diagnostics = channel("conduit:read-model-read");
				const record = (message: unknown) => {
					const read = message as ReadModelRead;
					if (read.kind === "window") reads.push(read);
				};
				yield* Effect.acquireRelease(
					Effect.sync(() => diagnostics.subscribe(record)),
					() => Effect.sync(() => diagnostics.unsubscribe(record)),
				);
				const openViewer = Effect.gen(function* () {
					const detail = yield* openSubscription(
						subscribeSessionDetail({ sessionId: "fanout" }),
					);
					const todos = yield* openTodos("fanout");
					const shell = yield* openSubscription(
						subscribeShell().pipe(
							Stream.filter((frame) => frame._tag !== "projects"),
						),
					);
					const approvals = yield* openSubscription(subscribeApprovals());
					const family = yield* openSubscription(
						subscribeSessionFamily({ sessionId: "fanout" }),
					);
					const openings = yield* Effect.all([
						takeN(detail, 2),
						takeN(todos, 2),
						takeN(shell, 2),
						takeN(approvals, 2),
						takeN(family, 2),
					]);
					for (const opening of openings) {
						expect(opening.map((envelope) => envelope._tag)).toEqual([
							"snapshot",
							"synchronized",
						]);
					}
					return { detail, todos };
				});
				const first = yield* openViewer;
				yield* Effect.sleep("10 millis");
				const second = yield* openViewer;
				const counts = (after: number) =>
					reads.slice(after).reduce<Record<string, number>>((result, read) => {
						result[read.source] = (result[read.source] ?? 0) + 1;
						return result;
					}, {});
				const textChunks: Record<string, number>[] = [];
				for (let chunk = 0; chunk < 3; chunk++) {
					const after = reads.length;
					yield* commit([textDelta("fanout", "reply")]);
					yield* Queue.take(first.detail);
					yield* Queue.take(second.detail);
					yield* Effect.sleep("20 millis");
					yield* Queue.clear(first.detail);
					yield* Queue.clear(second.detail);
					expect(yield* Queue.size(first.todos)).toBe(0);
					expect(yield* Queue.size(second.todos)).toBe(0);
					textChunks.push(counts(after));
				}
				const todoAfter = reads.length;
				yield* commit(
					todoWrite(
						"fanout",
						"todo-after",
						claudeTodos(["Build", "in_progress"]),
						"ok",
					),
				);
				for (const viewer of [first, second])
					expect(yield* Queue.take(viewer.todos)).toMatchObject({
						_tag: "upsert",
						item: { items: [{ subject: "Build", status: "in_progress" }] },
					});
				const todoChanged = counts(todoAfter);
				const dedupAfter = reads.length;
				yield* commit(
					todoWrite(
						"fanout",
						"todo-same",
						claudeTodos(["Build", "in_progress"]),
						"ok",
					),
				);
				yield* Effect.sleep("20 millis");
				for (const viewer of [first, second])
					expect(yield* Queue.size(viewer.todos)).toBe(0);
				const todoUnchanged = counts(dedupAfter);
				const measurement = { textChunks, todoChanged, todoUnchanged };
				const baseline = process.env["CONDUIT_CAPTURE_FANOUT_BASELINE"] === "1";
				yield* Effect.sync(() => {
					const file = "test-results/8rdf-13-read-counts.json";
					const previous: unknown = existsSync(file)
						? JSON.parse(readFileSync(file, "utf8"))
						: undefined;
					const recordedBaseline =
						typeof previous === "object" &&
						previous !== null &&
						"baseline" in previous
							? previous.baseline
							: undefined;
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						file,
						`${JSON.stringify(
							{
								ticket: "conduit-test-8rdf.13",
								subscribers: 2,
								baseline: baseline ? measurement : recordedBaseline,
								...(baseline ? {} : { after: measurement }),
							},
							null,
							2,
						)}\n`,
					);
				});
				if (!baseline) {
					for (const count of textChunks)
						expect(count).toEqual({
							"session-detail/fanout": 1,
							"todos/fanout": 1,
						});
					expect(todoChanged["todos/fanout"]).toBe(1);
					expect(todoUnchanged["todos/fanout"]).toBe(1);
				}
			}).pipe(Effect.provide(makeTodoTestLayer())),
	);

	it.effect(
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

	it.effect(
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

	it.effect(
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

	it.effect("a fresh subscription (a reload) starts from the stored list", () =>
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
