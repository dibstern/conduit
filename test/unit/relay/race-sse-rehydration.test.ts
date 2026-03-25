import { describe, expect, it, vi } from "vitest";
import {
	type SSEWiringDeps,
	wireSSEConsumer,
} from "../../../src/lib/relay/sse-wiring.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a controllable deferred promise. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Build a mock SSE consumer whose `on` stores listeners in a Map. */
function createMockConsumer() {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	const consumer = {
		on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
			listeners.set(name, fn);
		}),
	} as unknown as Parameters<typeof wireSSEConsumer>[1];
	return { consumer, listeners };
}

/** Minimal pending question for rehydration. */
function makePendingQuestion(id: string, sessionID: string) {
	return {
		id,
		sessionID,
		questions: [{ question: "Pick one", options: [{ label: "A" }] }],
		tool: { callID: `call-${id}` },
	};
}

// ─── Race: rapid SSE reconnect duplicates question rehydration ───────────────

describe("race: SSE rehydration generation counter", () => {
	it("supersedes first rehydration when connected fires twice rapidly (questions)", async () => {
		// Two controllable question deferreds — one per connect
		const q1 = deferred<Array<{ id: string; [key: string]: unknown }>>();
		const q2 = deferred<Array<{ id: string; [key: string]: unknown }>>();

		let callCount = 0;
		const listPendingQuestions = vi.fn(() => {
			callCount++;
			return callCount === 1 ? q1.promise : q2.promise;
		});

		const deps = createMockSSEWiringDeps({
			listPendingQuestions,
		});
		// Remove permissions path so we focus on questions
		delete (deps as Partial<SSEWiringDeps>).listPendingPermissions;

		const { consumer, listeners } = createMockConsumer();
		wireSSEConsumer(deps, consumer);

		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		const fireConnected = listeners.get("connected")!;

		// ── Two rapid connects ──
		fireConnected();
		fireConnected();

		expect(listPendingQuestions).toHaveBeenCalledTimes(2);

		// Resolve the SECOND connect's questions first (server responded faster)
		const question = makePendingQuestion("que_1", "sess-a");
		q2.resolve([question]);
		await vi.waitFor(() => {
			expect(deps.wsHandler.sendToSession).toHaveBeenCalledTimes(1);
		});

		// Resolve the FIRST connect's questions (stale — should be superseded)
		q1.resolve([question]);
		// Give the microtask queue a tick to process
		await new Promise((r) => setTimeout(r, 10));

		// The stale rehydration must NOT broadcast again — total is still 1
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledTimes(1);
	});

	it("supersedes first rehydration when connected fires twice rapidly (permissions)", async () => {
		const p1 =
			deferred<
				Array<{ id: string; permission: string; [key: string]: unknown }>
			>();
		const p2 =
			deferred<
				Array<{ id: string; permission: string; [key: string]: unknown }>
			>();

		let callCount = 0;
		const listPendingPermissions = vi.fn(() => {
			callCount++;
			return callCount === 1 ? p1.promise : p2.promise;
		});

		const deps = createMockSSEWiringDeps({
			listPendingPermissions,
		});
		delete (deps as Partial<SSEWiringDeps>).listPendingQuestions;

		// Mock recoverPending to return recoverable permissions
		vi.mocked(deps.permissionBridge.recoverPending).mockImplementation(
			(input) =>
				input.map((p) => ({
					requestId:
						p.id as unknown as import("../../../src/lib/shared-types.js").PermissionId,
					sessionId: (p as Record<string, unknown>)["sessionId"] as string,
					toolName: p.permission,
					toolInput: {},
					always: [],
					timestamp: Date.now(),
				})),
		);

		const { consumer, listeners } = createMockConsumer();
		wireSSEConsumer(deps, consumer);

		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		const fireConnected = listeners.get("connected")!;

		// ── Two rapid connects ──
		fireConnected();
		fireConnected();

		expect(listPendingPermissions).toHaveBeenCalledTimes(2);

		const perm = { id: "perm-1", permission: "Bash", sessionID: "sess-b" };

		// Resolve second connect first
		p2.resolve([perm]);
		await vi.waitFor(() => {
			// broadcast is called once for connection_status per connect (2x)
			// plus once for the recovered permission
			const permCalls = vi
				.mocked(deps.wsHandler.broadcast)
				.mock.calls.filter(
					(c) => (c[0] as { type: string }).type === "permission_request",
				);
			expect(permCalls).toHaveLength(1);
		});

		// Resolve the stale first connect
		p1.resolve([perm]);
		await new Promise((r) => setTimeout(r, 10));

		// Still only 1 permission_request broadcast (stale was superseded)
		const permCalls = vi
			.mocked(deps.wsHandler.broadcast)
			.mock.calls.filter(
				(c) => (c[0] as { type: string }).type === "permission_request",
			);
		expect(permCalls).toHaveLength(1);
	});

	it("allows rehydration when only a single connect fires", async () => {
		const q = deferred<Array<{ id: string; [key: string]: unknown }>>();
		const listPendingQuestions = vi.fn(() => q.promise);

		const deps = createMockSSEWiringDeps({
			listPendingQuestions,
		});
		delete (deps as Partial<SSEWiringDeps>).listPendingPermissions;

		const { consumer, listeners } = createMockConsumer();
		wireSSEConsumer(deps, consumer);

		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("connected")!();

		const question = makePendingQuestion("que_2", "sess-c");
		q.resolve([question]);

		await vi.waitFor(() => {
			expect(deps.wsHandler.sendToSession).toHaveBeenCalledTimes(1);
		});

		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"sess-c",
			expect.objectContaining({ type: "ask_user", toolId: "que_2" }),
		);
	});
});
