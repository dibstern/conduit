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

// Failure modes: a status read sampled before a session's newest streamed
// status overwrites it (idle settles a running turn, busy pins a finished
// one), including busy -> idle -> busy while the read is out; a fence so broad
// that a missed idle is never healed; or a change on one session blocking
// another session's correction.
describe("OpenCode status reads fenced by streamed status", () => {
	const directory = "/project";
	const emit = vi.fn<EmitToDirectory>();
	let reconciler: ReturnType<typeof createOpenCodeReconciler>;
	const status = (sessionID: string, type: SessionStatus["type"]) => ({
		id: `evt_${sessionID}_${type}`,
		type: "session.status",
		properties: { sessionID, status: { type } },
	});
	const emitted = () =>
		emit.mock.calls.map(([, { properties }]) => [
			properties?.["sessionID"],
			(properties?.["status"] as SessionStatus).type,
		]);

	const pollClient = (read: Promise<Record<string, SessionStatus>>) => ({
		session: {
			statuses: vi
				.fn<OpenCodeReconcileClient["session"]["statuses"]>()
				.mockResolvedValueOnce({})
				.mockReturnValueOnce(read),
		},
		permission: { list: async () => [] },
		question: { list: async () => [] },
	});

	beforeEach(() => {
		vi.useFakeTimers();
		emit.mockClear();
		reconciler = createOpenCodeReconciler({
			emit,
			log: createSilentLogger(),
			pollIntervalMs: 10,
		});
	});

	afterEach(() => {
		reconciler.reset();
		vi.useRealTimers();
	});

	it.each([
		"poll",
		"reconcile",
	])("a %s ignores idle sampled before a native user input was accepted", async (readKind) => {
		const statuses = deferred<Record<string, SessionStatus>>();
		const client = pollClient(statuses.promise);
		await reconciler.reconcile(client, [directory]);
		reconciler.observe(directory, status("s", "busy"));
		const read =
			readKind === "reconcile"
				? reconciler.reconcile(client, [directory])
				: Promise.resolve();
		if (readKind === "poll") await vi.advanceTimersByTimeAsync(10);
		expect(client.session.statuses).toHaveBeenCalledTimes(2);
		reconciler.observe(directory, {
			id: "native-user",
			type: "message.updated",
			properties: { info: { id: "u", sessionID: "s", role: "user" } },
		});
		statuses.resolve({});
		await read;
		await vi.advanceTimersByTimeAsync(0);
		expect(emitted()).toEqual([]);
		expect(reconciler.active()).toBe(true);
	});

	it.each([
		{
			name: "a stale idle after busy -> idle -> busy",
			sent: [["s", "busy"]],
			during: [
				["s", "idle"],
				["s", "busy"],
			],
			read: {},
			active: true,
		},
		{
			name: "a stale busy after idle",
			sent: [
				["s", "busy"],
				["t", "busy"],
			],
			during: [["s", "idle"]],
			read: { s: { type: "busy" }, t: { type: "busy" } },
			active: true,
		},
	] as const)("a poll ignores $name", async ({
		sent,
		during,
		read,
		active,
	}) => {
		const statuses = deferred<Record<string, SessionStatus>>();
		const client = pollClient(statuses.promise);
		await reconciler.reconcile(client, [directory]);
		for (const [id, type] of sent)
			reconciler.observe(directory, status(id, type));
		await vi.advanceTimersByTimeAsync(10);
		expect(client.session.statuses).toHaveBeenCalledTimes(2);
		for (const [id, type] of during)
			reconciler.observe(directory, status(id, type));

		statuses.resolve(read as Record<string, SessionStatus>);
		await vi.advanceTimersByTimeAsync(0);

		expect(emitted()).toEqual([]);
		expect(reconciler.active()).toBe(active);
	});

	it("a reconcile ignores a session that went busy after the read was sent", async () => {
		const statuses = deferred<Record<string, SessionStatus>>();
		const client: OpenCodeReconcileClient = {
			session: { statuses: () => statuses.promise },
			permission: { list: async () => [] },
			question: { list: async () => [] },
		};
		const read = reconciler.reconcile(client, [directory]);
		reconciler.observe(directory, status("s", "busy"));
		statuses.resolve({});
		await read;

		expect(emitted()).toEqual([]);
		expect(reconciler.active()).toBe(true);
	});

	it("still heals a missed idle when only another session changed", async () => {
		const statuses = deferred<Record<string, SessionStatus>>();
		const client = pollClient(statuses.promise);
		await reconciler.reconcile(client, [directory]);
		reconciler.observe(directory, status("s", "busy"));
		reconciler.observe(directory, status("t", "busy"));
		await vi.advanceTimersByTimeAsync(10);
		reconciler.observe(directory, status("t", "idle"));

		statuses.resolve({ t: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(0);

		expect(emitted()).toEqual([["s", "idle"]]);
		expect(reconciler.active()).toBe(false);
	});
});
