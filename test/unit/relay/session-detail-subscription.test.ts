import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	type EventStoreEffect,
	EventStoreEffectTag,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";

// ─── Real-stack harness ──────────────────────────────────────────────────────
// A fresh in-memory-equivalent (temp-file) persistence stack + the real
// SessionEventBus per test. The detail subscription reads the projected
// transcript (snapshot), the events table (replay), and the bus (live) — so the
// contracts under test are contracts WITH the store; fakes would prove nothing.
// SessionEventBusLive is passed to makePersistenceEffectLayer AND merged at the
// top level: the same module-singleton layer reference, so Effect memoization
// unifies ClaudeEventPersist's publisher, the driver's publisher, and the
// subscription's live() onto one PubSub.

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

// The ingestion choke point, inline: append → project → publish. A real store,
// real message projector, real bus — the faithful production write path.
const commit = (
	events: readonly CanonicalEvent[],
): Effect.Effect<
	readonly StoredEvent[],
	unknown,
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| SessionEventBusTag
	| SqlClient.SqlClient
> =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const bus = yield* SessionEventBusTag;
		const stored = yield* eventStore.appendBatch(events);
		yield* runner.projectBatch(stored);
		yield* bus.publish(stored);
		return stored;
	});

// Drain the subscription into a queue so the test pulls envelopes one at a time.
// The FIRST pulled envelope (snapshot or first replay delta) proves live() is
// already subscribed — the orchestrator acquires live before reading the base —
// so a delta committed AFTER that pull is guaranteed delivered, no sleeps.
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

const expectEventDelta = (
	envelope: Envelope<SessionDetailItem>,
): StoredEvent => {
	if (envelope._tag !== "upsert" || envelope.item._tag !== "event") {
		throw new Error(
			`expected an event upsert, got ${JSON.stringify(envelope)}`,
		);
	}
	return envelope.item.event;
};

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
			const stored = yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
				textDelta(SID, "m1", "m1-0", "Hello"),
				textDelta(SID, "m1", "m1-0", " world"),
				turnCompleted(SID, "m1"),
			]);
			const lastDelta = stored[3]; // second text.delta bumps the watermark
			if (!lastDelta) throw new Error("fixture");

			const { q } = yield* openDetail({ sessionId: SID });
			const [snapshot, synchronized] = yield* takeN(q, 2);

			if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
			expect(synchronized).toEqual({ _tag: "synchronized" });
			// HWM is the last APPLIED delta's sequence (turn.completed does not bump).
			expect(snapshot.sequence).toBe(lastDelta.sequence);
			expect(snapshot.rows).toHaveLength(1);
			const [row] = snapshot.rows;
			if (row?._tag !== "transcriptMessage")
				throw new Error("expected message");
			expect(row.message.id).toBe("m1");
			expect(row.message.role).toBe("assistant");
			expect(row.message["text"]).toBe("Hello world");
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"delivers live ingested events raw, strictly ascending, with no gaps vs the events table",
		() =>
			// F4: driven through the REAL ProviderRuntimeIngestion service — its own
			// translate → append → project → publish pipeline (spec acceptance #9).
			Effect.gen(function* () {
				yield* recoverProjections;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const eventStore = yield* EventStoreEffectTag;

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
				const preCount = (yield* eventStore.readBySession(SID, 0)).length;

				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2); // snapshot + synchronized ⇒ live is subscribed

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

				// The events table is the reference: everything ingestion durably
				// appended for this session after the snapshot must arrive, in order.
				const all = yield* eventStore.readBySession(SID, 0);
				const stored = all.slice(preCount);
				expect(stored.length).toBeGreaterThanOrEqual(3);

				const deltas = (yield* takeN(q, stored.length)).map(expectEventDelta);
				// Raw passthrough: each delta IS the stored event, byte-for-byte.
				expect(deltas).toEqual(stored);
				// Strictly ascending, contiguous with the store's assigned sequences.
				for (let i = 1; i < deltas.length; i++) {
					const prev = deltas[i - 1];
					const cur = deltas[i];
					if (!prev || !cur) throw new Error("fixture");
					expect(cur.sequence).toBeGreaterThan(prev.sequence);
				}
			}).pipe(Effect.provide(makeDetailIngestionTestLayer())),
	);

	it.scoped(
		"exactly-once across the snapshot boundary: base text + live deltas = final text",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				// Subscribe mid-turn: "Hello" is already in the transcript.
				const base = yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
				]);
				const hwm = base[2]?.sequence;
				if (hwm === undefined) throw new Error("fixture");

				const { q } = yield* openDetail({ sessionId: SID });
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				const [snapRow] = snapshot.rows;
				if (snapRow?._tag !== "transcriptMessage") throw new Error("row");
				const baseText = String(snapRow.message["text"] ?? "");
				expect(baseText).toBe("Hello");

				const live = yield* commit([textDelta(SID, "m1", "m1-0", " world")]);
				const deltas = (yield* takeN(q, live.length)).map(expectEventDelta);

				// No append-type delta at or below the HWM is redelivered (no double).
				for (const delta of deltas) {
					expect(delta.sequence).toBeGreaterThan(hwm);
				}
				// Fold equality: snapshot base + streamed deltas == final text.
				const streamed = deltas
					.filter((e) => e.type === "text.delta")
					.map((e) => (e.type === "text.delta" ? e.data.text : ""))
					.join("");
				expect(baseText + streamed).toBe("Hello world");
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"snapshot HWM is the applied-delta watermark, not MAX(events.sequence)",
		() =>
			// This is the crux of the design: a bare message.created (a set-type
			// event with a HIGHER sequence but no applied delta) must NOT raise the
			// HWM, or a live text.delta would be dropped as a false duplicate.
			Effect.gen(function* () {
				yield* recoverProjections;
				const stored = yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "content"),
					messageCreated(SID, "m2", "assistant"), // higher seq, no delta
				]);
				const appliedDelta = stored[2];
				const trailingCreate = stored[3];
				if (!appliedDelta || !trailingCreate) throw new Error("fixture");

				const readQuery = yield* ReadQueryEffectTag;
				const snapshot = yield* readQuery.getSessionDetailSnapshot(SID);
				expect(snapshot.sequence).toBe(appliedDelta.sequence);
				expect(snapshot.sequence).toBeLessThan(trailingCreate.sequence);
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"resume replays every event past the cursor, paging beyond 1000",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const deltas: CanonicalEvent[] = [];
				for (let i = 0; i < 1000; i++) {
					deltas.push(textDelta(SID, "m1", "m1-0", "x"));
				}
				const stored = yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					...deltas,
				]);
				expect(stored.length).toBeGreaterThan(1000); // forces a second page

				const { q } = yield* openDetail({
					sessionId: SID,
					resumeFromSequence: 0,
				});
				// No snapshot envelope on resume: all events, then synchronized.
				const replayed = (yield* takeN(q, stored.length)).map(expectEventDelta);
				expect(replayed.map((e) => e.sequence)).toEqual(
					stored.map((e) => e.sequence),
				);
				const boundary = yield* Queue.take(q);
				expect(boundary).toEqual({ _tag: "synchronized" });
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("never emits a remove envelope across a full turn", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([
				sessionCreated(SID),
				messageCreated(SID, "m1", "assistant"),
			]);
			const { q } = yield* openDetail({ sessionId: SID });
			yield* takeN(q, 2);
			const stored = yield* commit([
				textDelta(SID, "m1", "m1-0", "hi"),
				toolStarted(SID, "m1", "tool-1"),
				toolCompleted(SID, "m1", "tool-1"),
				turnCompleted(SID, "m1"),
			]);
			const envelopes = yield* takeN(q, stored.length);
			for (const env of envelopes) {
				expect(env._tag).not.toBe("remove");
			}
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("delivers only the subscribed session's events", () =>
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

			// Interleave both sessions; only session-a must surface.
			yield* commit([textDelta("session-b", "b1", "b1-0", "other")]);
			const wanted = yield* commit([
				textDelta("session-a", "a1", "a1-0", "mine"),
			]);

			const delta = expectEventDelta(yield* Queue.take(q));
			expect(delta.sessionId).toBe("session-a");
			expect(delta.eventId).toBe(wanted[0]?.eventId);
			// Nothing else queued for session-a.
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped("closing the scope tears down the live subscription", () =>
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

			// The subscription fiber is interrupted; live()'s scoped bus
			// subscription is released by the same Scope finalizer.
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

				// Lifecycle establishment owns session.created. User persistence emits
				// only message.created(user) and text.delta.
				const delivered = (yield* takeN(q, 2)).map(expectEventDelta);
				expect(delivered.map((e) => e.type)).toEqual([
					"message.created",
					"text.delta",
				]);
				const created = delivered[0];
				const delta = delivered[1];
				if (
					created?.type !== "message.created" ||
					delta?.type !== "text.delta"
				) {
					throw new Error("fixture");
				}
				expect(created.data.role).toBe("user");
				expect(delta.data.text).toBe("hello from user");
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
		"producer fix: publish:false persists without signalling live subscribers",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* establishSession(SID);
				const { q } = yield* openDetail({ sessionId: SID });
				yield* takeN(q, 2);

				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistUserMessage(SID, "silent", { publish: false });
				// A sentinel published normally must be the FIRST live delta — proving
				// the gated user-message events never reached the bus.
				const sentinel = yield* commit([
					textDelta(SID, "m-sentinel", "m-sentinel-0", "SENTINEL"),
				]);

				const first = expectEventDelta(yield* Queue.take(q));
				expect(first.eventId).toBe(sentinel[0]?.eventId);
				expect(first.type).toBe("text.delta");
			}).pipe(Effect.provide(makeDetailTestLayer())),
	);

	it.scoped(
		"replay pages until an empty read, so an event committed during the drain is replayed, not lost",
		() =>
			// F1 hardening: a commit landing while replay drains its final short page
			// may have had its bus signal dropped by the sliding buffer. Continuing
			// until an EMPTY read picks it up from the durable store instead.
			Effect.gen(function* () {
				yield* recoverProjections;
				const stored = yield* commit([
					sessionCreated(SID),
					messageCreated(SID, "m1", "assistant"),
					textDelta(SID, "m1", "m1-0", "Hello"),
				]);

				const real = yield* EventStoreEffectTag;
				const reads = yield* Ref.make(0);
				const late = textDelta(SID, "m1", "m1-0", " late");
				const lateStored = yield* Ref.make<StoredEvent | undefined>(undefined);
				// First replay read returns a SHORT page; while it drains, a late
				// event is committed whose bus signal is "lost" (never published).
				const wrapped: EventStoreEffect = {
					...real,
					readBySession: (sessionId, fromSequence, limit) =>
						Effect.gen(function* () {
							const call = yield* Ref.updateAndGet(reads, (n) => n + 1);
							const rows = yield* real.readBySession(
								sessionId,
								fromSequence,
								limit,
							);
							if (call === 1) {
								const appended = yield* real.appendBatch([late]);
								yield* Ref.set(lateStored, appended[0]);
							}
							return rows;
						}),
				};

				const q = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
				yield* Stream.runForEach(
					subscribeSessionDetail({ sessionId: SID, resumeFromSequence: 0 }),
					(env) => Queue.offer(q, env),
				).pipe(
					Effect.provideService(EventStoreEffectTag, wrapped),
					Effect.forkScoped,
				);

				const envelopes = yield* takeN(q, stored.length + 2);
				const deltas = envelopes
					.slice(0, stored.length + 1)
					.map(expectEventDelta);
				const lateEvent = yield* Ref.get(lateStored);
				expect(deltas.map((e) => e.eventId)).toEqual([
					...stored.map((e) => e.eventId),
					lateEvent?.eventId,
				]);
				// The late event arrived via REPLAY: before synchronized.
				expect(envelopes[stored.length + 1]).toEqual({
					_tag: "synchronized",
				});
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
					subscribe: () => Effect.dieMessage("unused in this test"),
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
