import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../src/lib/contracts/providers/opencode-sdk.js";
import {
	createOpenCodeReconciler,
	type EmitToDirectory,
	type OpenCodeReconcileClient,
} from "../../../src/lib/domain/daemon/Layers/opencode-instances-reconcile.js";
import { createSilentLogger } from "../../../src/lib/logger.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// Failure modes: reads outlive reset/stop, reuse of the same client bypasses
// invalidation, or removing and re-adding a directory accepts its old reads.
describe("OpenCode reconcile read fencing", () => {
	let reconciler: ReturnType<typeof createOpenCodeReconciler>;
	const emit = vi.fn<EmitToDirectory>();
	const onChange = vi.fn<() => void>();
	const directory = "/project";

	beforeEach(() => {
		vi.useFakeTimers();
		emit.mockClear();
		onChange.mockClear();
		reconciler = createOpenCodeReconciler({
			emit,
			onChange,
			log: createSilentLogger(),
			pollIntervalMs: 10,
		});
	});

	afterEach(() => {
		reconciler.reset();
		vi.useRealTimers();
	});

	it.each([
		"reset",
		"reset and reconnect",
		"forget and resubscribe",
	])("ignores deferred list reads after %s", async (action) => {
		const statuses = deferred<Record<string, SessionStatus>>();
		const permissions = deferred<{ id: string }[]>();
		const questions = deferred<{ id: string }[]>();
		const client: OpenCodeReconcileClient = {
			session: {
				statuses: vi
					.fn<OpenCodeReconcileClient["session"]["statuses"]>()
					.mockReturnValueOnce(statuses.promise)
					.mockResolvedValue({}),
			},
			permission: {
				list: vi
					.fn<OpenCodeReconcileClient["permission"]["list"]>()
					.mockReturnValueOnce(permissions.promise)
					.mockResolvedValue([]),
			},
			question: {
				list: vi
					.fn<OpenCodeReconcileClient["question"]["list"]>()
					.mockReturnValueOnce(questions.promise)
					.mockResolvedValue([]),
			},
		};
		const oldRead = reconciler.reconcile(client, [directory]);
		if (action === "forget and resubscribe") reconciler.forget(directory);
		else reconciler.reset();
		if (action !== "reset") await reconciler.reconcile(client, [directory]);

		statuses.resolve({ "old-session": { type: "busy" } });
		permissions.resolve([{ id: "old-permission" }]);
		questions.resolve([{ id: "old-question" }]);
		await oldRead;

		expect(emit).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
		expect(reconciler.active()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		"reset",
		"reset and reconnect",
		"forget and resubscribe",
	])("ignores a deferred status poll after %s", async (action) => {
		const statuses = deferred<Record<string, SessionStatus>>();
		const client: OpenCodeReconcileClient = {
			session: {
				statuses: vi
					.fn<OpenCodeReconcileClient["session"]["statuses"]>()
					.mockResolvedValueOnce({ "old-session": { type: "busy" } })
					.mockReturnValueOnce(statuses.promise)
					.mockResolvedValue({}),
			},
			permission: { list: async () => [] },
			question: { list: async () => [] },
		};
		await reconciler.reconcile(client, [directory]);
		await vi.advanceTimersByTimeAsync(10);
		expect(client.session.statuses).toHaveBeenCalledTimes(2);
		if (action === "forget and resubscribe") reconciler.forget(directory);
		else reconciler.reset();
		if (action !== "reset") await reconciler.reconcile(client, [directory]);
		emit.mockClear();
		onChange.mockClear();

		statuses.resolve({ "old-session": { type: "busy" } });
		await vi.advanceTimersByTimeAsync(0);

		expect(emit).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
		expect(reconciler.active()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
});
