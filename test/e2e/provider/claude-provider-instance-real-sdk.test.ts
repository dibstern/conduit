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

import { mkdirSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	configuredClaudeConfigDir,
	sdkDefaultClaudeConfigDir,
} from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type { EventSink } from "../../../src/lib/provider/types.js";
import { makeTestClaudeProviderInstance } from "../../helpers/claude-provider-instance.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";

// Turns no longer fall back to the environment's login, and test/setup.ts
// moves the reviewer's CLAUDE_CONFIG_DIR aside and replaces HOME, so pass the
// real login folder explicitly.
const configuredDir = process.env["CONDUIT_TEST_REAL_CLAUDE_CONFIG_DIR"];
const configDir =
	configuredDir === undefined
		? sdkDefaultClaudeConfigDir(join(userInfo().homedir, ".claude"))
		: configuredClaudeConfigDir(configuredDir);

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

describe.skipIf(!RUN_EXPENSIVE)("ClaudeProviderInstance E2E (real SDK)", () => {
	// macOS finds the login Keychain under HOME, which test/setup.ts isolates.
	// Link only the Keychains dir, as the process harness does.
	beforeAll(() => {
		if (process.platform !== "darwin") return;
		// Not os.homedir(): in a worker thread it still reports the real home.
		const home = process.env["HOME"];
		if (home === undefined || home === userInfo().homedir)
			throw new Error("Expected the isolated HOME from test/setup.ts");
		const library = join(home, "Library");
		mkdirSync(library, { recursive: true });
		symlinkSync(
			join(userInfo().homedir, "Library", "Keychains"),
			join(library, "Keychains"),
		);
	});

	it(
		"full turn: sendTurnEffect() resolves with completed TurnResult and emits canonical events",
		{ timeout: 120_000 },
		async () => {
			const instance = makeTestClaudeProviderInstance({
				// No queryFactory override — uses the real SDK
			});

			const sink = createCollectingEventSink();
			const abortController = new AbortController();

			const result = await Effect.runPromise(
				instance.sendTurnEffect({
					sessionId: `e2e-real-sdk-test-${Date.now()}`,
					inputId: "turn-1",
					prompt: "Reply with exactly: hello world",
					history: [],
					providerState: {},
					model: { providerId: "claude", modelId: "haiku" },
					configDir,
					workspaceRoot: process.cwd(),
					extraFolders: [],
					eventSink: sink,
					abortSignal: abortController.signal,
				}),
			);

			expect(result.status, JSON.stringify(result.error)).toBe("completed");
			expect(result.tokens.input).toBeGreaterThan(0);
			expect(result.tokens.output).toBeGreaterThan(0);
			expect(result.cost).toBeLessThan(0.5);

			const eventTypes = sink.events.map((e) => e.type);

			// Must include a turn.completed event
			expect(eventTypes).toContain("turn.completed");

			// Clean up the provider instance
			await Effect.runPromise(instance.shutdownEffect());
		},
	);

	// The activity indicators (composer bounce bar, sidebar processing dot) are
	// both driven by session.status. The main agent goes assistant-silent for as
	// long as it is blocked on a Task subagent, which is where they used to go
	// dark. The fixture replay in test/unit/provider/claude covers this against a
	// captured trace; this one proves the live SDK still orders things that way.
	it(
		"subagent turn: stays busy from the prompt until the result",
		{ timeout: 180_000 },
		async () => {
			const instance = makeTestClaudeProviderInstance({});
			const sink = createCollectingEventSink();
			const abortController = new AbortController();
			const sessionId = `e2e-real-sdk-subagent-${Date.now()}`;

			const result = await Effect.runPromise(
				instance.sendTurnEffect({
					sessionId,
					inputId: "turn-1",
					prompt:
						"Use the Task tool to launch exactly one general-purpose subagent " +
						"whose entire job is to reply with the word banana. Do not do the " +
						"work yourself. Once it returns, reply with exactly: done",
					history: [],
					providerState: {},
					model: { providerId: "claude", modelId: "haiku" },
					configDir,
					workspaceRoot: process.cwd(),
					extraFolders: [],
					eventSink: sink,
					abortSignal: abortController.signal,
				}),
			);

			expect(result.status, JSON.stringify(result.error)).toBe("completed");

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
			// The subagent streams into its own child session, which rightly goes
			// idle when it finishes. Only the parent's indicators are under test.
			const parentEvents = sink.events.filter((e) => e.sessionId === sessionId);
			const turnEnd = parentEvents.findIndex(
				(e) => e.type === "turn.completed",
			);
			expect(turnEnd).toBeGreaterThan(0);

			// Nothing may report idle before the turn ends — not system/init a
			// second after the prompt, and not the "requesting" status the main
			// chain emits while the subagent holds it.
			const midTurn = parentEvents.slice(0, turnEnd).filter(isStatus);
			expect(
				midTurn.filter((e) => statusOf(e) === "idle"),
				"session reported idle mid-turn",
			).toEqual([]);
			expect(midTurn.length).toBeGreaterThan(0);

			// And the lease is released exactly once, or the indicators stick on.
			expect(
				parentEvents.slice(turnEnd).filter(isStatus).map(statusOf),
			).toEqual(["idle"]);

			await Effect.runPromise(instance.shutdownEffect());
		},
	);
});
