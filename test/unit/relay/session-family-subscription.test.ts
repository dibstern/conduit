import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { BackgroundLivenessTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeSessionFamily } from "../../../src/lib/domain/relay/Services/session-family-subscription.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";

// The family source reads the sessions projection for one family (a root and
// every descendant), so what is under test is a contract with the store: the
// version the projectors stamp, the advance the commit seam publishes, and the
// query that turns one into the other. Writes go through the real commit seam,
// as shell-subscription.test.ts does.

const makeFamilyTestLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-family-sub-"));
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
		Layer.succeed(BackgroundLivenessTag, () => undefined),
		cleanup,
	);
};

let clock = 0;
const at = () => ++clock;

const created = (sessionId: string, parentId?: string): CanonicalEvent =>
	canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title: sessionId,
			provider: "claude",
			...(parentId === undefined ? {} : { parentId }),
		},
		{ provider: "claude", createdAt: at() },
	);
const renamed = (sessionId: string, title: string): CanonicalEvent =>
	canonicalEvent(
		"session.renamed",
		sessionId,
		{ sessionId, title },
		{ provider: "claude", createdAt: at() },
	);
const deleted = (sessionId: string): CanonicalEvent =>
	canonicalEvent(
		"session.deleted",
		sessionId,
		{ sessionId },
		{ provider: "claude", createdAt: at() },
	);
const modelChanged = (sessionId: string, modelId: string): CanonicalEvent =>
	canonicalEvent(
		"session.model_changed",
		sessionId,
		{ sessionId, modelId, providerId: "anthropic" },
		{ provider: "claude", createdAt: at() },
	);

const recoverProjections = Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
	runner.recover(),
);

const commit = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal(events),
	);

const openFamily = (sessionId: string, resumeFromSequence?: number) =>
	Effect.gen(function* () {
		const q = yield* Queue.unbounded<Envelope<SessionInfo>>();
		yield* Stream.runForEach(
			subscribeSessionFamily({
				sessionId,
				...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
			}),
			(env) => Queue.offer(q, env),
		).pipe(Effect.forkScoped);
		return q;
	});

const takeN = <A>(q: Queue.Queue<A>, n: number): Effect.Effect<A[]> =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

/** Upserts until the queue is momentarily empty, by id. */
const upsertedIds = (envelopes: readonly Envelope<SessionInfo>[]) =>
	envelopes.flatMap((env) => (env._tag === "upsert" ? [env.item.id] : []));

const seedTwoFamilies = commit([
	created("root"),
	created("child", "root"),
	created("grandchild", "child"),
	created("other"),
	created("other-child", "other"),
]);

describe("subscribeSessionFamily", () => {
	it.scoped(
		"serves the whole family of any member, and nothing outside it",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* seedTwoFamilies;
				const q = yield* openFamily("grandchild");
				const [snapshot, synchronized] = yield* takeN(q, 2);
				expect(snapshot?._tag).toBe("snapshot");
				if (snapshot?._tag !== "snapshot") return;
				expect(snapshot.rows.map((row) => row.id).sort()).toEqual([
					"child",
					"grandchild",
					"root",
				]);
				expect(
					snapshot.rows.find((row) => row.id === "grandchild")?.parentID,
				).toBe("child");
				expect(synchronized).toEqual({ _tag: "synchronized" });
			}).pipe(Effect.provide(makeFamilyTestLayer())),
	);

	it.scoped(
		"a new child and a child's model change arrive as versioned upserts; other families stay silent",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* seedTwoFamilies;
				const q = yield* openFamily("child");
				const [snapshot] = yield* takeN(q, 2);
				if (snapshot?._tag !== "snapshot") throw new Error("no snapshot");

				// Another family moving first: if it reached this subscriber, it
				// would be the next envelope instead of the new child.
				yield* commit([renamed("other-child", "Elsewhere")]);
				yield* commit([created("child-2", "root")]);
				const added = yield* Queue.take(q);
				expect(added).toMatchObject({ _tag: "upsert" });
				if (added._tag !== "upsert") return;
				expect(added.sequence).toBeGreaterThan(snapshot.sequence);
				const batch = [added, ...(yield* Queue.takeAll(q))];
				expect(upsertedIds(batch)).toContain("child-2");
				expect(upsertedIds(batch)).not.toContain("other-child");

				// ni8.55: a child's model is a session column, so it rides the
				// row's version bump rather than a push.
				yield* commit([renamed("other", "Still elsewhere")]);
				yield* commit([modelChanged("child", "claude-opus")]);
				const changed = yield* Queue.take(q);
				expect(changed).toMatchObject({
					_tag: "upsert",
					item: {
						id: "child",
						model: { model: "claude-opus", provider: "anthropic" },
					},
				});
			}).pipe(Effect.provide(makeFamilyTestLayer())),
	);

	it.scoped(
		"a member's deletion is a remove; another family's deletion is silent",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* seedTwoFamilies;
				const q = yield* openFamily("root");
				yield* takeN(q, 2);
				yield* commit([deleted("other-child")]);
				yield* commit([deleted("grandchild")]);
				const removed = yield* Queue.take(q);
				expect(removed).toMatchObject({ _tag: "remove", id: "grandchild" });
			}).pipe(Effect.provide(makeFamilyTestLayer())),
	);

	it.scoped(
		"follows the family after the member it was opened on is deleted",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				yield* seedTwoFamilies;
				const q = yield* openFamily("grandchild");
				yield* takeN(q, 2);
				yield* commit([deleted("grandchild")]);
				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "remove",
					id: "grandchild",
				});
				yield* commit([renamed("root", "Renamed root")]);
				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "upsert",
					item: { id: "root", title: "Renamed root" },
				});
			}).pipe(Effect.provide(makeFamilyTestLayer())),
	);

	it.scoped("a resume is a fresh snapshot of the family", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			yield* seedTwoFamilies;
			const q = yield* openFamily("child", 1);
			const [snapshot, synchronized] = yield* takeN(q, 2);
			expect(snapshot?._tag).toBe("snapshot");
			if (snapshot?._tag !== "snapshot") return;
			expect(snapshot.rows.map((row) => row.id).sort()).toEqual([
				"child",
				"grandchild",
				"root",
			]);
			expect(synchronized).toEqual({ _tag: "synchronized" });
		}).pipe(Effect.provide(makeFamilyTestLayer())),
	);
});
