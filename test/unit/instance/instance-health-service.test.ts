import { Cause, Effect, Exit, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceHealthCheckLiveService } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";

const instance: OpenCodeInstance = {
	id: "health-check",
	name: "Health check",
	port: 0,
	managed: false,
	status: "healthy",
	restartCount: 0,
	createdAt: 0,
	env: { OPENCODE_SERVER_PASSWORD: "" },
};

afterEach(() => vi.unstubAllGlobals());

describe("InstanceHealthCheckLiveService", () => {
	it.each([
		"",
		"password",
	])("aborts the underlying fetch when interrupted with password %j", async (password) => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let signal: AbortSignal | null | undefined;
		const aborted = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, options) =>
				new Promise<Response>((_resolve, reject) => {
					signal = options?.signal;
					signal?.addEventListener(
						"abort",
						() => {
							aborted();
							reject(new DOMException("Aborted", "AbortError"));
						},
						{ once: true },
					);
					markStarted?.();
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const fiber = Effect.runFork(
			InstanceHealthCheckLiveService.check({
				instance: {
					...instance,
					env: { OPENCODE_SERVER_PASSWORD: password },
				},
				url: "http://health-check.test",
			}),
		);
		try {
			await started;
			const exit = await Effect.runPromise(Fiber.interrupt(fiber));
			expect(fetch).toHaveBeenCalledOnce();
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
			}
			expect(aborted).toHaveBeenCalledOnce();
			expect(signal?.aborted).toBe(true);
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});

	it.each([true, false])("returns the API health value %s", async (healthy) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ healthy })),
		);
		expect(
			await Effect.runPromise(
				InstanceHealthCheckLiveService.check({
					instance,
					url: "http://health-check.test",
				}),
			),
		).toBe(healthy);
	});

	it("returns false when fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("Fetch failed")),
		);
		expect(
			await Effect.runPromise(
				InstanceHealthCheckLiveService.check({
					instance,
					url: "http://health-check.test",
				}),
			),
		).toBe(false);
	});
});
