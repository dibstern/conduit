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

// Direct manager fixtures need the same atomic run and owner claim as dispatch.
// Existing run ids stay untouched unless the fixture explicitly requests an owner.
export const reserveTestRun = <
	T extends Pick<SessionTurn, "sessionId" | "runId" | "inputId"> &
		Partial<Pick<SessionTurn, "commandAttempt" | "account" | "instanceId">>,
>(
	input: T,
	options?: { readonly ownerForExistingRun: true },
): Effect.Effect<T> =>
	Effect.gen(function* () {
		if (input.runId && !options?.ownerForExistingRun) return input;
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const store = yield* Effect.serviceOption(EventStoreEffectTag);
		const projection = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
		if (Option.isNone(sql) || Option.isNone(store) || Option.isNone(projection))
			return input;
		const runId = input.runId ?? `fixture-${randomUUID()}`;
		const commandAttempt = input.commandAttempt ?? 1;
		const reserved = { ...input, runId, commandAttempt };
		const commit = yield* makeCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql.value),
			Effect.provideService(EventStoreEffectTag, store.value),
			Effect.provideService(ProjectionRunnerEffectTag, projection.value),
		);
		yield* commit
			.write((project) =>
				Effect.gen(function* () {
					if (!input.runId)
						yield* project(
							yield* store.value.appendBatch([
								canonicalEvent("run.requested", input.sessionId, {
									runId,
									inputId: input.inputId,
								}),
							]),
						);
					const [next] = yield* sql.value<{
						sequence: number;
					}>`SELECT COALESCE(MAX(request_sequence), 0) + 1 AS sequence FROM provider_command_outbox`;
					const sequence = next?.sequence ?? 1;
					const [session] = yield* sql.value<{
						project_id: string;
						provider: string;
					}>`SELECT project_id, provider FROM sessions WHERE id = ${input.sessionId}`;
					const projectId = session?.project_id ?? "test-project";
					const providerId =
						input.account?.id ??
						input.instanceId ??
						session?.provider ??
						"claude";
					yield* sql.value`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
			VALUES (${input.inputId}, ${input.sessionId}, 'side_effect_requested', 1, 'send_turn', ${projectId}, 'sha256:runner-admission-fixture', 1, ${sequence}, 1)
			ON CONFLICT (command_id) DO UPDATE SET status = 'side_effect_requested', side_effect_sequence = excluded.side_effect_sequence`;
					yield* sql.value`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
				VALUES (${sequence}, ${input.inputId}, ${projectId}, ${input.sessionId}, ${providerId}, 'send_turn', ${JSON.stringify(reserved)}, ${runId}, 'running', ${commandAttempt}, 1, 1)`;
				}),
			)
			.pipe(Effect.orDie);
		return reserved;
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
				reserveTestRun(input).pipe(
					// A test's own facts stand in for the driver's prepare.
					Effect.map((input) => ({
						input: {
							...input,
							facts: input.facts ?? { _tag: "Claude" as const },
						},
					})),
				),
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
