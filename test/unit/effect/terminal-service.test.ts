import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, TestClock } from "effect";
import { expect, vi } from "vitest";
import type { PtyEvent } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	ConfigTag,
	type ConnectPtyUpstreamShape,
	ConnectPtyUpstreamTag,
	LoggerTag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	type LocalPtyService,
	LocalPtyServiceTag,
	type LocalPtySession,
	OpenCodeTerminalServiceLive,
	OpenCodeTerminalServiceTag,
	TerminalServiceError,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	PtyManager,
	type PtyUpstream,
} from "../../../src/lib/relay/pty-manager.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { partialFake } from "../../helpers/partial-fake.js";

const openState = 1;
const closedState = 3;

const makeUpstream = (
	readyState = openState,
): PtyUpstream & {
	readonly send: ReturnType<typeof vi.fn>;
	readonly close: ReturnType<typeof vi.fn>;
	readonly terminate: ReturnType<typeof vi.fn>;
} => ({
	readyState,
	send: vi.fn(),
	close: vi.fn(),
	terminate: vi.fn(),
});

const makeApi = (overrides?: Partial<OpenCodeAPI["pty"]>): OpenCodeAPI =>
	partialFake<OpenCodeAPI>({
		pty: partialFake<OpenCodeAPI["pty"]>({
			create: vi.fn(async () => ({
				id: "pty-1",
				title: "Shell",
				command: "zsh",
				cwd: "/project",
				status: "running",
				pid: 123,
			})),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => undefined),
			resize: vi.fn(async () => undefined),
			...overrides,
		}),
	});

/** Everything the terminal service publishes to SubscribePtys. */
const published = (ptyManager: PtyManager): PtyEvent[] => {
	const events: PtyEvent[] = [];
	ptyManager.subscribe((event) => events.push(event));
	return events;
};

const makeLayer = (options?: {
	readonly api?: OpenCodeAPI;
	readonly instances?: OpenCodeInstances;
	readonly ptyManager?: PtyManager;
	readonly connectPtyUpstream?: ConnectPtyUpstreamShape;
	readonly localPty?: LocalPtyService;
	readonly wsHandler?: ReturnType<typeof makeMockWebSocketHandler>;
	readonly log?: ReturnType<typeof makeMockLogger>;
}) => {
	const api = options?.api ?? makeApi();
	const ptyManager =
		options?.ptyManager ?? new PtyManager({ log: makeMockLogger() });
	const connectPtyUpstream =
		options?.connectPtyUpstream ?? vi.fn(() => Effect.void);
	const localPty =
		options?.localPty ??
		({
			list: () => Effect.succeed([]),
			attach: (ptyId: string) =>
				Effect.fail(
					new TerminalServiceError({
						operation: "connect",
						ptyId,
						cause: "Not found",
					}),
				),
			create: vi.fn(() => {
				const session: LocalPtySession = {
					pty: {
						id: "local-pty-1",
						title: "Terminal",
						command: "zsh",
						cwd: "/project",
						status: "running",
						pid: 456,
					},
					upstream: makeUpstream(openState),
					onData: vi.fn(),
					onExit: vi.fn(),
				};
				return Effect.succeed(session);
			}),
		} satisfies LocalPtyService);
	const wsHandler = options?.wsHandler ?? makeMockWebSocketHandler();
	const log = options?.log ?? makeMockLogger();

	return OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(
					OpenCodeInstancesTag,
					options?.instances ?? makeOpenCodeInstancesStub({ opencode: api }),
				),
				Layer.succeed(PtyManagerTag, ptyManager),
				Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
				Layer.succeed(LocalPtyServiceTag, localPty),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/project" })),
				Layer.succeed(LoggerTag, log),
			),
		),
	);
};

describe("OpenCodeTerminalServiceLive", () => {
	it.effect(
		"holds one reconcile lease through restoration, discovery and attachment",
		() => {
			let holds = 0;
			let acquisitions = 0;
			const phases: number[] = [];
			const api = makeApi({
				list: vi.fn(async () => {
					phases.push(holds);
					return [{ id: "external", status: "running" }];
				}),
			});
			const instances = {
				...makeOpenCodeInstancesStub({ opencode: api }),
				useIfRunning: () =>
					Effect.acquireRelease(
						Effect.sync(() => {
							holds++;
							acquisitions++;
							return Option.some(api);
						}),
						() =>
							Effect.sync(() => {
								holds--;
							}),
					),
			};
			const localPty = partialFake<LocalPtyService>({
				list: () =>
					Effect.sync(() => {
						phases.push(holds);
						return [];
					}),
			});
			const connectPtyUpstream = () =>
				Effect.sync(() => {
					phases.push(holds);
				});
			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.list();
				expect(phases).toEqual([1, 1, 1]);
				expect(acquisitions).toBe(1);
				expect(holds).toBe(0);
			}).pipe(
				Effect.provide(
					makeLayer({ api, instances, localPty, connectPtyUpstream }),
				),
			);
		},
	);

	it.effect(
		"a cancelled list cannot register a PTY after a later empty reconcile",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const attaching = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const registered = yield* Deferred.make<void>();
					const ptyManager = new PtyManager({ log: makeMockLogger() });
					let present = true;
					const api = makeApi({
						list: vi.fn(async () =>
							present ? [{ id: "external", status: "running" }] : [],
						),
					});
					const connectPtyUpstream: ConnectPtyUpstreamShape = (id) =>
						Effect.gen(function* () {
							const ready = yield* Deferred.make<void>();
							yield* Effect.gen(function* () {
								yield* Deferred.succeed(attaching, undefined);
								yield* Deferred.await(release);
								ptyManager.registerSession(id, makeUpstream(), "opencode");
								yield* Deferred.succeed(registered, undefined);
								yield* Deferred.succeed(ready, undefined);
							}).pipe(Effect.forkIn(scope));
							yield* Deferred.await(ready);
						});
					yield* Effect.gen(function* () {
						const service = yield* OpenCodeTerminalServiceTag;
						const first = yield* Effect.fork(service.list());
						yield* Deferred.await(attaching);
						yield* Fiber.interrupt(first);
						present = false;
						const second = yield* Effect.fork(service.list());
						yield* TestClock.adjust("0 millis");
						yield* Deferred.succeed(release, undefined);
						yield* Deferred.await(registered);
						yield* Fiber.join(second);
						expect(ptyManager.hasSession("external")).toBe(false);
					}).pipe(
						Effect.provide(makeLayer({ api, ptyManager, connectPtyUpstream })),
					);
				}),
			),
	);

	it.effect("retries failed discovery without another lifecycle signal", () => {
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		let attempts = 0;
		const list = vi.fn(async () => {
			if (++attempts === 1) throw new Error("temporarily unavailable");
			return [{ id: "recovered", status: "exited" }];
		});
		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			expect(yield* service.list()).toEqual([]);
			yield* TestClock.adjust("999 millis");
			expect(list).toHaveBeenCalledTimes(1);
			yield* TestClock.adjust("1 millis");
			expect(list).toHaveBeenCalledTimes(2);
			expect(ptyManager.hasSession("recovered")).toBe(true);
		}).pipe(Effect.provide(makeLayer({ api: makeApi({ list }), ptyManager })));
	});

	it.effect("stops retrying failed discovery until the next signal", () => {
		const list = vi.fn(async () => {
			throw new Error("unavailable");
		});
		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.list();
			yield* TestClock.adjust("10 minutes");
			const capped = list.mock.calls.length;
			expect(capped).toBe(6);
			service.onOpenCodePtysChanged("opencode");
			yield* TestClock.adjust("1 millis");
			expect(list).toHaveBeenCalledTimes(capped + 1);
		}).pipe(Effect.provide(makeLayer({ api: makeApi({ list }) })));
	});

	it.effect(
		"restores hosted local terminals on subscribe while OpenCode is stopped",
		() => {
			const api = makeApi();
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const hosted: LocalPtySession = {
				pty: {
					id: "hosted",
					title: "Shell",
					command: "sh",
					cwd: "/project",
					status: "running",
					pid: 1,
				},
				upstream: makeUpstream(),
				onData: vi.fn(),
				onExit: vi.fn(),
			};
			const localPty = partialFake<LocalPtyService>({
				list: vi.fn(() => Effect.succeed([hosted.pty])),
				attach: () => Effect.succeed(hosted),
			});
			const instances = {
				...makeOpenCodeInstancesStub({ opencode: api }),
				ifRunning: () => Effect.succeed(Option.none()),
				useIfRunning: () => Effect.succeed(Option.none()),
			};
			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				service.onOpenCodePtysChanged("opencode");
				yield* TestClock.adjust("0 millis");
				expect(localPty.list).not.toHaveBeenCalled();
				expect(yield* service.list()).toEqual([hosted.pty]);
				expect(ptyManager.getSession(hosted.pty.id)?.source).toBe("local");
				expect(api.pty.list).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(makeLayer({ api, instances, ptyManager, localPty })),
			);
		},
	);

	it.effect(
		"a failed provider delete preserves the cached PTY for reconciliation",
		() => {
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const upstream = makeUpstream();
			const row = ptyManager.registerSession("external", upstream, "opencode");
			const api = makeApi({
				delete: vi.fn(async () => {
					throw new Error("delete unavailable");
				}),
			});
			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* Effect.flip(service.close("external"));
				expect(ptyManager.getSession("external")).toBe(row);
				expect(upstream.close).not.toHaveBeenCalled();
			}).pipe(Effect.provide(makeLayer({ api, ptyManager })));
		},
	);

	it.effect(
		"backs off, releases demand between attempts and pauses while stopped",
		() => {
			let running = true;
			let holds = 0;
			const list = vi.fn(async () => {
				throw new Error("temporarily unavailable");
			});
			const api = makeApi({ list });
			const instances = {
				...makeOpenCodeInstancesStub({ opencode: api }),
				useIfRunning: () =>
					running
						? Effect.acquireRelease(
								Effect.sync(() => {
									holds++;
									return Option.some(api);
								}),
								() =>
									Effect.sync(() => {
										holds--;
									}),
							)
						: Effect.succeed(Option.none()),
			};
			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.list();
				let reads = 1;
				for (const delay of [1000, 2000, 4000]) {
					expect(holds).toBe(0);
					yield* TestClock.adjust(`${delay - 1} millis`);
					expect(list).toHaveBeenCalledTimes(reads);
					yield* TestClock.adjust("1 millis");
					expect(list).toHaveBeenCalledTimes(++reads);
				}
				running = false;
				yield* TestClock.adjust("8 seconds");
				running = true;
				yield* TestClock.adjust("60 seconds");
				expect(list).toHaveBeenCalledTimes(reads);
				yield* service.list();
				expect(list).toHaveBeenCalledTimes(reads + 1);
			}).pipe(Effect.provide(makeLayer({ api, instances })));
		},
	);

	it.effect("creates a local terminal without requiring OpenCode PTY", () => {
		const dataHandlers: Array<(data: string) => void> = [];
		const exitHandlers: Array<(exitCode: number) => void> = [];
		const upstream = { ...makeUpstream(openState), resize: vi.fn() };
		const localPty: LocalPtyService = {
			list: () => Effect.succeed([]),
			attach: (ptyId) =>
				Effect.fail(
					new TerminalServiceError({
						operation: "connect",
						ptyId,
						cause: "Not found",
					}),
				),
			create: vi.fn(() => {
				const session: LocalPtySession = {
					pty: {
						id: "local-pty-1",
						title: "Terminal",
						command: "zsh",
						cwd: "/project",
						status: "running",
						pid: 456,
					},
					upstream,
					onData: (handler: (data: string) => void) => {
						dataHandlers.push(handler);
					},
					onExit: (handler: (exitCode: number) => void) => {
						exitHandlers.push(handler);
					},
				};
				return Effect.succeed(session);
			}),
		};
		const api = makeApi({
			create: vi.fn(async () => {
				throw new Error("fetch failed");
			}),
		});
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		const events = published(ptyManager);
		const layer = makeLayer({ api, ptyManager, localPty });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.create("client-1");
			yield* service.sendInput("local-pty-1", "echo hi\n");

			expect(api.pty.create).not.toHaveBeenCalled();
			expect(ptyManager.hasSession("local-pty-1")).toBe(true);
			expect(upstream.send).toHaveBeenCalledWith("echo hi\n");
			dataHandlers[0]?.("hello\n");
			expect(events).toEqual([
				{
					_tag: "upsert",
					item: {
						id: "local-pty-1",
						title: "Terminal",
						command: "zsh",
						cwd: "/project",
						status: "running",
						pid: 456,
					},
				},
				{ _tag: "output", ptyId: "local-pty-1", data: "hello\n" },
			]);

			yield* service.resize("client-1", "local-pty-1", 40, 120);
			expect(upstream.resize).toHaveBeenCalledWith(120, 40);

			yield* service.close("local-pty-1");
			expect(upstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
			expect(api.pty.delete).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"does not connect an OpenCode upstream when creating a terminal",
		() => {
			const events: string[] = [];
			const wsHandler = makeMockWebSocketHandler();
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			ptyManager.subscribe((event) => events.push(`publish:${event._tag}`));
			const connectPtyUpstream = vi.fn(() =>
				Effect.sync(() => {
					events.push("connect");
				}),
			);
			const api = makeApi();
			const layer = makeLayer({
				api,
				wsHandler,
				ptyManager,
				connectPtyUpstream,
			});

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.create("client-1");

				expect(events).toEqual(["publish:upsert"]);
				expect(api.pty.create).not.toHaveBeenCalled();
				expect(connectPtyUpstream).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"fails typed without publishing when local terminal creation fails",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const events = published(ptyManager);
			const localPty: LocalPtyService = {
				list: () => Effect.succeed([]),
				attach: (ptyId) =>
					Effect.fail(
						new TerminalServiceError({
							operation: "connect",
							ptyId,
							cause: "Not found",
						}),
					),
				create: vi.fn(() =>
					Effect.fail(
						new TerminalServiceError({
							operation: "create",
							cause: new Error("spawn failed"),
						}),
					),
				),
			};
			const layer = makeLayer({ wsHandler, localPty, ptyManager });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				const error = yield* Effect.flip(service.create("client-1"));

				expect(error).toMatchObject({ operation: "create" });
				expect(events).toEqual([]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"lists PTYs and reconnects missing running upstreams with cursor -1",
		() => {
			const connectPtyUpstream = vi.fn(() => Effect.void);
			const api = makeApi({
				list: vi.fn(async () => [
					{ id: "pty-1", status: "running" },
					{ id: "pty-2", status: "exited" },
				]),
			});
			const layer = makeLayer({ api, connectPtyUpstream });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				const ptys = yield* service.list();

				expect(ptys).toEqual([
					{
						id: "pty-1",
						title: "Terminal",
						command: "bash",
						cwd: "/project",
						status: "running",
						pid: 0,
					},
					{
						id: "pty-2",
						title: "Terminal",
						command: "bash",
						cwd: "/project",
						status: "exited",
						pid: 0,
					},
				]);

				expect(connectPtyUpstream).toHaveBeenCalledWith("pty-1", -1);
				expect(connectPtyUpstream).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"sends input only to open tracked upstreams, failing otherwise",
		() => {
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const open = makeUpstream(openState);
			const closed = makeUpstream(closedState);
			ptyManager.registerSession("pty-open", open);
			ptyManager.registerSession("pty-closed", closed);
			const layer = makeLayer({ ptyManager });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.sendInput("pty-open", "ls\n");
				const closedError = yield* Effect.flip(
					service.sendInput("pty-closed", "pwd\n"),
				);
				const missingError = yield* Effect.flip(
					service.sendInput("pty-missing", "whoami\n"),
				);

				expect(open.send).toHaveBeenCalledWith("ls\n");
				expect(closed.send).not.toHaveBeenCalled();
				expect(closedError).toMatchObject({
					operation: "input",
					ptyId: "pty-closed",
				});
				expect(missingError).toMatchObject({
					operation: "input",
					ptyId: "pty-missing",
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"closes the local upstream, deletes provider PTY, and publishes removal",
		() => {
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const upstream = makeUpstream(openState);
			ptyManager.registerSession("pty-1", upstream);
			const api = makeApi();
			const events = published(ptyManager);
			const layer = makeLayer({ api, ptyManager });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.close("pty-1");

				expect(upstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
				expect(api.pty.delete).toHaveBeenCalledWith("pty-1");
				expect(events).toEqual([{ _tag: "remove", id: "pty-1" }]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("closes a hosted terminal before the relay discovers it", () => {
		const upstream = makeUpstream(openState);
		const hosted: LocalPtySession = {
			pty: {
				id: "local-pty-undiscovered",
				title: "Terminal",
				command: "sh",
				cwd: "/project",
				status: "running",
				pid: 456,
			},
			upstream,
			onData: vi.fn(),
			onExit: vi.fn(),
		};
		const localPty: LocalPtyService = {
			list: vi.fn(() => Effect.succeed([hosted.pty])),
			attach: vi.fn(() => Effect.succeed(hosted)),
			create: vi.fn(() => Effect.succeed(hosted)),
		};
		const api = makeApi();
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		const layer = makeLayer({ localPty, api, ptyManager });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			expect(ptyManager.sessionCount).toBe(0);
			yield* service.close(hosted.pty.id);
			expect(localPty.list).toHaveBeenCalledWith("/project");
			expect(localPty.attach).toHaveBeenCalledWith(hosted.pty.id, "/project");
			expect(upstream.close).toHaveBeenCalledWith(1000, "Terminal closed");
			expect(api.pty.delete).not.toHaveBeenCalled();
			expect(ptyManager.sessionCount).toBe(0);
		}).pipe(Effect.provide(layer));
	});

	it.effect("serializes close after a suspended local terminal reattach", () =>
		Effect.gen(function* () {
			const attachStarted = yield* Deferred.make<void>();
			const releaseAttach = yield* Deferred.make<void>();
			const closeStarted = yield* Deferred.make<void>();
			const events: Array<"attached" | "closed" | "deleted" | "listed"> = [];
			const disconnectHandlers: Array<() => void> = [];
			const oldUpstream = makeUpstream(openState);
			const restoredUpstream = makeUpstream(openState);
			restoredUpstream.close.mockImplementation(() => events.push("closed"));
			const initial: LocalPtySession = {
				pty: {
					id: "local-pty-1",
					title: "Terminal",
					command: "sh",
					cwd: "/project",
					status: "running",
					pid: 456,
				},
				upstream: oldUpstream,
				onData: vi.fn(),
				onExit: vi.fn(),
				onDisconnect: (handler) => disconnectHandlers.push(handler),
			};
			const restored: LocalPtySession = {
				...initial,
				upstream: restoredUpstream,
				onData: (handler) => {
					events.push("attached");
					handler("replayed\n");
				},
			};
			const localPty: LocalPtyService = {
				create: () => Effect.succeed(initial),
				list: () => Effect.succeed([initial.pty]),
				attach: () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(attachStarted, undefined);
						yield* Deferred.await(releaseAttach);
						return restored;
					}),
			};
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			ptyManager.subscribe((event) => {
				if (event._tag === "remove") events.push("deleted");
				if (event._tag === "upsert" && event.item.id === initial.pty.id)
					events.push("listed");
			});
			const layer = makeLayer({ localPty, ptyManager });

			yield* Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.create("client-1");
				oldUpstream.readyState = 0;
				disconnectHandlers[0]?.();
				const listing = yield* Effect.fork(service.list());
				yield* Deferred.await(attachStarted);
				const closing = yield* Effect.fork(
					Effect.gen(function* () {
						yield* Deferred.succeed(closeStarted, undefined);
						yield* service.close(initial.pty.id);
					}),
				);
				yield* Deferred.await(closeStarted);
				yield* Effect.yieldNow();
				const closedBeforeAttach = Option.isSome(yield* Fiber.poll(closing));
				yield* Deferred.succeed(releaseAttach, undefined);
				yield* Fiber.join(listing);
				yield* Fiber.join(closing);

				expect(closedBeforeAttach).toBe(false);
				expect(ptyManager.hasSession(initial.pty.id)).toBe(false);
				expect(restoredUpstream.close).toHaveBeenCalledExactlyOnceWith(
					1000,
					"Proxy closed",
				);
				const deletion = events.indexOf("deleted");
				expect(deletion).toBeGreaterThan(events.indexOf("attached"));
				expect(events.slice(deletion + 1)).not.toContain("listed");
			}).pipe(Effect.provide(layer));
		}),
	);

	it.effect(
		"snapshots tracked PTY sessions, scrollback, and exit state",
		() => {
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			ptyManager.registerSession("pty-running", makeUpstream(openState));
			ptyManager.appendScrollback("pty-running", "hello\n");
			ptyManager.registerSession("pty-exited", makeUpstream(closedState));
			ptyManager.appendScrollback("pty-exited", "done\n");
			ptyManager.markExited("pty-exited", 7);
			const layer = makeLayer({ ptyManager });
			const info = (id: string, status: "running" | "exited") => ({
				id,
				title: "Terminal",
				command: "bash",
				cwd: "/project",
				status,
				pid: 0,
			});

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				expect(service.snapshot()).toEqual([
					{ pty: info("pty-running", "running"), scrollback: "hello\n" },
					{ pty: info("pty-exited", "exited"), scrollback: "done\n" },
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("snapshots nothing when no PTYs are tracked", () =>
		Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			expect(service.snapshot()).toEqual([]);
		}).pipe(Effect.provide(makeLayer())),
	);
});
