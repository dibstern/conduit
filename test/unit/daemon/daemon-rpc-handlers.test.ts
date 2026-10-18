import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Either, Layer, Ref } from "effect";
import { expect, vi } from "vitest";
import { hashPin } from "../../../src/lib/auth.js";
import {
	GetStatus,
	WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { ShutdownSignalTag } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import {
	TailscaleCliTag,
	TailscaleServeError,
} from "../../../src/lib/domain/daemon/Layers/tailscale-serve-layer.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonStateTag } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { AuthManagerTag } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import { getLogLevel } from "../../../src/lib/logger.js";
import { isServerSupervised } from "../../../src/lib/server/build-update.js";
import {
	makeRoutedWsRpcServerLayer,
	wsRpcHandlers,
} from "../../../src/lib/server/ws-rpc.js";
import { getVersion } from "../../../src/lib/version.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

const makeClient = Effect.gen(function* () {
	const handlers = yield* DaemonWsRpcHandlersTag;
	return yield* RpcTest.makeClient(WsRpcGroup).pipe(
		Effect.provide(
			makeRoutedWsRpcServerLayer(
				() => Effect.die("Unexpected project routing"),
				handlers,
			),
		),
	);
});

describe("daemon control through the shared RPC group", () => {
	it.effect(
		"returns live status, cached session counts and optional SSE health",
		() => {
			const sse = {
				connected: true,
				lastEventAt: 1234,
				reconnectCount: 2,
				stale: false,
			};
			const factory = (slug: string) =>
				Effect.succeed({
					slug,
					attach: () => () => {},
					wsHandler: {},
					rpcWsHandler: {},
					syncGlobalSetting: () => Effect.void,
					refreshGlobalDefaults: () => Effect.void,
					getStatusSnapshot: () => ({
						sessionCount: 3,
						clients: 2,
						isProcessing: true,
						sse,
					}),
					stop: () => {},
				});
			return Effect.gen(function* () {
				const cache = yield* RelayCacheTag;
				yield* cache.get("cached");
				const client = yield* makeClient;
				const result = yield* client.GetStatus({});
				expect(result).toMatchObject({
					version: getVersion(),
					logLevel: getLogLevel(),
					supervised: isServerSupervised(),
					port: 0,
					host: "0.0.0.0",
					projectCount: 2,
					sessionCount: 8,
					tlsEnabled: true,
					pinEnabled: true,
					keepAwake: true,
				});
				expect(Object.hasOwn(result, "ok")).toBe(false);
				expect(result.projects).toEqual([
					{
						slug: "cold",
						title: "Cold",
						folders: ["/tmp/cold"],
						status: "registering",
						lastUsed: 2000,
					},
					{
						slug: "cached",
						title: "Cached",
						folders: ["/tmp/cached"],
						status: "registering",
						lastUsed: 1000,
						sse,
					},
				]);
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer(
						[
							{
								slug: "cached",
								title: "Cached",
								folders: ["/tmp/cached"],
								lastUsed: 1000,
							},
							{
								slug: "cold",
								title: "Cold",
								folders: ["/tmp/cold"],
								lastUsed: 2000,
							},
						],
						factory,
						{
							config: {
								host: "0.0.0.0",
								tlsEnabled: true,
								pinHash: "hashed",
								keepAwake: true,
								persistedSessionCounts: new Map([["cold", 5]]),
							},
						},
					),
				),
			);
		},
	);

	it.effect(
		"updates reactive auth and both PIN refs before requesting persistence",
		() => {
			const snapshots: Array<{
				statePin: string | null;
				configPin: string | null;
			}> = [];
			const persistence = Layer.effect(
				ConfigPersistenceTag,
				Effect.gen(function* () {
					const state = yield* DaemonStateTag;
					const config = yield* DaemonConfigRefTag;
					return {
						requestSave: Effect.gen(function* () {
							const statePin = (yield* Ref.get(state)).pinHash;
							const configPin = (yield* Ref.get(config)).pinHash;
							yield* Effect.sync(() => snapshots.push({ statePin, configPin }));
						}),
						flush: Effect.void,
					};
				}),
			);
			const layer = makeDaemonRpcTestLayer([], undefined, { persistence });
			return Effect.gen(function* () {
				const auth = yield* AuthManagerTag;
				const client = yield* makeClient;
				expect(yield* auth.hasPin()).toBe(false);
				expect(yield* client.SetPin({ pin: "1234" })).toEqual({ ok: true });
				expect(yield* auth.hasPin()).toBe(true);
				expect(yield* auth.checkPin("1234")).toBe(true);
				yield* client.SetPin({ pin: null });
				expect(yield* auth.hasPin()).toBe(false);
				expect(snapshots).toEqual([
					{ statePin: hashPin("1234"), configPin: hashPin("1234") },
					{ statePin: null, configPin: null },
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("toggles keep-awake and persists command arguments", () =>
		Effect.gen(function* () {
			const client = yield* makeClient;
			const state = yield* DaemonStateTag;
			const config = yield* DaemonConfigRefTag;
			expect(yield* client.SetKeepAwake({ enabled: true })).toEqual({
				ok: true,
				supported: true,
				active: true,
			});
			expect((yield* Ref.get(state)).keepAwake).toBe(true);
			expect((yield* Ref.get(config)).keepAwake).toBe(true);
			expect(yield* client.SetKeepAwake({ enabled: false })).toEqual({
				ok: true,
				supported: true,
				active: false,
			});
			expect((yield* Ref.get(state)).keepAwake).toBe(false);
			expect((yield* Ref.get(config)).keepAwake).toBe(false);
			yield* client.SetKeepAwakeCommand({
				command: "caffeinate",
				args: ["-di"],
			});
			expect(yield* Ref.get(state)).toMatchObject({
				keepAwakeCommand: "caffeinate",
				keepAwakeArgs: ["-di"],
			});
			expect(yield* Ref.get(config)).toMatchObject({
				keepAwakeCommand: "caffeinate",
				keepAwakeArgs: ["-di"],
			});
			yield* client.SetKeepAwakeCommand({ command: "awake" });
			expect((yield* Ref.get(config)).keepAwakeArgs).toEqual([]);
		}).pipe(Effect.provide(makeDaemonRpcTestLayer())),
	);

	// Failure modes: unavailable CLI, conflicting Serve handler, failed enable or
	// disable, stale URL after disabling, and HTTP/HTTPS proxy mismatch.
	for (const tlsEnabled of [false, true]) {
		it.effect(
			`applies and persists Tailscale Serve with TLS ${tlsEnabled}`,
			() => {
				const calls: string[][] = [];
				let proxy: string | undefined;
				const snapshots: boolean[] = [];
				const tailscaleCli = Layer.succeed(TailscaleCliTag, {
					exec: (args) =>
						Effect.sync(() => {
							calls.push(args);
							if (args[0] === "status")
								return JSON.stringify({
									BackendState: "Running",
									Self: { DNSName: "computer.tailnet.ts.net." },
									CertDomains: ["computer.tailnet.ts.net"],
								});
							if (args[1] === "status")
								return JSON.stringify({
									Web: {
										"computer.tailnet.ts.net:2633": {
											Handlers: proxy ? { "/": { Proxy: proxy } } : {},
										},
									},
								});
							proxy = args.at(-1) === "off" ? undefined : args.at(-1);
							return "";
						}),
				});
				const persistence = Layer.effect(
					ConfigPersistenceTag,
					Effect.gen(function* () {
						const config = yield* DaemonConfigRefTag;
						return {
							requestSave: Ref.get(config).pipe(
								Effect.tap((current) =>
									Effect.sync(() =>
										snapshots.push(current.tailscaleServeEnabled === true),
									),
								),
								Effect.asVoid,
							),
							flush: Effect.void,
						};
					}),
				);
				return Effect.gen(function* () {
					const client = yield* makeClient;
					const config = yield* DaemonConfigRefTag;
					expect(yield* client.GetStatus({})).toMatchObject({
						tailscaleServeEnabled: false,
						tailscaleServeAvailable: true,
					});
					expect(yield* client.SetTailscaleServe({ enabled: true })).toEqual({
						ok: true,
					});
					expect(calls).toContainEqual([
						"serve",
						"--bg",
						"--https=2633",
						"--set-path=/",
						`${tlsEnabled ? "https+insecure" : "http"}://127.0.0.1:2633`,
					]);
					expect(yield* client.GetStatus({})).toMatchObject({
						tailscaleServeEnabled: true,
						tailscaleServe: { url: "https://computer.tailnet.ts.net:2633" },
					});
					expect(yield* client.SetTailscaleServe({ enabled: false })).toEqual({
						ok: true,
					});
					expect(calls).toContainEqual([
						"serve",
						"--https=2633",
						"--set-path=/",
						"off",
					]);
					const disabled = yield* client.GetStatus({});
					expect(disabled.tailscaleServeEnabled).toBe(false);
					expect(disabled.tailscaleServe).toBeUndefined();
					expect((yield* Ref.get(config)).tlsEnabled).toBe(tlsEnabled);
					expect(snapshots).toEqual([true, false]);
				}).pipe(
					Effect.provide(
						makeDaemonRpcTestLayer([], undefined, {
							config: { port: 2633, tlsEnabled },
							tailscaleCli,
							persistence,
						}),
					),
				);
			},
		);
	}

	for (const enabled of [true, false]) {
		it.effect(
			`keeps the previous Tailscale state when setting ${enabled} fails`,
			() => {
				const requestSave = vi.fn(() => {});
				const previous = {
					tailscaleServeEnabled: !enabled,
					...(!enabled && {
						tailscaleServe: { url: "https://computer.tailnet.ts.net:2633" },
					}),
				};
				const tailscaleCli = Layer.succeed(TailscaleCliTag, {
					exec: (args) =>
						args[0] === "status"
							? Effect.succeed(
									JSON.stringify({
										BackendState: "Running",
										Self: { DNSName: "computer.tailnet.ts.net" },
										CertDomains: ["computer.tailnet.ts.net"],
									}),
								)
							: args[1] === "status"
								? Effect.succeed(
										JSON.stringify({
											Web: {
												"computer.tailnet.ts.net:2633": {
													Handlers: enabled
														? {}
														: { "/": { Proxy: "http://127.0.0.1:2633" } },
												},
											},
										}),
									)
								: Effect.fail(
										new TailscaleServeError({ message: "Permission denied" }),
									),
				});
				return Effect.gen(function* () {
					const client = yield* makeClient;
					const config = yield* DaemonConfigRefTag;
					const before = yield* Ref.get(config);
					const result = yield* Effect.either(
						client.SetTailscaleServe({ enabled }),
					);
					expect(Either.isLeft(result)).toBe(true);
					if (Either.isLeft(result))
						expect(result.left).toBeInstanceOf(WsRpcError);
					expect(yield* Ref.get(config)).toEqual(before);
					expect(yield* client.GetStatus({})).toMatchObject(previous);
					expect(requestSave).not.toHaveBeenCalled();
				}).pipe(
					Effect.provide(
						makeDaemonRpcTestLayer([], undefined, {
							config: { port: 2633, ...previous },
							tailscaleCli,
							persistence: Layer.succeed(ConfigPersistenceTag, {
								requestSave: Effect.sync(requestSave),
								flush: Effect.void,
							}),
						}),
					),
				);
			},
		);
	}

	it.effect(
		"reports unavailable Tailscale and rejects enabling without persisting",
		() => {
			const requestSave = vi.fn(() => {});
			return Effect.gen(function* () {
				const client = yield* makeClient;
				expect((yield* client.GetStatus({})).tailscaleServeAvailable).toBe(
					false,
				);
				const result = yield* Effect.either(
					client.SetTailscaleServe({ enabled: true }),
				);
				expect(Either.isLeft(result)).toBe(true);
				expect((yield* client.GetStatus({})).tailscaleServeEnabled).toBe(false);
				expect(requestSave).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], undefined, {
						tailscaleCli: Layer.succeed(TailscaleCliTag, {
							exec: () =>
								Effect.fail(
									new TailscaleServeError({
										message: "Tailscale CLI not found",
									}),
								),
						}),
						persistence: Layer.succeed(ConfigPersistenceTag, {
							requestSave: Effect.sync(requestSave),
							flush: Effect.void,
						}),
					}),
				),
			);
		},
	);

	it.effect("rejects a conflicting Serve root and leaves it untouched", () => {
		const calls: string[][] = [];
		return Effect.gen(function* () {
			const client = yield* makeClient;
			const result = yield* Effect.either(
				client.SetTailscaleServe({ enabled: true }),
			);
			expect(Either.isLeft(result)).toBe(true);
			expect(calls).toEqual([
				["status", "--json"],
				["serve", "status", "--json"],
			]);
			expect(
				(yield* Ref.get(yield* DaemonConfigRefTag)).tailscaleServeEnabled,
			).toBe(false);
		}).pipe(
			Effect.provide(
				makeDaemonRpcTestLayer([], undefined, {
					config: { port: 2633 },
					tailscaleCli: Layer.succeed(TailscaleCliTag, {
						exec: (args) =>
							Effect.sync(() => {
								calls.push(args);
								return JSON.stringify(
									args[0] === "status"
										? {
												BackendState: "Running",
												Self: { DNSName: "computer.tailnet.ts.net" },
												CertDomains: ["computer.tailnet.ts.net"],
											}
										: {
												Web: {
													"computer.tailnet.ts.net:2633": {
														Handlers: {
															"/": { Proxy: "http://127.0.0.1:9000" },
														},
													},
												},
											},
								);
							}),
					}),
				}),
			),
		);
	});

	it.effect(
		"reconciles its HTTPS proxy after a restart changes the local listener to HTTP",
		() => {
			const calls: string[][] = [];
			return Effect.gen(function* () {
				const client = yield* makeClient;
				yield* client.SetTailscaleServe({ enabled: true });
				expect(calls).toContainEqual([
					"serve",
					"--bg",
					"--https=2633",
					"--set-path=/",
					"http://127.0.0.1:2633",
				]);
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], undefined, {
						config: { port: 2633, tailscaleServeEnabled: true },
						tailscaleCli: Layer.succeed(TailscaleCliTag, {
							exec: (args) =>
								Effect.sync(() => {
									calls.push(args);
									return JSON.stringify(
										args[0] === "status"
											? {
													BackendState: "Running",
													Self: { DNSName: "computer.tailnet.ts.net" },
													CertDomains: ["computer.tailnet.ts.net"],
												}
											: {
													Web: {
														"computer.tailnet.ts.net:2633": {
															Handlers: {
																"/": {
																	Proxy: "https+insecure://127.0.0.1:2633",
																},
															},
														},
													},
												},
									);
								}),
						}),
					}),
				),
			);
		},
	);

	it.effect(
		"updates the project default agent through the cached relay",
		() => {
			const setDefaultAgent = vi.fn((_agent: string) => Effect.void);
			return Effect.gen(function* () {
				const client = yield* makeClient;
				expect(
					yield* client.SetAgent({ slug: "project", agent: "build" }),
				).toEqual({ ok: true });
				expect(setDefaultAgent).toHaveBeenCalledWith("build");
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], (slug) =>
						Effect.succeed({
							slug,
							attach: () => () => {},
							wsHandler: {},
							rpcWsHandler: {},
							syncGlobalSetting: () => Effect.void,
							refreshGlobalDefaults: () => Effect.void,
							setDefaultAgent,
							stop: () => {},
						}),
					),
				),
			);
		},
	);

	it.effect(
		"returns typed errors when a relay rejects default agent updates",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				const agent = yield* Effect.either(
					client.SetAgent({ slug: "project", agent: "build" }),
				);
				const rejected = yield* Effect.either(
					client.SetAgent({ slug: "rejected", agent: "build" }),
				);
				expect(Either.isLeft(agent) && agent.left.message).toBe(
					'Relay "project" does not support default agent updates',
				);
				expect(Either.isLeft(rejected) && rejected.left.message).toBe(
					"agent unavailable",
				);
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], (slug) =>
						Effect.succeed({
							slug,
							attach: () => () => {},
							wsHandler: {},
							rpcWsHandler: {},
							syncGlobalSetting: () => Effect.void,
							refreshGlobalDefaults: () => Effect.void,
							...(slug === "rejected"
								? {
										setDefaultAgent: () =>
											Effect.fail(
												new WsRpcError({ message: "agent unavailable" }),
											),
									}
								: {}),
							stop: () => {},
						}),
					),
				),
			),
	);

	for (const command of ["Shutdown", "RestartWithConfig"] as const) {
		it.effect(
			`${command} marks shutdown without completing the shutdown signal`,
			() => {
				const saves = vi.fn();
				const layer = makeDaemonRpcTestLayer([], undefined, {
					persistence: Layer.succeed(ConfigPersistenceTag, {
						requestSave: Effect.sync(() => saves()),
						flush: Effect.void,
					}),
				});
				return Effect.gen(function* () {
					const signal = yield* ShutdownSignalTag;
					const client = yield* makeClient;
					const result =
						command === "Shutdown"
							? yield* client.Shutdown({})
							: yield* client.RestartWithConfig({});
					expect(result).toEqual({ ok: true });
					expect(yield* Deferred.isDone(signal)).toBe(false);
					const state = yield* Ref.get(yield* DaemonStateTag);
					const config = yield* Ref.get(yield* DaemonConfigRefTag);
					expect(state.shuttingDown).toBe(true);
					expect(config.shuttingDown).toBe(true);
					if (command === "RestartWithConfig") {
						expect(state).toMatchObject({
							port: 0,
							tls: false,
							pinHash: null,
							keepAwake: false,
						});
						expect(config).toMatchObject({
							port: 0,
							tlsEnabled: false,
							pinHash: null,
							keepAwake: false,
						});
						expect(saves).toHaveBeenCalledOnce();
					}
				}).pipe(Effect.provide(layer));
			},
		);
	}

	it.effect(
		"lists and inspects instances with stable added IDs and typed missing-instance errors",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				const first = yield* client.AddInstance({
					name: "Work Claude",
					driver: "claude",
					managed: false,
					configDir: "/tmp/profile-work",
				});
				const second = yield* client.AddInstance({
					name: "Work Claude",
					driver: "claude",
					managed: false,
				});
				expect(first.addedInstanceId).toBe("work-claude");
				expect(second.addedInstanceId).toBe("work-claude-2");
				expect((yield* client.GetInstances({})).instances).toHaveLength(2);
				expect(
					yield* client.GetInstanceStatus({ instanceId: "work-claude" }),
				).toMatchObject({
					instance: {
						id: "work-claude",
						driver: "claude",
						configDir: "/tmp/profile-work",
						status: "healthy",
					},
				});
				yield* client.StartInstance({ instanceId: "work-claude" });
				yield* client.StopInstance({ instanceId: "work-claude" });
				yield* client.UpdateInstance({
					instanceId: "work-claude",
					driver: "claude",
					configDir: "/tmp/profile-personal",
				});
				expect(
					(yield* client.GetInstanceStatus({ instanceId: "work-claude" }))
						.instance,
				).toMatchObject({
					status: "healthy",
					configDir: "/tmp/profile-personal",
				});
				const missing = yield* Effect.either(
					client.GetInstanceStatus({ instanceId: "missing" }),
				);
				expect(Either.isLeft(missing) && missing.left).toBeInstanceOf(
					WsRpcError,
				);
				expect(Either.isLeft(missing) && missing.left.message).toBe(
					'Instance "missing" not found',
				);
			}).pipe(Effect.provide(makeDaemonRpcTestLayer())),
	);

	it.effect("returns daemon-required errors from standalone handlers", () =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				wsRpcHandlers.GetStatus(new GetStatus({})),
			);
			expect(Either.isLeft(result) && result.left.message).toBe(
				"GetStatus requires daemon mode",
			);
		}),
	);
});
