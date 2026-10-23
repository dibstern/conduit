import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { expect, vi } from "vitest";
import type {
	PtyEnvelope,
	ShellProjectsFrame,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	SessionDirectory,
	SessionDirectoryReadError,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { EffectWsHandler } from "../../../src/lib/server/effect-ws-handler.js";
import { EventDelivery } from "../../../src/lib/server/event-audiences.js";
import {
	CurrentEventDelivery,
	deliverEventStream,
	deliverPtyRows,
	deliverSessionRows,
} from "../../../src/lib/server/event-delivery.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

describe("RPC event audiences", () => {
	it.effect.each([false, true])(
		"EA31 startup revocation drops the first chunk even after same-tick re-coverage: %s",
		(restoreCoverage) =>
			Effect.gen(function* () {
				const delivery = new EventDelivery();
				const empty = {
					sessions: new Set<string>(),
					projects: new Set<string>(),
					ptys: new Map<string, ReadonlySet<string>>(),
				};
				const catalogue = delivery.subscription(empty);
				let finalized = false;
				const source = Stream.suspend(() => {
					catalogue.update(empty, true);
					if (restoreCoverage)
						catalogue.update(
							{ ...empty, projects: new Set(["project-a"]) },
							true,
						);
					expect(
						delivery.covers({ _tag: "project", projectId: "project-a" }),
					).toBe(restoreCoverage);
					return Stream.make("first", "queued");
				}).pipe(
					Stream.ensuring(
						Effect.sync(() => {
							finalized = true;
						}),
					),
				);
				const events = yield* deliverEventStream(
					"SubscribeProjectSettings",
					{ projectSlug: "project-a" },
					source,
					{ projectId: "project-a" },
				).pipe(
					Stream.runCollect,
					Effect.provideService(CurrentEventDelivery, delivery),
					Effect.ensuring(Effect.sync(catalogue.release)),
				);
				expect(events).toEqual([]);
				expect(finalized).toBe(true);
			}),
	);
	it.effect(
		"EA32 revoked subscriptions release their Interests listeners",
		() =>
			Effect.gen(function* () {
				const delivery = new EventDelivery();
				const onChange = delivery.onChange.bind(delivery);
				let listening: Deferred.Deferred<void> | undefined;
				let callbacks = 0;
				let finalizations = 0;
				// Observe the public registration callback, without inspecting private listeners.
				vi.spyOn(delivery, "onChange").mockImplementation((listener) => {
					const release = onChange(() => {
						callbacks++;
						listener();
					});
					const registered = listening;
					if (registered !== undefined)
						queueMicrotask(() => Deferred.doneUnsafe(registered, Effect.void));
					return release;
				});
				yield* Effect.scoped(
					Effect.gen(function* () {
						for (let cycle = 0; cycle < 5; cycle++) {
							delivery.setClientSession("tab", "session-a", "project-a");
							listening = yield* Deferred.make<void>();
							const pulling = yield* Deferred.make<void>();
							const stopped = yield* Deferred.make<void>();
							const fiber = yield* deliverEventStream(
								"SubscribeSessionDetail",
								{ sessionId: "session-a" },
								Stream.fromEffect(
									Deferred.succeed(pulling, undefined).pipe(
										Effect.andThen(Effect.never),
									),
								).pipe(
									Stream.ensuring(
										Effect.sync(() => {
											finalizations++;
										}).pipe(
											Effect.andThen(Deferred.succeed(stopped, undefined)),
										),
									),
								),
								{ projectId: "project-a" },
							).pipe(
								Stream.runDrain,
								Effect.provideService(CurrentEventDelivery, delivery),
								Effect.provideService(SessionDirectory, {
									projectOf: () => Effect.succeed(Option.some("project-a")),
								}),
								Effect.forkScoped,
							);
							yield* Deferred.await(listening);
							yield* Deferred.await(pulling);
							// The final idle producer closes with its scope instead of revoking.
							if (cycle === 4) continue;
							delivery.setClientSession("tab", "session-b", "project-b");
							yield* Deferred.await(stopped);
							yield* Fiber.join(fiber);
							const before = callbacks;
							delivery.setClientSession("tab", "session-c", "project-c");
							expect(callbacks).toBe(before);
							expect(delivery.interests.sessions.has("session-a")).toBe(false);
						}
					}),
				);
				expect(finalizations).toBe(5);
				const before = callbacks;
				delivery.setClientSession("tab", "session-d", "project-d");
				expect(callbacks).toBe(before);
			}),
	);
	it.effect(
		"EA30 resumed shell tombstones retain their producer-owned project",
		() =>
			Effect.gen(function* () {
				const projects = {
					_tag: "projects",
					projects: [{ slug: "project-a", title: "A", folders: ["/a"] }],
				} satisfies ShellProjectsFrame;
				const own = {
					_tag: "remove",
					id: "deleted-a",
					sequence: 2,
					deleted: true,
					projectSlug: "project-a",
				} as const;
				const foreign = {
					_tag: "remove",
					id: "deleted-b",
					sequence: 3,
					deleted: true,
					projectSlug: "project-b",
				} as const;
				const result = yield* deliverEventStream(
					"SubscribeShell",
					{},
					deliverSessionRows<{ id: string; projectSlug: string }, never, never>(
						Stream.make(projects, own, foreign),
					),
				).pipe(Stream.runCollect);
				expect(result).toEqual([projects, own]);
			}),
	);
	it.effect(
		"EA29 closed shell catalogues do not strand later subscriptions",
		() =>
			Effect.gen(function* () {
				const delivery = new EventDelivery();
				const projects = {
					_tag: "projects",
					projects: [],
				} satisfies ShellProjectsFrame;
				yield* deliverEventStream(
					"SubscribeShell",
					{},
					deliverSessionRows<{ id: string; projectSlug: string }, never, never>(
						Stream.make(projects),
					),
				).pipe(
					Stream.runDrain,
					Effect.provideService(CurrentEventDelivery, delivery),
				);
				const result = yield* deliverEventStream(
					"SubscribeProjectSettings",
					{ projectSlug: "project-a" },
					Stream.make("settings"),
					{ projectId: "project-a" },
				).pipe(
					Stream.runCollect,
					Effect.provideService(CurrentEventDelivery, delivery),
				);
				expect(result).toEqual(["settings"]);
			}),
	);
	it.effect(
		"EA28 repeating a session selection keeps its subscription open",
		() =>
			Effect.gen(function* () {
				const delivery = new EventDelivery();
				const handler = new EffectWsHandler();
				handler.setClientSession("tab", "session-a", "project-a", delivery);
				const ready = yield* Deferred.make<void>();
				const next = yield* Deferred.make<string>();
				const events: string[] = [];
				const fiber = yield* deliverEventStream(
					"SubscribeSessionDetail",
					{ sessionId: "session-a" },
					Stream.concat(
						Stream.make("first"),
						Stream.fromEffect(Deferred.await(next)),
					),
					{ projectId: "project-a" },
				).pipe(
					Stream.runForEach((event) =>
						Effect.sync(() => {
							events.push(event);
						}).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
					),
					Effect.provideService(CurrentEventDelivery, delivery),
					Effect.provideService(SessionDirectory, {
						projectOf: () => Effect.succeed(Option.some("project-a")),
					}),
					Effect.forkChild,
				);
				yield* Deferred.await(ready);
				yield* Effect.yieldNow;
				handler.setClientSession("tab", "session-a", "project-a", delivery);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(next, "second");
				yield* Fiber.join(fiber);
				expect(events).toEqual(["first", "second"]);
			}),
	);
	it.effect(
		"EA26 PTY detach and reattach within one chunk retain row order",
		() =>
			Effect.gen(function* () {
				const delivery = new EventDelivery();
				const pty = {
					id: "pty-a",
					title: "Shell",
					command: "zsh",
					cwd: "/a",
					status: "running",
					pid: 1,
				} as const;
				const snapshot = {
					_tag: "snapshot",
					rows: [{ pty, scrollback: "" }],
				} satisfies PtyEnvelope;
				const before = {
					_tag: "output",
					ptyId: "pty-a",
					data: "before",
				} satisfies PtyEnvelope;
				const remove = { _tag: "remove", id: "pty-a" } satisfies PtyEnvelope;
				const detached = {
					_tag: "output",
					ptyId: "pty-a",
					data: "detached",
				} satisfies PtyEnvelope;
				const upsert = { _tag: "upsert", item: pty } satisfies PtyEnvelope;
				const after = {
					_tag: "output",
					ptyId: "pty-a",
					data: "after",
				} satisfies PtyEnvelope;
				const chunks: (readonly PtyEnvelope[])[] = [];
				yield* deliverEventStream(
					"SubscribePtys",
					{ projectSlug: "project-a" },
					deliverPtyRows(
						Stream.make(snapshot, before, remove, detached, upsert, after),
						"project-a",
					),
					{ projectId: "project-a" },
				).pipe(
					Stream.runForEachArray((chunk) =>
						Effect.sync(() => {
							chunks.push(chunk);
						}),
					),
					Effect.provideService(CurrentEventDelivery, delivery),
				);
				expect(chunks).toEqual([[snapshot, before, remove, upsert, after]]);
			}),
	);
	it.effect("EA20 delivery preserves a multi-event RPC chunk", () =>
		Effect.gen(function* () {
			const chunks: (readonly number[])[] = [];
			yield* deliverEventStream(
				"SubscribeInstances",
				{},
				Stream.make(1, 2, 3),
			).pipe(
				Stream.runForEachArray((chunk) =>
					Effect.sync(() => {
						chunks.push(chunk);
					}),
				),
			);
			expect(chunks).toEqual([[1, 2, 3]]);
		}),
	);
	it.effect("EA21 standalone producer rejects another requested project", () =>
		Effect.gen(function* () {
			for (const method of [
				"SubscribeProjectSettings",
				"SubscribePtys",
				"SubscribeAlerts",
			] as const) {
				let opened = false;
				const result = yield* deliverEventStream(
					method,
					{ projectSlug: "project-b" },
					Stream.fromEffect(
						Effect.sync(() => {
							opened = true;
							return "secret from a";
						}),
					),
				).pipe(
					Stream.runCollect,
					Effect.result,
					Effect.provideService(
						ConfigTag,
						makeMockConfig({ slug: "project-a" }),
					),
				);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "WsRpcError", code: "project-mismatch" },
				});
				expect(opened).toBe(false);
			}
		}),
	);
	it.effect("EA22 ownership lookup failure fails subscription opening", () =>
		Effect.gen(function* () {
			let reads = 0;
			let opened = false;
			const result = yield* deliverEventStream(
				"SubscribeInputDraft",
				{ key: { session: "session-a" } },
				Stream.fromEffect(
					Effect.sync(() => {
						opened = true;
						return "draft";
					}),
				),
			).pipe(
				Stream.runCollect,
				Effect.result,
				Effect.provideService(SessionDirectory, {
					projectOf: (sessionId) =>
						++reads === 1
							? Effect.fail(
									new SessionDirectoryReadError({
										sessionId,
										cause: "unavailable",
									}),
								)
							: Effect.succeed(Option.some("project-a")),
				}),
			);
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "WsRpcError", code: "ownership-lookup-failed" },
			});
			expect(opened).toBe(false);
		}),
	);
	it.effect.each([true, false])(
		"EA24 session switch interrupts a producer mid-chunk, selected before subscribe: %s",
		(selectedFirst) =>
			Effect.gen(function* () {
				const delivery = new EventDelivery();
				if (selectedFirst)
					delivery.setClientSession("tab", "session-a", "project-a");
				const pulling = yield* Deferred.make<void>();
				const stopped = yield* Deferred.make<void>();
				const events: string[] = [];
				const source = Stream.make("first", "queued").pipe(
					Stream.mapEffect(() =>
						Deferred.succeed(pulling, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					),
					Stream.ensuring(Deferred.succeed(stopped, undefined)),
				);
				const fiber = yield* deliverEventStream(
					"SubscribeSessionDetail",
					{ sessionId: "session-a" },
					source,
					{ projectId: "project-a" },
				).pipe(
					Stream.runForEach((event: string) =>
						Effect.sync(() => {
							events.push(event);
						}),
					),
					Effect.provideService(CurrentEventDelivery, delivery),
					Effect.provideService(SessionDirectory, {
						projectOf: () => Effect.succeed(Option.some("project-a")),
					}),
					Effect.forkChild,
				);
				yield* Deferred.await(pulling);
				if (!selectedFirst)
					delivery.setClientSession("tab", "session-a", "project-a");
				delivery.setClientSession("tab", "session-b", "project-b");
				yield* Deferred.await(stopped);
				yield* Fiber.await(fiber);
				expect(events).toEqual([]);
				expect(delivery.interests.sessions.has("session-a")).toBe(false);
			}),
	);
	it.effect(
		"EA18 family delivery survives deletion of the requested member",
		() =>
			Effect.gen(function* () {
				const { deliverEventStream } = yield* Effect.promise(
					() => import("../../../src/lib/server/event-delivery.js"),
				);
				const snapshot = {
					_tag: "snapshot",
					rows: [{ id: "root", projectSlug: "project-a" }],
					sequence: 0,
				} satisfies Envelope<{ id: string; projectSlug: string }>;
				const removal = { _tag: "remove", id: "child", sequence: 1 } as const;
				const later = {
					_tag: "upsert",
					item: { id: "root", projectSlug: "project-a" },
					sequence: 2,
				} satisfies Envelope<{ id: string; projectSlug: string }>;
				let deleted = false;
				const source = Stream.concat(
					Stream.make(snapshot),
					Stream.fromEffect(
						Effect.sync(() => {
							deleted = true;
							return removal;
						}),
					),
				).pipe(Stream.concat(Stream.make(later)));
				const received = yield* deliverEventStream(
					"SubscribeSessionFamily",
					{ sessionId: "child" },
					deliverSessionRows(source, "project-a"),
					{ projectId: "project-a" },
				).pipe(
					Stream.runCollect,
					Effect.provideService(SessionDirectory, {
						projectOf: () =>
							Effect.sync(() =>
								deleted ? Option.none() : Option.some("project-a"),
							),
					}),
				);
				expect(received).toEqual([snapshot, removal, later]);
			}),
	);
	it.effect("EA16 shell upserts cannot bypass row provenance", () =>
		Effect.gen(function* () {
			const { deliverEventStream } = yield* Effect.promise(
				() => import("../../../src/lib/server/event-delivery.js"),
			);
			const projects = {
				_tag: "projects",
				projects: [{ slug: "project-a", title: "A", folders: ["/a"] }],
			} satisfies ShellProjectsFrame;
			const own = {
				_tag: "upsert",
				item: { id: "a", projectSlug: "project-a" },
				sequence: 1,
			} satisfies Envelope<{ id: string; projectSlug: string }>;
			const foreign = {
				_tag: "upsert",
				item: { id: "b", projectSlug: "project-b" },
				sequence: 2,
			} satisfies Envelope<{ id: string; projectSlug: string }>;
			const unknown = {
				_tag: "upsert",
				item: { id: "unknown" },
				sequence: 3,
			} satisfies Envelope<{ id: string; projectSlug?: string }>;
			expect(
				yield* deliverEventStream(
					"SubscribeShell",
					{},
					deliverSessionRows<
						{ id: string; projectSlug?: string },
						never,
						never
					>(Stream.make(projects, own, foreign, unknown)),
				).pipe(Stream.runCollect),
			).toEqual([projects, own]);
		}),
	);

	it.effect("EA17 daemon input drafts restore without a relay context", () =>
		Effect.gen(function* () {
			const { deliverEventStream } = yield* Effect.promise(
				() => import("../../../src/lib/server/event-delivery.js"),
			);
			const frame = { _tag: "snapshot", text: "restored draft" };
			for (const key of [{ draft: "unsent" }, { session: "session-a" }]) {
				expect(
					yield* deliverEventStream(
						"SubscribeInputDraft",
						{ key },
						Stream.make(frame),
					).pipe(
						Stream.runCollect,
						Effect.provideService(SessionDirectory, {
							projectOf: () => Effect.succeed(Option.some("project-a")),
						}),
					),
				).toEqual([frame]);
			}
		}),
	);
	it.effect(
		"EA11 PTY inventory attaches output only for its subscription lifetime",
		() =>
			Effect.gen(function* () {
				const { deliverEventStream, CurrentEventDelivery } =
					yield* Effect.promise(
						() => import("../../../src/lib/server/event-delivery.js"),
					);
				const { EventDelivery } = yield* Effect.promise(
					() => import("../../../src/lib/server/event-audiences.js"),
				);
				const delivery = new EventDelivery();
				const snapshot = {
					_tag: "snapshot",
					rows: [
						{
							pty: {
								id: "pty-a",
								title: "Shell",
								command: "zsh",
								cwd: "/a",
								status: "running",
								pid: 1,
							},
							scrollback: "before",
						},
					],
				} satisfies PtyEnvelope;
				const output = {
					_tag: "output",
					ptyId: "pty-a",
					data: "after",
				} satisfies PtyEnvelope;
				const foreign = {
					_tag: "output",
					ptyId: "unattached",
					data: "secret",
				} satisfies PtyEnvelope;
				expect(
					yield* deliverEventStream(
						"SubscribePtys",
						{ projectSlug: "project-a" },
						deliverPtyRows(Stream.make(snapshot, output, foreign), "project-a"),
						{ projectId: "project-a" },
					).pipe(
						Stream.runCollect,
						Effect.provideService(CurrentEventDelivery, delivery),
					),
				).toEqual([snapshot, output]);
				expect(delivery.interests.ptys.size).toBe(0);
			}),
	);

	it.effect("EA02 a shell snapshot cannot smuggle a foreign project row", () =>
		Effect.gen(function* () {
			const { deliverEventStream } = yield* Effect.promise(
				() => import("../../../src/lib/server/event-delivery.js"),
			);
			const projects = {
				_tag: "projects",
				projects: [{ slug: "project-a", title: "A", folders: ["/a"] }],
			} satisfies ShellProjectsFrame;
			const snapshot = {
				_tag: "snapshot",
				rows: [
					{ id: "a", projectSlug: "project-a" },
					{ id: "b", projectSlug: "project-b" },
				],
				sequence: 0,
			} satisfies Envelope<{ id: string; projectSlug: string }>;
			expect(
				yield* deliverEventStream(
					"SubscribeShell",
					{},
					deliverSessionRows(Stream.make(projects, snapshot)),
				).pipe(Stream.runCollect),
			).toEqual([projects, { ...snapshot, rows: [snapshot.rows[0]] }]);
		}),
	);
	it.effect(
		"EA14 direct and routed subscription events use the same policy",
		() =>
			Effect.gen(function* () {
				const { deliverEventStream, CurrentEventDelivery } =
					yield* Effect.promise(
						() => import("../../../src/lib/server/event-delivery.js"),
					);
				const { EventDelivery } = yield* Effect.promise(
					() => import("../../../src/lib/server/event-audiences.js"),
				);
				const delivery = new EventDelivery();
				for (const projectId of ["project-a", "project-b"]) {
					const result = yield* deliverEventStream(
						"SubscribeSessionDetail",
						{ sessionId: "session-a" },
						Stream.make("snapshot", "delta"),
						{ projectId },
					).pipe(
						Stream.runCollect,
						Effect.result,
						Effect.provideService(CurrentEventDelivery, delivery),
						Effect.provideService(SessionDirectory, {
							projectOf: () => Effect.succeed(Option.some("project-a")),
						}),
					);
					expect(result).toEqual(
						projectId === "project-a"
							? expect.objectContaining({
									_tag: "Success",
									success: ["snapshot", "delta"],
								})
							: expect.objectContaining({
									_tag: "Failure",
									failure: expect.objectContaining({
										_tag: "WsRpcError",
										code: "project-mismatch",
									}),
								}),
					);
					expect(delivery.interests.sessions.size).toBe(0);
				}
			}),
	);

	it.effect("EA05 subscription ownership is resolved once at open", () =>
		Effect.gen(function* () {
			const { deliverEventStream, CurrentEventDelivery } =
				yield* Effect.promise(
					() => import("../../../src/lib/server/event-delivery.js"),
				);
			const { EventDelivery } = yield* Effect.promise(
				() => import("../../../src/lib/server/event-audiences.js"),
			);
			const delivery = new EventDelivery();
			let owner = "project-a";
			let lookups = 0;
			const result = yield* deliverEventStream(
				"SubscribeSessionDetail",
				{ sessionId: "session-a" },
				Stream.concat(
					Stream.make("first"),
					Stream.fromEffect(
						Effect.sync(() => {
							owner = "project-b";
							return "stale";
						}),
					),
				),
				{ projectId: "project-a" },
			).pipe(
				Stream.runCollect,
				Effect.provideService(CurrentEventDelivery, delivery),
				Effect.provideService(SessionDirectory, {
					projectOf: () =>
						Effect.sync(() => {
							lookups++;
							return Option.some(owner);
						}),
				}),
			);
			expect(result).toEqual(["first", "stale"]);
			expect(lookups).toBe(1);
			expect(delivery.interests.projects.size).toBe(0);
		}),
	);

	it.effect(
		"EA07 cancellation during provenance resolution drops the pending event",
		() =>
			Effect.gen(function* () {
				const { deliverEventStream, CurrentEventDelivery } =
					yield* Effect.promise(
						() => import("../../../src/lib/server/event-delivery.js"),
					);
				const { EventDelivery } = yield* Effect.promise(
					() => import("../../../src/lib/server/event-audiences.js"),
				);
				const delivery = new EventDelivery();
				const resolving = yield* Deferred.make<void>();
				const events: string[] = [];
				const fiber = yield* deliverEventStream(
					"SubscribeSessionDetail",
					{ sessionId: "session-a" },
					Stream.make("queued"),
					{ projectId: "project-a" },
				).pipe(
					Stream.runForEach((value) =>
						Effect.sync(() => {
							events.push(value);
						}),
					),
					Effect.provideService(CurrentEventDelivery, delivery),
					Effect.provideService(SessionDirectory, {
						projectOf: () =>
							Deferred.succeed(resolving, undefined).pipe(
								Effect.andThen(Effect.never),
							),
					}),
					Effect.forkChild,
				);
				yield* Deferred.await(resolving);
				yield* Fiber.interrupt(fiber);
				expect(events).toEqual([]);
				expect(delivery.interests.sessions.size).toBe(0);
			}),
	);

	it.effect("EA03 approval frames stay global without session provenance", () =>
		Effect.gen(function* () {
			const { deliverEventStream } = yield* Effect.promise(
				() => import("../../../src/lib/server/event-delivery.js"),
			);
			expect(
				yield* deliverEventStream(
					"SubscribeApprovals",
					{ projectSlug: "project-a" },
					Stream.make({ _tag: "permission", sessionId: "unknown" }),
				).pipe(Stream.runCollect),
			).toEqual([{ _tag: "permission", sessionId: "unknown" }]);
		}),
	);
});
