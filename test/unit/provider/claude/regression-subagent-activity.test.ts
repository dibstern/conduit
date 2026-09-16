// ─── Regression: activity indicators must survive a subagent wait ───────────
// The composer bounce bar and the sidebar processing dot are both driven by
// the parent session's projected status. The Claude SDK's main chain goes
// assistant-silent for the whole time it is blocked on a Task subagent; the
// only status it emits in that window is `system/status: "requesting"` — which
// means "issuing an API call", i.e. maximally busy. Translating it to idle
// (the old fall-through) told every UI surface the session had stopped, right
// as the main agent resumed. Replays a real captured subagent turn.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

const TRACE = join(
	import.meta.dirname,
	"../../../fixtures/claude-sdk-traces/subagent-task-turn.jsonl",
);

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

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: "parent-session",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-08-12T00:00:00.000Z",
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
		turnInFlight: true,
		currentModel: "claude-sonnet-5",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

async function replay(
	ctx: ClaudeSessionContext = makeCtx(),
): Promise<ProviderRuntimeEvent[]> {
	const sink = makeStubSink();
	const translator = new ClaudeEventTranslator({ getSink: () => sink });
	for (const line of readFileSync(TRACE, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const message = decodeClaudeSDKMessage(JSON.parse(line)) as SDKMessage;
		await Effect.runPromise(translator.translate(ctx, message));
	}
	return sink.events;
}

const statusOf = (event: ProviderRuntimeEvent): string =>
	String((event.data as { status?: unknown }).status);

describe("subagent turn keeps the parent session busy", () => {
	it("never reports the parent idle between the first busy and turn completion", async () => {
		const events = await replay();
		const firstBusy = events.findIndex(
			(e) => e.type === "session.status" && statusOf(e) === "busy",
		);
		const turnEnd = events.findIndex((e) => e.type === "turn.completed");
		expect(firstBusy).toBeGreaterThanOrEqual(0);
		expect(turnEnd).toBeGreaterThan(firstBusy);

		const midTurnIdle = events
			.slice(firstBusy + 1, turnEnd)
			.filter((e) => e.type === "session.status" && statusOf(e) === "idle");

		expect(midTurnIdle, "parent session reported idle mid-turn").toEqual([]);
	});

	it("releases the busy lease when the turn terminates", async () => {
		const events = await replay();
		const turnEnd = events.findIndex((e) => e.type === "turn.completed");
		expect(turnEnd).toBeGreaterThanOrEqual(0);
		// The SDK emits no "no operation" status of its own — the terminal turn
		// message is the only authoritative stop signal. Without this the
		// sidebar dot would stick on forever (the mirror-image failure).
		const after = events
			.slice(turnEnd)
			.filter((e) => e.type === "session.status");
		expect(after.map(statusOf)).toEqual(["idle"]);
	});

	it("stays quiet when init lands after the prompt has started", async () => {
		const events = await replay();
		const firstBusy = events.findIndex(
			(e) => e.type === "session.status" && statusOf(e) === "busy",
		);
		expect(firstBusy).toBeGreaterThanOrEqual(0);
		// system/init arrives ~1s AFTER the prompt is submitted. Conduit renders
		// its idle as a synthetic `done`, which idles the composer and fires the
		// completion notifications — at the top of every session's first turn.
		const beforeBusy = events
			.slice(0, firstBusy)
			.filter((e) => e.type === "session.status");
		expect(beforeBusy.map(statusOf), "init idled a live turn").toEqual([]);
	});

	it("still clears a stale busy when init lands with no turn running", async () => {
		const events = await replay({ ...makeCtx(), turnInFlight: false });
		// The mirror case: a crash mid-turn strands the session busy, and init
		// on the next connect is the only thing that clears it.
		const first = events.find((e) => e.type === "session.status");
		expect(first && statusOf(first)).toBe("idle");
	});

	it("reports busy when the SDK says it is requesting", async () => {
		const events = await replay();
		const fromStatus = events.filter(
			(e) => e.type === "session.status" && statusOf(e) === "busy",
		);
		// Two `system/status: requesting` messages in the trace, one of them
		// after the subagent finished — the moment the old mapping idled the UI.
		expect(fromStatus.length).toBeGreaterThanOrEqual(2);
	});
});
