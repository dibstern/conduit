// Tool rows carry the Run Ledger's run id, the folder, real start and end times and the parent tool
// (82tn.45), against real SQLite through the projection runner. Failure modes are numbered in the
// lane audit (lane-45/audit.md):
// 1. a row whose run is unknown at projection time gets a guessed run id, not null;
// 2. an old store's rows get invented values after the migration, or a replay stamps differently;
// 3. a background Bash outliving two runs is closed at run 1's or run 2's end;
// 4. a subagent tool nested two deep points at the root Task, or gets no run id;
// 5. a tool.completed after the run ended is dropped, or a resultless one erases the mark;
// 6. run-end closing reads as failed rather than ended by the run;
// 7. run-end closing touches another session's rows or the next Run's;
// 8. a redelivered tool.started re-stamps a row with a later Run;
// 9. a wake Run's row gets no folder though the session's launch folder is known;
// 10. a subagent's terminal event ends the parent Run;
// 12. a task-linked row is closed at its Run's end while the ledger cannot tell which tasks are live;
// 13. run-end closing does not advance the read model.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { effectMigrationEntries } from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";

const withStore = <A, E>(
	effect: Effect.Effect<A, E, PersistenceEffectContext>,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "tool-rows-ledger-"))),
		(dir) =>
			effect.pipe(
				Effect.provide(
					makePersistenceEffectLayer(join(dir, "events.db"), "test-project"),
				),
			),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

const at = (createdAt: number, metadata = {}) => ({
	createdAt,
	metadata,
	provider: "claude",
});

const created = (sessionId: string, parentId?: string) =>
	canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title: sessionId,
			provider: "claude",
			...(parentId ? { parentId } : {}),
		},
		at(1000),
	);

/** One input admitted, sent, requested (launched in `folder`) and started as `runId`. */
const start = (
	sessionId: string,
	runId: string,
	t: number,
	folder?: string,
) => [
	canonicalEvent(
		"input.admitted",
		sessionId,
		{
			sessionId,
			inputId: `u-${runId}`,
			delivery: "queue",
			request: { text: "hi", images: [] },
		},
		at(t),
	),
	canonicalEvent(
		"input.sent",
		sessionId,
		{ sessionId, inputId: `u-${runId}` },
		at(t + 1),
	),
	canonicalEvent(
		"run.requested",
		sessionId,
		{ runId, inputId: `u-${runId}`, ...(folder && { folder }) },
		at(t + 2, { runId }),
	),
	canonicalEvent(
		"run.started",
		sessionId,
		{ inputId: `u-${runId}`, requestedRunId: runId },
		at(t + 3, { runId }),
	),
];

const end = (sessionId: string, runId: string, t: number) =>
	canonicalEvent(
		"turn.completed",
		sessionId,
		{ messageId: `m-${runId}` },
		at(t, { runId }),
	);

const toolStarted = (
	sessionId: string,
	partId: string,
	t: number,
	messageId = `m-${sessionId}`,
) =>
	canonicalEvent(
		"tool.started",
		sessionId,
		{
			messageId,
			partId,
			toolName: "Bash",
			callId: partId,
			input: { tool: "Bash", command: "ls" },
		},
		at(t),
	);

const toolRunning = (
	sessionId: string,
	partId: string,
	metadata: Record<string, unknown>,
	t: number,
) =>
	canonicalEvent(
		"tool.running",
		sessionId,
		{ messageId: `m-${sessionId}`, partId, metadata },
		at(t),
	);

const toolCompleted = (
	sessionId: string,
	partId: string,
	result: string | null,
	t: number,
) =>
	canonicalEvent(
		"tool.completed",
		sessionId,
		{ messageId: `m-${sessionId}`, partId, result, duration: 1 },
		at(t),
	);

const project = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		yield* runner.recover();
		for (const event of events)
			yield* runner.projectEvent(yield* store.append(event));
	});

const rows = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<{
		id: string;
		status: string;
		run_id: string | null;
		folder: string | null;
		started_at: number | null;
		ended_at: number | null;
		ended_by: string | null;
		parent_tool_id: string | null;
		version: number;
	}>`SELECT id, status, run_id, folder, started_at, ended_at, ended_by, parent_tool_id, version
		FROM message_parts WHERE type = 'tool' ORDER BY id`;
});
const row = (id: string) =>
	rows.pipe(Effect.map((all) => all.find((r) => r.id === id)));

describe("Tool rows on the Run Ledger", () => {
	it.effect(
		"stamps the ledger's Run, its launch folder and the real start; unknown reads null (1, 8, 9)",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						created("s1"),
						...start("s1", "r1", 1001, "/work/a"),
					]);
					// 1: before any Run, and between Runs, the row's run is unknown.
					yield* project([created("s0"), toolStarted("s0", "orphan", 1009)]);
					yield* project([toolStarted("s1", "t1", 1010)]);
					expect(yield* row("t1")).toMatchObject({
						run_id: "r1",
						folder: "/work/a",
						started_at: 1010,
						ended_at: null,
						parent_tool_id: null,
					});
					expect(yield* row("orphan")).toMatchObject({
						run_id: null,
						folder: null,
					});
					yield* project([end("s1", "r1", 1020)]);
					// 9: a row while no Run is active has no run, but the session's launch folder.
					yield* project([toolStarted("s1", "between", 1021)]);
					expect(yield* row("between")).toMatchObject({
						run_id: null,
						folder: "/work/a",
					});
					// 8: a later Run never re-stamps a row a redelivered tool.started names again.
					yield* project([...start("s1", "r2", 1030, "/work/b")]);
					yield* project([toolStarted("s1", "t1", 1040)]);
					expect(yield* row("t1")).toMatchObject({
						run_id: "r1",
						folder: "/work/a",
						started_at: 1010,
					});
				}),
			),
	);

	it.effect(
		"ends a Run's open rows as ended by the run; a background Bash outlives two Runs (3, 5, 6, 7, 13)",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						created("s1"),
						created("other"),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "rn", label: "rn:1", reattached: false },
							at(1000),
						),
						...start("s1", "r1", 1001, "/work/a"),
						...start("other", "o1", 1001),
					]);
					yield* project([
						toolStarted("s1", "fg", 1010),
						toolStarted("s1", "bg", 1011),
						toolRunning("s1", "bg", { providerTaskId: "task-1" }, 1012),
						canonicalEvent(
							"evidence.tasks_snapshot",
							"s1",
							{
								label: "rn:1",
								tasks: [
									{
										key: { taskId: "task-1", runId: "r1" },
										taskType: "local_bash",
										description: "sleep 60",
										ambient: false,
									},
								],
							},
							at(1013),
						),
						toolStarted("s1", "done", 1014),
						toolCompleted("s1", "done", "ok", 1015),
						toolStarted("other", "theirs", 1016),
					]);
					const before = (yield* row("fg"))?.version ?? 0;
					yield* project([end("s1", "r1", 1020)]);
					// 6, 13: ended by the run, not failed, and the read model advanced.
					const fg = yield* row("fg");
					expect(fg).toMatchObject({
						status: "completed",
						ended_at: 1020,
						ended_by: "run",
					});
					expect(fg?.version).toBeGreaterThan(before);
					// 6: the browser reads it as ended by the run, on every transcript read.
					const read = yield* ReadQueryEffectTag;
					for (const messages of [
						(yield* read.readSessionTranscriptPage("s1", {
							limit: 50,
							previewTools: true,
						})).messages,
						(yield* read.readSessionTranscript("s1")).messages,
					]) {
						const parts = messageRowsToHistory(messages, {
							pageSize: 50,
						}).messages.flatMap((message) => message.parts ?? []);
						const outcome = (id: string) =>
							parts.find((part) => part.id === id)?.state?.outcome;
						expect([outcome("fg"), outcome("bg"), outcome("done")]).toEqual([
							"endedByRun",
							undefined,
							"succeeded",
						]);
					}
					// 3: the background row stays open past its Run's end.
					expect(yield* row("bg")).toMatchObject({
						status: "running",
						ended_at: null,
						ended_by: null,
					});
					// A row closed by its own completion keeps its real end.
					expect(yield* row("done")).toMatchObject({
						status: "completed",
						ended_at: 1015,
						ended_by: null,
					});
					// 7: another session's open row is not this Run's.
					expect(yield* row("theirs")).toMatchObject({
						status: "started",
						ended_by: null,
					});
					// 3: a second Run starts and ends; the background row is still open.
					yield* project([...start("s1", "r2", 1030, "/work/a")]);
					yield* project([
						toolStarted("s1", "fg2", 1035),
						end("s1", "r2", 1040),
					]);
					expect(yield* row("fg2")).toMatchObject({
						run_id: "r2",
						ended_by: "run",
					});
					expect(yield* row("bg")).toMatchObject({
						run_id: "r1",
						status: "running",
						ended_by: null,
					});
					// 5: its own completion closes it, after both Runs ended, at its real end.
					yield* project([toolCompleted("s1", "bg", "exit 0", 1050)]);
					expect(yield* row("bg")).toMatchObject({
						status: "completed",
						ended_at: 1050,
						ended_by: null,
					});
					// 5: a late resultless completion leaves an ended-by-the-run row as it was; a late
					// result is the row's own end.
					yield* project([toolCompleted("s1", "fg2", null, 1060)]);
					expect(yield* row("fg2")).toMatchObject({
						ended_at: 1040,
						ended_by: "run",
					});
					yield* project([toolCompleted("s1", "fg", "late output", 1070)]);
					expect(yield* row("fg")).toMatchObject({
						status: "completed",
						ended_at: 1070,
						ended_by: null,
					});
				}),
			),
	);

	// 12: a process harness cannot reach this. A restart reattaches at the same label and keeps the
	// stored tasks, Codex never raises its label, and a replaced Claude query lists its empty set
	// straight after its busy status, so no Run ends in between.
	it.effect(
		"keeps a task-linked row open when its Run ends while the ledger's tasks are unknown (12)",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						created("s1"),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "rn", label: "rn:1", reattached: false },
							at(1000),
						),
						...start("s1", "r1", 1001),
					]);
					yield* project([
						toolStarted("s1", "fg", 1010),
						toolStarted("s1", "linked", 1011),
						toolRunning("s1", "linked", { providerTaskId: "task-9" }, 1012),
						// A newer label's first output: its tasks are unknown until it lists them.
						canonicalEvent(
							"evidence.turn_ended",
							"s1",
							{ label: "rn:2" },
							at(1013),
						),
					]);
					expect((yield* loadLedgerView("s1"))?.tasks.tag).toBe("unknown");
					yield* project([end("s1", "r1", 1020)]);
					expect(yield* row("fg")).toMatchObject({ ended_by: "run" });
					expect(yield* row("linked")).toMatchObject({
						status: "running",
						ended_at: null,
						ended_by: null,
					});
				}),
			),
	);

	it.effect(
		"links a subagent tool nested two deep to its own parent Task, under the parent's Run (4, 10)",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						created("s1"),
						created("c1", "s1"),
						created("c2", "c1"),
						...start("s1", "r1", 1001, "/work/a"),
					]);
					yield* project([
						toolStarted("s1", "task1", 1010),
						toolRunning("s1", "task1", { childSessionId: "c1" }, 1011),
						toolStarted("c1", "task2", 1012),
						toolRunning("c1", "task2", { childSessionId: "c2" }, 1013),
						toolStarted("c2", "leaf", 1014),
					]);
					expect(yield* row("task2")).toMatchObject({
						parent_tool_id: "task1",
						run_id: "r1",
						folder: "/work/a",
					});
					expect(yield* row("leaf")).toMatchObject({
						parent_tool_id: "task2",
						run_id: "r1",
						folder: "/work/a",
					});
					// 10: the subagents' own terminal events leave the parent Run as it was.
					const parentRun = (yield* loadLedgerView("s1"))?.active;
					expect(parentRun?.runId).toBe("r1");
					yield* project([
						canonicalEvent(
							"turn.completed",
							"c2",
							{ messageId: "m-c2" },
							at(1015),
						),
						canonicalEvent(
							"turn.completed",
							"c1",
							{ messageId: "m-c1" },
							at(1016),
						),
					]);
					expect((yield* loadLedgerView("s1"))?.active).toEqual(parentRun);
					expect(yield* row("task1")).toMatchObject({ ended_by: null });
				}),
			),
	);

	it.effect(
		"keeps old rows unknown after the migration, reruns it safely and replays the same stamps (2)",
		() =>
			Effect.gen(function* () {
				const events = [
					created("s1"),
					...start("s1", "r1", 1001, "/work/a"),
					toolStarted("s1", "t1", 1010),
					toolStarted("s1", "t2", 1011),
					end("s1", "r1", 1020),
				];
				const live = yield* withStore(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						yield* project(events.slice(0, 4));
						yield* project(events.slice(4));
						// An old store: its rows predate the columns.
						yield* sql`UPDATE message_parts SET run_id = NULL, folder = NULL,
							started_at = NULL, ended_at = NULL, ended_by = NULL WHERE id = 't1'`;
						yield* effectMigrationEntries["0092_tool_row_run"];
						yield* (yield* ProjectionRunnerEffectTag).recover();
						expect(yield* row("t1")).toMatchObject({
							run_id: null,
							folder: null,
						});
						return (yield* rows).filter((r) => r.id !== "t1");
					}),
				);
				const replayed = yield* withStore(
					Effect.gen(function* () {
						const store = yield* EventStoreEffectTag;
						for (const event of events) yield* store.append(event);
						yield* (yield* ProjectionRunnerEffectTag).recover();
						return (yield* rows).filter((r) => r.id !== "t1");
					}),
				);
				expect(replayed.map(({ version: _, ...rest }) => rest)).toEqual(
					live.map(({ version: _, ...rest }) => rest),
				);
				expect(live[0]).toMatchObject({
					id: "t2",
					run_id: "r1",
					folder: "/work/a",
					ended_by: "run",
				});
			}),
	);
});
