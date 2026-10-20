// Failure modes: first launch hands off instead of forking, retry forks twice,
// an unlaunched ancestor loses its cut, a missing/unmappable transcript is resumed,
// and a different account accidentally inherits a native transcript.
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import type { ClaudeSessionForkSdk } from "../../../../src/lib/provider/claude/claude-session-fork.js";
import { makePrepareTurn } from "../../../../src/lib/provider/claude/prepare-turn.js";

const configDir = configuredClaudeConfigDir("/fixture/claude");
const transcript: SessionMessage[] = [
	{
		type: "user",
		uuid: "question",
		session_id: "source-native",
		parent_tool_use_id: null,
		parent_agent_id: null,
		message: { content: "Question" },
	},
	{
		type: "assistant",
		uuid: "answer-uuid",
		session_id: "source-native",
		parent_tool_use_id: null,
		parent_agent_id: null,
		message: { id: "answer", content: "Answer" },
	},
];

describe("Claude fork preparation", () => {
	it.each([
		"first",
		"retry",
		"ancestor",
		"missing",
		"unmappable",
		"other-account",
	] as const)("prepares %s from durable fork data", async (scenario) => {
		const reads = vi.fn(async (id: string) => {
			if (id === "fork" && scenario === "retry") return transcript;
			if (id === "source-native" && scenario !== "missing") return transcript;
			throw new Error("Transcript missing");
		});
		const sdk: ClaudeSessionForkSdk = {
			readTranscript: reads,
			forkSession: vi.fn(async () => ({ sessionId: "unexpected" })),
		};
		const prepared = await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const state = yield* ProviderStateEffectTag;
				yield* commit([
					canonicalEvent("session.created", "source", {
						sessionId: "source",
						title: "Source",
						provider: "claude",
					}),
					canonicalEvent(
						"message.created",
						"source",
						{
							sessionId: "source",
							messageId: "answer",
							role: "assistant",
						},
						{ createdAt: 1 },
					),
					canonicalEvent("text.delta", "source", {
						messageId: "answer",
						partId: "answer:text",
						text: "Canonical history",
					}),
				]);
				yield* state.saveUpdates("source", [
					{
						key: "nativeThread:claude",
						value: JSON.stringify({
							resumeSessionId: "source-native",
							configDir,
							firstSequence: 0,
							deliveredThrough: 100,
						}),
					},
				]);
				if (scenario === "ancestor")
					yield* commit([
						canonicalEvent("session.created", "unlaunched", {
							sessionId: "unlaunched",
							title: "Unlaunched",
							provider: "claude",
							forkedFrom: "source",
							forkPointMessageId: "answer",
							forkPointTimestamp: 1,
							inheritsHistory: true,
						}),
					]);
				yield* commit([
					canonicalEvent("session.created", "fork", {
						sessionId: "fork",
						title: "Fork",
						provider: "claude",
						forkedFrom: scenario === "ancestor" ? "unlaunched" : "source",
						forkPointMessageId:
							scenario === "unmappable"
								? "missing"
								: scenario === "ancestor"
									? "answer_unlaunched"
									: "answer",
						forkPointTimestamp: 1,
						inheritsHistory: true,
					}),
				]);
				const prepare = yield* makePrepareTurn({
					configDir,
					folderSource: "account",
					sessionForkSdk: sdk,
					workspaceRoot: "/fixture/workspace",
				});
				return yield* prepare(
					"fork",
					scenario === "other-account" ? "other" : "claude",
					"Current question",
				);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
		if (["missing", "unmappable", "other-account"].includes(scenario)) {
			expect(prepared.resumeSessionId).toBeUndefined();
			expect(prepared.handoff).toBeDefined();
			expect(prepared.prompt).toContain("Canonical history");
		} else {
			expect(prepared).toMatchObject({
				resumeSessionId: scenario === "retry" ? "fork" : "source-native",
				clearInheritedGoal: true,
			});
			if (scenario === "retry")
				expect(prepared).not.toHaveProperty("forkSession");
			else
				expect(prepared).toMatchObject({
					forkSession: true,
					resumeSessionAt: "answer-uuid",
				});
			expect(prepared.prompt).toBe("Current question");
		}
		expect(sdk.forkSession).not.toHaveBeenCalled();
	});
});
