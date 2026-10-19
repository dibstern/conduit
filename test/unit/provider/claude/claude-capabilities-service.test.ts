import { createHash } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Result as Either,
	Fiber,
	Layer,
	Logger,
	Option,
} from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, vi } from "vitest";
import {
	__setProbeOverrideForTesting,
	type ProbeResult,
} from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";
import {
	ClaudeCapabilitiesServiceLive,
	ClaudeCapabilitiesServiceTag,
	makeClaudeCapabilitiesService,
} from "../../../../src/lib/provider/claude/claude-capabilities-service.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { ClaudeBoundaryError } from "../../../../src/lib/provider/event-sink-errors.js";

const launchConfig = () => ({
	folderSource: "account" as const,
	configDir: configuredClaudeConfigDir("/tmp/claude-account"),
});

const capabilities = (id: string): ProbeResult => ({
	models: [{ id, name: id, providerId: "claude" }],
	commands: [],
	agents: [],
});

const waitUntil = <E, R>(check: Effect.Effect<boolean, E, R>) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 1000; attempt++) {
			if (yield* check) return;
			yield* Effect.promise(() => setImmediate());
		}
		return yield* Effect.fail(new Error("Background work did not complete"));
	});

const cacheFile = (cacheDir: string) =>
	join(
		cacheDir,
		`${createHash("sha256")
			.update(
				["Configured", "/tmp/claude-account", "/tmp/workspace"].join("\0"),
			)
			.digest("hex")}.json`,
	);

describe("ClaudeCapabilitiesService", () => {
	const tempDirs: string[] = [];
	const tempDir = () =>
		Effect.tryPromise(async () => {
			const directory = await mkdtemp(join(tmpdir(), "claude-capabilities-"));
			tempDirs.push(directory);
			return directory;
		});

	afterEach(async () => {
		__setProbeOverrideForTesting(undefined);
		await Promise.all(
			tempDirs
				.splice(0)
				.map((path) => rm(path, { recursive: true, force: true })),
		);
	});

	it.effect(
		"refreshes a fresh value and serves the new value on later gets",
		() =>
			Effect.gen(function* () {
				const refreshed = capabilities("new");
				const probe = vi
					.fn()
					.mockResolvedValueOnce(capabilities("old"))
					.mockResolvedValueOnce(refreshed);
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({ launchConfig });
				yield* service.get("/tmp/workspace");
				yield* TestClock.adjust("1 minute");

				expect(yield* service.get("/tmp/workspace", { refresh: true })).toEqual(
					refreshed,
				);
				expect(yield* service.get("/tmp/workspace")).toEqual(refreshed);
				expect(probe).toHaveBeenCalledTimes(2);
			}),
	);

	it.effect("persists the refreshed value before returning", () =>
		Effect.gen(function* () {
			const cacheDir = yield* tempDir();
			const refreshed = capabilities("new");
			const probe = vi
				.fn()
				.mockResolvedValueOnce(capabilities("old"))
				.mockResolvedValueOnce(refreshed);
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({
				launchConfig,
				cacheDir,
			});
			yield* service.get("/tmp/workspace");
			yield* service.get("/tmp/workspace", { refresh: true });

			const persisted = yield* Effect.tryPromise(() =>
				readFile(cacheFile(cacheDir), "utf8"),
			);
			expect(JSON.parse(persisted)).toMatchObject({
				version: 1,
				result: refreshed,
			});
			expect(probe).toHaveBeenCalledTimes(2);
		}),
	);

	for (const inFlight of ["cold", "background", "refresh"] as const) {
		it.effect(`joins an in-flight ${inFlight} probe when refreshing`, () =>
			Effect.gen(function* () {
				const release = yield* Deferred.make<void>();
				const refreshed = capabilities("shared");
				const probe = vi.fn(async () => {
					await Effect.runPromise(Deferred.await(release));
					return refreshed;
				});
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({ launchConfig });
				if (inFlight !== "cold") {
					probe.mockResolvedValueOnce(capabilities("old"));
					yield* service.get("/tmp/workspace");
					probe.mockClear();
				}
				if (inFlight === "background") yield* TestClock.adjust("6 minutes");

				yield* Effect.gen(function* () {
					const first = yield* Effect.forkChild(
						service.get(
							"/tmp/workspace",
							inFlight === "refresh" ? { refresh: true } : undefined,
						),
					);
					yield* waitUntil(Effect.sync(() => probe.mock.calls.length === 1));
					const second = yield* Effect.forkChild(
						service.get("/tmp/workspace", { refresh: true }),
					);
					yield* Effect.yieldNow;
					expect(
						Option.isNone(
							yield* Effect.sync(() =>
								Option.fromUndefinedOr(second.pollUnsafe()),
							),
						),
					).toBe(true);
					expect(probe).toHaveBeenCalledTimes(1);
					yield* Deferred.succeed(release, undefined);
					expect(yield* Fiber.join(second)).toEqual(refreshed);
					expect(yield* Fiber.join(first)).toEqual(
						inFlight === "background" ? capabilities("old") : refreshed,
					);
					expect(probe).toHaveBeenCalledTimes(1);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		);
	}

	it.effect(
		"propagates refresh failures and preserves the previous cached value",
		() =>
			Effect.gen(function* () {
				const original = capabilities("old");
				const cause = new Error("refresh failed");
				const probe = vi
					.fn()
					.mockResolvedValueOnce(original)
					.mockRejectedValueOnce(cause);
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({ launchConfig });
				yield* service.get("/tmp/workspace");

				const failed = yield* Effect.result(
					service.get("/tmp/workspace", { refresh: true }),
				);
				expect(Either.isFailure(failed)).toBe(true);
				if (Either.isFailure(failed)) {
					expect(failed.failure).toBeInstanceOf(ClaudeBoundaryError);
					expect(failed.failure.cause).toBe(cause);
				}
				expect(yield* service.get("/tmp/workspace")).toEqual(original);
				expect(probe).toHaveBeenCalledTimes(2);
			}),
	);

	it.effect("serves the cached value immediately during a refresh", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			const original = capabilities("old");
			const probe = vi
				.fn()
				.mockResolvedValueOnce(original)
				.mockImplementationOnce(async () => {
					await Effect.runPromise(Deferred.await(release));
					return capabilities("new");
				});
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({ launchConfig });
			yield* service.get("/tmp/workspace");

			yield* Effect.gen(function* () {
				const refresh = yield* Effect.forkChild(
					service.get("/tmp/workspace", { refresh: true }),
				);
				yield* Effect.yieldNow;
				expect(probe).toHaveBeenCalledTimes(2);
				const plain = yield* Effect.forkChild(service.get("/tmp/workspace"));
				yield* waitUntil(
					Effect.sync(() => Option.fromUndefinedOr(plain.pollUnsafe())).pipe(
						Effect.map(Option.isSome),
					),
				);
				expect(yield* Fiber.join(plain)).toEqual(original);
				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(refresh.pollUnsafe()),
						),
					),
				).toBe(true);
				expect(probe).toHaveBeenCalledTimes(2);
				yield* Deferred.succeed(release, undefined);
				expect(yield* Fiber.join(refresh)).toEqual(capabilities("new"));
			}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
		}),
	);

	it.effect("serves stale values while one background probe refreshes", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			const probe = vi
				.fn()
				.mockResolvedValueOnce(capabilities("claude-sonnet-1"))
				.mockImplementationOnce(async () => {
					await Effect.runPromise(Deferred.await(release));
					return capabilities("claude-sonnet-2");
				});
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({ launchConfig });

			const first = yield* service.get("/tmp/workspace");
			yield* TestClock.adjust("4 minutes");
			const second = yield* service.get("/tmp/workspace");
			expect(first.models[0]?.id).toBe("claude-sonnet-1");
			expect(second.models[0]?.id).toBe("claude-sonnet-1");
			expect(probe).toHaveBeenCalledTimes(1);

			yield* Effect.gen(function* () {
				yield* TestClock.adjust("2 minutes");
				const reads = yield* Effect.forkChild(
					Effect.all(
						Array.from({ length: 4 }, () => service.get("/tmp/workspace")),
						{ concurrency: "unbounded" },
					),
				);
				yield* waitUntil(
					Effect.sync(() => Option.fromUndefinedOr(reads.pollUnsafe())).pipe(
						Effect.map(Option.isSome),
					),
				);
				expect(yield* Fiber.join(reads)).toEqual(Array(4).fill(first));
				yield* waitUntil(Effect.sync(() => probe.mock.calls.length === 2));
				expect(yield* service.get("/tmp/workspace")).toEqual(first);
				expect(probe).toHaveBeenCalledTimes(2);
			}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			yield* waitUntil(
				service
					.get("/tmp/workspace")
					.pipe(
						Effect.map((result) => result.models[0]?.id === "claude-sonnet-2"),
					),
			);
			expect(probe).toHaveBeenCalledTimes(2);
		}),
	);

	it.effect("dedupes concurrent probes inside one layer", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			const probe = vi.fn(async () => {
				await Effect.runPromise(Deferred.await(release));
				return { models: [], commands: [], agents: [] };
			});
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({
				launchConfig: () => ({
					folderSource: "account",
					configDir: configuredClaudeConfigDir("/tmp/claude-account"),
				}),
			});

			const first = yield* Effect.forkChild(service.get("/tmp/workspace"));
			const second = yield* Effect.forkChild(service.get("/tmp/workspace"));
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(first);
			yield* Fiber.join(second);

			expect(probe).toHaveBeenCalledTimes(1);
			__setProbeOverrideForTesting(undefined);
		}),
	);

	it.effect(
		"serves a persisted value after restart and refreshes it once in the background",
		() =>
			Effect.gen(function* () {
				const cacheDir = yield* tempDir();
				const original: ProbeResult = {
					models: [
						{
							id: "old",
							name: "Old",
							providerId: "claude",
							resolvedModel: "old-v1",
							limit: { context: 200000, output: 64000 },
							variants: { high: { effort: "high", budget: 1000 } },
							routingOptions: [
								{ value: "old[1m]", label: "1m", isDefault: false },
							],
							contextWindowOptions: [
								{ value: "200k", label: "200k", isDefault: true },
							],
						},
					],
					subscriptionType: "max",
					commands: [
						{
							name: "review",
							description: "Review",
							args: "file",
							source: "project-skill",
						},
					],
					agents: [
						{
							id: "reviewer",
							name: "Reviewer",
							description: "Review code",
							model: "old",
						},
					],
				};
				const probe = vi.fn().mockResolvedValue(original);
				__setProbeOverrideForTesting(probe);
				const first = yield* makeClaudeCapabilitiesService({
					launchConfig,
					cacheDir,
				});
				expect(yield* first.get("/tmp/workspace")).toEqual(original);
				const persisted = yield* Effect.tryPromise(() =>
					readFile(cacheFile(cacheDir), "utf8"),
				);
				expect(JSON.parse(persisted)).toEqual({
					version: 1,
					workspaceRoot: "/tmp/workspace",
					configDir: launchConfig().configDir,
					probedAt: 0,
					result: original,
				});
				const release = yield* Deferred.make<void>();
				probe.mockClear().mockImplementation(async () => {
					await Effect.runPromise(Deferred.await(release));
					return capabilities("new");
				});
				const restarted = yield* makeClaudeCapabilitiesService({
					launchConfig,
					cacheDir,
				});
				yield* Effect.gen(function* () {
					const stale = yield* Effect.forkChild(
						restarted.get("/tmp/workspace"),
					);
					yield* waitUntil(
						Effect.sync(() => Option.fromUndefinedOr(stale.pollUnsafe())).pipe(
							Effect.map(Option.isSome),
						),
					);
					expect(yield* Fiber.join(stale)).toEqual(original);
					yield* waitUntil(Effect.sync(() => probe.mock.calls.length === 1));
					expect(yield* restarted.get("/tmp/workspace")).toEqual(original);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
				yield* waitUntil(
					restarted
						.get("/tmp/workspace")
						.pipe(Effect.map((result) => result.models[0]?.id === "new")),
				);
				yield* waitUntil(
					Effect.tryPromise(async () =>
						(await readFile(cacheFile(cacheDir), "utf8")).includes(
							'"id":"new"',
						),
					),
				);
				expect(probe).toHaveBeenCalledTimes(1);
			}),
	);

	it.effect(
		"dedupes concurrent cold gets while reading a missing disk entry",
		() =>
			Effect.gen(function* () {
				const cacheDir = yield* tempDir();
				const release = yield* Deferred.make<void>();
				const result = capabilities("shared");
				const probe = vi.fn(async () => {
					await Effect.runPromise(Deferred.await(release));
					return result;
				});
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({
					launchConfig,
					cacheDir,
				});
				const reads = yield* Effect.forkChild(
					Effect.all(
						Array.from({ length: 8 }, () => service.get("/tmp/workspace")),
						{ concurrency: "unbounded" },
					),
				);
				yield* waitUntil(Effect.sync(() => probe.mock.calls.length > 0)).pipe(
					Effect.ensuring(Deferred.succeed(release, undefined)),
				);
				expect(yield* Fiber.join(reads)).toEqual(Array(8).fill(result));
				expect(probe).toHaveBeenCalledTimes(1);
				const persisted = yield* Effect.tryPromise(() =>
					readFile(cacheFile(cacheDir), "utf8"),
				);
				expect(JSON.parse(persisted)).toMatchObject({ version: 1, result });
			}),
	);

	for (const [name, content] of [
		["corrupt JSON", "garbage bytes"],
		[
			"wrong version",
			JSON.stringify({
				version: 2,
				workspaceRoot: "/tmp/workspace",
				configDir: launchConfig().configDir,
				probedAt: 0,
				result: capabilities("invalid"),
			}),
		],
		[
			"invalid command source",
			JSON.stringify({
				version: 1,
				workspaceRoot: "/tmp/workspace",
				configDir: launchConfig().configDir,
				probedAt: 0,
				result: {
					...capabilities("invalid"),
					commands: [{ name: "bad", source: "invalid" }],
				},
			}),
		],
	] as const) {
		it.effect(`treats ${name} as a miss and replaces the file`, () =>
			Effect.gen(function* () {
				const cacheDir = yield* tempDir();
				yield* Effect.tryPromise(() => writeFile(cacheFile(cacheDir), content));
				const result = capabilities("valid");
				const probe = vi
					.fn()
					.mockResolvedValueOnce(result)
					.mockResolvedValue(capabilities("refreshed"));
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({
					launchConfig,
					cacheDir,
				});
				expect(yield* service.get("/tmp/workspace")).toEqual(result);
				expect(probe).toHaveBeenCalledTimes(1);
				const persisted = yield* Effect.tryPromise(() =>
					readFile(cacheFile(cacheDir), "utf8"),
				);
				expect(JSON.parse(persisted)).toMatchObject({ version: 1, result });
				const restarted = yield* makeClaudeCapabilitiesService({
					launchConfig,
					cacheDir,
				});
				expect(yield* restarted.get("/tmp/workspace")).toEqual(result);
				yield* waitUntil(
					Effect.tryPromise(async () =>
						(await readFile(cacheFile(cacheDir), "utf8")).includes(
							'"id":"refreshed"',
						),
					),
				);
				expect(probe).toHaveBeenCalledTimes(2);
			}),
		);
	}

	it.effect(
		"keeps stale values after refresh failure and backs off for a TTL",
		() =>
			Effect.gen(function* () {
				let warned = false;
				const refreshLogs = Logger.layer([
					Logger.make(() => {
						warned = true;
					}),
				]);
				const release = yield* Deferred.make<void>();
				const probe = vi
					.fn()
					.mockResolvedValueOnce(capabilities("old"))
					.mockImplementationOnce(async () => {
						await Effect.runPromise(Deferred.await(release));
						throw new Error("refresh failed");
					})
					.mockResolvedValue(capabilities("recovered"));
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({ launchConfig });
				const original = yield* service.get("/tmp/workspace");
				yield* Effect.gen(function* () {
					yield* TestClock.adjust("6 minutes");
					const stale = yield* Effect.forkChild(
						service.get("/tmp/workspace").pipe(Effect.provide(refreshLogs)),
					);
					yield* waitUntil(
						Effect.sync(() => Option.fromUndefinedOr(stale.pollUnsafe())).pipe(
							Effect.map(Option.isSome),
						),
					);
					expect(yield* Fiber.join(stale)).toEqual(original);
					yield* waitUntil(Effect.sync(() => probe.mock.calls.length === 2));
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
				yield* waitUntil(Effect.sync(() => warned));
				yield* TestClock.adjust("4 minutes");
				expect(yield* service.get("/tmp/workspace")).toEqual(original);
				expect(probe).toHaveBeenCalledTimes(2);
				yield* TestClock.adjust("2 minutes");
				expect(yield* service.get("/tmp/workspace")).toEqual(original);
				yield* waitUntil(
					service
						.get("/tmp/workspace")
						.pipe(Effect.map((result) => result.models[0]?.id === "recovered")),
				);
				expect(probe).toHaveBeenCalledTimes(3);
			}),
	);

	it.effect(
		"isolates account folders on the same workspace in memory and on disk",
		() =>
			Effect.gen(function* () {
				const cacheDir = yield* tempDir();
				let accountPath = "/tmp/account-one";
				const launch = vi.fn(() => ({
					folderSource: "account" as const,
					configDir: configuredClaudeConfigDir(accountPath),
				}));
				const probe = vi
					.fn()
					.mockResolvedValueOnce(capabilities("one"))
					.mockResolvedValueOnce(capabilities("two"))
					.mockResolvedValue(capabilities("refreshed"));
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({
					launchConfig: launch,
					cacheDir,
				});
				expect((yield* service.get("/tmp/workspace")).models[0]?.id).toBe(
					"one",
				);
				accountPath = "/tmp/account-two";
				expect((yield* service.get("/tmp/workspace")).models[0]?.id).toBe(
					"two",
				);
				accountPath = "/tmp/account-one";
				expect((yield* service.get("/tmp/workspace")).models[0]?.id).toBe(
					"one",
				);
				expect(launch).toHaveBeenCalledTimes(3);
				expect(probe).toHaveBeenCalledTimes(2);
				const files = yield* Effect.tryPromise(() => readdir(cacheDir));
				expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(2);
				const restarted = yield* makeClaudeCapabilitiesService({
					launchConfig: launch,
					cacheDir,
				});
				expect((yield* restarted.get("/tmp/workspace")).models[0]?.id).toBe(
					"one",
				);
				accountPath = "/tmp/account-two";
				expect((yield* restarted.get("/tmp/workspace")).models[0]?.id).toBe(
					"two",
				);
				// Disk entries are served stale, so each account refreshes once.
				yield* waitUntil(
					Effect.tryPromise(async () =>
						(
							await Promise.all(
								files
									.filter((file) => file.endsWith(".json"))
									.map((file) => readFile(join(cacheDir, file), "utf8")),
							)
						).every((content) => content.includes('"id":"refreshed"')),
					),
				);
				expect(probe).toHaveBeenCalledTimes(4);
			}),
	);

	it.effect("succeeds when the cache directory is a regular file", () =>
		Effect.gen(function* () {
			const root = yield* tempDir();
			const cacheDir = join(root, "not-a-directory");
			yield* Effect.tryPromise(() => writeFile(cacheDir, "occupied"));
			const result = capabilities("available");
			const probe = vi.fn().mockResolvedValue(result);
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({
				launchConfig,
				cacheDir,
			});
			expect(yield* service.get("/tmp/workspace")).toEqual(result);
			expect(yield* service.get("/tmp/workspace")).toEqual(result);
			expect(probe).toHaveBeenCalledTimes(1);
		}),
	);

	it.effect("propagates a cold probe failure and retries the next get", () =>
		Effect.gen(function* () {
			const cause = new Error("probe failed");
			const probe = vi
				.fn()
				.mockRejectedValueOnce(cause)
				.mockResolvedValueOnce(capabilities("retry"));
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({ launchConfig });
			const failed = yield* Effect.result(service.get("/tmp/workspace"));
			expect(Either.isFailure(failed)).toBe(true);
			if (Either.isFailure(failed)) {
				expect(failed.failure).toBeInstanceOf(ClaudeBoundaryError);
				expect(failed.failure.operation).toBe("probeCapabilities");
				expect(failed.failure.cause).toBe(cause);
			}
			expect((yield* service.get("/tmp/workspace")).models[0]?.id).toBe(
				"retry",
			);
			expect(probe).toHaveBeenCalledTimes(2);
		}),
	);

	it.effect(
		"maps a throwing launchConfig to a typed failure even on a cache hit",
		() =>
			Effect.gen(function* () {
				const cause = new Error("launch config unavailable");
				const launch = vi.fn(launchConfig).mockImplementationOnce(() => {
					throw cause;
				});
				const probe = vi.fn().mockResolvedValue(capabilities("cached"));
				__setProbeOverrideForTesting(probe);
				const service = yield* makeClaudeCapabilitiesService({
					launchConfig: launch,
				});
				const failure = yield* Effect.result(service.get("/tmp/workspace"));
				expect(Either.isFailure(failure)).toBe(true);
				if (Either.isFailure(failure)) {
					expect(failure.failure).toBeInstanceOf(ClaudeBoundaryError);
					expect(failure.failure.cause).toBe(cause);
				}
				expect(probe).not.toHaveBeenCalled();
				yield* service.get("/tmp/workspace");
				launch.mockImplementationOnce(() => {
					throw cause;
				});
				const cachedFailure = yield* Effect.result(
					service.get("/tmp/workspace"),
				);
				expect(Either.isFailure(cachedFailure)).toBe(true);
				expect(probe).toHaveBeenCalledTimes(1);
			}),
	);

	it.effect("retries after an interrupted cold probe", () =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>();
			const probe = vi
				.fn()
				.mockImplementationOnce(async () => {
					await Effect.runPromise(Deferred.await(release));
					return capabilities("interrupted");
				})
				.mockResolvedValueOnce(capabilities("retry"));
			__setProbeOverrideForTesting(probe);
			const service = yield* makeClaudeCapabilitiesService({ launchConfig });
			const first = yield* Effect.forkChild(service.get("/tmp/workspace"));
			yield* waitUntil(Effect.sync(() => probe.mock.calls.length === 1));
			yield* Fiber.interrupt(first);
			yield* Deferred.succeed(release, undefined);
			expect((yield* service.get("/tmp/workspace")).models[0]?.id).toBe(
				"retry",
			);
			expect(probe).toHaveBeenCalledTimes(2);
		}),
	);

	it.effect(
		"prunes old JSON and temporary files while keeping fresh files",
		() =>
			Effect.gen(function* () {
				const cacheDir = yield* tempDir();
				yield* Effect.tryPromise(async () => {
					const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
					for (const name of [
						"old.json",
						"old.json.123.uuid.tmp",
						"old.txt",
						"fresh.json",
						"fresh.json.123.uuid.tmp",
					]) {
						const path = join(cacheDir, name);
						await writeFile(path, "fixture");
						if (name.startsWith("old")) await utimes(path, old, old);
					}
				});
				yield* makeClaudeCapabilitiesService({ launchConfig, cacheDir });
				yield* waitUntil(
					Effect.tryPromise(async () => {
						const files = await readdir(cacheDir);
						return (
							!files.includes("old.json") &&
							!files.includes("old.json.123.uuid.tmp")
						);
					}),
				);
				expect(
					(yield* Effect.tryPromise(() => readdir(cacheDir))).sort(),
				).toEqual(["fresh.json", "fresh.json.123.uuid.tmp", "old.txt"]);
			}),
	);

	it.effect("does not share cached probes across fresh service layers", () =>
		Effect.gen(function* () {
			const firstQueryFactory = vi.fn(() => ({
				async *[Symbol.asyncIterator]() {
					yield* [];
				},
				initializationResult: vi.fn(async () => ({
					models: [
						{
							value: "claude-layer-one",
							displayName: "Layer One",
						},
					],
					commands: [],
					agents: [],
				})),
			}));
			const secondQueryFactory = vi.fn(() => ({
				async *[Symbol.asyncIterator]() {
					yield* [];
				},
				initializationResult: vi.fn(async () => ({
					models: [
						{
							value: "claude-layer-two",
							displayName: "Layer Two",
						},
					],
					commands: [],
					agents: [],
				})),
			}));
			const readTwice = Effect.gen(function* () {
				const service = yield* ClaudeCapabilitiesServiceTag;
				const first = yield* service.get("/tmp/workspace");
				const second = yield* service.get("/tmp/workspace");
				return [first, second] as const;
			});

			const [firstLayerInitial, firstLayerCached] = yield* readTwice.pipe(
				Effect.provide(
					Layer.fresh(
						ClaudeCapabilitiesServiceLive({
							launchConfig: () => ({
								folderSource: "account",
								configDir: configuredClaudeConfigDir("/tmp/claude-account"),
							}),
							queryFactory: firstQueryFactory,
						}),
					),
				),
			);
			const [secondLayerInitial, secondLayerCached] = yield* readTwice.pipe(
				Effect.provide(
					Layer.fresh(
						ClaudeCapabilitiesServiceLive({
							launchConfig: () => ({
								folderSource: "account",
								configDir: configuredClaudeConfigDir("/tmp/claude-account"),
							}),
							queryFactory: secondQueryFactory,
						}),
					),
				),
			);

			expect(firstLayerInitial.models[0]?.id).toBe("claude-layer-one");
			expect(firstLayerCached.models[0]?.id).toBe("claude-layer-one");
			expect(secondLayerInitial.models[0]?.id).toBe("claude-layer-two");
			expect(secondLayerCached.models[0]?.id).toBe("claude-layer-two");
			expect(firstQueryFactory).toHaveBeenCalledTimes(1);
			expect(secondQueryFactory).toHaveBeenCalledTimes(1);
		}),
	);
});
