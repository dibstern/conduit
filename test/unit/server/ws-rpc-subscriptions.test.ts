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
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import {
	Effect,
	HashMap,
	Layer,
	Queue,
	Ref,
	Schema,
	type Scope,
	Stream,
} from "effect";
import { expect, expectTypeOf } from "vitest";
import {
	type SessionDetailEnvelope,
	SubscribeSessionDetail,
	type WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceLive } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	type DetailLengthMismatch,
	decodeSessionDetail,
} from "../../../src/lib/frontend/transport/session-detail-wire.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
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

// The real choke point: append → project → COMMIT → publish the advance. It
// returns the read-model version the commit moved the counter to, which is the
// number every envelope this commit causes will carry.
const commit = (event: CanonicalEvent) =>
	Effect.gen(function* () {
		const commitAndSignal = yield* makeCommitAndSignal;
		yield* commitAndSignal([event]);
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ value: number }>`
			SELECT value FROM read_model_counter WHERE id = 1`;
		const version = rows[0]?.value;
		if (version === undefined)
			return yield* Effect.die("Expected a read-model counter row");
		return version;
	});

describe("subscription RPC handlers", () => {
	for (const textSuffixes of [undefined, false, true]) {
		it.scoped(`negotiates suffixes only for capability ${textSuffixes}`, () =>
			Effect.gen(function* () {
				yield* (yield* ProjectionRunnerEffectTag).recover();
				yield* commit(
					canonicalEvent(
						"session.created",
						"s",
						{ sessionId: "s", title: "Negotiation", provider: "claude" },
						{ provider: "claude", createdAt: 1 },
					),
				);
				yield* commit(
					canonicalEvent(
						"message.created",
						"s",
						{ sessionId: "s", messageId: "m", role: "assistant" },
						{ provider: "claude", createdAt: 2 },
					),
				);
				yield* commit(
					canonicalEvent(
						"text.delta",
						"s",
						{ messageId: "m", partId: "p", text: "Hello" },
						{ provider: "claude", createdAt: 3 },
					),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const wire = yield* Queue.unbounded<SessionDetailEnvelope>();
				const decoded = yield* Queue.unbounded<SessionDetailEnvelope>();
				const request = Schema.decodeUnknownSync(
					SubscribeSessionDetail.payloadSchema,
				)({
					projectSlug: "project-a",
					sessionId: "s",
					...(textSuffixes === undefined ? {} : { textSuffixes }),
				});
				yield* client.SubscribeSessionDetail(request).pipe(
					Stream.tap((envelope) => Queue.offer(wire, envelope)),
					decodeSessionDetail,
					Stream.runForEach((envelope) => Queue.offer(decoded, envelope)),
					Effect.forkScoped,
				);
				for (const tag of ["snapshot", "synchronized"]) {
					expect((yield* Queue.take(decoded))._tag).toBe(tag);
					expect(yield* Queue.take(wire)).not.toHaveProperty("textSuffixes");
				}
				// An empty delta moves the row version without changing its text.
				for (const text of [" world", ""]) {
					yield* commit(
						canonicalEvent(
							"text.delta",
							"s",
							{ messageId: "m", partId: "p", text },
							{ provider: "claude", createdAt: 4 },
						),
					);
					expect(yield* Queue.take(decoded)).toMatchObject({
						item: {
							message: {
								text: "Hello world",
								parts: [{ text: "Hello world" }],
							},
						},
					});
					const envelope = yield* Queue.take(wire);
					if (textSuffixes === true) {
						expect(envelope).toHaveProperty("textSuffixes");
						expect(envelope).toMatchObject({ item: { message: { text } } });
					} else {
						expect(envelope).not.toHaveProperty("textSuffixes");
						expect(envelope).toMatchObject({
							item: {
								message: {
									text: "Hello world",
									parts: [{ text: "Hello world" }],
								},
							},
						});
					}
				}
			}).pipe(Effect.provide(makeLayer())),
		);
	}
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
				const createdVersion = yield* commit(
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
					(yield* readQuery.readSessionList()).rows.find(
						({ item }) => item.id === "fork-1",
					)?.item,
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
					sequence: createdVersion,
					rows: listed.sessions,
				});
				expect(yield* Queue.take(envelopes)).toEqual({ _tag: "synchronized" });
				const renamedVersion = yield* commit(
					canonicalEvent(
						"session.renamed",
						"fork-1",
						{ sessionId: "fork-1", title: "Renamed fork" },
						{ provider: "opencode", createdAt: 2 },
					),
				);
				const updated = yield* client.ListSessions({
					projectSlug: "project-a",
				});
				expect(yield* Queue.take(envelopes)).toEqual({
					_tag: "upsert",
					sequence: renamedVersion,
					item: updated.sessions[0],
				});
				// The shell rebases on resume rather than catching up: a deleted row
				// leaves no version behind (§8), so the only honest answer to "what
				// did I miss" is the current set.
				const replay = yield* client
					.SubscribeShell({
						projectSlug: "project-a",
						resumeFromSequence: createdVersion,
					})
					.pipe(Stream.take(2), Stream.runCollect);
				expect(Array.from(replay)).toEqual([
					{
						_tag: "snapshot",
						sequence: renamedVersion,
						rows: updated.sessions,
					},
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
					const cursor = yield* commit(
						canonicalEvent(
							"text.delta",
							"session-1",
							{ messageId: "message-1", partId: "part-1", text: "Hello" },
							{ provider: "claude", createdAt: 3 },
						),
					);
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
					const wireSubscriptions: Queue.Queue<SessionDetailEnvelope>[] = [];
					const subscribe = (
						resumeFromSequence?: number,
						wire?: Queue.Queue<SessionDetailEnvelope>,
					): Stream.Stream<unknown, WsRpcError | DetailLengthMismatch> => {
						const request = {
							projectSlug: "project-a",
							sessionId: "session-1",
							...(resumeFromSequence === undefined
								? {}
								: { resumeFromSequence }),
						};
						return member === "SubscribeShell"
							? client.SubscribeShell(request)
							: client
									.SubscribeSessionDetail({ ...request, textSuffixes: true })
									.pipe(
										Stream.tap((envelope) =>
											wire ? Queue.offer(wire, envelope) : Effect.void,
										),
										decodeSessionDetail,
									);
					};
					// Each consumer stays live after its boundary; the 33rd must not wait for a permit.
					for (let i = 0; i < 33; i++) {
						const wire = yield* Queue.unbounded<SessionDetailEnvelope>();
						if (member === "SubscribeSessionDetail")
							wireSubscriptions.push(wire);
						yield* subscribe(undefined, wire).pipe(
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
					// One commit, routed to the subscribers it touches: the shell re-reads
					// the session row the rename moved, detail re-reads the message the
					// part write moved. Each source asks its own `version > lastSeen`.
					const liveVersion = yield* commit(
						member === "SubscribeShell"
							? canonicalEvent(
									"session.renamed",
									"session-1",
									{ sessionId: "session-1", title: "Renamed" },
									{ provider: "claude", createdAt: 4 },
								)
							: canonicalEvent(
									"text.delta",
									"session-1",
									{ messageId: "message-1", partId: "part-1", text: " world" },
									{ provider: "claude", createdAt: 4 },
								),
					);
					const expected = {
						_tag: "upsert",
						sequence: liveVersion,
						item: expect.objectContaining(
							member === "SubscribeShell"
								? { id: "session-1", title: "Renamed" }
								: {
										_tag: "transcriptMessage",
										message: expect.objectContaining({
											id: "message-1",
											text: "Hello world",
											parts: [
												expect.objectContaining({
													id: "part-1",
													text: "Hello world",
												}),
											],
										}),
									},
						),
					};
					for (let i = 0; i < 33; i++)
						expect(yield* Queue.take(envelopes)).toMatchObject(expected);
					// Check each encoder independently, including subscribers 2..33.
					for (const wire of wireSubscriptions) {
						expect(yield* Queue.take(wire)).toMatchObject({
							_tag: "snapshot",
							sequence: cursor,
						});
						expect(yield* Queue.take(wire)).toEqual({ _tag: "synchronized" });
						expect(yield* Queue.take(wire)).toMatchObject({
							_tag: "upsert",
							sequence: liveVersion,
							item: {
								_tag: "transcriptMessage",
								message: {
									id: "message-1",
									text: " world",
									parts: [
										expect.objectContaining({ id: "part-1", text: " world" }),
									],
								},
							},
							textSuffixes: [
								{ from: 5, total: 11 },
								{ partId: "part-1", from: 5, total: 11 },
							],
						});
					}
					const resumed = Array.from(
						yield* subscribe(cursor).pipe(Stream.take(2), Stream.runCollect),
					);
					expect(resumed[1]).toEqual({ _tag: "synchronized" });
					// Detail catches up from the cursor; the shell rebases on it.
					expect(resumed[0]).toMatchObject(
						member === "SubscribeShell"
							? {
									_tag: "snapshot",
									sequence: liveVersion,
									rows: [expect.objectContaining({ title: "Renamed" })],
								}
							: expected,
					);
				}).pipe(Effect.provide(makeLayer())),
			{ timeout: 10000 },
		);
	}
});
