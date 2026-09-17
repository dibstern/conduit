// test/unit/provider/claude/claude-plan-mode-exit.test.ts
//
// Plan mode's approval loop. The SDK asks for `ExitPlanMode` through the
// ordinary `canUseTool` callback, so conduit's existing permission card is
// already the approval UI. What makes it a *loop* is the mode change: an
// approved plan has to drop the session out of plan mode, or the SDK stays
// read-only and Claude goes on planning against a plan the user just accepted.
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudePermissionBridge } from "../../../../src/lib/provider/claude/claude-permission-bridge.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";
import type {
	EventSink,
	PermissionResponse,
} from "../../../../src/lib/provider/types.js";

function makeSink(): EventSink {
	return {
		push: vi.fn(() => Effect.void),
		requestPermission: vi.fn(() =>
			Effect.succeed({ decision: "once" as const }),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
}

function respondWith(sink: EventSink, response: unknown): void {
	(sink.requestPermission as ReturnType<typeof vi.fn>) = vi.fn(() =>
		Effect.succeed(response as PermissionResponse),
	);
}

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: "sess-plan",
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
		currentTurnId: "turn-1",
		currentModel: undefined,
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

const PLAN = "## Plan\n\n1. Do the thing\n2. Test the thing\n";

describe("plan mode exit approval", () => {
	let bridge: ClaudePermissionBridge;
	let sink: EventSink;
	let ctx: ClaudeSessionContext;
	const ac = new AbortController();
	const baseOptions = {
		signal: ac.signal,
		toolUseID: "tool-exit-plan",
		requestId: "req-exit-plan",
	};

	beforeEach(() => {
		sink = makeSink();
		ctx = makeCtx();
		bridge = new ClaudePermissionBridge({ sink });
	});

	it("drops the session out of plan mode when the plan is approved", async () => {
		respondWith(sink, { decision: "once" });

		const result = await bridge.canUseTool(
			ctx,
			"ExitPlanMode",
			{ plan: PLAN },
			baseOptions,
		);

		// Without this the SDK receives a bare allow, stays read-only, and the
		// user's approved plan produces nothing but more planning.
		expect(result).toMatchObject({ behavior: "allow" });
		expect(
			result.behavior === "allow" ? result.updatedPermissions : undefined,
		).toEqual([
			// "default" (conduit's "ask"), not acceptEdits: approving a plan is
			// approving the *plan*, not pre-approving every edit it implies.
			{ type: "setMode", mode: "default", destination: "session" },
		]);
	});

	it("uses the SDK's own exit suggestion in place of conduit's fallback", async () => {
		const suggested: PermissionUpdate = {
			type: "setMode",
			mode: "acceptEdits",
			destination: "session",
		};
		respondWith(sink, { decision: "once" });

		const result = await bridge.canUseTool(
			ctx,
			"ExitPlanMode",
			{ plan: PLAN },
			{ ...baseOptions, suggestions: [suggested] },
		);

		// The SDK knows which mode it wants the session to land in; conduit's
		// fallback exists for the case where it does not say.
		expect(
			result.behavior === "allow" ? result.updatedPermissions : undefined,
		).toEqual([suggested]);
	});

	it("ignores a suggestion that would leave the session in plan mode", async () => {
		respondWith(sink, { decision: "once" });

		const result = await bridge.canUseTool(
			ctx,
			"ExitPlanMode",
			{ plan: PLAN },
			{
				...baseOptions,
				suggestions: [
					{ type: "setMode", mode: "plan", destination: "session" },
				],
			},
		);

		expect(
			result.behavior === "allow" ? result.updatedPermissions : undefined,
		).toEqual([{ type: "setMode", mode: "default", destination: "session" }]);
	});

	it("keeps the session planning when the plan is rejected", async () => {
		respondWith(sink, { decision: "reject" });

		const result = await bridge.canUseTool(
			ctx,
			"ExitPlanMode",
			{ plan: PLAN },
			baseOptions,
		);

		// Rejecting is "keep planning", so the mode must survive untouched.
		expect(result.behavior).toBe("deny");
		expect(result).not.toHaveProperty("updatedPermissions");
	});

	it("does not add a mode change to an ordinary tool approval", async () => {
		respondWith(sink, { decision: "once" });

		const result = await bridge.canUseTool(
			ctx,
			"Bash",
			{ command: "ls" },
			{ ...baseOptions, toolUseID: "tool-bash", requestId: "req-bash" },
		);

		expect(
			result.behavior === "allow" ? result.updatedPermissions : undefined,
		).toBeUndefined();
	});

	it("does not double up when the user's own choice already exits plan mode", async () => {
		const chosen: PermissionUpdate = {
			type: "setMode",
			mode: "acceptEdits",
			destination: "session",
		};
		respondWith(sink, { decision: "always", permissionUpdates: [chosen] });

		const result = await bridge.canUseTool(
			ctx,
			"ExitPlanMode",
			{ plan: PLAN },
			baseOptions,
		);

		expect(
			result.behavior === "allow" ? result.updatedPermissions : undefined,
		).toEqual([chosen]);
	});
});
