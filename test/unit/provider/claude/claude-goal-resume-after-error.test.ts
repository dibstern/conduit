import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import { ClaudeGoalTracker } from "../../../../src/lib/provider/claude/claude-goal-tracker.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { partialFake } from "../../../helpers/partial-fake.js";

// A usage limit pauses the goal. When the user continues and the next turn
// succeeds while waiting on background work, Claude writes only a sentinel goal
// check (or none), so no new goal fact arrives to clear the pause.
it("clears a paused goal when a later turn succeeds", async () => {
	const goal = {
		condition: "Ship it",
		iterations: 0,
		setAt: 1,
		tokensAtStart: 0,
	};
	const events: ProviderRuntimeEvent[] = [];
	const sink = partialFake<EventSink>({
		push: (event) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
	});
	const sessionId = "goal-resume-session";
	const ctx = partialFake<ClaudeSessionContext>({
		sessionId,
		workspaceRoot: "/tmp/goal-resume",
		startedAt: "2026-10-06T00:00:00.000Z",
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: sink,
		currentTurnId: "turn",
		currentModel: "claude-opus-5-5",
		resumeSessionId: "sdk-session",
		lastAssistantUuid: "assistant-1",
		turnCount: 0,
		stopped: false,
		cumulativeTokens: 0,
		goalTracker: new ClaudeGoalTracker(sessionId, {
			sessionId,
			goal,
			pausedReason: "You've hit your session limit",
		}),
	});
	const translator = new ClaudeEventTranslator({
		getSink: () => sink,
		readGoalStatus: vi.fn(async () => ({
			met: false,
			sentinel: true,
			condition: goal.condition,
		})),
	});
	const result = partialFake<SDKMessage>({
		type: "result",
		subtype: "success",
		is_error: false,
		result: "",
		session_id: "sdk-session",
		uuid: "result-1",
		duration_ms: 1,
		num_turns: 1,
		total_cost_usd: 0,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
	} as never);

	await Effect.runPromise(translator.translate(ctx, result));

	expect(
		events.flatMap((event) =>
			event.type === "session.goal_changed" ? [event.data] : [],
		),
	).toEqual([{ sessionId, goal }]);
});
