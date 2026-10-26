import { Effect, Option } from "effect";
import { accountsStateFromInstances } from "../../src/lib/account-directory.js";
import type { KnownProviderDriverKind } from "../../src/lib/contracts/provider-instance.js";
import { configuredClaudeConfigDir } from "../../src/lib/provider/claude/claude-sdk-env.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
} from "../../src/lib/provider/runner/runner-provider-instance.js";
import type {
	SessionCommand,
	SessionRunner,
} from "../../src/lib/provider/runner/session-runner.js";

function idleExecute(
	command: Extract<SessionCommand, { type: "send-turn" }>,
): Effect.Effect<never>;
function idleExecute(
	command: Exclude<SessionCommand, { type: "send-turn" }>,
): Effect.Effect<undefined>;
function idleExecute(command: SessionCommand): Effect.Effect<undefined>;
function idleExecute(command: SessionCommand): Effect.Effect<undefined> {
	return command.type === "send-turn"
		? Effect.die("Unexpected runner execution")
		: Effect.succeed(undefined);
}

/** Keep prepared-command assertions while exercising the provider's real admission. */
export const makeRunnerAdmission = (
	runner: SessionRunner = {
		hasLiveProcessEffect: () => Effect.succeed(false),
		executeEffect: idleExecute,
	},
	driverKind: KnownProviderDriverKind = "claude",
) =>
	makeRunnerProviderInstance(
		{
			accounts: Effect.succeed(
				accountsStateFromInstances(
					[],
					configuredClaudeConfigDir("/tmp/runner-provider-admission"),
				),
			),
		},
		{
			driverKind,
			discoverEffect: () => Effect.die("Unexpected discovery"),
			generateTextEffect: () => Effect.die("Unexpected generation"),
			prepareTurnEffect: (input) => Effect.succeed({ input }),
		},
		() => Effect.succeed(runner),
	);

export const admitRunnerCommand = (
	provider: RunnerProviderInstance,
	runner: SessionRunner,
	command: Extract<SessionCommand, { type: "send-turn" }>,
) =>
	provider
		.admitSendEffect(
			{
				origin: { _tag: "Fresh" },
				sinkId: command.sinkId,
				input: command.input,
			},
			(send) => runner.executeEffect(command, send),
		)
		.pipe(
			Effect.flatMap((result) =>
				Option.isSome(result)
					? Effect.succeed(result.value)
					: Effect.die("Fresh test send was not admitted"),
			),
		);
