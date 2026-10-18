import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { afterEach, expect, vi } from "vitest";
import {
	UpdateMessageSurfacing,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { makeMessageSurfacingSettings } from "../../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import {
	makeRoutedWsRpcServerLayer,
	RpcCaller,
} from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

// Failure modes: secret leakage, insecure inbound/outbound transport, bad keys,
// network failures, partial/concurrent patches, restart after 401, stale 401s,
// env precedence, credential removal, file permissions, and disabling mid-call.
// Received 401s must survive cancellation during body cleanup or while a failed
// replacement holds the lock, and must remain invalid after restarting.
// Key ownership must remain visible after rejection/restart so environment keys
// stay read-only, while stored keys remain editable and missing keys have no owner.
// Turns open must survive restart and partial patches. Pre-minimise snapshots
// must default to Auto without dropping their existing preferences or key.
// Split flags must survive restart and independent patches. Legacy snapshots
// retain the effective summary state, including missing/rejected keys and Off.
const directories: string[] = [];
const directory = () => {
	const dir = mkdtempSync("/tmp/message-surfacing-");
	directories.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const validTransport = () =>
	vi.fn(async () => new Response("{}", { status: 200 }));

describe("message surfacing settings", () => {
	it.effect("persists summaries independently of Jev and its key", () =>
		Effect.gen(function* () {
			const dir = directory();
			const transport = validTransport();
			const settings = yield* makeMessageSurfacingSettings(dir, {
				env: {},
				transport,
			});
			yield* settings.update({
				summariesEnabled: true,
				recap: { model: "opus" },
			});
			yield* settings.update({ enabled: true });
			yield* settings.update({ enabled: false });
			const restarted = yield* makeMessageSurfacingSettings(dir, {
				env: {},
				transport,
			});
			expect(yield* restarted.get).toMatchObject({
				enabled: false,
				active: false,
				summariesEnabled: true,
				recap: { model: "opus" },
				key: { source: "none" },
			});
			yield* restarted.update({ summariesEnabled: false });
			expect(yield* restarted.get).toMatchObject({
				enabled: false,
				summariesEnabled: false,
				recap: { model: "opus" },
			});
			expect(transport).not.toHaveBeenCalled();
		}),
	);
	for (const legacy of [
		{
			enabled: true,
			key: true,
			rejected: false,
			model: "opus",
			summaries: true,
		},
		{
			enabled: false,
			key: true,
			rejected: false,
			model: "sonnet",
			summaries: false,
		},
		{
			enabled: true,
			key: false,
			rejected: false,
			model: "sonnet",
			summaries: false,
		},
		{
			enabled: true,
			key: true,
			rejected: true,
			model: "sonnet",
			summaries: false,
		},
		{
			enabled: true,
			key: true,
			rejected: false,
			model: "off",
			summaries: false,
		},
	] as const) {
		it.effect(`migrates legacy summary state ${JSON.stringify(legacy)}`, () =>
			Effect.gen(function* () {
				const dir = directory();
				const settings = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport: validTransport(),
				});
				yield* settings.update({
					enabled: legacy.enabled,
					...(legacy.key ? { apiKey: "fake-legacy-key" } : {}),
					recap: { model: legacy.model, when: "turn-end" },
				});
				const filename = join(dir, "credentials/typesafe");
				const saved: { settings: Record<string, unknown>; keyState: string } =
					JSON.parse(readFileSync(filename, "utf8"));
				delete saved.settings["summariesEnabled"];
				if (legacy.rejected) saved.keyState = "invalid";
				writeFileSync(filename, JSON.stringify(saved));
				const restarted = yield* makeMessageSurfacingSettings(dir, { env: {} });
				expect(yield* restarted.get).toMatchObject({
					enabled: legacy.enabled,
					summariesEnabled: legacy.summaries,
					recap: { model: legacy.model, when: "turn-end" },
				});
				yield* restarted.update({ defaultLevel: "key" });
				expect(
					JSON.parse(readFileSync(filename, "utf8")).settings.summariesEnabled,
				).toBe(legacy.summaries);
			}),
		);
	}
	it.effect(
		"defaults Jev off and summaries on without a key and merges patches durably",
		() =>
			Effect.gen(function* () {
				const dir = directory();
				const transport = validTransport();
				const settings = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport,
				});
				expect(yield* settings.get).toEqual({
					enabled: false,
					summariesEnabled: true,
					active: false,
					key: { source: "none", rejected: false },
					defaultLevel: "balanced",
					turnsOpen: "auto",
					recap: { model: "sonnet", when: "on-request" },
					tuningModel: "opus",
				});
				yield* Effect.all(
					[
						settings.update({ enabled: true, recap: { model: "off" } }),
						settings.update({
							defaultLevel: "key",
							turnsOpen: "minimised",
							recap: { when: "on-request" },
						}),
					],
					{ concurrency: 2 },
				);
				const restarted = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport,
				});
				expect(yield* restarted.get).toMatchObject({
					enabled: true,
					active: false,
					defaultLevel: "key",
					turnsOpen: "minimised",
					recap: { model: "off", when: "on-request" },
				});
				expect(transport).not.toHaveBeenCalled();
			}),
	);
	it.effect(
		"loads older snapshots with Auto and retains explicit choices",
		() =>
			Effect.gen(function* () {
				const dir = directory();
				const settings = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport: validTransport(),
				});
				yield* settings.update({
					apiKey: "fake-legacy-key",
					enabled: true,
					defaultLevel: "key",
				});
				const filename = join(dir, "credentials/typesafe");
				const saved: { settings: Record<string, unknown> } = JSON.parse(
					readFileSync(filename, "utf8"),
				);
				delete saved.settings["turnsOpen"];
				writeFileSync(filename, JSON.stringify(saved));
				const restarted = yield* makeMessageSurfacingSettings(dir, { env: {} });
				expect(yield* restarted.get).toMatchObject({
					turnsOpen: "auto",
					defaultLevel: "key",
					active: true,
					key: { source: "stored" },
				});
				for (const turnsOpen of ["expanded", "auto", "minimised"] as const) {
					yield* restarted.update({ turnsOpen });
					yield* restarted.update({ recap: { model: "off" } });
					const reloaded = yield* makeMessageSurfacingSettings(dir, {
						env: {},
					});
					expect(yield* reloaded.get).toMatchObject({
						turnsOpen,
						defaultLevel: "key",
						active: true,
					});
				}
			}),
	);
	it.effect("validates once, stores privately and never returns the key", () =>
		Effect.gen(function* () {
			const dir = directory();
			const transport = validTransport();
			const settings = yield* makeMessageSurfacingSettings(dir, {
				env: { TYPESAFE_BASE_URL: "http://127.0.0.1:4198" },
				transport,
			});
			const result = yield* settings.update({
				enabled: true,
				apiKey: "fake-secret-canary",
			});
			expect(result).toMatchObject({
				active: true,
				key: { source: "stored", rejected: false },
			});
			expect(JSON.stringify(result)).not.toContain("fake-secret-canary");
			expect(transport).toHaveBeenCalledTimes(1);
			expect(transport).toHaveBeenCalledWith(
				"http://127.0.0.1:4198/v1/systemone",
				expect.objectContaining({
					method: "POST",
					redirect: "error",
					headers: {
						authorization: "Bearer fake-secret-canary",
						"content-type": "application/json",
					},
				}),
			);
			expect(statSync(join(dir, "credentials")).mode & 0o777).toBe(0o700);
			expect(statSync(join(dir, "credentials/typesafe")).mode & 0o777).toBe(
				0o600,
			);
			expect(readdirSync(join(dir, "credentials"))).toEqual(["typesafe"]);
			const restarted = yield* makeMessageSurfacingSettings(dir, {
				env: {},
				transport,
			});
			expect(yield* restarted.get).toEqual(result);
			yield* restarted.update({ apiKey: null });
			expect(yield* restarted.get).toMatchObject({
				enabled: true,
				active: false,
				key: { source: "none", rejected: false },
			});
			expect(
				readFileSync(join(dir, "credentials/typesafe"), "utf8"),
			).not.toContain("fake-secret-canary");
		}),
	);
	it.effect(
		"rejects a failed validation without replacing an existing key or patch",
		() =>
			Effect.gen(function* () {
				const transport = validTransport();
				const settings = yield* makeMessageSurfacingSettings(directory(), {
					env: {},
					transport,
				});
				yield* settings.update({ apiKey: "fake-original" });
				transport.mockImplementationOnce(
					async () => new Response("fake-rejected", { status: 401 }),
				);
				const failure = yield* Effect.either(
					settings.update({ apiKey: "fake-rejected", enabled: true }),
				);
				expect(failure._tag).toBe("Left");
				expect(JSON.stringify(failure)).not.toContain("fake-rejected");
				expect(yield* settings.get).toMatchObject({
					enabled: false,
					key: { source: "stored", rejected: false },
				});
			}),
	);
	it.effect(
		"persists runtime 401 and stops requests until a key is saved",
		() =>
			Effect.gen(function* () {
				const dir = directory();
				const transport = validTransport();
				const settings = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport,
				});
				yield* settings.update({ enabled: true, apiKey: "fake-key" });
				transport.mockImplementationOnce(
					async () => new Response(null, { status: 401 }),
				);
				yield* Effect.either(settings.post({ state: "test" }));
				expect(yield* settings.get).toMatchObject({
					active: false,
					key: { source: "stored", rejected: true },
				});
				const restarted = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport,
				});
				yield* Effect.either(restarted.post({}));
				yield* restarted.update({ enabled: false });
				yield* restarted.update({ enabled: true });
				expect(yield* restarted.get).toMatchObject({
					active: false,
					key: { source: "stored", rejected: true },
				});
				expect(transport).toHaveBeenCalledTimes(2);
				yield* restarted.update({ apiKey: "fake-key" });
				expect(yield* restarted.get).toMatchObject({
					active: true,
					key: { source: "stored", rejected: false },
				});
			}),
	);
	for (const cancelDuring of ["body cleanup", "lock acquisition"] as const) {
		it.effect(
			`persists a received 401 despite cancellation during ${cancelDuring}`,
			() =>
				Effect.gen(function* () {
					const dir = directory();
					const transport = validTransport();
					const settings = yield* makeMessageSurfacingSettings(dir, {
						env: {},
						transport,
					});
					yield* settings.update({ enabled: true, apiKey: "fake-original" });
					const runtimeStarted = yield* Deferred.make<void>();
					const runtimeReply = yield* Deferred.make<Response>();
					transport.mockImplementationOnce(() =>
						Effect.runPromise(
							Deferred.succeed(runtimeStarted, undefined).pipe(
								Effect.zipRight(Deferred.await(runtimeReply)),
							),
						),
					);
					const request = yield* Effect.fork(settings.post({}));
					yield* Deferred.await(runtimeStarted);
					const replacementStarted = yield* Deferred.make<void>();
					const replacementReply = yield* Deferred.make<Response>();
					transport.mockImplementationOnce(() =>
						Effect.runPromise(
							Deferred.succeed(replacementStarted, undefined).pipe(
								Effect.zipRight(Deferred.await(replacementReply)),
							),
						),
					);
					const replacement = yield* Effect.fork(
						settings.update({ apiKey: "fake-rejected" }).pipe(Effect.either),
					);
					yield* Deferred.await(replacementStarted);
					const cleanupStarted = yield* Deferred.make<void>();
					const cleanupFinished = yield* Deferred.make<void>();
					yield* Deferred.succeed(
						runtimeReply,
						new Response(
							new ReadableStream({
								cancel() {
									return Effect.runPromise(
										Deferred.succeed(cleanupStarted, undefined).pipe(
											Effect.zipRight(Deferred.await(cleanupFinished)),
										),
									);
								},
							}),
							{ status: 401 },
						),
					);
					yield* Deferred.await(cleanupStarted);
					if (cancelDuring === "lock acquisition") {
						yield* Deferred.succeed(cleanupFinished, undefined);
						// Let the response cleanup settle before interrupting the lock waiter.
						yield* Effect.promise(
							() => new Promise<void>((resolve) => setImmediate(resolve)),
						);
					}
					yield* Fiber.interruptFork(request);
					yield* Effect.yieldNow();
					yield* Deferred.succeed(cleanupFinished, undefined);
					yield* Deferred.succeed(
						replacementReply,
						new Response(null, { status: 401 }),
					);
					expect(yield* Fiber.join(replacement)).toMatchObject({
						_tag: "Left",
					});
					expect(Exit.isInterrupted(yield* Fiber.await(request))).toBe(true);
					expect(yield* settings.get).toMatchObject({
						active: false,
						key: { source: "stored", rejected: true },
					});
					const restarted = yield* makeMessageSurfacingSettings(dir, {
						env: {},
						transport,
					});
					expect(yield* restarted.get).toMatchObject({
						active: false,
						key: { source: "stored", rejected: true },
					});
					yield* Effect.either(restarted.post({}));
					expect(transport).toHaveBeenCalledTimes(3);
				}),
		);
	}
	it.effect(
		"env overrides storage and a rejected env key stays invalid after restart",
		() =>
			Effect.gen(function* () {
				const dir = directory();
				const transport = validTransport();
				const stored = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport,
				});
				yield* stored.update({ enabled: true, apiKey: "fake-stored" });
				const env = { TYPESAFE_API_KEY: "fake-env" };
				const settings = yield* makeMessageSurfacingSettings(dir, {
					env,
					transport,
				});
				expect(yield* settings.get).toMatchObject({
					active: true,
					key: { source: "env", rejected: false },
				});
				expect(
					(yield* Effect.either(settings.update({ apiKey: null })))._tag,
				).toBe("Left");
				transport.mockImplementationOnce(
					async () => new Response(null, { status: 401 }),
				);
				yield* Effect.either(settings.post({}));
				expect(yield* settings.get).toMatchObject({
					active: false,
					key: { source: "env", rejected: true },
				});
				const restarted = yield* makeMessageSurfacingSettings(dir, {
					env,
					transport,
				});
				expect(yield* restarted.get).toMatchObject({
					active: false,
					key: { source: "env", rejected: true },
				});
				for (const apiKey of [null, "fake-replacement"]) {
					expect(
						(yield* Effect.either(restarted.update({ apiKey })))._tag,
					).toBe("Left");
				}
				yield* Effect.either(restarted.post({}));
				expect(transport).toHaveBeenCalledTimes(2);
				expect(
					readFileSync(join(dir, "credentials/typesafe"), "utf8"),
				).not.toContain("fake-env");
				const changed = yield* makeMessageSurfacingSettings(dir, {
					env: { TYPESAFE_API_KEY: "fake-new-env" },
					transport,
				});
				expect(yield* changed.get).toMatchObject({
					active: true,
					key: { source: "env", rejected: false },
				});
				const withoutEnv = yield* makeMessageSurfacingSettings(dir, {
					env: {},
					transport,
				});
				expect(yield* withoutEnv.get).toMatchObject({
					active: true,
					key: { source: "stored", rejected: false },
				});
			}),
	);
	it.effect(
		"blocks remote HTTP before transport and sanitizes transport exceptions",
		() =>
			Effect.gen(function* () {
				const transport = validTransport();
				const unsafe = yield* makeMessageSurfacingSettings(directory(), {
					env: { TYPESAFE_BASE_URL: "http://example.com" },
					transport,
				});
				expect(
					(yield* Effect.either(unsafe.update({ apiKey: "fake-secret" })))._tag,
				).toBe("Left");
				expect(transport).not.toHaveBeenCalled();
				const settings = yield* makeMessageSurfacingSettings(directory(), {
					env: {},
					transport: async () => {
						throw new Error("fake-secret in an upstream error");
					},
				});
				const failure = yield* Effect.either(
					settings.update({ apiKey: "fake-secret" }),
				);
				expect(failure._tag).toBe("Left");
				expect(JSON.stringify(failure)).not.toContain("fake-secret");
			}),
	);
	it.effect(
		"lets an in-flight request finish after disabling and ignores stale 401s",
		() =>
			Effect.gen(function* () {
				let complete: (response: Response) => void = () => {
					throw new Error("Not started");
				};
				let started: () => void = () => {};
				const pending = new Promise<void>((resolve) => {
					started = resolve;
				});
				const transport = validTransport();
				const settings = yield* makeMessageSurfacingSettings(directory(), {
					env: {},
					transport,
				});
				yield* settings.update({ enabled: true, apiKey: "fake-old" });
				transport.mockImplementationOnce(
					() =>
						new Promise<Response>((resolve) => {
							complete = resolve;
							started();
						}),
				);
				const request = yield* Effect.fork(
					settings.post({}).pipe(Effect.either),
				);
				yield* Effect.promise(() => pending);
				yield* settings.update({ enabled: false, apiKey: "fake-new" });
				complete(new Response(null, { status: 401 }));
				yield* request.await;
				expect(yield* settings.get).toMatchObject({
					enabled: false,
					key: { source: "stored", rejected: false },
				});
				yield* Effect.either(settings.post({}));
				expect(transport).toHaveBeenCalledTimes(3);
			}),
	);
	it.scoped(
		"routes RPCs without a project, guards key writes and returns only status",
		() =>
			Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							() => Effect.die("Unexpected relay"),
							handlers,
						),
					),
				);
				expect(yield* client.GetMessageSurfacing({})).toMatchObject({
					enabled: false,
					key: { source: "none", rejected: false },
				});
				expect(
					yield* client.UpdateMessageSurfacing({
						enabled: true,
						recap: { model: "opus" },
					}),
				).toMatchObject({
					enabled: true,
					active: false,
					recap: { model: "opus", when: "on-request" },
				});
				const denied = yield* Effect.either(
					handlers
						.UpdateMessageSurfacing(
							new UpdateMessageSurfacing({ apiKey: "fake-secret" }),
						)
						.pipe(
							Effect.provideService(RpcCaller, {
								kind: "browser",
								ip: "192.0.2.1",
							}),
						),
				);
				expect(denied).toMatchObject({
					_tag: "Left",
					left: { message: "Saving a TypeSafe key requires TLS or loopback" },
				});
				for (const caller of [
					{ kind: "cli" } as const,
					{ kind: "browser", ip: "127.0.0.1" } as const,
					{ kind: "browser", ip: "::1" } as const,
					{ kind: "browser", ip: "::ffff:127.0.0.1" } as const,
					{ kind: "browser", ip: "192.0.2.1", secure: true } as const,
				]) {
					const result = yield* handlers
						.UpdateMessageSurfacing(
							new UpdateMessageSurfacing({ apiKey: "fake-secret" }),
						)
						.pipe(Effect.provideService(RpcCaller, caller));
					expect(result).toMatchObject({
						active: true,
						key: { source: "stored", rejected: false },
					});
					expect(JSON.stringify(result)).not.toContain("fake-secret");
				}
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], undefined, {
						configDir: directory(),
						messageSurfacing: { env: {}, transport: validTransport() },
					}),
				),
			),
	);
});
