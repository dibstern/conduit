import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import { partialFake } from "../../../helpers/partial-fake.js";
import { assertProviderRuntimeStreamInvariants } from "../../../helpers/provider-runtime-stream-invariants.js";

it("replays captured goal set, nine not-yet checks, status, and clear", async () => {
	const messages = readFileSync(
		join(
			import.meta.dirname,
			"../../../fixtures/claude-sdk-traces/goal-not-met-status-clear.jsonl",
		),
		"utf8",
	)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => decodeClaudeSDKMessage(JSON.parse(line)));
	const events: ProviderRuntimeEvent[] = [];
	const sink = partialFake<EventSink>({
		push: (event) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
	});
	const ctx = partialFake<ClaudeSessionContext>({
		sessionId: "goal-replay-session",
		workspaceRoot: "/tmp/goal-replay",
		startedAt: "2026-10-02T00:00:00.000Z",
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: sink,
		currentTurnId: "goal-replay-turn",
		currentModel: "claude-fable-5",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		cumulativeTokens: 312,
	});
	const readGoalStatus = vi.fn(async () => undefined);
	const translator = new ClaudeEventTranslator({
		getSink: () => sink,
		readGoalStatus,
	});
	const setAt = 1_759_363_200_000;
	const clock = vi.spyOn(Date, "now").mockReturnValue(setAt);
	try {
		for (const message of messages) {
			await Effect.runPromise(translator.translate(ctx, message));
		}
	} finally {
		clock.mockRestore();
	}

	const condition =
		"The file tick.txt exists in the working directory AND the user has typed the exact message GO-AHEAD in this conversation";
	const reasons = messages.flatMap((message) => {
		if (message.type !== "user" || !message.isSynthetic) return [];
		const content = message.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n");
		const prefix = `Stop hook feedback:\n[${condition}]: `;
		return text.startsWith(prefix) ? [text.slice(prefix.length)] : [];
	});
	expect(reasons).toHaveLength(9);
	const goal = { condition, setAt, tokensAtStart: 312 };
	expect(
		events.flatMap((event) =>
			event.type === "session.goal_changed" ? [event.data] : [],
		),
	).toEqual([
		{ sessionId: ctx.sessionId, goal: { ...goal, iterations: 0 } },
		...reasons.map((lastReason, index) => ({
			sessionId: ctx.sessionId,
			goal: { ...goal, iterations: index + 1, lastReason },
		})),
		{
			sessionId: ctx.sessionId,
			goal: null,
			ended: "cleared",
			endedGoal: { ...goal, iterations: 9, lastReason: reasons[8] },
			endedAt: setAt,
		},
	]);
	expect(readGoalStatus).toHaveBeenCalledTimes(2);
	assertProviderRuntimeStreamInvariants(events);
});
