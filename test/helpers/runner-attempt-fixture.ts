import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { runSessionRunner } from "../../src/lib/provider/runner/runner-host.js";

let executions = 0;

NodeRuntime.runMain(
	Effect.scoped(
		runSessionRunner("claude", () =>
			Effect.succeed({
				makeRunner: () =>
					Effect.succeed({
						hasLiveProcessEffect: () => Effect.succeed(true),
						executeEffect: () => Effect.die("Unused payload entrypoint"),
						executeNativeEffect: () => Effect.die("Unused payload entrypoint"),
					}),
				upgradeState: () => ({}),
				acceptCommand: () => {},
				executeEffect: (_runner, command) =>
					Effect.gen(function* () {
						if (command.type !== "send-turn") return;
						executions++;
						if (command.input.prompt === "held") {
							process.send?.({ type: "executing" });
							return yield* Effect.never;
						}
						return {
							status:
								command.input.prompt === "accepted" ||
								command.input.prompt === "joined" ||
								command.input.prompt === "indeterminate"
									? command.input.prompt
									: command.input.prompt === "resume-rejected"
										? ("error" as const)
										: ("completed" as const),
							...(command.input.prompt === "resume-rejected"
								? { nativeResumeRejected: true }
								: {}),
							cost: executions,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						};
					}),
			}),
		),
	),
);
