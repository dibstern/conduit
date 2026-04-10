// test/e2e/provider/claude-adapter-real-sdk.test.ts
/**
 * E2E test for ClaudeAdapter.sendTurn() against the real Claude Agent SDK.
 *
 * This test makes a real API call to Anthropic's API using your OAuth session.
 * It is gated behind the RUN_EXPENSIVE_E2E=1 environment variable and is
 * NEVER included in `pnpm test` or `pnpm test:unit`. Run it explicitly:
 *
 *   pnpm test:e2e:expensive-real-prompts
 */
import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { ClaudeAdapter } from "../../../src/lib/provider/claude/claude-adapter.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "../../../src/lib/provider/types.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";

// ─── Collecting EventSink ──────────────────────────────────────────────────

function createCollectingEventSink(): EventSink & {
	readonly events: CanonicalEvent[];
} {
	const events: CanonicalEvent[] = [];
	return {
		events,
		async push(event: CanonicalEvent): Promise<void> {
			events.push(event);
		},
		async requestPermission(
			_request: PermissionRequest,
		): Promise<PermissionResponse> {
			return { decision: "once" };
		},
		async requestQuestion(
			_request: QuestionRequest,
		): Promise<Record<string, unknown>> {
			return {};
		},
	};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_EXPENSIVE)("ClaudeAdapter E2E (real SDK)", () => {
	it(
		"full turn: sendTurn() resolves with completed TurnResult and emits canonical events",
		async () => {
			const adapter = new ClaudeAdapter({
				workspaceRoot: process.cwd(),
				// No queryFactory override — uses the real SDK
			});

			const sink = createCollectingEventSink();
			const abortController = new AbortController();

			const result = await adapter.sendTurn({
				sessionId: `e2e-real-sdk-test-${Date.now()}`,
				turnId: "turn-1",
				prompt: "Reply with exactly: hello world",
				history: [],
				providerState: {},
				model: { providerId: "claude", modelId: "claude-haiku-4-5" },
				workspaceRoot: process.cwd(),
				eventSink: sink,
				abortSignal: abortController.signal,
			});

			// ── TurnResult assertions ──────────────────────────────────────
			expect(result.status).toBe("completed");
			expect(result.tokens.input).toBeGreaterThan(0);
			expect(result.tokens.output).toBeGreaterThan(0);
			expect(result.cost).toBeLessThan(0.5);

			// ── Canonical event assertions ──────────────────────────────────
			const eventTypes = sink.events.map((e) => e.type);

			// Must include a turn.completed event
			expect(eventTypes).toContain("turn.completed");

			// Clean up the adapter
			await adapter.shutdown();
		},
		{ timeout: 120_000 },
	);
});
