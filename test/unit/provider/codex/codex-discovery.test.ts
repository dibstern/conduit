// Failure modes: queued callers spawn after a failure, failures cross cache
// keys or outlive their TTL, refresh cannot retry, or queue time consumes timeout.
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { connectAppServer } from "../../../../src/lib/provider/codex/app-server/client.js";
import { AppServerIoError } from "../../../../src/lib/provider/codex/app-server/transport.js";
import { discoverCodex } from "../../../../src/lib/provider/codex/codex-discovery.js";
import { makeCodexRunnerDriver } from "../../../../src/lib/provider/codex/codex-runner-driver.js";

vi.mock("../../../../src/lib/provider/codex/app-server/app-server.js", () => ({
	openAppServerTransport: () => Effect.void,
}));
vi.mock(
	"../../../../src/lib/provider/codex/app-server/client.js",
	async (original) => ({
		...(await original<
			typeof import("../../../../src/lib/provider/codex/app-server/client.js")
		>()),
		connectAppServer: vi.fn(),
	}),
);

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("Codex discovery failure memory", () => {
	it.effect(
		"shares a failure with queued callers, expires it after 60 seconds, and separates cache keys",
		() =>
			Effect.gen(function* () {
				const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
				const connect = vi.mocked(connectAppServer);
				const started = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				connect.mockReturnValue(
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined);
						yield* Deferred.await(release);
						return yield* Effect.fail(
							new AppServerIoError({
								operation: "connect",
								cause: new Error("offline"),
							}),
						);
					}),
				);
				const read = discoverCodex(
					"/tmp/codex-failure-memory",
					{},
					"/tmp/work",
				);
				const first = yield* read.pipe(Effect.result, Effect.forkChild);
				yield* Deferred.await(started);
				const second = yield* read.pipe(Effect.result, Effect.forkChild);
				yield* Deferred.succeed(release, undefined);
				const failure = yield* Fiber.join(first);
				expect(failure._tag).toBe("Failure");
				expect(yield* Fiber.join(second)).toEqual(failure);
				expect(connect).toHaveBeenCalledTimes(1);
				now.mockReturnValue(60_999);
				expect(yield* Effect.result(read)).toEqual(failure);
				expect(connect).toHaveBeenCalledTimes(1);
				now.mockReturnValue(61_000);
				yield* Effect.result(read);
				expect(connect).toHaveBeenCalledTimes(2);
				yield* Effect.result(
					discoverCodex("/tmp/codex-failure-memory", {}, "/tmp/other-work"),
				);
				yield* Effect.result(
					discoverCodex("/tmp/codex-other-home", {}, "/tmp/work"),
				);
				expect(connect).toHaveBeenCalledTimes(4);
			}),
	);

	it.effect("lets an explicit driver refresh retry a remembered failure", () =>
		Effect.gen(function* () {
			const connect = vi.mocked(connectAppServer);
			connect.mockReturnValue(
				Effect.fail(
					new AppServerIoError({
						operation: "connect",
						cause: new Error("offline"),
					}),
				),
			);
			const driver = makeCodexRunnerDriver("/tmp/codex-refresh-work");
			const account = {
				id: AccountIdSchema.make("codex"),
				driver: "codex" as const,
				configuredFolder: "/tmp/codex-refresh-home",
				name: "Codex",
				isDefault: false,
				usageEligible: false,
			};
			yield* Effect.result(driver.discoverEffect(undefined, account));
			yield* Effect.result(driver.discoverEffect(undefined, account));
			expect(connect).toHaveBeenCalledTimes(1);
			yield* Effect.result(
				driver.discoverEffect(undefined, account, { refresh: true }),
			);
			expect(connect).toHaveBeenCalledTimes(2);
		}),
	);

	it.effect("clears a remembered failure after a successful refresh", () =>
		Effect.gen(function* () {
			const connect = vi.mocked(connectAppServer);
			const read = (refresh = false) =>
				discoverCodex(
					"/tmp/codex-recovery-home",
					{},
					"/tmp/recovery-work",
					false,
					{ refresh },
				);
			connect.mockReturnValue(
				Effect.fail(
					new AppServerIoError({
						operation: "connect",
						cause: new Error("offline"),
					}),
				),
			);
			yield* Effect.result(read());
			connect.mockReturnValue(
				Effect.succeed({
					serverVersion: "999.0.0",
					notifications: Stream.empty,
					request: (method, _params, schema) =>
						Schema.decodeUnknownEffect(schema)(
							method === "account/read"
								? { account: null, requiresOpenaiAuth: true }
								: method === "model/list"
									? { data: [], nextCursor: null }
									: { data: [] },
						),
				}),
			);
			expect((yield* read(true)).models).toEqual([]);
			expect((yield* read()).models).toEqual([]);
			expect(connect).toHaveBeenCalledTimes(2);
		}),
	);

	it.effect(
		"starts each 15 second timeout only after acquiring the discovery lock",
		() =>
			Effect.gen(function* () {
				const connect = vi.mocked(connectAppServer);
				const started = yield* Deferred.make<void>();
				connect.mockReturnValue(
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				);
				const first = yield* discoverCodex("/tmp/codex-timeout-first").pipe(
					Effect.result,
					Effect.forkChild,
				);
				yield* Deferred.await(started);
				const second = yield* discoverCodex("/tmp/codex-timeout-second").pipe(
					Effect.result,
					Effect.forkChild,
				);
				yield* TestClock.adjust("15 seconds");
				expect((yield* Fiber.join(first))._tag).toBe("Failure");
				expect(connect).toHaveBeenCalledTimes(2);
				yield* TestClock.adjust("14 seconds");
				expect(second.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust("1 second");
				expect((yield* Fiber.join(second))._tag).toBe("Failure");
			}),
	);
});
