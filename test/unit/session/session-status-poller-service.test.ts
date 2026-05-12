import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	createStatusPollerService,
	makeDeferredStatusPollerRuntime,
	makePollerPubSubLive,
	makePollerStateLive,
} from "../../../src/lib/effect/session-status-poller.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";

const pollerLayer = () =>
	Layer.mergeAll(makePollerStateLive(), makePollerPubSubLive());

const waitFor = async (assertion: () => void, timeout = 1000) => {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < timeout) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw lastError;
};

describe("createStatusPollerService deferred runtime", () => {
	it("defers registration and start work until a runtime is attached", async () => {
		let rawStatuses: Record<string, SessionStatus> = {
			s1: { type: "idle" },
		};
		const getRawStatuses = vi.fn(() => Effect.succeed(rawStatuses));
		const changed = vi.fn();
		const deferredRuntime = makeDeferredStatusPollerRuntime();
		const service = createStatusPollerService({
			pollDeps: {
				getRawStatuses,
				getSessionParentMap: () => new Map(),
				resolveParent: () => Effect.succeed(undefined),
			},
			interval: 60_000,
			runtime: deferredRuntime,
		});

		service.on("changed", changed);
		service.start();
		expect(getRawStatuses).not.toHaveBeenCalled();

		const runtime = ManagedRuntime.make(pollerLayer());
		try {
			deferredRuntime.attach(runtime);
			await waitFor(() => expect(getRawStatuses).toHaveBeenCalledTimes(1));
			expect(changed).not.toHaveBeenCalled();

			rawStatuses = { s1: { type: "busy" } };
			service.markMessageActivity("s1");
			await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
			expect(changed).toHaveBeenLastCalledWith({ s1: { type: "busy" } }, true);
		} finally {
			await service.drain();
			await runtime.dispose();
		}
	});

	it("does not start a queued poll after drain runs before attach", async () => {
		const getRawStatuses = vi.fn(() =>
			Effect.succeed({ s1: { type: "idle" } satisfies SessionStatus }),
		);
		const deferredRuntime = makeDeferredStatusPollerRuntime();
		const service = createStatusPollerService({
			pollDeps: {
				getRawStatuses,
				getSessionParentMap: () => new Map(),
				resolveParent: () => Effect.succeed(undefined),
			},
			interval: 60_000,
			runtime: deferredRuntime,
		});

		service.start();
		await service.drain();

		const runtime = ManagedRuntime.make(pollerLayer());
		try {
			deferredRuntime.attach(runtime);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(getRawStatuses).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});
});
