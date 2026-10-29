import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
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
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	prepareRunnerDirectory,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";
import {
	makeRunnerRunLifecycle,
	makeRunnerStopReconciler,
} from "../../../src/lib/provider/runner/runner-retirement.js";
import type { SendEvidence } from "../../../src/lib/provider/runner/send-settlement.js";

// Settle at the reconciler's interface over a real store: a gone runner's held
// send with no journal is released only when the runner journals before it
// executes. The cursor row records that at hello (BC-1); rows from before
// migration 0089 have no record and fall back to the evidence file's build.
const runnerId = "0123456789ab";
const settle = (journals: boolean | undefined, buildId: string) =>
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
		yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at) VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1)`;
		const lifecycle = makeRunnerRunLifecycle({
			sql,
			commit,
			eventStore: yield* EventStoreEffectTag,
		});
		// The runner's identity outlives its process; its journal directory is empty.
		registerRunner({
			runnerId,
			sessionId: "session",
			socketPath: join(prepareRunnerDirectory(root, configDir), runnerId),
			buildId,
			pid: 123,
			startTime: "started",
		});
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
			release: (input, stop) =>
				lifecycle
					.releaseRun(input, stop ?? (() => Effect.succeed(undefined)))
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
				commit: (evidence) => Effect.sync(() => committed.push(evidence)),
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
		yield* reconciler.requestStop(
			{
				runnerId,
				sessionId: "session",
				driverKind: "claude",
				identity: { tag: "Verified", pid: 123, startTime: "started" },
				reaper: undefined,
				members: [],
			},
			{ _tag: "Explicit" },
		);
		yield* TestClock.adjust("10 seconds");
		expect(reconciler.state(runnerId)._tag).toBe("Settled");
		return {
			released: released.map(({ reason, runId }) => ({ reason, runId })),
			committed: committed.map(({ _tag, send }) => ({
				_tag,
				runId: send.runId,
			})),
		};
	}).pipe(
		Effect.scoped,
		Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
	);

it.effect(
	"BC-1 a gone journalling runner from an older build with no journal is released JournalAbsent",
	() =>
		Effect.gen(function* () {
			expect(yield* settle(true, "previous-build")).toEqual({
				released: [{ reason: "JournalAbsent", runId: "run" }],
				committed: [],
			});
		}),
);

it.effect(
	"BC-1 a row that records a legacy runner is not released on a current-build journal absence",
	() =>
		Effect.gen(function* () {
			expect(yield* settle(false, runnerBuildId())).toEqual({
				released: [],
				committed: [{ _tag: "delivery_unknown", runId: "run" }],
			});
		}),
);

it.effect(
	"a row with no journal record still falls back to the evidence build",
	() =>
		Effect.gen(function* () {
			expect(yield* settle(undefined, runnerBuildId())).toEqual({
				released: [{ reason: "JournalAbsent", runId: "run" }],
				committed: [],
			});
			expect(yield* settle(undefined, "previous-build")).toEqual({
				released: [],
				committed: [{ _tag: "delivery_unknown", runId: "run" }],
			});
		}),
);
