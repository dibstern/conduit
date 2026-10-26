import { Effect } from "effect";
import { expect, it } from "vitest";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeInProcessSessionRunner } from "../../../src/lib/provider/runner/in-process-session-runner.js";
import type { SessionTurn } from "../../../src/lib/provider/runner/session-runner.js";
import {
	admitRunnerCommand,
	makeRunnerAdmission,
} from "../../helpers/runner-provider-admission.js";

it("keeps native activity after intake acknowledgement and waits for it before shutdown", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				let active = false;
				let ended = false;
				const runner = yield* makeInProcessSessionRunner(
					() =>
						Effect.succeed({
							sendTurn: () =>
								Effect.sync(() => {
									active = true;
									return {
										status: "accepted" as const,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 0,
										providerStateUpdates: [],
									};
								}),
							hasActiveTurnsEffect: () => Effect.sync(() => active),
							interrupt: () => Effect.void,
							applySettings: () => Effect.void,
							endSession: () =>
								Effect.sync(() => {
									ended = true;
								}),
						}),
					() => Effect.succeed({}),
				);
				const admission = yield* makeRunnerAdmission(runner, "claude");
				const input: SessionTurn = {
					sessionId: "session",
					inputId: "input",
					runId: "run",
					prompt: "Hello",
					history: [],
					providerState: {},
					handoff: {
						included: 1,
						omitted: 0,
						firstMessageIncluded: false,
						tokens: 10,
					},
					workspaceRoot: "/tmp",
					extraFolders: [],
					configDir: configuredClaudeConfigDir("/tmp/claude"),
					folderSource: "account",
				};
				const intake = yield* admitRunnerCommand(admission, runner, {
					type: "send-turn",
					input,
					sinkId: "sink",
					aborted: false,
				});
				expect(intake.status).toBe("accepted");
				expect(intake.handoff).toEqual(input.handoff);
				yield* runner.executeEffect({
					type: "shutdown-after-turn",
					sessionId: "session",
				});
				yield* Effect.sleep("20 millis");
				expect(ended).toBe(false);
				expect(
					yield* runner.hasActiveTurnsEffect?.("session") ??
						Effect.succeed(false),
				).toBe(true);
				active = false;
				while (!ended) yield* Effect.sleep("10 millis");
				expect(
					yield* runner.hasActiveTurnsEffect?.("session") ??
						Effect.succeed(true),
				).toBe(false);
			}),
		),
	);
});
