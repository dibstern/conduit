// test/unit/provider/claude/claude-reported-permission-mode.test.ts
//
// The Claude Agent SDK owns the live permission mode: it echoes the mode it is
// actually running in on every turn's system/init, and again on a system/status
// whenever the mode changes mid-turn (e.g. leaving plan mode after an approved
// ExitPlanMode). Conduit's stored mode is a *request*; these messages are the
// answer. The translator reports the answer so the store and the picker stop
// showing a mode the session is not in.

import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

function makeStubSink(): EventSink & { events: ProviderRuntimeEvent[] } {
	const events: ProviderRuntimeEvent[] = [];
	return {
		events,
		push: vi.fn((event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				events.push(event);
			}),
		),
		requestPermission: vi.fn(() =>
			Effect.succeed({ decision: "once" as const }),
		),
		requestQuestion: vi.fn(() => Effect.succeed({})),
		resolvePermission: vi.fn(() => Effect.void),
		resolveQuestion: vi.fn(() => Effect.void),
	};
}

function makeCtx(
	sink: EventSink,
	overrides: Partial<ClaudeSessionContext> = {},
): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-05T00:00:00.000Z",
		promptQueue: {
			enqueue: vi.fn(),
			close: vi.fn(),
			[Symbol.asyncIterator]: vi.fn(),
		} as unknown as ClaudeSessionContext["promptQueue"],
		query: {} as unknown as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: sink,
		currentTurnId: "turn-1",
		currentModel: "claude-opus-4-6",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

function initWithMode(permissionMode: string): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		apiKeySource: "api_key",
		claude_code_version: "1.0.0",
		cwd: "/tmp/ws",
		tools: [],
		mcp_servers: [],
		model: "claude-opus-4-6",
		permissionMode,
		slash_commands: [],
		output_style: "text",
		skills: [],
		plugins: [],
		uuid: "00000000-0000-0000-0000-0000000000a1",
		session_id: "sdk-sess",
	} as unknown as SDKMessage;
}

function statusWithMode(permissionMode: string | undefined): SDKMessage {
	return {
		type: "system",
		subtype: "status",
		status: null,
		...(permissionMode === undefined ? {} : { permissionMode }),
		uuid: "00000000-0000-0000-0000-0000000000a2",
		session_id: "sdk-sess",
	} as unknown as SDKMessage;
}

const modeEvents = (sink: { events: ProviderRuntimeEvent[] }) =>
	sink.events.filter((e) => e.type === "session.permission_mode_changed");

describe("Claude translator — SDK-reported permission mode", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;

	beforeEach(() => {
		sink = makeStubSink();
		translator = new ClaudeEventTranslator({ getSink: () => sink });
	});

	it("reports the SDK's mode on init when it disagrees with conduit's", async () => {
		const ctx = makeCtx(sink, { reportedPermissionMode: "ask" });

		await Effect.runPromise(
			translator.translate(ctx, initWithMode("acceptEdits")),
		);

		expect(modeEvents(sink).map((e) => e.data)).toEqual([
			{ sessionId: "sess-1", mode: "acceptEdits" },
		]);
		expect(ctx.reportedPermissionMode).toBe("acceptEdits");
	});

	// Every turn emits init. Re-reporting an unchanged mode would append a
	// permission event per turn forever and rewrite the sessions row each time.
	it("stays silent when the SDK confirms the mode conduit already believes", async () => {
		const ctx = makeCtx(sink, { reportedPermissionMode: "acceptEdits" });

		await Effect.runPromise(
			translator.translate(ctx, initWithMode("acceptEdits")),
		);

		expect(modeEvents(sink)).toEqual([]);
	});

	// The first init of a session is the answer to a request conduit has not
	// heard back on yet, so it must land even though nothing has been reported.
	it("reports the first init of a session", async () => {
		const ctx = makeCtx(sink);

		await Effect.runPromise(translator.translate(ctx, initWithMode("plan")));

		expect(modeEvents(sink).map((e) => e.data)).toEqual([
			{ sessionId: "sess-1", mode: "plan" },
		]);
	});

	// The live signal: approving an ExitPlanMode drops the SDK out of plan mode
	// mid-turn, and a status message is the only notice conduit gets.
	it("reports a mid-turn mode change from a status message", async () => {
		const ctx = makeCtx(sink, { reportedPermissionMode: "plan" });

		await Effect.runPromise(
			translator.translate(ctx, statusWithMode("acceptEdits")),
		);

		expect(modeEvents(sink).map((e) => e.data)).toEqual([
			{ sessionId: "sess-1", mode: "acceptEdits" },
		]);
		expect(ctx.reportedPermissionMode).toBe("acceptEdits");
	});

	it("ignores a status message that carries no permission mode", async () => {
		const ctx = makeCtx(sink, { reportedPermissionMode: "plan" });

		await Effect.runPromise(
			translator.translate(ctx, statusWithMode(undefined)),
		);

		expect(modeEvents(sink)).toEqual([]);
		expect(ctx.reportedPermissionMode).toBe("plan");
	});

	// A future SDK mode conduit does not model must not be coerced onto one it
	// does — that would write a wrong mode into the store and the picker.
	it("ignores an SDK mode conduit does not model", async () => {
		const ctx = makeCtx(sink, { reportedPermissionMode: "full" });

		await Effect.runPromise(
			translator.translate(ctx, initWithMode("someFutureMode")),
		);

		expect(modeEvents(sink)).toEqual([]);
		expect(ctx.reportedPermissionMode).toBe("full");
	});
});
