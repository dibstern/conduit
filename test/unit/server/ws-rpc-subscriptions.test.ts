import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RpcClient,
	type RpcGroup,
	type RpcMessage,
	RpcServer,
	RpcTest,
} from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import {
	Effect,
	HashMap,
	Layer,
	Queue,
	Ref,
	type Scope,
	Stream,
	TestClock,
} from "effect";
import { expect, expectTypeOf } from "vitest";
import {
	type WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceLive } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

const makeLayer = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-rpc-sub-"));
	const persistence = Layer.mergeAll(
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
	const dependencies = Layer.mergeAll(
		makeTestHandlerLayer(),
		persistence,
		makeSessionManagerStateLive(),
		DaemonEventBusLive,
	);
	return WsRpcServerLayer.pipe(
		Layer.provideMerge(
			Layer.merge(
				dependencies,
				Layer.fresh(SessionManagerServiceLive).pipe(
					Layer.provide(dependencies),
				),
			),
		),
	);
};

const commit = (event: CanonicalEvent) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const bus = yield* SessionEventBusTag;
		const stored = yield* store.appendBatch([event]);
		yield* runner.projectBatch(stored);
		yield* bus.publish(stored);
		const first = stored[0];
		if (!first) return yield* Effect.die("Expected one stored fixture event");
		return first;
	});

describe("subscription RPC handlers", () => {
	it("do not require a caller-owned Scope", () => {
		expectTypeOf<
			Extract<Layer.Layer.Context<typeof WsRpcServerLayer>, Scope.Scope>
		>().toEqualTypeOf<never>();
	});

	it.scoped(
		"shell snapshot, live and replay preserve Ref-only fork lineage from ListSessions",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const created = yield* commit(
					canonicalEvent(
						"session.created",
						"fork-1",
						{ sessionId: "fork-1", title: "Fork", provider: "opencode" },
						{ provider: "opencode", createdAt: 1 },
					),
				);
				const state = yield* SessionManagerStateTag;
				yield* Ref.update(state, (value) => ({
					...value,
					forkMeta: HashMap.make([
						"fork-1",
						{
							parentID: "parent-1",
							forkMessageId: "message-1",
							forkPointTimestamp: 123456,
						},
					]),
				}));
				const readQuery = yield* ReadQueryEffectTag;
				expect(
					yield* readQuery.getSessionListEntry("fork-1"),
				).not.toHaveProperty("forkPointTimestamp");
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const listed = yield* client.ListSessions({ projectSlug: "project-a" });
				expect(listed.sessions).toEqual([
					expect.objectContaining({
						id: "fork-1",
						parentID: "parent-1",
						forkMessageId: "message-1",
						forkPointTimestamp: 123456,
					}),
				]);
				const envelopes = yield* Queue.unbounded<unknown>();
				yield* client.SubscribeShell({ projectSlug: "project-a" }).pipe(
					Stream.runForEach((envelope) => Queue.offer(envelopes, envelope)),
					Effect.forkScoped,
				);
				expect(yield* Queue.take(envelopes)).toEqual({
					_tag: "snapshot",
					sequence: created.sequence,
					rows: listed.sessions,
				});
				expect(yield* Queue.take(envelopes)).toEqual({ _tag: "synchronized" });
				const renamed = yield* commit(
					canonicalEvent(
						"session.renamed",
						"fork-1",
						{ sessionId: "fork-1", title: "Renamed fork" },
						{ provider: "opencode", createdAt: 2 },
					),
				);
				yield* TestClock.adjust("50 millis");
				const updated = yield* client.ListSessions({
					projectSlug: "project-a",
				});
				const expected = {
					_tag: "upsert",
					sequence: renamed.sequence,
					item: updated.sessions[0],
				};
				expect(yield* Queue.take(envelopes)).toEqual(expected);
				const replay = yield* client
					.SubscribeShell({
						projectSlug: "project-a",
						resumeFromSequence: created.sequence,
					})
					.pipe(Stream.take(2), Stream.runCollect);
				expect(Array.from(replay)).toEqual([
					expected,
					{ _tag: "synchronized" },
				]);
			}).pipe(Effect.provide(makeLayer())),
	);

	for (const member of ["SubscribeShell", "SubscribeSessionDetail"] as const) {
		it.scoped(
			`${member} delivers real snapshots, live updates and resume with 33 subscriptions`,
			() =>
				Effect.gen(function* () {
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.recover();
					yield* commit(
						canonicalEvent(
							"session.created",
							"session-1",
							{ sessionId: "session-1", title: "Original", provider: "claude" },
							{ provider: "claude", createdAt: 1 },
						),
					);
					yield* commit(
						canonicalEvent(
							"message.created",
							"session-1",
							{ sessionId: "session-1", messageId: "message-1", role: "user" },
							{ provider: "claude", createdAt: 2 },
						),
					);
					const textEvent = yield* commit(
						canonicalEvent(
							"text.delta",
							"session-1",
							{ messageId: "message-1", partId: "part-1", text: "Hello" },
							{ provider: "claude", createdAt: 3 },
						),
					);
					const cursor = textEvent.sequence;
					const responses =
						yield* Queue.unbounded<
							RpcMessage.FromServer<RpcGroup.Rpcs<typeof WsRpcGroup>>
						>();
					const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
						concurrency: 32,
						onFromServer: (response) =>
							Queue.offer(responses, response).pipe(Effect.asVoid),
					});
					const { client, write } = yield* RpcClient.makeNoSerialization(
						WsRpcGroup,
						{
							supportsAck: true,
							onFromClient: ({ message }) => server.write(0, message),
						},
					);
					yield* Stream.fromQueue(responses).pipe(
						Stream.runForEach(write),
						Effect.forkScoped,
					);
					const envelopes = yield* Queue.unbounded<unknown>();
					const subscribe = (
						resumeFromSequence?: number,
					): Stream.Stream<unknown, WsRpcError> =>
						client[member]({
							projectSlug: "project-a",
							sessionId: "session-1",
							...(resumeFromSequence === undefined
								? {}
								: { resumeFromSequence }),
						});
					// Each consumer stays live after its boundary; the 33rd must not wait for a permit.
					for (let i = 0; i < 33; i++) {
						yield* subscribe().pipe(
							Stream.runForEach((envelope) => Queue.offer(envelopes, envelope)),
							Effect.forkScoped,
						);
						expect(yield* Queue.take(envelopes)).toMatchObject({
							_tag: "snapshot",
							rows: [
								expect.objectContaining(
									member === "SubscribeShell"
										? { id: "session-1", title: "Original" }
										: {
												_tag: "transcriptMessage",
												message: expect.objectContaining({
													id: "message-1",
													text: "Hello",
												}),
											},
								),
							],
						});
						expect(yield* Queue.take(envelopes)).toEqual({
							_tag: "synchronized",
						});
					}
					const renamed = yield* commit(
						canonicalEvent(
							"session.renamed",
							"session-1",
							{ sessionId: "session-1", title: "Renamed" },
							{ provider: "claude", createdAt: 4 },
						),
					);
					yield* TestClock.adjust("50 millis");
					const expected = {
						_tag: "upsert",
						sequence: renamed.sequence,
						item: expect.objectContaining(
							member === "SubscribeShell"
								? { id: "session-1", title: "Renamed" }
								: { _tag: "event", event: renamed },
						),
					};
					for (let i = 0; i < 33; i++)
						expect(yield* Queue.take(envelopes)).toMatchObject(expected);
					const resumed = yield* subscribe(cursor).pipe(
						Stream.take(2),
						Stream.runCollect,
					);
					expect(Array.from(resumed)).toEqual([
						expected,
						{ _tag: "synchronized" },
					]);
				}).pipe(Effect.provide(makeLayer())),
			{ timeout: 10000 },
		);
	}
});
