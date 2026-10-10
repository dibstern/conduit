import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionGitLive } from "../../../src/lib/domain/relay/Layers/session-git-layer.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionGitServiceTag } from "../../../src/lib/domain/relay/Services/session-git-service.js";
import { daemonSessionGitCache } from "../../../src/lib/git/session-git.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";
import { tempEventsDbPath } from "../../helpers/temp-events-db.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const path = tempEventsDbPath();
	const runtime = ManagedRuntime.make(
		SessionGitLive.pipe(
			Layer.provideMerge(
				Layer.merge(
					makePersistenceEffectLayer(path),
					Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/primary" })),
				),
			),
		),
	);
	cleanups.push(async () => {
		await runtime.dispose();
		rmSync(dirname(path), { recursive: true, force: true });
	});
	await runtime.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			for (const [sessionId, directory] of [
				["one", "/one"],
				["shared", "/one"],
				["two", "/two"],
				["settled", "/settled"],
			] as const) {
				yield* commit([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: sessionId,
						provider: "claude",
					}),
					canonicalEvent("session.workspace_changed", sessionId, {
						sessionId,
						cause: "user",
						origin: "existing",
						worktrees: { "/primary": directory },
					}),
				]);
			}
			yield* commit([
				canonicalEvent("session.settled", "settled", { sessionId: "settled" }),
			]);
		}),
	);
	const service = await runtime.runPromise(SessionGitServiceTag);
	return {
		runtime,
		refresh: (options?: Parameters<typeof service.refresh>[0]) =>
			runtime.runPromise(service.refresh(options)),
	};
}

describe("Session git refresh", () => {
	it("coalesces a burst into one follow-up instead of repeating git for every request", async () => {
		const { refresh } = await fixture();
		let started!: () => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let blocked = true;
		const read = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockImplementation(async () => {
				if (blocked) {
					blocked = false;
					started();
					await held;
				}
				return { branch: "main" };
			});
		const first = refresh();
		await reading;
		const queued = Array.from({ length: 5 }, () => refresh());
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		release();
		await Promise.all([first, ...queued]);
		const directories = read.mock.calls.map(([directory]) => directory);
		expect(
			directories.filter((directory) => directory === "/one"),
		).toHaveLength(2);
		expect(directories).not.toContain("/settled");
	});

	it("polls only stale entries and publishes the cached git for fresh entries", async () => {
		const { refresh, runtime } = await fixture();
		vi.spyOn(daemonSessionGitCache, "isStale").mockImplementation(
			(directory) => directory === "/two",
		);
		vi.spyOn(daemonSessionGitCache, "peek").mockReturnValue({
			branch: "cached",
		});
		const read = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockResolvedValue({ branch: "updated" });
		const before = await runtime.runPromise(
			Effect.flatMap(ReadQueryEffectTag, (query) => query.getSession("one")),
		);
		await refresh({ staleOnly: true });
		expect(read.mock.calls.map(([directory]) => directory)).toEqual(["/two"]);
		const updated = await runtime.runPromise(
			Effect.flatMap(ReadQueryEffectTag, (query) => query.getSession("one")),
		);
		expect(updated?.version).toBeGreaterThan(before?.version ?? 0);
		read.mockClear();
		vi.mocked(daemonSessionGitCache.isStale).mockReturnValue(false);
		await refresh({ staleOnly: true });
		expect(read).not.toHaveBeenCalled();
	});

	it("merges the affected sessions from queued events and forces only their directories", async () => {
		const { refresh } = await fixture();
		vi.spyOn(daemonSessionGitCache, "isStale").mockReturnValue(false);
		let started!: () => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockImplementationOnce(async () => {
				started();
				await held;
				return { branch: "before" };
			})
			.mockResolvedValue({ branch: "after" });
		const first = refresh({ sessionId: "one" });
		await reading;
		const queued = [
			refresh({ sessionId: "shared" }),
			refresh({ sessionId: "two" }),
			refresh({ sessionId: "two" }),
		];
		release();
		await Promise.all([first, ...queued]);
		expect(read.mock.calls.map(([directory]) => directory).sort()).toEqual([
			"/one",
			"/one",
			"/two",
		]);
	});

	it("can refresh again after a failed read", async () => {
		const { refresh } = await fixture();
		const read = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockRejectedValueOnce(new Error("git failed"))
			.mockResolvedValue({ branch: "recovered" });
		await expect(refresh({ sessionId: "one" })).rejects.toThrow();
		await refresh({ sessionId: "one" });
		expect(read.mock.calls.map(([directory]) => directory)).toEqual([
			"/one",
			"/one",
		]);
	});

	it("keeps polling stale-only when a forced event is merged into its follow-up", async () => {
		const { refresh } = await fixture();
		vi.spyOn(daemonSessionGitCache, "isStale").mockReturnValue(false);
		let started!: () => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockImplementationOnce(async () => {
				started();
				await held;
				return { branch: "before" };
			})
			.mockResolvedValue({ branch: "after" });
		const first = refresh({ sessionId: "one" });
		await reading;
		const queued = [
			refresh({ staleOnly: true }),
			refresh({ sessionId: "two" }),
		];
		release();
		await Promise.all([first, ...queued]);
		expect(read.mock.calls.map(([directory]) => directory)).toEqual([
			"/one",
			"/two",
		]);
	});

	it("releases the refresh slot after interruption", async () => {
		const { runtime } = await fixture();
		let started!: () => void;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockImplementationOnce(async () => {
				started();
				await held;
				return { branch: "cancelled" };
			})
			.mockResolvedValue({ branch: "recovered" });
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const service = yield* SessionGitServiceTag;
					const running = yield* Effect.fork(
						service.refresh({ sessionId: "one" }),
					);
					yield* Effect.promise(() => reading);
					yield* Fiber.interrupt(running);
					yield* service.refresh({ sessionId: "one" });
				}),
			);
			expect(read.mock.calls.map(([directory]) => directory)).toEqual([
				"/one",
				"/one",
			]);
		} finally {
			release();
		}
	});
});
