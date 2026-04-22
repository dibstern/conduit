// test/unit/provider/claude/claude-permission-bridge.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudePermissionBridge } from "../../../../src/lib/provider/claude/claude-permission-bridge.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

function makeSink(): EventSink {
	return {
		push: vi.fn(async () => {}),
		requestPermission: vi.fn(async () => ({ decision: "once" as const })),
		requestQuestion: vi.fn(),
	};
}

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: new Date().toISOString(),
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {
			interrupt: vi.fn(),
			close: vi.fn(),
			setModel: vi.fn(),
			setPermissionMode: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: undefined,
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: undefined,
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

describe("ClaudePermissionBridge", () => {
	let bridge: ClaudePermissionBridge;
	let sink: EventSink;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeSink();
		ctx = makeCtx();
		bridge = new ClaudePermissionBridge({ sink });
	});

	it("creates a pending approval and blocks until resolved", async () => {
		let resolveSink: (v: unknown) => void = () => {};
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(
			() =>
				new Promise((r) => {
					resolveSink = r;
				}),
		);

		const ac = new AbortController();
		const callbackPromise = bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "ls" },
			{
				signal: ac.signal,
				toolUseID: "tool-abc",
			},
		);

		// Give the microtask queue a tick.
		await new Promise((r) => setTimeout(r, 0));
		expect(ctx.pendingApprovals.size).toBe(1);
		const pending = [...ctx.pendingApprovals.values()][0];
		expect(pending?.toolName).toBe("Bash");

		// Resolve with "once" decision
		resolveSink({ decision: "once" });
		const result = await callbackPromise;
		expect(result.behavior).toBe("allow");
		expect(ctx.pendingApprovals.size).toBe(0);
	});

	it("returns deny when user rejects", async () => {
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
			decision: "reject",
		}));
		const ac = new AbortController();
		const result = await bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "rm -rf /" },
			{
				signal: ac.signal,
				toolUseID: "tool-xyz",
			},
		);
		expect(result.behavior).toBe("deny");
	});

	it("returns deny when abort signal fires before user responds", async () => {
		let resolveSink: (v: unknown) => void = () => {};
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(
			() =>
				new Promise((r) => {
					resolveSink = r;
				}),
		);

		const ac = new AbortController();
		const callbackPromise = bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "sleep 60" },
			{
				signal: ac.signal,
				toolUseID: "tool-q",
			},
		);

		await new Promise((r) => setTimeout(r, 0));
		ac.abort();
		const result = await callbackPromise;
		expect(result.behavior).toBe("deny");
		expect(ctx.pendingApprovals.size).toBe(0);

		// Late resolver no-ops cleanly.
		resolveSink({ decision: "once" });
	});

	it("returns allow when decision is 'always'", async () => {
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
			decision: "always",
		}));
		const ac = new AbortController();
		const result = await bridge.canUseTool(
			ctx,
			"Read",
			{ file_path: "/etc/passwd" },
			{
				signal: ac.signal,
				toolUseID: "tool-r",
			},
		);
		expect(result.behavior).toBe("allow");
	});

	it("createCanUseTool returns a function with the CanUseTool signature", async () => {
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
			decision: "once",
		}));
		const canUseTool = bridge.createCanUseTool(ctx);
		expect(typeof canUseTool).toBe("function");

		const ac = new AbortController();
		const result = await canUseTool(
			"Bash",
			{ command: "echo hi" },
			{
				signal: ac.signal,
				toolUseID: "tool-create",
			},
		);
		expect(result.behavior).toBe("allow");
	});

	it("resolvePermission resolves the pending approval's deferred", async () => {
		// Use a sink that blocks forever (the bridge will resolve via resolvePermission)
		let resolveSink: (v: unknown) => void = () => {};
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(
			() =>
				new Promise((r) => {
					resolveSink = r;
				}),
		);

		const ac = new AbortController();
		const callbackPromise = bridge.canUseTool(
			ctx,
			"Read",
			{ file_path: "/tmp/test" },
			{
				signal: ac.signal,
				toolUseID: "tool-resolve",
			},
		);

		await new Promise((r) => setTimeout(r, 0));
		const pending = [...ctx.pendingApprovals.values()][0];
		expect(pending).toBeDefined();

		// Resolve via the bridge's resolvePermission (which resolves the deferred)
		await bridge.resolvePermission(ctx, pending?.requestId ?? "", "once");
		// Also resolve the sink promise so the bridge can complete
		resolveSink({ decision: "once" });

		const result = await callbackPromise;
		expect(result.behavior).toBe("allow");
	});

	it("resolvePermission is a no-op for unknown requestId", async () => {
		// Should not throw
		await bridge.resolvePermission(ctx, "unknown-id", "once");
	});

	it("concurrent canUseTool calls for different tools resolve independently", async () => {
		let resolveSinkA: (v: unknown) => void = () => {};
		let resolveSinkB: (v: unknown) => void = () => {};
		let callCount = 0;
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(() => {
			callCount++;
			if (callCount === 1) {
				return new Promise((r) => {
					resolveSinkA = r;
				});
			}
			return new Promise((r) => {
				resolveSinkB = r;
			});
		});

		const acA = new AbortController();
		const acB = new AbortController();

		const promiseA = bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "ls" },
			{
				signal: acA.signal,
				toolUseID: "tool-a",
			},
		);
		const promiseB = bridge.canUseTool(
			ctx,
			"Read",
			{ file_path: "/tmp" },
			{
				signal: acB.signal,
				toolUseID: "tool-b",
			},
		);

		// Let microtasks settle — both pending approvals should exist
		await new Promise((r) => setTimeout(r, 0));
		expect(ctx.pendingApprovals.size).toBe(2);

		// Resolve only the first call
		resolveSinkA({ decision: "once" });
		const resultA = await promiseA;
		expect(resultA.behavior).toBe("allow");

		// Second is still pending
		let bSettled = false;
		void promiseB.then(() => {
			bSettled = true;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(bSettled).toBe(false);

		// Now resolve the second call
		resolveSinkB({ decision: "reject" });
		const resultB = await promiseB;
		expect(resultB.behavior).toBe("deny");

		// All approvals cleaned up
		expect(ctx.pendingApprovals.size).toBe(0);
	});

	it("unexpected response shape from EventSink defaults to reject", async () => {
		// Return a weird shape from requestPermission
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(async () => ({
			decision: "invalid_value",
		}));

		const ac = new AbortController();
		const result = await bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "rm -rf /" },
			{ signal: ac.signal, toolUseID: "tool-weird" },
		);
		expect(result.behavior).toBe("deny");

		// Also test with empty object
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(
			async () => ({}),
		);
		const result2 = await bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "echo hi" },
			{ signal: ac.signal, toolUseID: "tool-empty" },
		);
		expect(result2.behavior).toBe("deny");

		// Also test with undefined
		(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(
			async () => undefined,
		);
		const result3 = await bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "echo bye" },
			{ signal: ac.signal, toolUseID: "tool-undef" },
		);
		expect(result3.behavior).toBe("deny");
	});
});
