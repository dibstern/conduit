import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import {
	Chunk,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect";
import { expect } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	type SessionDetailItem,
	subscribeSessionDetail,
} from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { resumeStream } from "../../../src/lib/frontend/transport/resume.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import type { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";

// ─── Real-stack harness ──────────────────────────────────────────────────────
// A fresh temp-file persistence stack + the real SessionEventBus per test. The
// detail subscription reads the projected transcript and nothing else, so the
// contracts under test are contracts WITH the store: the version the message
// projector stamps, the advance the commit seam publishes post-COMMIT, and the
// `WHERE session_id = ? AND version > ?` query that turns one into the other.
//
// SessionEventBusLive is passed to makePersistenceEffectLayer AND merged at the
// top level: the same module-singleton layer reference, so Effect memoization
// unifies ClaudeEventPersist's publisher, the driver's publisher, and the
// subscription's listener onto one PubSub.

const makeDetailTestLayer = (options?: {
	readonly projectors?: readonly EffectProjector[];
	readonly busLayer?: Layer.Layer<SessionEventBusTag>;
}) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-detail-sub-"));
	const filename = join(dir, "events.db");
	const busLayer = options?.busLayer ?? SessionEventBusLive;
	const cleanup = Layer.scopedDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		makePersistenceEffectLayer(filename, options?.projectors, busLayer),
		busLayer,
		cleanup,
	);
};

// F4: the real ingestion service on top of the same base — one memoized layer
// reference, so ingestion's store/runner/bus ARE the ones the subscription reads.
const makeDetailIngestionTestLayer = () => {
	const base = makeDetailTestLayer();
	return Layer.merge(
		base,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(base)),
	);
};

// Monotonic clock → deterministic message ordering across the suite.
let clock = 0;
const at = () => ++clock;

const sessionCreated = (sessionId: string): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{ sessionId, title: "Detail Session", provider: "claude" },
		{ provider: "claude", createdAt: at() },
	);
const messageCreated = (
	sessionId: string,
	messageId: string,
	role: "user" | "assistant",
): CanonicalEvent =>
	canonicalEvent(
		"message.created",
		sessionId,
		{ messageId, role, sessionId },
		{ provider: "claude", createdAt: at() },
	);
const textDelta = (
	sessionId: string,
	messageId: string,
	partId: string,
	text: string,
): CanonicalEvent =>
	canonicalEvent(
		"text.delta",
		sessionId,
		{ messageId, partId, text },
		{ provider: "claude", createdAt: at() },
	);
const toolStarted = (
	sessionId: string,
	messageId: string,
	partId: string,
): CanonicalEvent =>
	canonicalEvent(
		"tool.started",
		sessionId,
		{
			messageId,
			partId,
			toolName: "Bash",
			callId: partId,
			input: { tool: "Bash", command: "pwd" },
		},
		{ provider: "claude", createdAt: at() },
	);
const toolCompleted = (
	sessionId: string,
	messageId: string,
	partId: string,
): CanonicalEvent =>
	canonicalEvent(
		"tool.completed",
		sessionId,
		{ messageId, partId, result: "ok", duration: 1 },
		{ provider: "claude", createdAt: at() },
	);
const turnCompleted = (sessionId: string, messageId: string): CanonicalEvent =>
	canonicalEvent(
		"turn.completed",
		sessionId,
		{ messageId },
		{ provider: "claude", createdAt: at() },
	);

// Recover projections once so projectBatch is permitted.
const recoverProjections = Effect.gen(function* () {
	const runner = yield* ProjectionRunnerEffectTag;
	yield* runner.recover();
});

const establishSession = (sessionId: string) =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const stored = yield* eventStore.append(sessionCreated(sessionId));
		yield* runner.projectEvent(stored);
	});

/** The ingestion choke point: append → project → COMMIT → publish the advance. */
const commit = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal(events),
	);

/** The number the envelopes speak in. */
const readModelVersion = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{ value: number }>`
		SELECT value FROM read_model_counter WHERE id = 1`;
	return rows[0]?.value ?? 0;
});

// Drain the subscription into a queue so the test pulls envelopes one at a time.
// The opening envelopes prove the advance subscription is already acquired — the
// orchestrator acquires it before reading the base — so a commit landing after
// that pull is guaranteed delivered, no sleeps.
const openDetail = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
		const fiber = yield* Stream.runForEach(
			subscribeSessionDetail(options),
			(env) => Queue.offer(q, env),
		).pipe(Effect.forkScoped);
		return { q, fiber };
	});

const takeN = <A>(q: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

/** The delta this source produces: a whole projected transcript message. */
const expectMessage = (envelope: Envelope<SessionDetailItem> | undefined) => {
	if (
		envelope?._tag !== "upsert" ||
		envelope.item._tag !== "transcriptMessage"
	) {
		throw new Error(
			`expected a transcript-message upsert, got ${JSON.stringify(envelope)}`,
		);
	}
	return envelope.item.message;
};

const textOf = (message: { readonly [key: string]: unknown }): string =>
	String(message["text"] ?? "");

const SID = "session-detail";

// Provider runtime-event factory for the real-ingestion test (F4).
const RUNTIME_BASE = {
	providerId: "claude",
	sessionId: SID,
	createdAt: "2026-07-28T00:00:00.000Z",
	rawSource: {
		kind: "claude.sdk.message",
		providerMessageType: "assistant",
	},
	providerRefs: { providerSessionId: "provider-session-detail" },
} as const;

const runtimeEvent = (event: Record<string, unknown>): ProviderRuntimeEvent =>
	decodeProviderRuntimeEvent({ ...RUNTIME_BASE, ...event });

describe("subscribeSessionDetail", () => {
	it.scoped("cold start emits the transcript snapshot then synchronized", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				textDelta(SID, "m1", "m1-0", "Hello"),
				textDelta(SID, "m1", "m1-0", " world"),
				turnCompleted(SID, "m1"),
			]);

			const { q } = yield* openDetail({ sessionId: SID });
			const [snapshot, synchronized] = yield* takeN(q, 2);

			if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
			expect(synchronized).toEqual({ _tag: "synchronized" });
			// The base carries the read-model version it was read at — the same
			// number a live delta or a resume will speak in.
			expect(snapshot.sequence).toBe(yield* readModelVersion);
			expect(snapshot.rows).toHaveLength(1);
			const [row] = snapshot.rows;
			if (row?._tag !== "transcriptMessage")
				throw new Error("expected message");
			expect(row.message.id).toBe("m1");
			expect(row.message.role).toBe("assistant");
			expect(textOf(row.message)).toBe("Hello world");
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"a live commit re-queries: the whole current message, parts included",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2);

				// A part write carries no version of its own, so it advances the
				// message that owns it and the whole message comes back — which is
				// why the delta is a projected message, not the event that caused it.
				yield* commit([
					textDelta(SID, "m1", "m1-0", " world"),
					toolStarted(SID, "m1", "tool-1"),
					toolCompleted(SID, "m1", "tool-1"),
				]);

				const message = expectMessage(yield* Queue.take(q));
				expect(message.id).toBe("m1");
				expect(textOf(message)).toBe("Hello world");
				expect(message.parts?.map((part) => part.type)).toEqual([
					"text",
					"tool",
				]);
				expect(message.parts?.[1]?.state?.["status"]).toBe("completed");
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("the sequence on every envelope is the read-model version", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);

			const { q } = yield* openDetail({ sessionId: SID });
			const [snapshot] = yield* takeN(q, 2);
			if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");

			yield* commit([textDelta(SID, "m1", "m1-0", "one")]);
			const first = yield* Queue.take(q);
			yield* commit([textDelta(SID, "m1", "m1-0", "two")]);
			const second = yield* Queue.take(q);

			if (first._tag !== "upsert" || second._tag !== "upsert") {
				throw new Error("expected upserts");
			}
			// Monotone, and the last one is exactly where the read model now is:
			// change notification, resume point and high-water mark are one number.
			expect(first.sequence).toBeGreaterThan(snapshot.sequence);
			expect(second.sequence).toBeGreaterThan(first.sequence);
			expect(second.sequence).toBe(yield* readModelVersion);
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"delivers what the REAL ingestion service committed, as projected messages",
		() =>
			// F4: driven through the ProviderRuntimeIngestion service — its own
			// translate → append → project → publish pipeline (spec acceptance #9).
			Effect.gen(function* () {
				yield* recoverProjections;
				const ingestion = yield* ProviderRuntimeIngestionTag;

				yield* ingestion.ingestBatch([
					runtimeEvent({
						eventId: "rt-session-created",
						type: "session.created",
						data: { sessionId: SID, title: "Detail", provider: "claude" },
					}),
					runtimeEvent({
						eventId: "rt-message-created",
						type: "message.created",
						turnId: "turn-1",
						data: { messageId: "m1", role: "assistant" },
					}),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2); // snapshot + synchronized ⇒ subscribed

				yield* ingestion.ingestBatch([
					runtimeEvent({
						eventId: "rt-text-delta",
						type: "text.delta",
						turnId: "turn-1",
						data: { messageId: "m1", partId: "m1-0", text: "Hi" },
					}),
					runtimeEvent({
						eventId: "rt-tool-started",
						type: "tool.started",
						turnId: "turn-1",
						data: {
							partId: "tool-1",
							toolName: "Bash",
							input: { tool: "Bash", command: "pwd" },
						},
					}),
					runtimeEvent({
						eventId: "rt-tool-completed",
						type: "tool.completed",
						turnId: "turn-1",
						data: {
							messageId: "m1",
							partId: "tool-1",
							toolName: "Bash",
							input: { tool: "Bash", command: "pwd" },
							result: "ok",
						},
					}),
				]);

				const message = expectMessage(yield* Queue.take(q));
				expect(message.id).toBe("m1");
				expect(textOf(message)).toBe("Hi");
				expect(message.parts?.map((part) => part.type)).toContain("tool");
				// The transcript is durable, so what a subscriber receives outlives
				// event eviction — it is the projection, not the log.
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailIngestionTestLayer())),
	);

	it.scoped(
		"exactly-once across the base read: only messages past the base come back",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				// Subscribe mid-turn: "Hello" is already in the transcript, and an
				// older message m0 is settled.
				yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m0", "user"),
					textDelta(SID, "m0", "m0-0", "prompt"),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
				]);

				const { q } = yield* openDetail({ sessionId: SID });
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows).toHaveLength(2);

				yield* commit([textDelta(SID, "m1", "m1-0", " world")]);

				// One envelope, for the one message that moved: m0 is untouched, so
				// its version is below the floor and the query does not return it.
				const message = expectMessage(yield* Queue.take(q));
				expect(message.id).toBe("m1");
				expect(textOf(message)).toBe("Hello world");
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("resume catches up from the cursor with no base envelope", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m0", "user"),
				textDelta(SID, "m0", "m0-0", "held by the client"),
			]);
			const cursor = yield* readModelVersion;

			// Two messages land while the client is away.
			yield* commit([
				messageCreated(SID, "m1", "assistant"),
				textDelta(SID, "m1", "m1-0", "missed"),
			]);
			yield* commit([
				messageCreated(SID, "m2", "assistant"),
				textDelta(SID, "m2", "m2-0", "also missed"),
			]);
			const version = yield* readModelVersion;

			const { q } = yield* openDetail({
				sessionId: SID,
				resumeFromSequence: cursor,
			});

			// Detail is append-only, so the version alone is enough: no row it
			// serves can have disappeared while the client was away.
			const [first, second] = yield* takeN(q, 2);
			const boundary = yield* Queue.take(q);
			expect(boundary).toEqual({ _tag: "synchronized" });
			expect([expectMessage(first).id, expectMessage(second).id]).toEqual([
				"m1",
				"m2",
			]);
			// Each replayed message carries the version of the commit that wrote
			// it, not the counter the replay happened to read. That is what lets a
			// client recognise a row it already holds as the SAME envelope rather
			// than a new one, so an unrelated commit during the gap cannot make it
			// re-deliver (T-3 suppresses a repeated identity only within one
			// sequence group).
			if (first?._tag !== "upsert" || second?._tag !== "upsert") {
				throw new Error("expected upserts");
			}
			expect(first.sequence).toBeGreaterThan(cursor);
			expect(second.sequence).toBeGreaterThan(first.sequence);
			expect(second.sequence).toBe(version);

			// And live continues from there.
			yield* commit([textDelta(SID, "m2", "m2-0", "!")]);
			expect(textOf(expectMessage(yield* Queue.take(q)))).toBe("also missed!");
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	for (const separateBatches of [false, true]) {
		it.scoped(
			`real client resumes without repeating messages after ${separateBatches ? "multiple projection batches in one commit" : "an unrelated commit"}`,
			() =>
				Effect.gen(function* () {
					yield* recoverProjections;
					yield* commit([sessionCreated(SID)]);
					const context = yield* Effect.context<
						ReadQueryEffectTag | SessionEventBusTag
					>();
					const requests: (number | undefined)[] = [];
					const dropped = yield* Deferred.make<void>();
					const reconnect = yield* Deferred.make<void>();
					const output = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
					const client = resumeStream((resumeFromSequence) => {
						requests.push(resumeFromSequence);
						const source = subscribeSessionDetail({
							sessionId: SID,
							...(resumeFromSequence === undefined
								? {}
								: { resumeFromSequence }),
						}).pipe(Stream.provideContext(context), Stream.orDie);
						if (requests.length === 1) {
							// Lose the transport after snapshot, synchronized, and m1.
							return source.pipe(
								Stream.take(3),
								Stream.concat(
									Stream.fail(
										new RpcClientError({
											reason: "Protocol",
											message: "socket dropped after m1",
										}),
									),
								),
							);
						}
						return Stream.unwrap(
							Effect.gen(function* () {
								yield* Deferred.succeed(dropped, undefined);
								yield* Deferred.await(reconnect);
								return source;
							}),
						);
					});
					yield* Stream.runForEach(client, (envelope) =>
						Queue.offer(output, envelope),
					).pipe(Effect.forkScoped);
					const opening = yield* takeN(output, 2);
					expect(opening.map((envelope) => envelope._tag)).toEqual([
						"snapshot",
						"synchronized",
					]);

					if (separateBatches) {
						const store = yield* EventStoreEffectTag;
						const commitAndSignal = yield* makeCommitAndSignal;
						yield* commitAndSignal.write((project) =>
							Effect.gen(function* () {
								// One COMMIT, two row versions: m1@2 and m2@3.
								yield* project(
									yield* store.appendBatch([
										messageCreated(SID, "m1", "assistant"),
									]),
								);
								yield* project(
									yield* store.appendBatch([
										messageCreated(SID, "m2", "assistant"),
									]),
								);
							}),
						);
					} else {
						yield* commit([
							messageCreated(SID, "m1", "assistant"),
							messageCreated(SID, "m2", "assistant"),
						]);
					}
					yield* Deferred.await(dropped);
					yield* commit([sessionCreated("some-other-session")]);
					yield* Deferred.succeed(reconnect, undefined);
					const delivered: { id: string; sequence: number }[] = [];
					while (true) {
						const envelope = yield* Queue.take(output);
						if (envelope._tag === "synchronized") break;
						if (envelope._tag !== "upsert") throw new Error("expected upsert");
						delivered.push({
							id: expectMessage(envelope).id,
							sequence: envelope.sequence,
						});
					}
					expect(delivered).toEqual([
						{ id: "m1", sequence: 2 },
						{ id: "m2", sequence: separateBatches ? 3 : 2 },
					]);
					expect(requests).toEqual([undefined, 1]);
				}).pipe(
					Effect.provide(
						Layer.merge(
							makePersistenceEffectLayer(
								":memory:",
								undefined,
								SessionEventBusLive,
							),
							SessionEventBusLive,
						),
					),
				),
		);
	}

	it.scoped("never emits a remove envelope across a full turn", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			yield* takeN(q, 2);

			for (const event of [
				textDelta(SID, "m1", "m1-0", "hi"),
				toolStarted(SID, "m1", "tool-1"),
				toolCompleted(SID, "m1", "tool-1"),
				turnCompleted(SID, "m1"),
			]) {
				yield* commit([event]);
				const envelope = yield* Queue.take(q);
				// A remove id is a row id, and an advance speaks in sessions: the
				// session's own disappearance is the shell's to report, not this
				// source's.
				expect(envelope._tag).toBe("upsert");
			}
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("delivers only the subscribed session's messages", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated("session-a"),
				messageCreated("session-a", "a1", "assistant"),
				sessionCreated("session-b"),
				messageCreated("session-b", "b1", "assistant"),
			]);

			const { q } = yield* openDetail({ sessionId: "session-a" });
			yield* takeN(q, 2);

			// Interleave both sessions; only session-a must surface. The advance for
			// session-b does not route here, so it costs not even a query.
			yield* commit([textDelta("session-b", "b1", "b1-0", "other")]);
			yield* commit([textDelta("session-a", "a1", "a1-0", "mine")]);

			const message = expectMessage(yield* Queue.take(q));
			expect(message.id).toBe("a1");
			expect(textOf(message)).toBe("mine");
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("closing the scope tears down the advance subscription", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);

			const scope = yield* Scope.make();
			const q = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
			const fiber = yield* Stream.runForEach(
				subscribeSessionDetail({ sessionId: SID }),
				(env) => Queue.offer(q, env),
			).pipe(Effect.forkIn(scope));

			yield* takeN(q, 2); // running & subscribed
			yield* Scope.close(scope, Exit.void);

			expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"producer fix: a persisted user message is delivered live to detail subscribers",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2); // snapshot(empty) + synchronized

				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistUserMessage(SID, "hello from user");

				const message = expectMessage(yield* Queue.take(q));
				expect(message.role).toBe("user");
				expect(textOf(message)).toBe("hello from user");

				// Lifecycle establishment owns session.created; user persistence adds
				// only message.created(user) and text.delta.
				const sql = yield* SqlClient.SqlClient;
				const counts = yield* sql<{
					event_count: number;
					creation_count: number;
				}>`
					SELECT
						COUNT(*) AS event_count,
						SUM(CASE WHEN type = 'session.created' THEN 1 ELSE 0 END) AS creation_count
					FROM events WHERE session_id = ${SID}`;
				expect(counts[0]).toEqual({ event_count: 3, creation_count: 1 });
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"publish:false persists silently, and the next advance heals it",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2);

				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistUserMessage(SID, "silent", { publish: false });
				// Nothing was announced, so nothing is delivered — and when the next
				// advance does arrive, the re-query picks the silent row up too: the
				// floor is the subscriber's version, not the advance's contents. A
				// dropped signal costs latency, never a lost row.
				yield* commit([
					messageCreated(SID, "m-sentinel", "assistant"),
					textDelta(SID, "m-sentinel", "m-sentinel-0", "SENTINEL"),
				]);

				const [first, second] = yield* takeN(q, 2);
				// Both rows, in transcript order (created_at, then id), from one query.
				expect(
					[textOf(expectMessage(first)), textOf(expectMessage(second))].sort(),
				).toEqual(["SENTINEL", "silent"]);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"a projector failure fails the persist and suppresses the bus signal",
		() =>
			// F2: the persist service is all-or-nothing — a projection failure rolls
			// the batch back, the persist FAILS, and no change signal is published
			// ("a bus signal implies committed projection").
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const bus = yield* SessionEventBusTag;
				const events = yield* bus.subscribe({ sessionId: SID });
				const persist = yield* ClaudeEventPersistEffectTag;

				const result = yield* Effect.either(
					persist.persistEvent(
						canonicalEvent(
							"session.renamed",
							SID,
							{ sessionId: SID, title: "poisoned" },
							{ provider: "claude", createdAt: at() },
						),
					),
				);
				expect(result._tag).toBe("Left");

				// Sentinel: the next successful persist must be the FIRST bus signal —
				// proving the failed persist published nothing.
				yield* persist.persistEvent(messageCreated(SID, "m-ok", "user"));
				const first = Chunk.toReadonlyArray(
					yield* events.pipe(Stream.take(1), Stream.runCollect),
				);
				expect(first[0]?.type).toBe("message.created");
			}).pipe(
				Effect.provide(
					makeDetailTestLayer({
						projectors: [
							...createAllEffectProjectors(),
							{
								name: "failing-renamed-projector",
								handles: ["session.renamed"],
								project: () =>
									Effect.fail(
										new ProjectionError({
											projector: "failing-renamed-projector",
											operation: "project",
											cause: "boom",
										}),
									),
							},
						],
					}),
				),
			),
	);

	it.scoped(
		"an interrupt cannot split the projection commit from its bus signal",
		() =>
			// F3: append → project → publish is one uninterruptible region. An
			// interrupt landing while the signal is in flight defers until the
			// signal is delivered — projected always implies published.
			Effect.gen(function* () {
				const publishStarted = yield* Deferred.make<void>();
				const publishGate = yield* Deferred.make<void>();
				const published = yield* Ref.make<readonly StoredEvent[]>([]);
				const probeBus: SessionEventBus = {
					publish: (events) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(publishStarted, undefined);
							yield* Deferred.await(publishGate);
							yield* Ref.update(published, (all) => [...all, ...events]);
						}),
					publishAdvance: () => Effect.void,
					subscribe: () => Effect.dieMessage("unused in this test"),
					subscribeAdvances: () => Effect.dieMessage("unused in this test"),
				};

				yield* Effect.gen(function* () {
					yield* recoverProjections;
					yield* establishSession(SID);
					const persist = yield* ClaudeEventPersistEffectTag;
					const sql = yield* SqlClient.SqlClient;

					const fiber = yield* Effect.fork(
						persist.persistUserMessage(SID, "hello"),
					);
					yield* Deferred.await(publishStarted);
					// The projection is already committed when publish begins.
					const rows = yield* sql<{ id: string }>`
						SELECT id FROM messages WHERE session_id = ${SID}`;
					expect(rows).toHaveLength(1);

					// Interrupt while the publish is held open at the gate…
					yield* Fiber.interruptFork(fiber);
					yield* Deferred.succeed(publishGate, undefined);
					yield* Fiber.await(fiber);

					// …the signal still lands: projected ⇒ published, never one only.
					const delivered = yield* Ref.get(published);
					expect(delivered.map((e) => e.type)).toEqual([
						"message.created",
						"text.delta",
					]);
				}).pipe(
					Effect.provide(
						makeDetailTestLayer({
							busLayer: Layer.succeed(SessionEventBusTag, probeBus),
						}),
					),
				);
			}),
	);
});
