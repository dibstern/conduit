import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import { subscribeApprovals } from "../../../src/lib/domain/relay/Services/approvals-subscription.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import type { Approval } from "../../../src/lib/shared-types.js";

// The approvals source reads pending_approvals and nothing else, so the seam
// under test is the real store: the approval projector stamps the read-model
// version on the row, the commit seam publishes the advance after COMMIT, and
// the ranged query turns one into upserts and removes. The bus layer is shared
// by the persistence layer and the subscription, as in shell-subscription.test.

const makeLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-approvals-sub-"));
	return Layer.mergeAll(
		makePersistenceEffectLayer(
			join(dir, "events.db"),
			undefined,
			SessionEventBusLive,
		),
		SessionEventBusLive,
		Layer.scopedDiscard(
			Effect.addFinalizer(() =>
				Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			),
		),
	);
};

let clock = 0;
const at = () => ({ provider: "claude", createdAt: ++clock });

const sessionCreated = (sessionId: string, parentId?: string) =>
	canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title: sessionId,
			provider: "claude",
			...(parentId === undefined ? {} : { parentId }),
		},
		at(),
	);
const permissionAsked = (sessionId: string, id: string) =>
	canonicalEvent(
		"permission.asked",
		sessionId,
		{
			id,
			sessionId,
			toolName: "Bash",
			input: { command: "rm -rf build" },
			toolUseId: `toolu_${id}`,
			always: ["rm *"],
			permissionTitle: "Claude wants to run rm",
			permissionReason: "Deletes files",
		},
		at(),
	);
const permissionResolved = (sessionId: string, id: string) =>
	canonicalEvent(
		"permission.resolved",
		sessionId,
		{ id, decision: "once" },
		at(),
	);
// The OpenCode wire shape: `multiple`, not `multiSelect`.
const questionAsked = (sessionId: string, id: string) =>
	canonicalEvent(
		"question.asked",
		sessionId,
		{
			id,
			sessionId,
			questions: [
				{
					question: "Which database?",
					header: "Database",
					options: [{ label: "Postgres", description: "Relational" }],
					multiple: true,
				},
			],
			toolUseId: "call_q",
			providerId: "opencode",
		},
		at(),
	);
const sessionRenamed = (sessionId: string) =>
	canonicalEvent(
		"session.renamed",
		sessionId,
		{ sessionId, title: "renamed" },
		at(),
	);
const sessionDeleted = (sessionId: string) =>
	canonicalEvent("session.deleted", sessionId, { sessionId }, at());

const commit = (events: readonly CanonicalEvent[]) =>
	Effect.flatMap(makeCommitAndSignal, (commitAndSignal) =>
		commitAndSignal(events),
	);

const recoverProjections = Effect.flatMap(ProjectionRunnerEffectTag, (runner) =>
	runner.recover(),
);

const open = Effect.gen(function* () {
	const q = yield* Queue.unbounded<Envelope<Approval>>();
	yield* Stream.runForEach(subscribeApprovals(), (envelope) =>
		Queue.offer(q, envelope),
	).pipe(Effect.forkScoped);
	return q;
});

const take = <A>(q: Queue.Queue<A>, n: number) =>
	Effect.forEach(Array.from({ length: n }), () => Queue.take(q));

describe("subscribeApprovals", () => {
	it.scoped(
		"raise then resolve: snapshot, synchronized, upsert, remove, each version once",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				// Resolved before anyone subscribed: absent from the base.
				yield* commit([
					sessionCreated("s1"),
					permissionAsked("s1", "perm-old"),
				]);
				yield* commit([permissionResolved("s1", "perm-old")]);
				yield* commit([questionAsked("s1", "que-1")]);

				const q = yield* open;
				const [snapshot, synchronized] = (yield* take(q, 2)) as [
					Envelope<Approval>,
					Envelope<Approval>,
				];
				expect(snapshot).toMatchObject({
					_tag: "snapshot",
					rows: [
						{
							_tag: "question",
							toolId: "que-1",
							sessionId: "s1",
							toolUseId: "call_q",
							providerId: "opencode",
							questions: [
								{
									question: "Which database?",
									header: "Database",
									options: [{ label: "Postgres", description: "Relational" }],
									multiSelect: true,
								},
							],
						},
					],
				});
				expect(synchronized).toEqual({ _tag: "synchronized" });

				yield* commit([permissionAsked("s1", "perm-1")]);
				const upsert = yield* Queue.take(q);
				expect(upsert).toEqual({
					_tag: "upsert",
					sequence: expect.any(Number),
					item: {
						_tag: "permission",
						requestId: "perm-1",
						sessionId: "s1",
						toolName: "Bash",
						toolInput: { command: "rm -rf build" },
						toolUseId: "toolu_perm-1",
						always: ["rm *"],
						permissionTitle: "Claude wants to run rm",
						permissionReason: "Deletes files",
					},
				});

				// Moves the session but no approval: nothing to say.
				yield* commit([sessionRenamed("s1")]);
				yield* commit([permissionResolved("s1", "perm-1")]);
				const remove = yield* Queue.take(q);
				expect(remove).toMatchObject({ _tag: "remove", id: "perm-1" });

				const sequences = [snapshot, upsert, remove].map((envelope) =>
					"sequence" in envelope ? envelope.sequence : -1,
				);
				expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
				expect(new Set(sequences).size).toBe(3);
				expect(yield* Queue.size(q)).toBe(0);
			}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped(
		"serves the whole project: a subagent's approval needs no membership",
		() =>
			Effect.gen(function* () {
				yield* recoverProjections;
				const q = yield* open;
				yield* take(q, 2);
				yield* commit([
					sessionCreated("parent"),
					sessionCreated("child", "parent"),
				]);
				yield* commit([permissionAsked("child", "perm-child")]);
				expect(yield* Queue.take(q)).toMatchObject({
					_tag: "upsert",
					item: { requestId: "perm-child", sessionId: "child" },
				});
			}).pipe(Effect.provide(makeLayer())),
	);

	it.scoped("deleting a session removes the approvals it was holding", () =>
		Effect.gen(function* () {
			yield* recoverProjections;
			const q = yield* open;
			yield* take(q, 2);
			yield* commit([
				sessionCreated("doomed"),
				questionAsked("doomed", "que-d"),
			]);
			expect(yield* Queue.take(q)).toMatchObject({
				_tag: "upsert",
				item: { toolId: "que-d" },
			});
			yield* commit([sessionDeleted("doomed")]);
			expect(yield* Queue.take(q)).toMatchObject({
				_tag: "remove",
				id: "que-d",
			});
		}).pipe(Effect.provide(makeLayer())),
	);
});
