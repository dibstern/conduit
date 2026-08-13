// test/e2e/provider/claude-provider-instance-real-sdk.test.ts
/**
 * E2E test for ClaudeProviderInstance.sendTurnEffect() against the real Claude Agent SDK.
 *
 * This test makes a real API call to Anthropic's API using your OAuth session.
 * It is gated behind the RUN_EXPENSIVE_E2E=1 environment variable and is
 * NEVER included in `pnpm test` or `pnpm test:unit`. Run it explicitly:
 *
 *   pnpm test:e2e:expensive-real-prompts
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { ClaudeProviderInstance } from "../../../src/lib/provider/claude/claude-provider-instance.js";
import type { EventSink } from "../../../src/lib/provider/types.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";

// ─── Collecting EventSink ──────────────────────────────────────────────────

function createCollectingEventSink(): EventSink & {
	readonly events: ProviderRuntimeEvent[];
} {
	const events: ProviderRuntimeEvent[] = [];
	return {
		events,
		push: (event: ProviderRuntimeEvent) =>
			Effect.sync(() => {
				events.push(event);
			}),
		requestPermission: () => Effect.succeed({ decision: "once" }),
		requestQuestion: () => Effect.succeed({}),
		resolvePermission: () => Effect.void,
		resolveQuestion: () => Effect.void,
	};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_EXPENSIVE)("ClaudeProviderInstance E2E (real SDK)", () => {
	it(
		"full turn: sendTurnEffect() resolves with completed TurnResult and emits canonical events",
		async () => {
			const instance = new ClaudeProviderInstance({
				workspaceRoot: process.cwd(),
				// No queryFactory override — uses the real SDK
			});

			const sink = createCollectingEventSink();
			const abortController = new AbortController();

			const result = await Effect.runPromise(
				instance.sendTurnEffect({
					sessionId: `e2e-real-sdk-test-${Date.now()}`,
					turnId: "turn-1",
					prompt: "Reply with exactly: hello world",
					history: [],
					providerState: {},
					model: { providerId: "claude", modelId: "claude-haiku-4-5" },
					workspaceRoot: process.cwd(),
					eventSink: sink,
					abortSignal: abortController.signal,
				}),
			);

			// ── TurnResult assertions ──────────────────────────────────────
			expect(result.status).toBe("completed");
			expect(result.tokens.input).toBeGreaterThan(0);
			expect(result.tokens.output).toBeGreaterThan(0);
			expect(result.cost).toBeLessThan(0.5);

			// ── Canonical event assertions ──────────────────────────────────
			const eventTypes = sink.events.map((e) => e.type);

			// Must include a turn.completed event
			expect(eventTypes).toContain("turn.completed");

			// Clean up the provider instance
			await Effect.runPromise(instance.shutdownEffect());
		},
		{ timeout: 120_000 },
	);

	// The activity indicators (composer bounce bar, sidebar processing dot) are
	// both driven by session.status. The main agent goes assistant-silent for as
	// long as it is blocked on a Task subagent, which is where they used to go
	// dark. The fixture replay in test/unit/provider/claude covers this against a
	// captured trace; this one proves the live SDK still orders things that way.
	it(
		"subagent turn: stays busy from the prompt until the result",
		async () => {
			const instance = new ClaudeProviderInstance({
				workspaceRoot: process.cwd(),
			});
			const sink = createCollectingEventSink();
			const abortController = new AbortController();

			const result = await Effect.runPromise(
				instance.sendTurnEffect({
					sessionId: `e2e-real-sdk-subagent-${Date.now()}`,
					turnId: "turn-1",
					prompt:
						"Use the Task tool to launch exactly one general-purpose subagent " +
						"whose entire job is to reply with the word banana. Do not do the " +
						"work yourself. Once it returns, reply with exactly: done",
					history: [],
					providerState: {},
					model: { providerId: "claude", modelId: "claude-haiku-4-5" },
					workspaceRoot: process.cwd(),
					eventSink: sink,
					abortSignal: abortController.signal,
				}),
			);

			expect(result.status).toBe("completed");

			// Without a real Task the rest of this proves nothing.
			const usedSubagent = sink.events.some(
				(e) =>
					e.type === "tool.started" &&
					(e.data as { toolName?: string }).toolName === "Task",
			);
			expect(usedSubagent, "the model never launched a subagent").toBe(true);

			const statusOf = (e: ProviderRuntimeEvent): string =>
				String((e.data as { status?: unknown }).status);
			const isStatus = (e: ProviderRuntimeEvent) => e.type === "session.status";
			const turnEnd = sink.events.findIndex((e) => e.type === "turn.completed");
			expect(turnEnd).toBeGreaterThan(0);

			// Nothing may report idle before the turn ends — not system/init a
			// second after the prompt, and not the "requesting" status the main
			// chain emits while the subagent holds it.
			const midTurn = sink.events.slice(0, turnEnd).filter(isStatus);
			expect(
				midTurn.filter((e) => statusOf(e) === "idle"),
				"session reported idle mid-turn",
			).toEqual([]);
			expect(midTurn.length).toBeGreaterThan(0);

			// And the lease is released exactly once, or the indicators stick on.
			expect(sink.events.slice(turnEnd).filter(isStatus).map(statusOf)).toEqual(
				["idle"],
			);

			await Effect.runPromise(instance.shutdownEffect());
		},
		{ timeout: 180_000 },
	);
});
