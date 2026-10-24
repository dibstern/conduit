// Failure modes: concurrent callers bypass the cap; background work jumps the
// interactive queue; dedupe survives completion or cancellation kills another
// waiter; hung children hold slots; spawn errors leak capacity; metrics omit
// failed commands; read guards disappear at the legacy Promise boundary.
import { Effect, Exit, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeSubprocessLive } from "../../../src/lib/domain/daemon/Layers/subprocess-layer.js";
import { withReadRequest } from "../../../src/lib/domain/daemon/Services/read-request.js";
import {
	makeSubprocessRunner,
	Subprocess,
} from "../../../src/lib/domain/daemon/Services/subprocess.js";

const options = { cwd: process.cwd(), timeoutMs: 3_000 };
const waitUntil = async (predicate: () => Promise<boolean>) => {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Subprocess did not progress");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

describe("daemon subprocess owner", () => {
	it("shares its default across runtimes and preserves overrides across Promise awaits", async () => {
		expect(await Effect.runPromise(Subprocess)).toBe(
			await Effect.runPromise(Subprocess),
		);
		const runtime = ManagedRuntime.make(makeSubprocessLive());
		try {
			await runtime.runPromise(
				Effect.tryPromise(async () => {
					const run = makeSubprocessRunner();
					await Promise.resolve();
					await run("git", ["--version"], options);
				}),
			);
			const owner = await runtime.runPromise(Subprocess);
			expect((await runtime.runPromise(owner.metrics)).spawnCount).toBe(1);
		} finally {
			await runtime.dispose();
		}
	});
	it("captures both pipes, exit codes and timings, including spawn failures", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive());
		try {
			const owner = await runtime.runPromise(Subprocess);
			expect(
				await runtime.runPromise(owner.run("git", ["--version"], options)),
			).toMatchObject({ exitCode: 0, stderr: "" });
			expect(
				await runtime.runPromise(
					owner.run(
						"sh",
						["-c", "printf out; printf err >&2; exit 7"],
						options,
					),
				),
			).toEqual({ stdout: "out", stderr: "err", exitCode: 7 });
			const failed = await runtime.runPromise(
				Effect.result(owner.run("/nonexistent/conduit-command", [], options)),
			);
			expect(failed).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "SubprocessError", reason: "spawn", code: "ENOENT" },
			});
			const metrics = await runtime.runPromise(owner.metrics);
			expect(metrics.spawnCount).toBe(3);
			expect(metrics.commands["git"]?.spawnCount).toBe(1);
			expect(metrics.wallTimeMs).toBeGreaterThan(0);
			expect(metrics.spawnTimeMs).toBeGreaterThan(0);
			expect(metrics.active).toBe(0);
			expect(() => JSON.stringify(metrics)).not.toThrow();
		} finally {
			await runtime.dispose();
		}
	});

	it("caps real commands and runs queued interactive work first, FIFO within a priority", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive({ concurrency: 1 }));
		try {
			const owner = await runtime.runPromise(Subprocess);
			const order: string[] = [];
			const run = (
				name: string,
				priority: "interactive" | "background",
				delay = "0",
			) =>
				runtime
					.runPromise(
						owner.run("sh", ["-c", `sleep ${delay}; printf ${name}`], {
							...options,
							priority,
						}),
					)
					.then(({ stdout }) => {
						order.push(stdout);
					});
			const holding = run("holding", "background", "0.15");
			await waitUntil(
				async () => (await runtime.runPromise(owner.metrics)).active === 1,
			);
			await Promise.all([
				holding,
				run("background1", "background"),
				run("background2", "background"),
				run("interactive", "interactive"),
			]);
			expect(order).toEqual([
				"holding",
				"interactive",
				"background1",
				"background2",
			]);
			expect((await runtime.runPromise(owner.metrics)).maxActive).toBe(1);
		} finally {
			await runtime.dispose();
		}
	});

	it("uses four slots by default across independent callers", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive());
		try {
			const owner = await runtime.runPromise(Subprocess);
			await Promise.all(
				Array.from({ length: 9 }, () =>
					runtime.runPromise(owner.run("sh", ["-c", "sleep 0.05"], options)),
				),
			);
			expect(await runtime.runPromise(owner.metrics)).toMatchObject({
				maxActive: 4,
				active: 0,
				queued: 0,
				spawnCount: 9,
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("dedupes pending keys but does not cache completed commands", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive());
		try {
			const owner = await runtime.runPromise(Subprocess);
			const command = owner.run("sh", ["-c", "sleep 0.05; printf shared"], {
				...options,
				key: "shared",
			});
			const results = await Promise.all(
				Array.from({ length: 8 }, () => runtime.runPromise(command)),
			);
			expect(results.every(({ stdout }) => stdout === "shared")).toBe(true);
			expect((await runtime.runPromise(owner.metrics)).spawnCount).toBe(1);
			await runtime.runPromise(command);
			expect((await runtime.runPromise(owner.metrics)).spawnCount).toBe(2);
		} finally {
			await runtime.dispose();
		}
	});

	it("times out children, bounds output and releases the slot", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive({ concurrency: 1 }));
		try {
			const owner = await runtime.runPromise(Subprocess);
			expect(
				await runtime.runPromise(
					Effect.result(
						owner.run("sh", ["-c", "sleep 30"], {
							...options,
							timeoutMs: 30,
							killProcessGroup: true,
						}),
					),
				),
			).toMatchObject({ _tag: "Failure", failure: { reason: "timeout" } });
			expect(
				await runtime.runPromise(
					Effect.result(
						owner.run("sh", ["-c", "printf 123456789"], {
							...options,
							maxBuffer: 4,
						}),
					),
				),
			).toMatchObject({ _tag: "Failure", failure: { reason: "output-limit" } });
			expect(
				(await runtime.runPromise(owner.run("git", ["--version"], options)))
					.exitCode,
			).toBe(0);
			expect((await runtime.runPromise(owner.metrics)).active).toBe(0);
		} finally {
			await runtime.dispose();
		}
	});

	it("cancels queued work and preserves another deduped waiter", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive({ concurrency: 1 }));
		try {
			const owner = await runtime.runPromise(Subprocess);
			const controller = new AbortController();
			const command = owner.run("sh", ["-c", "sleep 0.1; printf kept"], {
				...options,
				key: "waiters",
			});
			const cancelled = runtime.runPromiseExit(command, {
				signal: controller.signal,
			});
			const kept = runtime.runPromise(command);
			const queuedController = new AbortController();
			const queued = runtime.runPromiseExit(
				owner.run("sh", ["-c", "printf never"], options),
				{ signal: queuedController.signal },
			);
			await waitUntil(
				async () => (await runtime.runPromise(owner.metrics)).queued === 1,
			);
			queuedController.abort();
			controller.abort();
			expect(Exit.isFailure(await cancelled)).toBe(true);
			expect(Exit.isFailure(await queued)).toBe(true);
			expect((await kept).stdout).toBe("kept");
			expect((await runtime.runPromise(owner.metrics)).spawnCount).toBe(1);
		} finally {
			await runtime.dispose();
		}
	});

	it("defects before spawning in a strict read, including a Promise runner", async () => {
		const runtime = ManagedRuntime.make(makeSubprocessLive());
		vi.stubEnv("CONDUIT_STRICT_READ_SPAWN", "1");
		try {
			const owner = await runtime.runPromise(Subprocess);
			expect(
				Exit.isFailure(
					await runtime.runPromise(
						Effect.exit(
							withReadRequest(
								owner.run("git", ["--version"], options),
								"GetSessions",
							),
						),
					),
				),
			).toBe(true);
			const runner = await runtime.runPromise(
				withReadRequest(Effect.sync(makeSubprocessRunner), "GetSessions"),
			);
			await expect(runner("git", ["--version"], options)).rejects.toThrow(
				"Subprocess requested during read RPC GetSessions",
			);
			expect((await runtime.runPromise(owner.metrics)).spawnCount).toBe(0);
			expect(
				(await runtime.runPromise(owner.run("git", ["--version"], options)))
					.exitCode,
			).toBe(0);
		} finally {
			vi.unstubAllEnvs();
			await runtime.dispose();
		}
	});
});
