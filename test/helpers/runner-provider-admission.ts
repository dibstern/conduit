import { randomUUID } from "node:crypto";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { accountsStateFromInstances } from "../../src/lib/account-directory.js";
import type { KnownProviderDriverKind } from "../../src/lib/contracts/provider-instance.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../src/lib/persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../src/lib/provider/claude/claude-sdk-env.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
} from "../../src/lib/provider/runner/runner-provider-instance.js";
import type {
	SessionCommand,
	SessionRunner,
	SessionTurn,
} from "../../src/lib/provider/runner/session-runner.js";

// Direct manager fixtures bypass the outbox's run.requested transaction.
// Explicit owners stay untouched so invalid/missing ownership tests still fail.
const reserveTestRun = <
	T extends Pick<SessionTurn, "sessionId" | "runId" | "inputId">,
>(
	input: T,
): Effect.Effect<T> =>
	Effect.gen(function* () {
		if (input.runId) return input;
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const store = yield* Effect.serviceOption(EventStoreEffectTag);
		const projection = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
		if (Option.isNone(sql) || Option.isNone(store) || Option.isNone(projection))
			return input;
		const runId = `fixture-${randomUUID()}`;
		const commit = yield* makeCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql.value),
			Effect.provideService(EventStoreEffectTag, store.value),
			Effect.provideService(ProjectionRunnerEffectTag, projection.value),
		);
		yield* commit([
			canonicalEvent("run.requested", input.sessionId, {
				runId,
				inputId: input.inputId ?? runId,
			}),
		]).pipe(Effect.orDie);
		return { ...input, runId };
	});

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
			prepareTurnEffect: (input) =>
				reserveTestRun(input).pipe(Effect.map((input) => ({ input }))),
		},
		() => Effect.succeed(runner),
	);

export const admitRunnerCommand = (
	provider: RunnerProviderInstance,
	runner: SessionRunner,
	command: Extract<SessionCommand, { type: "send-turn" }>,
) =>
	Effect.gen(function* () {
		const input = yield* reserveTestRun(command.input);
		return yield* provider
			.admitSendEffect(
				{
					origin: { _tag: "Fresh" },
					sinkId: command.sinkId,
					input,
				},
				(send) => runner.executeEffect({ ...command, input }, send),
			)
			.pipe(
				Effect.flatMap((result) =>
					Option.isSome(result)
						? Effect.succeed(result.value)
						: Effect.die("Fresh test send was not admitted"),
				),
			);
	});
