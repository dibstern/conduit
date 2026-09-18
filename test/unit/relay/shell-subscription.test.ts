import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import {
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect";
import { expect } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingSendOwnershipLive } from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionEventBusLive,
	type SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { deleteSession } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import type { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	type SessionInfo,
	SessionInfoSchema,
} from "../../../src/lib/shared-types.js";
import { makeMockOpenCodeAPI } from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

// ─── Real-stack harness ──────────────────────────────────────────────────────
// A fresh temp-file persistence stack + the real SessionEventBus per test. The
// shell source reads the sessions projection and nothing else, so what is under
// test is a contract WITH the store: the version column the projectors stamp,
// the advance the commit seam publishes post-COMMIT, and the query that turns
// one into the other. Writes go through `commit` — the real seam — because an
// advance that the seam did not publish is a signal the production path would
// never produce.
//
// The same module-singleton bus layer reference is passed to the persistence
// layer AND merged at the top level, so Effect memoization unifies the persist
// path's publisher, the test driver's publisher and the subscription's listener
// onto one PubSub. No clock anywhere: the version column removed the window.

const makeShellTestLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-shell-sub-"));
	const filename = join(dir, "events.db");
	const cleanup = Layer.scopedDiscard(
		Effect.addFinalizer(() =>
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
	return Layer.mergeAll(
		PendingSendOwnershipLive,
		makePersistenceEffectLayer(filename, undefined, SessionEventBusLive),
		SessionEventBusLive,
		Layer.succeed(
			OrchestrationEngineTag,
			withDispatchEffect({ dispatch: async () => undefined }),
		),
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

/** Wrap the real read side, counting session re-queries. */
const countingReadQuery = (
	real: ReadQueryEffect,
	requeries: Ref.Ref<number>,
): ReadQueryEffect => ({
	...real,
	readSessionList: (afterVersion) =>
		Ref.update(requeries, (n) => n + 1).pipe(
			Effect.zipRight(real.readSessionList(afterVersion)),
		),
});

// Drain the subscription into a queue so the test pulls envelopes one at a
// time. `readQuery` lets a test substitute a wrapped read side (re-query
// counting, mid-read commits) while everything else stays real.
const openShell = (options?: {
	readonly resumeFromSequence?: number;
	readonly readQuery?: ReadQueryEffect;
}) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionInfo>>();
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
		"cold start snapshots the list, then upserts the whole current row per advance",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([sessionCreated(SID)]);

				const { q } = yield* openShell();
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				expect(snapshot.rows.map((row) => row.id)).toEqual([SID]);
				expect(snapshot.sequence).toBe(yield* readModelVersion);

				yield* commit([
					sessionRenamed(SID, "Renamed"),
					sessionStatus(SID, "busy"),
				]);

				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				// The re-query returns the CURRENT whole row, so one envelope carries
				// every change the commit made to it.
				expect(delta.item.id).toBe(SID);
				expect(delta.item.title).toBe("Renamed");
				expect(delta.item.status).toBe("busy");
				// The stream carries the single session type (ni8.5 T-1), not the
				// projection row: everything on the item is in the contract and
				// nothing outside it rides along.
				expect(Schema.decodeUnknownSync(SessionInfoSchema)(delta.item)).toEqual(
					delta.item,
				);
				// The sequence is the read-model version, not an event sequence.
				expect(delta.sequence).toBe(yield* readModelVersion);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("two sessions moved by one commit arrive as one upsert each", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated("shell-a"), sessionCreated("shell-b")]);

			const { q } = yield* openShell();
			yield* takeN(q, 2);

			yield* commit([
				sessionRenamed("shell-a", "A1"),
				sessionStatus("shell-b", "busy"),
			]);

			const version = yield* readModelVersion;
			const [first, second] = yield* takeN(q, 2);
			if (first?._tag !== "upsert" || second?._tag !== "upsert") {
				throw new Error("expected two upserts");
			}
			// Recency order out of the query; both stamped by the same commit, so
			// both carry the version that commit moved the read model to.
			expect([first.item.id, second.item.id].sort()).toEqual([
				"shell-a",
				"shell-b",
			]);
			expect(first.sequence).toBe(version);
			expect(second.sequence).toBe(version);
			expect(yield* Queue.size(q)).toBe(0);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("traffic that moves no session row emits nothing", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID), messageCreated(SID, "m1")]);

			const requeries = yield* Ref.make(0);
			const real = yield* ReadQueryEffectTag;
			const { q } = yield* openShell({
				readQuery: countingReadQuery(real, requeries),
			});
			yield* takeN(q, 2);

			// Per-token streaming traffic. It advances the message row it belongs
			// to, so the advance does name this session and the shell does look:
			// one indexed range scan over `sessions` that comes back empty. That is
			// what the event-type allowlist — a second copy of the session
			// projector's event list, free to drift from it — used to buy.
			yield* commit(
				Array.from({ length: 200 }, (_, i) => textDelta(SID, "m1", `t${i}`)),
			);
			// FIFO: anything leaked above would surface ahead of this rename.
			yield* commit([sessionRenamed(SID, "Only This")]);

			const delta = yield* Queue.take(q);
			if (delta._tag !== "upsert") throw new Error("expected upsert");
			expect(delta.item.title).toBe("Only This");
			expect(yield* Queue.size(q)).toBe(0);
			// Base read plus at most one scan per ADVANCE — 200 streamed parts in
			// one commit are one advance, and a re-query that overtakes a later
			// advance spends it, so two reads is also a correct outcome here.
			expect(yield* Ref.get(requeries)).toBeLessThanOrEqual(3);
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

				const delta = yield* Queue.take(q);
				if (delta._tag !== "remove") throw new Error("expected remove");
				expect(delta.id).toBe(SID);
				// A deleted row leaves no version behind (§8), so the removal carries
				// the advance's own version — the number the client resumes from.
				expect(delta.sequence).toBe(yield* readModelVersion);
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
		"deleting a parent emits remove(parent) AND remove(child) at one sequence, live",
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

				// The real service-level delete: the tombstone captures descendant ids
				// BEFORE the schema cascade deletes them, so the advance can name
				// every removed row alongside the parent.
				yield* deleteSession("shell-parent");

				const [first, second] = yield* takeN(q, 2);
				if (first?._tag !== "remove") throw new Error("expected remove first");
				if (second?._tag !== "remove")
					throw new Error("expected remove second");
				expect([first.id, second.id].sort()).toEqual([
					"shell-child",
					"shell-parent",
				]);
				// One commit, one version: the pair is a group the client's resume
				// cursor may only cross whole (T-3).
				expect(second.sequence).toBe(first.sequence);
				expect(yield* Queue.size(q)).toBe(0);
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
		"resume rebases: the reconnecting client is told what still exists, not what moved",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* commit([
					sessionCreated("shell-kept"),
					sessionCreated("shell-doomed"),
				]);
				const cursor = yield* readModelVersion;

				// Both changes land while the client is away: one row moves, one
				// disappears. A version-only catch-up could only report the first —
				// the deleted row leaves nothing behind to find — so the client would
				// reconnect still showing a session that is gone.
				yield* commit([sessionRenamed("shell-kept", "Kept")]);
				yield* deleteSession("shell-doomed");

				const { q } = yield* openShell({ resumeFromSequence: cursor });
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(snapshot.rows.map((row) => row.id)).toEqual(["shell-kept"]);
				expect(snapshot.rows[0]?.title).toBe("Kept");
				expect(snapshot.sequence).toBe(yield* readModelVersion);
				expect(snapshot.sequence).toBeGreaterThan(cursor);
				expect(synchronized).toEqual({ _tag: "synchronized" });

				// And live continues from the number that snapshot carried.
				yield* commit([sessionStatus("shell-kept", "busy")]);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item.status).toBe("busy");
				expect(delta.sequence).toBe(yield* readModelVersion);
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
		"exactly-once across the base read: a commit during the read is not re-delivered",
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
				// A commit lands (and publishes its advance) WHILE the base is being
				// read — after the advance subscription exists, before the rows are
				// taken. The base therefore already carries it, and its buffered
				// advance is at or below the base's version, so the orchestrator
				// drops it rather than re-querying and re-sending the same row.
				const raced = yield* Ref.make(false);
				const racingReadQuery: ReadQueryEffect = {
					...real,
					readSessionList: (afterVersion) =>
						Ref.getAndSet(raced, true).pipe(
							Effect.flatMap((already) =>
								already
									? Effect.void
									: Effect.orDie(
											commit([sessionRenamed(SID, "Raced")]).pipe(
												Effect.provide(services),
											),
										),
							),
							Effect.zipRight(real.readSessionList(afterVersion)),
						),
				};

				const { q } = yield* openShell({ readQuery: racingReadQuery });
				const [snapshot, synchronized] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("expected snapshot");
				expect(synchronized).toEqual({ _tag: "synchronized" });
				expect(snapshot.rows[0]?.title).toBe("Raced");

				// A genuinely new change still flows exactly once. (The racing wrapper
				// commits on every read, so this one arrives ahead of it in FIFO
				// order and a re-delivered "Raced" would have to precede it.)
				yield* commit([sessionRenamed(SID, "Fresh")]);
				const delta = yield* Queue.take(q);
				if (delta._tag !== "upsert") throw new Error("expected upsert");
				expect(delta.item.title).toBe("Fresh");
			}).pipe(Effect.provide(makeShellTestLayer())),
	);

	it.scoped("closing the scope tears down the advance subscription", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* commit([sessionCreated(SID)]);

			const scope = yield* Scope.make();
			const q = yield* Queue.unbounded<Envelope<SessionInfo>>();
			const fiber = yield* Stream.runForEach(subscribeShell(), (env) =>
				Queue.offer(q, env),
			).pipe(Effect.forkIn(scope));

			yield* takeN(q, 2); // running & subscribed
			yield* Scope.close(scope, Exit.void);

			expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
		}).pipe(Effect.provide(makeShellTestLayer())),
	);
});
