import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import {
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Scope,
	Stream,
	TestClock,
} from "effect";
import { expect } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { deleteSession } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	SHELL_COALESCE_WINDOW,
	subscribeShell,
} from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import { makeMockOpenCodeAPI } from "../../helpers/mock-factories.js";

// ─── Real-stack harness ──────────────────────────────────────────────────────
// A fresh temp-file persistence stack + the real SessionEventBus per test,
// mirroring the detail-subscription suite: the shell source reads the sessions
// projection (snapshot + re-query), the events table (replay), and the bus
// (live), so the contracts under test are contracts WITH the store. The same
// module-singleton bus layer reference is passed to the persistence layer AND
// merged at the top level, so Effect memoization unifies the persist path's
// publisher, the test driver's publisher, and the subscription's live() onto
// one PubSub. All timing is TestClock-driven — no real sleeps anywhere.

const makeShellTestLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-shell-sub-"));
	const filename = join(dir, "events.db");
	const cleanup = Layer.scopedDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		makePersistenceEffectLayer(filename, undefined, SessionEventBusLive),
		SessionEventBusLive,
		cleanup,
	);
};

// Monotonic clock → deterministic recency ordering across the suite.
let clock = 0;
const at = () => ++clock;

const sessionCreated = (
	sessionId: string,
	title = "Shell",
	parentId?: string,
): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title,
			provider: "claude",
			...(parentId === undefined ? {} : { parentId }),
		},
		{ provider: "claude", createdAt: at() },
	);
const sessionRenamed = (sessionId: string, title: string): CanonicalEvent =>
	canonicalEvent(
		"session.renamed",
		sessionId,
		{ sessionId, title },
		{ provider: "claude", createdAt: at() },
	);
const sessionStatus = (
	sessionId: string,
	status: "idle" | "busy",
): CanonicalEvent =>
	canonicalEvent(
		"session.status",
		sessionId,
		{ sessionId, status },
		{ provider: "claude", createdAt: at() },
	);
const messageCreated = (sessionId: string, messageId: string): CanonicalEvent =>
	canonicalEvent(
		"message.created",
		sessionId,
		{ messageId, role: "user", sessionId },
		{ provider: "claude", createdAt: at() },
	);
const textDelta = (
	sessionId: string,
	messageId: string,
	text: string,
): CanonicalEvent =>
	canonicalEvent(
		"text.delta",
		sessionId,
		{ messageId, partId: `${messageId}-0`, text },
		{ provider: "claude", createdAt: at() },
	);
const sessionDeleted = (sessionId: string): CanonicalEvent =>
	canonicalEvent(
		"session.deleted",
		sessionId,
		{ sessionId },
		{ provider: "claude", createdAt: at() },
	);

// Recover projections once so projectBatch is permitted.
const recoverProjections = Effect.gen(function* () {
	const runner = yield* ProjectionRunnerEffectTag;
	yield* runner.recover();
});

// The ingestion choke point, inline: append → project → publish.
const commit = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const bus = yield* SessionEventBusTag;
		const stored = yield* eventStore.appendBatch(events);
		yield* runner.projectBatch(stored);
		yield* bus.publish(stored);
		return stored;
	});

const maxSequence = (stored: readonly StoredEvent[]): number =>
	stored.reduce((max, event) => Math.max(max, event.sequence), 0);

/** Wrap the real read side, counting row re-queries (`getSession` calls). */
const countingReadQuery = (
	real: ReadQueryEffect,
	requeries: Ref.Ref<number>,
): ReadQueryEffect => ({
	...real,
	getSession: (sessionId) =>
		Ref.update(requeries, (n) => n + 1).pipe(
			Effect.zipRight(real.getSession(sessionId)),
		),
});

// Drain the subscription into a queue so the test pulls envelopes one at a
// time. `readQuery` lets a test substitute a wrapped read side (re-query
// counting, mid-snapshot commits) while everything else stays real.
const openShell = (options?: {
	readonly resumeFromSequence?: number;
	readonly readQuery?: ReadQueryEffect;
}) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionRow>>();
		const run = Stream.runForEach(
			subscribeShell(
				options?.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence },
			),
			(env) => Queue.offer(q, env),
		);
		const fiber = yield* (
			options?.readQuery === undefined
				? run
				: run.pipe(Effect.provideService(ReadQueryEffectTag, options.readQuery))
		).pipe(Effect.forkScoped);
		return { q, fiber };
	});

const takeN = <A>(q: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

const SID = "session-shell";

describe("subscribeShell", () => {
	it.scoped(
		"a burst of events for one session within the window collapses to ONE re-query and ONE upsert",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const requeries = yield* Ref.make(0);
				const real = yield* ReadQueryEffectTag;
				const { q } = yield* openShell({
					readQuery: countingReadQuery(real, requeries),
				});
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				expect(snapshot.rows.map((row) => row.id)).toEqual([SID]);

				// Three separate commits (three bus publishes) with NO virtual time
				// between them: all land in the same 50ms coalesce window.
				yield* commit([sessionRenamed(SID, "Renamed")]);
				yield* commit([sessionStatus(SID, "busy")]);
				const last = yield* commit([messageCreated(SID, "m1")]);

				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);

				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				// The single upsert carries the CURRENT whole row (all burst events
				// applied) tagged with the session's max published sequence.
				expect(delta.item.id).toBe(SID);
				expect(delta.item.title).toBe("Renamed");
				expect(delta.item.status).toBe("busy");
				expect(delta.sequence).toBe(maxSequence(last));
				// One re-query for the whole burst, and nothing else queued.
				expect(yield* Ref.get(requeries)).toBe(1);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"two sessions in one window coalesce independently: one upsert each, ascending by sequence",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated("shell-a"), sessionCreated("shell-b")]);

				const { q } = yield* openShell();
				yield* takeN(q, 2);

				// Interleave both sessions inside one window.
				const a1 = yield* commit([sessionRenamed("shell-a", "A1")]);
				yield* commit([sessionStatus("shell-b", "busy")]);
				const a2 = yield* commit([sessionStatus("shell-a", "busy")]);
				const b2 = yield* commit([sessionRenamed("shell-b", "B2")]);
				expect(maxSequence(a1)).toBeGreaterThan(0);

				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);

				const [first, second] = yield* takeN(q, 2);
				if (first?._tag !== "upsert" || second?._tag !== "upsert") {
					throw new Error("expected two upserts");
				}
				// One per session, ascending by each session's max sequence.
				expect(first.item.id).toBe("shell-a");
				expect(first.sequence).toBe(maxSequence(a2));
				expect(second.item.id).toBe("shell-b");
				expect(second.sequence).toBe(maxSequence(b2));
				expect(first.sequence).toBeLessThan(second.sequence);
				expect(first.item.status).toBe("busy");
				expect(second.item.title).toBe("B2");
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"a burst after a window flush starts a new window: two upserts",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);
				const { q } = yield* openShell();
				yield* takeN(q, 2);

				const first = yield* commit([sessionRenamed(SID, "First")]);
				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				const second = yield* commit([sessionRenamed(SID, "Second")]);
				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);

				const [one, two] = yield* takeN(q, 2);
				if (one?._tag !== "upsert" || two?._tag !== "upsert") {
					throw new Error("expected upserts");
				}
				expect(one.item.title).toBe("First");
				expect(two.item.title).toBe("Second");
				expect(one.sequence).toBe(maxSequence(first));
				expect(two.sequence).toBe(maxSequence(second));
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"event types the session projector does not handle trigger no re-query and no delta",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID), messageCreated(SID, "m1")]);

				const requeries = yield* Ref.make(0);
				const real = yield* ReadQueryEffectTag;
				const { q } = yield* openShell({
					readQuery: countingReadQuery(real, requeries),
				});
				yield* takeN(q, 2);

				// Per-token streaming traffic: irrelevant to the sessions projection.
				yield* commit([textDelta(SID, "m1", "streamed tokens")]);
				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				// An idle window (all events filtered) emits nothing either.
				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);

				expect(yield* Queue.size(q)).toBe(0);
				expect(yield* Ref.get(requeries)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"session.deleted through the persist choke point projects the row away and the shell emits remove",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const { q } = yield* openShell();
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows.map((row) => row.id)).toEqual([SID]);

				// The real producer path: append → project (DELETE row) → publish.
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistEvent(sessionDeleted(SID));

				const readQuery = yield* ReadQueryEffectTag;
				expect(yield* readQuery.getSession(SID)).toBeUndefined();

				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "remove") throw new Error("expected remove");
				expect(delta.id).toBe(SID);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"deleteSession appends the session.deleted tombstone: row gone, shell emits remove live",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);
				const { q } = yield* openShell();
				yield* takeN(q, 2);

				// The real service-level delete path (provider delete mocked).
				yield* deleteSession(SID);

				const readQuery = yield* ReadQueryEffectTag;
				expect(yield* readQuery.getSession(SID)).toBeUndefined();

				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "remove") throw new Error("expected remove");
				expect(delta.id).toBe(SID);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"deleting a parent emits remove(parent) AND upsert(child) with parent_id nulled, live",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated("shell-parent"),
					sessionCreated("shell-child", "Child", "shell-parent"),
				]);

				const { q } = yield* openShell();
				yield* takeN(q, 2);

				const readQuery = yield* ReadQueryEffectTag;
				const before = yield* readQuery.getSession("shell-child");
				expect(before?.parent_id).toBe("shell-parent");

				// The real service-level delete: the tombstone captures the child ids
				// BEFORE the projector cascade nulls their parent_id, so the fold can
				// signal each child alongside the parent's remove.
				yield* deleteSession("shell-parent");

				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				expect(yield* Queue.size(q)).toBe(2);
				const [first, second] = yield* takeN(q, 2);
				if (first?._tag !== "remove") throw new Error("expected remove first");
				if (second?._tag !== "upsert")
					throw new Error("expected upsert second");
				expect(first.id).toBe("shell-parent");
				expect(second.item.id).toBe("shell-child");
				expect(second.item.parent_id).toBeNull();
				// Both deltas ride the tombstone's sequence — ascending order holds.
				expect(second.sequence).toBe(first.sequence);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"replaying a stored parent tombstone emits remove(parent) AND upsert(child) with parent_id nulled",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const seed = yield* commit([
					sessionCreated("shell-parent"),
					sessionCreated("shell-child", "Child", "shell-parent"),
				]);
				const cursor = maxSequence(seed);

				// The tombstone lands AFTER the resume cursor; replay folds the STORED
				// payload, so the child ids must have been stamped in at persist time.
				yield* deleteSession("shell-parent");

				const { q } = yield* openShell({ resumeFromSequence: cursor });
				const [first, second] = yield* takeN(q, 2);
				const boundary = yield* Queue.take(q);
				expect(boundary).toEqual({ _tag: "synchronized" });
				if (first?._tag !== "remove") throw new Error("expected remove first");
				if (second?._tag !== "upsert")
					throw new Error("expected upsert second");
				expect(first.id).toBe("shell-parent");
				expect(second.item.id).toBe("shell-child");
				expect(second.item.parent_id).toBeNull();
				expect(second.sequence).toBe(first.sequence);
				expect(first.sequence).toBeGreaterThan(cursor);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeShellTestLayer(),
						Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
						makeSessionManagerStateLive(),
					),
				),
			),
	);

	it.scoped(
		"snapshot returns all rows recency-ordered with an HWM that never over-claims; empty store is ([], 0)",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const readQuery = yield* ReadQueryEffectTag;

				const empty = yield* readQuery.getSessionListSnapshot();
				expect(empty.rows).toEqual([]);
				expect(empty.sequence).toBe(0);

				const stored = yield* commit([
					sessionCreated("shell-old"),
					sessionCreated("shell-new"),
				]);
				const projected = yield* readQuery.getSessionListSnapshot();
				// Recency order: latest updated_at first.
				expect(projected.rows.map((row) => row.id)).toEqual([
					"shell-new",
					"shell-old",
				]);
				expect(projected.sequence).toBe(maxSequence(stored));

				// Appended-but-NOT-projected events must not raise the HWM: claiming
				// them would drop their (post-projection) live signals as duplicates.
				const eventStore = yield* EventStoreEffectTag;
				yield* eventStore.appendBatch([sessionRenamed("shell-old", "stale")]);
				const unprojected = yield* readQuery.getSessionListSnapshot();
				expect(unprojected.sequence).toBe(maxSequence(stored));
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"replay pages past the store's read limit and emits one current-row delta per touched session, ascending; a deleted session yields remove",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const aSeed = yield* commit([sessionCreated("shell-a")]);
				expect(maxSequence(aSeed)).toBeGreaterThan(0);
				// >1000 shell-relevant events for shell-a forces a second replay page.
				const bulk: CanonicalEvent[] = [];
				for (let i = 0; i < 1000; i++) {
					bulk.push(messageCreated("shell-a", `m${i}`));
				}
				const aStored = yield* commit(bulk);
				const bStored = yield* commit([sessionCreated("shell-b")]);
				yield* commit([sessionCreated("shell-c")]);
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistEvent(sessionDeleted("shell-c"));

				const { q } = yield* openShell({ resumeFromSequence: 0 });
				// One delta per touched session — NOT one per replayed event.
				const deltas = yield* takeN(q, 3);
				const boundary = yield* Queue.take(q);
				expect(boundary).toEqual({ _tag: "synchronized" });

				const [a, b, c] = deltas;
				if (a?._tag !== "upsert" || b?._tag !== "upsert") {
					throw new Error("expected upserts for shell-a and shell-b");
				}
				if (c?._tag !== "remove") throw new Error("expected remove");
				expect(a.item.id).toBe("shell-a");
				expect(a.sequence).toBe(maxSequence(aStored));
				expect(b.item.id).toBe("shell-b");
				expect(b.sequence).toBe(maxSequence(bStored));
				expect(c.id).toBe("shell-c");
				// Strictly after the cursor, ascending.
				expect(a.sequence).toBeGreaterThan(0);
				expect(b.sequence).toBeGreaterThan(a.sequence);
				expect(c.sequence).toBeGreaterThan(b.sequence);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped(
		"exactly-once across the snapshot boundary: a burst during the snapshot read is not re-delivered",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const real = yield* ReadQueryEffectTag;
				const services = yield* Effect.context<
					| EventStoreEffectTag
					| ProjectionRunnerEffectTag
					| SessionEventBusTag
					| SqlClient.SqlClient
				>();
				// A burst commits (and publishes) WHILE the snapshot is being read —
				// after live() subscribed, before the base is captured. The snapshot
				// then already reflects it, so its buffered live signal must be
				// dropped by the orchestrator's HWM filter, not re-applied.
				const raceCommit = Effect.orDie(
					commit([sessionRenamed(SID, "Raced")]).pipe(Effect.provide(services)),
				);
				const racingReadQuery: ReadQueryEffect = {
					...real,
					getSessionListSnapshot: () =>
						Effect.zipRight(raceCommit, real.getSessionListSnapshot()),
				};

				const { q } = yield* openShell({ readQuery: racingReadQuery });
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				expect(snapshot.rows[0]?.title).toBe("Raced");

				// The raced signal coalesces to a delta at/below the HWM → dropped.
				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				expect(yield* Queue.size(q)).toBe(0);

				// A genuinely new change still flows exactly once.
				const fresh = yield* commit([sessionRenamed(SID, "Fresh")]);
				yield* TestClock.adjust(SHELL_COALESCE_WINDOW);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item.title).toBe("Fresh");
				expect(delta.sequence).toBe(maxSequence(fresh));
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("closing the scope tears down the live subscription", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID)]);

			const scope = yield* Scope.make();
			const q = yield* Queue.unbounded<Envelope<SessionRow>>();
			const fiber = yield* Stream.runForEach(subscribeShell(), (env) =>
				Queue.offer(q, env),
			).pipe(Effect.forkIn(scope));

			yield* takeN(q, 2); // running & subscribed
			yield* Scope.close(scope, Exit.void);

			// The subscription fiber is interrupted; live()'s scoped bus
			// subscription and the coalescing pipeline are released with it.
			expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);
});
