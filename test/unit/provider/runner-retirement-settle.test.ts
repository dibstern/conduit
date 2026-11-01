import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { RunRelease } from "../../../src/lib/provider/runner/process-runner-types.js";
import {
	runnerBuildId,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	makeRunnerReceiptStore,
	type StopReason,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	prepareRunnerDirectory,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";
import {
	makeRunnerRunLifecycle,
	makeRunnerStopReconciler,
} from "../../../src/lib/provider/runner/runner-retirement.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";
import type { SendEvidence } from "../../../src/lib/provider/runner/send-settlement.js";
import { settleSend } from "../../../src/lib/provider/runner/send-settlement-outbox.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";

// Settle at the reconciler's interface over a real store: a gone runner's held
// send with no journal is released only when the runner journals before it
// executes. The cursor row records that at hello (BC-1); rows from before
// migration 0089 have no record and fall back to the evidence file's build.
// Each committed evidence settles through main's Send Settlement, so a test
// reads the label a lost run ends with.
const runnerId = "0123456789ab";
const settle = (
	journals: boolean | undefined,
	buildId: string,
	reason: StopReason = { _tag: "Explicit" },
	answer?: TurnResult,
) =>
	Effect.gen(function* () {
		const configDir = mkdtempSync(join(tmpdir(), "settle-config-"));
		const root = mkdtempSync(join(tmpdir(), "settle-root-"));
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				rmSync(configDir, { recursive: true, force: true });
				rmSync(root, { recursive: true, force: true });
			}),
		);
		const sql = yield* SqlClient.SqlClient;
		const receipts = yield* makeRunnerReceiptStore(sql);
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent("session.created", "session", {
				sessionId: "session",
				title: "session",
				provider: "claude",
			}),
			canonicalEvent(
				"run.requested",
				"session",
				{ runId: "run", inputId: "run" },
				{ provider: "claude", metadata: { runId: "run" } },
			),
		]);
		yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at) VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{"prompt":"text"}', 'run', 'running', 1, 1, 1)`;
		const lifecycle = makeRunnerRunLifecycle({
			sql,
			commit,
			eventStore: yield* EventStoreEffectTag,
		});
		// The runner's identity outlives its process; its journal holds at most
		// the answer the agent gave before it went.
		const directory = prepareRunnerDirectory(root, configDir);
		registerRunner({
			runnerId,
			sessionId: "session",
			socketPath: join(directory, runnerId),
			buildId,
			pid: 123,
			startTime: "started",
		});
		if (answer)
			yield* new RunnerSendJournal(directory, "session", "claude").execute(
				"send",
				1,
				false,
				Effect.succeed(answer),
			);
		const released: RunRelease[] = [];
		const committed: SendEvidence[] = [];
		const reconciler = yield* makeRunnerStopReconciler({
			receipts,
			processTable: {
				inspect: () => ({ state: "gone" }),
				signal: () => undefined,
			},
			holdRun: (sessionId, runId, commandId) =>
				lifecycle.holdRun({ sessionId, runId, commandId }),
			release: (input) =>
				lifecycle
					.releaseRun(input)
					.pipe(
						Effect.mapError((cause) => runnerFailure("release run", cause)),
					),
			released: (input) => Effect.sync(() => released.push(input)),
			committed: () => Effect.void,
			shutdown: () => Effect.void,
			settlement: {
				sql,
				configDir,
				driverKind: "claude",
				entry: () => undefined,
				ingestion: () =>
					Effect.succeed({ ingestBatch: () => Effect.succeed(0) }),
				projectRoot: () => Effect.succeed(root),
				commit: (evidence) =>
					Effect.sync(() => committed.push(evidence)).pipe(
						Effect.andThen(
							commit.write((project, stamp) =>
								settleSend({ sql, project, stamp }, evidence),
							),
						),
					),
				wake: () => Effect.void,
			},
			evict: () => Effect.void,
			prune: () => Effect.void,
			notice: () => Effect.succeed(true),
		});
		yield* reconciler.register(
			runnerId,
			{ sessionId: "session", pid: 123, startTime: "started" },
			"serving",
		);
		if (reason._tag === "Superseded")
			yield* reconciler.register(
				reason.successor,
				{ sessionId: "session", pid: 124, startTime: "started" },
				"candidate",
			);
		// The hello's cursor claim records whether this runner journals first.
		yield* receipts.attach(runnerId, "attachment", {
			sessionId: "session",
			...(journals === undefined ? {} : { journalsBeforeExecution: journals }),
		});
		expect(
			yield* lifecycle.holdRun({
				sessionId: "session",
				runId: "run",
				commandId: "send",
			}),
		).toMatchObject({ _tag: "Held", runner: runnerId });
		const stopped = yield* Effect.exit(
			reconciler.requestStop(
				{
					runnerId,
					sessionId: "session",
					driverKind: "claude",
					identity: { tag: "Verified", pid: 123, startTime: "started" },
					reaper: undefined,
					members: [],
				},
				reason,
			),
		);
		const stop = Exit.isSuccess(stopped) ? stopped.value : "Failed";
		if (stop === "Requested") {
			yield* TestClock.adjust("10 seconds");
			expect(reconciler.state(runnerId)._tag).toBe("Settled");
			// A fresh serving runner holds the send again only if the stop left
			// its run open.
			yield* reconciler.register(
				"fedcba987654",
				{ sessionId: "session", pid: 125, startTime: "started" },
				"serving",
			);
			yield* receipts.attach("fedcba987654", "next-attachment", {
				sessionId: "session",
			});
		}
		return {
			stop,
			released: released.map(({ reason, runId }) => ({ reason, runId })),
			committed: committed.map(({ _tag, send }) => ({
				_tag,
				runId: send.runId,
			})),
			ended: yield* sql<{
				type: string;
				code: string | null;
			}>`SELECT type, json_extract(data, '$.code') AS code FROM events
				WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
			again: yield* lifecycle.holdRun({
				sessionId: "session",
				runId: "run",
				commandId: "send",
			}),
			send: yield* sql<{
				status: string;
				error_code: string | null;
			}>`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
		};
	}).pipe(
		Effect.scoped,
		Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
	);

it.effect(
	"BC-1 a gone journalling runner from an older build with no journal is released JournalAbsent",
	() =>
		Effect.gen(function* () {
			expect(yield* settle(true, "previous-build")).toMatchObject({
				released: [{ reason: "JournalAbsent", runId: "run" }],
				committed: [],
			});
		}),
);

it.effect(
	"BC-1 a row that records a legacy runner is not released on a current-build journal absence",
	() =>
		Effect.gen(function* () {
			expect(yield* settle(false, runnerBuildId())).toMatchObject({
				released: [],
				committed: [{ _tag: "delivery_unknown", runId: "run" }],
			});
		}),
);

it.effect(
	"a row with no journal record still falls back to the evidence build",
	() =>
		Effect.gen(function* () {
			expect(yield* settle(undefined, runnerBuildId())).toMatchObject({
				released: [{ reason: "JournalAbsent", runId: "run" }],
				committed: [],
			});
			expect(yield* settle(undefined, "previous-build")).toMatchObject({
				released: [],
				committed: [{ _tag: "delivery_unknown", runId: "run" }],
			});
		}),
);

// 32.2.16 (CONTRACT 3.6 D50, 3.8, 6.5, 7.3): Gone-time settlement of a held
// send, per StopReason that can retire its holder.
const reasons: ReadonlyArray<StopReason> = [
	{ _tag: "Explicit" },
	{ _tag: "EndSession" },
	{ _tag: "ProjectRemoved" },
	{ _tag: "Idle" },
	{ _tag: "Exited" },
];

// A hold binds only the serving runner. The swap refuses a target that holds
// a run, and an abandoned candidate that serves is Ignored (6.3), so neither
// reason retires a holder: the send stays held by it.
it.effect.each([
	{ reason: { _tag: "Superseded", successor: "abcdef012345" }, stop: "Failed" },
	{ reason: { _tag: "CandidateAbandoned" }, stop: "Ignored" },
] satisfies ReadonlyArray<{ reason: StopReason; stop: string }>)(
	"a $reason._tag stop never retires the runner holding a send",
	({ reason, stop }) =>
		Effect.gen(function* () {
			expect(yield* settle(true, runnerBuildId(), reason)).toEqual({
				stop,
				released: [],
				committed: [],
				ended: [],
				again: { _tag: "Busy" },
				send: [{ status: "running", error_code: null }],
			});
		}),
);

it.effect.each(reasons)(
	"a $_tag stop's send that never reached the agent is held again on the next runner",
	(reason) =>
		Effect.gen(function* () {
			const settled = yield* settle(true, runnerBuildId(), reason);
			expect(settled.released).toEqual([
				{ reason: "JournalAbsent", runId: "run" },
			]);
			expect(settled.committed).toEqual([]);
			expect(settled.ended).toEqual([]);
			expect(settled.again).toMatchObject({ _tag: "Held", transmission: 2 });
		}),
);

it.effect.each(reasons)(
	"a $_tag stop's send the agent accepted ends process lost, interrupted only for the user's End",
	(reason) =>
		Effect.gen(function* () {
			const settled = yield* settle(true, runnerBuildId(), reason, {
				status: "accepted",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			});
			const end = reason._tag === "EndSession";
			expect(settled.released).toEqual([]);
			expect(settled.committed).toEqual([
				{ _tag: "process_lost", runId: "run" },
			]);
			expect(settled.ended).toEqual([
				end
					? { type: "turn.interrupted", code: null }
					: { type: "turn.error", code: "runner_stopped" },
			]);
			expect(settled.send).toEqual([
				{
					status: "failed",
					error_code: end ? "interrupted" : "runner_stopped",
				},
			]);
			expect(settled.again).toEqual({ _tag: "Ended" });
		}),
);
