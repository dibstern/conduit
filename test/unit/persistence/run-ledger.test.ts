// The catalogue's ledger cases the arm reaches today (32.3), against real SQLite through the
// projecting write. Each case's other half stays a todo under its owning ticket. How they could fail:
// 1. a second terminal, a late status or a runner's exit ends a Run twice, or under the later outcome;
// 2. a runner's exit leaves a dispatched Run open, so its session never reads Quiescent;
// 3. a Stop before intake ends the Run at its commit, or the host's terminal never ends it;
// 4. a late dispatch on a replacement runner binds an ended Run, or issues an effect for it;
// 5. an arm read scans events, the outbox or the ledger instead of searching an index;
// 6. a folded indeterminate delivery leaves the session's version where it was.
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
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const withStore = <A, E>(
	effect: Effect.Effect<A, E, PersistenceEffectContext>,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-rl-"))),
		(dir) =>
			effect.pipe(
				Effect.provide(
					makePersistenceEffectLayer(join(dir, "events.db"), "test-project"),
				),
			),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

type Provider = "claude" | "opencode" | "cursor";
const at = (provider: Provider, createdAt: number, metadata = {}) => ({
	createdAt,
	metadata,
	provider,
});

/** Session s1's input u1 admitted, handed off and requested as Run r1, then started unless not. */
const turn = (provider: Provider, started = true) => [
	makeSessionCreatedEvent("s1", { provider, createdAt: 1000 }),
	canonicalEvent(
		"input.admitted",
		"s1",
		{
			sessionId: "s1",
			inputId: "u1",
			delivery: "queue",
			request: { text: "hi", images: [] },
		},
		at(provider, 1001),
	),
	canonicalEvent(
		"input.sent",
		"s1",
		{ sessionId: "s1", inputId: "u1" },
		at(provider, 1002),
	),
	canonicalEvent(
		"run.requested",
		"s1",
		{ runId: "r1", inputId: "u1" },
		at(provider, 1003, { runId: "r1" }),
	),
	...(started
		? [
				canonicalEvent(
					"run.started",
					"s1",
					{ inputId: "u1", requestedRunId: "r1" },
					at(provider, 1004, { runId: "r1" }),
				),
			]
		: []),
];

const stop = (provider: Provider, createdAt: number) =>
	canonicalEvent(
		"interrupt.requested",
		"s1",
		{
			providerProcessId: "p1",
			stop: {
				deadlineAt: createdAt + 30_000,
				owners: [{ runId: "r1" }],
				turnIds: [],
				runnerBacked: provider === "claude" || provider === "cursor",
				retainedSteers: false,
			},
		},
		at(provider, createdAt, { commandId: "k1" }),
	);

const project = (events: readonly CanonicalEvent[]) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		yield* runner.recover();
		for (const event of events)
			yield* runner.projectEvent(yield* store.append(event));
	});

/** Run r1's end entries, s1's view, its ledger row and the ledger effects naming r1. */
const settled = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		ends: (yield* sql<{ entry_json: string }>`
			SELECT entry_json FROM run_ledger_entries
			WHERE session_id = 's1' AND json_extract(entry_json, '$.kind') = 'end'
				AND json_extract(entry_json, '$.runId') = 'r1'
			ORDER BY entry_seq`).map(({ entry_json }): unknown =>
			JSON.parse(entry_json),
		),
		view: yield* loadLedgerView("s1"),
		row: yield* sql`SELECT state, alarm_at FROM run_ledger_sessions WHERE session_id = 's1'`,
		effects:
			yield* sql`SELECT command_id FROM provider_command_outbox WHERE command_id LIKE 'ledger:r1:%'`,
	};
});
const quiescent = [{ state: "Quiescent", alarm_at: null }];

/** Run r1 dispatched on Claude runner R1, which raised a permission prompt for each id. */
const asked = (...ids: readonly string[]) => [
	...turn("claude"),
	canonicalEvent(
		"evidence.process_started",
		"s1",
		{ runnerId: "R1", label: "R1:1", reattached: false },
		at("claude", 1005),
	),
	canonicalEvent(
		"run.dispatched",
		"s1",
		{ runId: "r1", runnerId: "R1", commandId: "c1", transmission: 1 },
		at("claude", 1006),
	),
	...ids.map((id) => prompt(id, 1007)),
];
const prompt = (id: string, createdAt: number) =>
	canonicalEvent(
		"permission.asked",
		"s1",
		{
			id,
			sessionId: "s1",
			toolName: "Bash",
			input: {},
			providerProcessId: "R1",
		},
		at("claude", createdAt),
	);
/** Main's answer to prompt id, committed under commandId (3.10). */
const answer = (id: string, commandId: string, createdAt: number) =>
	canonicalEvent(
		"permission.resolved",
		"s1",
		{ id, decision: "once", providerProcessId: "R1" },
		at("claude", createdAt, { commandId }),
	);
/** The outcome main appends as it ends an answer's outbox row (3.4, 3.12). */
const outcome = (
	commandId: string,
	transmission: number,
	result:
		| { tag: "succeeded" }
		| { tag: "retryable"; retryAt: number; code: string }
		| { tag: "permanent"; code: string },
	createdAt: number,
) =>
	canonicalEvent(
		"evidence.effect_outcome",
		"s1",
		{ commandId, transmission, outcome: result },
		at("claude", createdAt),
	);
/** The runner's own resolution, main's ledger-only confirmation of a delivered answer (3.10). */
const confirmed = (id: string, createdAt: number) =>
	canonicalEvent(
		"evidence.interaction_resolved",
		"s1",
		{ id, providerProcessId: "R1" },
		at("claude", createdAt),
	);
/** s1's interactions, the answers the ledger folded, its row and its Run's ends. */
const prompts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		interactions: (yield* loadLedgerView("s1"))?.interactions,
		answers: (yield* sql<{ commandId: string; interactionId: string }>`
			SELECT json_extract(entry_json, '$.command.control.commandId') AS commandId,
				json_extract(entry_json, '$.command.control.interactionId') AS interactionId
			FROM run_ledger_entries WHERE session_id = 's1'
				AND json_extract(entry_json, '$.command.control.kind') = 'answer'
			ORDER BY entry_seq`).map((row) => ({ ...row })),
		row: yield* sql`SELECT state FROM run_ledger_sessions WHERE session_id = 's1'`,
		ends: (yield* settled).ends,
	};
});
const pending = (interactionId: string) => ({
	tag: "Pending",
	interactionId,
	kind: "permission",
});
const delivered = (interactionId: string) => ({
	tag: "Answered",
	interactionId,
	kind: "permission",
	delivery: "settled",
});

describe("Run Ledger ledger regressions the arm reaches", () => {
	it.effect(
		"RL-006: an OpenCode turn.error then a late idle for the same Run end it once",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...turn("opencode"),
						canonicalEvent(
							"turn.error",
							"s1",
							{ messageId: "m1", error: "boom", code: "provider_error" },
							at("opencode", 1005, { runId: "r1" }),
						),
					]);
					const errored = yield* settled;
					expect(errored.ends).toMatchObject([{ outcome: "error" }]);
					expect(errored.view?.active).toBeUndefined();
					expect(errored.row).toEqual(quiescent);
					yield* project([
						canonicalEvent(
							"session.status",
							"s1",
							{ sessionId: "s1", status: "idle" },
							at("opencode", 1006, { runId: "r1" }),
						),
					]);
					expect(yield* settled).toEqual(errored);
				}),
			),
	);

	it.effect(
		"RL-012: the runner's exit ends its dispatched Run once, and a late cleanup error adds nothing",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...turn("claude"),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R1", label: "R1:1", reattached: false },
							at("claude", 1005),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							{ runId: "r1", runnerId: "R1", commandId: "c1", transmission: 1 },
							at("claude", 1006),
						),
						canonicalEvent(
							"evidence.process_lost",
							"s1",
							{ runnerId: "R1", retiredAt: 1007 },
							at("claude", 1007),
						),
					]);
					const lost = yield* settled;
					expect(lost.ends).toMatchObject([
						{ outcome: "error", reason: { tag: "process_lost" } },
					]);
					expect(lost.view?.active).toBeUndefined();
					expect(lost.row).toEqual(quiescent);
					yield* project([
						canonicalEvent(
							"turn.error",
							"s1",
							{ messageId: "m1", error: "runner exited" },
							at("claude", 1008, { runId: "r1" }),
						),
					]);
					expect(yield* settled).toEqual(lost);
				}),
			),
	);

	it.effect(
		"RL-016: a Stop on a placed Cursor input before intake holds the Run until the host's terminal ends it interrupted",
		() =>
			withStore(
				Effect.gen(function* () {
					// Cursor's runner placed the input; Stop arrives before its RUNNING frame (run.started).
					yield* project([
						...turn("cursor", false),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R1", label: "R1:1", reattached: false },
							at("cursor", 1004),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							{ runId: "r1", runnerId: "R1", commandId: "c1", transmission: 1 },
							at("cursor", 1005),
						),
						stop("cursor", 1006),
					]);
					const stopping = yield* settled;
					expect(stopping.ends).toEqual([]);
					expect(stopping.view?.active).toMatchObject({
						runId: "r1",
						tag: "Interrupting",
						by: "stop",
					});
					expect(
						stopping.view?.active?.inputs.map(({ state }) => state.tag),
					).not.toContain("Accepted");
					yield* project([
						canonicalEvent(
							"turn.interrupted",
							"s1",
							{ messageId: "m1" },
							at("cursor", 1007, { runId: "r1" }),
						),
					]);
					const ended = yield* settled;
					expect(ended.ends).toMatchObject([{ outcome: "interrupted" }]);
					expect(ended.view?.active).toBeUndefined();
					expect(ended.row).toEqual(quiescent);
				}),
			),
	);

	it.effect(
		"RL-047: a released Run's late dispatch on a replacement runner binds nothing after Stop and retirement",
		() =>
			withStore(
				Effect.gen(function* () {
					const hold = (runnerId: string, transmission: number) => ({
						runId: "r1",
						runnerId,
						commandId: "c1",
						transmission,
					});
					yield* project([
						...turn("claude"),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R1", label: "R1:1", reattached: false },
							at("claude", 1005),
						),
						canonicalEvent(
							"run.dispatched",
							"s1",
							hold("R1", 1),
							at("claude", 1006),
						),
						canonicalEvent(
							"run.released",
							"s1",
							{ ...hold("R1", 1), reason: "JournalAbsent" },
							at("claude", 1007),
						),
						stop("claude", 1008),
						canonicalEvent(
							"turn.interrupted",
							"s1",
							{ messageId: "m1" },
							at("claude", 1009, { runId: "r1" }),
						),
						canonicalEvent(
							"evidence.process_lost",
							"s1",
							{ runnerId: "R1", retiredAt: 1010 },
							at("claude", 1010),
						),
						canonicalEvent(
							"evidence.process_started",
							"s1",
							{ runnerId: "R2", label: "R2:1", reattached: false },
							at("claude", 1011),
						),
					]);
					const retired = yield* settled;
					expect(retired.ends).toMatchObject([{ outcome: "interrupted" }]);
					yield* project([
						canonicalEvent(
							"run.dispatched",
							"s1",
							hold("R2", 2),
							at("claude", 1012),
						),
					]);
					expect(yield* settled).toEqual(retired);
					expect(retired.effects).toEqual([]);
				}),
			),
	);

	it.effect(
		"RL-061: a cleanup turn.error after Claude's completion leaves the Run ended completed",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...turn("claude"),
						canonicalEvent(
							"turn.completed",
							"s1",
							{ messageId: "m1" },
							at("claude", 1005, { runId: "r1" }),
						),
					]);
					const completed = yield* settled;
					expect(completed.ends).toMatchObject([{ outcome: "completed" }]);
					yield* project([
						canonicalEvent(
							"turn.error",
							"s1",
							{ messageId: "m1", error: "cleanup failed" },
							at("claude", 1006, { runId: "r1" }),
						),
					]);
					expect(yield* settled).toEqual(completed);
				}),
			),
	);

	it.effect(
		"RL-063: the arm's reads search an index, whatever the session's or the outbox's history",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					// The arm's reads (run-ledger-arm.ts), each as it runs there.
					const reads = [
						"SELECT provider, state, alarm_at FROM run_ledger_sessions WHERE session_id = 's1'",
						"SELECT provider FROM sessions WHERE id = 's1'",
						"SELECT entry_seq, event_sequence, stamp, entry_json FROM run_ledger_entries WHERE session_id = 's1' ORDER BY entry_seq",
						`SELECT json_remove(json_extract(data, '$.request'), '$.images') AS request FROM events
							WHERE session_id = 's1' AND type = 'input.admitted'
								AND json_extract(data, '$.inputId') = 'u1' AND sequence < 9
							ORDER BY sequence DESC LIMIT 1`,
						`SELECT type, json_extract(data, '$.inputId') AS input_id FROM events
							WHERE session_id = 's1'
								AND type IN ('input.interrupt_requested', 'interrupt.requested') AND sequence < 9
							ORDER BY sequence DESC LIMIT 1`,
						`SELECT COALESCE(MAX(request_sequence), 0) + 1, 'ledger:r1:probe:t',
								(SELECT provider FROM sessions WHERE id = 's1'), 'pending'
							FROM provider_command_outbox`,
						"UPDATE sessions SET version = 1 WHERE id = 's1'",
					];
					const plans = yield* Effect.forEach(reads, (read) =>
						sql
							.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${read}`)
							.pipe(Effect.map((rows) => rows.map(({ detail }) => detail))),
					);
					expect(
						plans
							.flat()
							.filter(
								(detail) =>
									detail.startsWith("SCAN") ||
									(detail.startsWith("SEARCH events") &&
										!detail.includes("(session_id=?")),
							),
					).toEqual([]);
				}),
			),
	);

	it.effect(
		"RL-113: a folded indeterminate delivery advances the session's version",
		() =>
			withStore(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const version = sql<{
						version: number;
					}>`SELECT version FROM sessions WHERE id = 's1'`;
					yield* project(turn("opencode"));
					const [before] = yield* version;
					yield* project([
						canonicalEvent(
							"evidence.delivery_indeterminate",
							"s1",
							{ runId: "r1", commandId: "c1" },
							at("opencode", 1005, { runId: "r1" }),
						),
					]);
					const [after] = yield* version;
					expect(after?.version).toBeGreaterThan(
						before?.version ?? Number.POSITIVE_INFINITY,
					);
				}),
			),
	);

	it.effect(
		"RL-064: a runner's loss ends its Run and retires its Pending prompt in the same commit",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project(asked("q1"));
					expect((yield* prompts).interactions).toEqual([pending("q1")]);
					yield* project([
						canonicalEvent(
							"evidence.process_lost",
							"s1",
							{ runnerId: "R1", retiredAt: 1010 },
							at("claude", 1010),
						),
					]);
					const lost = yield* prompts;
					expect(lost.ends).toMatchObject([
						{ outcome: "error", reason: { tag: "process_lost" } },
					]);
					expect(lost.interactions).toEqual([]);
					expect(lost.row).toEqual([{ state: "Quiescent" }]);
				}),
			),
	);

	it.effect(
		"RL-068: main's timed-out rejection folds once as an answer under its outbox row's id, across a recovery",
		() =>
			withStore(
				Effect.gen(function* () {
					const timeout = canonicalEvent(
						"permission.resolved",
						"s1",
						{ id: "q1", decision: "reject", providerProcessId: "R1" },
						at("claude", 1010, { source: "permission-timeout" }),
					);
					yield* project([...asked("q1"), timeout]);
					const commandId = `legacy-answer:${timeout.eventId}`;
					const timedOut = yield* prompts;
					expect(timedOut.answers).toEqual([
						{ commandId, interactionId: "q1" },
					]);
					expect(timedOut.interactions).toMatchObject([
						{ tag: "Answered", interactionId: "q1" },
					]);
					yield* (yield* ProjectionRunnerEffectTag).recover();
					expect(yield* prompts).toEqual(timedOut);
					yield* project([
						outcome(commandId, 1, { tag: "succeeded" }, 1011),
						confirmed("q1", 1012),
					]);
					expect((yield* prompts).interactions).toEqual([delivered("q1")]);
				}),
			),
	);

	it.effect(
		"RL-070: a retryable answer outcome keeps the answer and the prompt Pending, and a second browser answer adds nothing",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...asked("q1"),
						answer("q1", "a1", 1010),
						outcome(
							"a1",
							1,
							{ tag: "retryable", retryAt: 2010, code: "ECONNRESET" },
							1011,
						),
						answer("q1", "a2", 1012),
					]);
					const refused = yield* prompts;
					expect(refused.interactions).toEqual([
						{
							...pending("q1"),
							lastRefusal: {
								attempt: { commandId: "a1", transmission: 1 },
								code: "ECONNRESET",
							},
						},
					]);
					expect(refused.answers).toEqual([
						{ commandId: "a1", interactionId: "q1" },
					]);
					yield* project([
						outcome("a1", 2, { tag: "succeeded" }, 2011),
						confirmed("q1", 2012),
					]);
					const answered = yield* prompts;
					expect(answered.interactions).toEqual([delivered("q1")]);
					expect(answered.answers).toEqual(refused.answers);
				}),
			),
	);

	it.effect(
		"RL-071: an answer that cannot reach its live runner ends alone; the runner's Run and other prompt stay",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...asked("q1", "q2"),
						answer("q1", "a1", 1010),
						outcome(
							"a1",
							1,
							{ tag: "permanent", code: "provider_process_unavailable" },
							1011,
						),
					]);
					const undeliverable = yield* prompts;
					expect(undeliverable.interactions).toEqual([
						delivered("q1"),
						pending("q2"),
					]);
					expect(undeliverable.ends).toEqual([]);
					expect((yield* loadLedgerView("s1"))?.active?.runId).toBe("r1");
				}),
			),
	);

	for (const [id, code] of [
		["RL-073", "provider_control_timeout"],
		["RL-086", "secret_answer_expired"],
	] as const)
		it.effect(
			`${id}: a prompt main reopens after its answer failed for good (${code}) is Pending and answerable again`,
			() =>
				withStore(
					Effect.gen(function* () {
						yield* project([
							...asked("q1"),
							answer("q1", "a1", 1010),
							outcome("a1", 1, { tag: "permanent", code }, 1011),
						]);
						expect((yield* prompts).interactions).toEqual([delivered("q1")]);
						// readFailedControlPrompt re-asks the same prompt where it finds the answer unconsumed.
						yield* project([prompt("q1", 1012)]);
						expect((yield* prompts).interactions).toEqual([pending("q1")]);
						yield* project([
							answer("q1", "a2", 1013),
							outcome("a2", 1, { tag: "succeeded" }, 1014),
							confirmed("q1", 1015),
						]);
						const answered = yield* prompts;
						expect(answered.answers).toEqual([
							{ commandId: "a1", interactionId: "q1" },
							{ commandId: "a2", interactionId: "q1" },
						]);
						expect(answered.interactions).toEqual([delivered("q1")]);
					}),
				),
		);

	it.effect(
		"RL-077: a second outcome for the answer's same transmission changes nothing",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...asked("q1"),
						answer("q1", "a1", 1010),
						outcome("a1", 1, { tag: "succeeded" }, 1011),
						confirmed("q1", 1012),
					]);
					const first = yield* prompts;
					expect(first.interactions).toEqual([delivered("q1")]);
					yield* project([
						outcome(
							"a1",
							1,
							{ tag: "permanent", code: "control_exhausted" },
							1012,
						),
					]);
					expect(yield* prompts).toEqual(first);
				}),
			),
	);

	it.effect(
		"RL-088: a consumed answer whose reply timed out stays the only answer: a second one adds no delivery",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([
						...asked("q1"),
						answer("q1", "a1", 1010),
						outcome(
							"a1",
							1,
							{ tag: "permanent", code: "provider_control_timeout" },
							1011,
						),
					]);
					const timedOut = yield* prompts;
					// Main found it consumed and reopens nothing; the late answer is refused.
					yield* project([answer("q1", "a2", 1012)]);
					expect(yield* prompts).toEqual(timedOut);
					expect(timedOut.answers).toEqual([
						{ commandId: "a1", interactionId: "q1" },
					]);
				}),
			),
	);

	it.effect(
		"RL-115: an answer whose outcome never came stays in delivery across a recovery, then settles once",
		() =>
			withStore(
				Effect.gen(function* () {
					yield* project([...asked("q1"), answer("q1", "a1", 1010)]);
					const claimed = yield* prompts;
					expect(claimed.interactions).toMatchObject([
						{ tag: "Answered", interactionId: "q1" },
					]);
					expect(claimed.interactions).not.toEqual([delivered("q1")]);
					yield* (yield* ProjectionRunnerEffectTag).recover();
					expect(yield* prompts).toEqual(claimed);
					yield* project([
						outcome("a1", 2, { tag: "succeeded" }, 1011),
						confirmed("q1", 1012),
					]);
					const answered = yield* prompts;
					expect(answered.interactions).toEqual([delivered("q1")]);
					expect(answered.answers).toEqual(claimed.answers);
				}),
			),
	);
});

// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
describe("Run Ledger ledger regressions", () => {
	it.todo("RL-001: Preserve active ownership during upgrade backfill");
	it.todo(
		"RL-002: Reconcile external OpenCode runs without commands after restart",
	);
	it.todo(
		"RL-004: Invalidate sampled OpenCode idle when new input is accepted",
	);
	it.todo("RL-006: the receipt and command views (25scs)");
	it.todo("RL-007: Reconcile every accepted input belonging to the same Run");
	it.todo("RL-008: Recover an open Run despite an already-completed command");
	it.todo("RL-011: Retain pre-intake input identity at a processing deadline");
	it.todo("RL-012: the placed input's settlement (32.6)");
	it.todo("RL-015: Preserve an exact input failure before provider delivery");
	it.todo("RL-016: the Stop's pause (32.8, 32.13)");
	it.todo(
		"RL-018: Do not manufacture success from migration-interrupted OpenCode history",
	);
	it.todo("RL-022: Keep copied fork history outside live Run membership");
	it.todo(
		"RL-023: Do not idle another Run's children when a steer is declined",
	);
	it.todo("RL-024: Do not copy native agent identity into a fork");
	it.todo("RL-026: Preserve failed pre-intake history when forking");
	it.todo("RL-035: Keep unclaimed input queued when Stop pauses the inbox");
	it.todo("RL-042: Derive inbox busy and pause from one ledger view");
	it.todo("RL-043: Place a continuation once per admitted attempt");
	it.todo("RL-044: Do not let replayed compaction markers steal a new input");
	it.todo("RL-046: Trigger OpenCode recaps from committed Run completion");
	it.todo("RL-047: the interpreter's claim before delivery (32.6, 32.29.2)");
	it.todo(
		"RL-051: Settle indeterminate inputs after confirmed runner retirement",
	);
	it.todo("RL-057: Attach legacy output placed after hello to its exact input");
	it.todo("RL-060: Do not let duplicate placement discard an owned failure");
	it.todo("RL-061: no false error card (25scs)");
	it.todo("RL-062: Retain admitted handoff data during live-command recovery");
	it.todo("RL-063: main's ownership select through the view (25scs)");
	it.todo(
		"RL-066: Detach duplicate control waiters without cancelling shared work",
	);
	it.todo(
		"RL-067: Retain ordinary Stop pause after the pending steer finishes",
	);
	it.todo(
		"RL-069: Cancel inactive-project effects without blocking shared OpenCode",
	);
	it.todo(
		"RL-074: Publish newly admitted controls only when execution ownership is durable",
	);
	it.todo("RL-076: Respect the persisted effect budget across a crash");
	it.todo("RL-084: Preserve immutable legacy Stop payload on replay");
	it.todo("RL-093: Recover controls imported after initial startup");
	it.todo("RL-094: Preserve refused unplaced user input durably");
	it.todo("RL-095: Settle claimed unaccepted work for inactive projects");
	it.todo(
		"RL-097: Retain late accounting without changing an interrupted lifecycle",
	);
	it.todo(
		"RL-098: Fence new claims while replacement attachment recovery selects work",
	);
	it.todo("RL-099: Retain historical accounting after a prompt is reused");
	it.todo(
		"RL-100: Do not confuse a refusal lock with live execution ownership",
	);
	it.todo(
		"RL-101: Resolve persisted parents for separately batched late accounting",
	);
	it.todo("RL-102: Keep execution ownership specific to each retry attempt");
	it.todo(
		"RL-103: Reconcile cancelled pending OpenCode reservations on project return",
	);
	it.todo("RL-104: Honor explicit input ownership on late bare SDK results");
	it.todo("RL-113: canStop from the view and the sidebar delta (25scs)");
	it.todo(
		"RL-116: Attribute out-of-order cumulative accounting without miscounting",
	);
});
