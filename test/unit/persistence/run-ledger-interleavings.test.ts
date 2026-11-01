// Generated interleavings of the Run Ledger on real SQLite (CONTRACT.md 11.2 spec properties, 3.12):
// a runner-held Claude session and a direct OpenCode session, their events interleaved at random,
// with a restart (a fresh persistence graph over the file) or a crash between any two steps. A crash
// aborts the projecting write at the arm's entry insert or at the batch's last write, after the arm
// folded, then the event is delivered again. How it could fail:
// 1. a Run ends twice;
// 2. a Tombstoned Run becomes the active Run again (it accepts a lifecycle event), or keeps a live
//    issue (a late dispatch binds a start for it);
// 3. an input whose delivery is unknown is transmitted again (delivered twice);
// 4. a crashed write leaves an entry, a session row or a view behind (tables and views disagree
//    after a rollback), or its stale cache forks the next fold;
// 5. a restart's load differs from the view before it;
// 6. the live fold, across its crashes and restarts, differs from one replay of the committed events.
// CI runs one fixed seed; RUN_LEDGER_SQLITE_SEED and RUN_LEDGER_SQLITE_RUNS widen it. Gap: no runner
// wire or receipts (32.5, 32.6), so the alphabet is today's canonical events.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import type { LedgerView } from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const SESSIONS = ["c", "o"] as const;
const at = (
	provider: "claude" | "opencode",
	createdAt: number,
	metadata = {},
) => ({
	createdAt,
	metadata,
	provider,
});
const hold = (transmission: number) => ({
	runId: "r1",
	runnerId: "rn1",
	commandId: "c1",
	transmission,
});
const stop = (id: "c" | "o", now: number) =>
	canonicalEvent(
		"interrupt.requested",
		id,
		{
			providerProcessId: "p1",
			stop: {
				deadlineAt: now + 500,
				owners: [{ runId: "r1" }],
				turnIds: [],
				runnerBacked: id === "c",
				retainedSteers: false,
			},
		},
		at(id === "c" ? "claude" : "opencode", now, { commandId: `stop-${now}` }),
	);
const alarm = (id: "c" | "o", now: number) =>
	canonicalEvent(
		"evidence.alarm_fired",
		id,
		{ alarmAt: now },
		at(id === "c" ? "claude" : "opencode", now),
	);

/** Each step's event at its time: `c.` the runner-held Claude session, `o.` the direct OpenCode one. */
const STEPS = {
	"c.claim": (now: number) =>
		canonicalEvent("run.dispatched", "c", hold(1), at("claude", now)),
	"c.retryClaim": (now: number) =>
		canonicalEvent("run.dispatched", "c", hold(2), at("claude", now)),
	"c.replyCurrent": (now: number) =>
		canonicalEvent(
			"run.released",
			"c",
			{ ...hold(1), reason: "NotSent" },
			at("claude", now),
		),
	"c.replyOld": (now: number) =>
		canonicalEvent(
			"run.released",
			"c",
			{ ...hold(0), reason: "NotSent" },
			at("claude", now),
		),
	"c.refusal": (now: number) =>
		canonicalEvent(
			"run.released",
			"c",
			{ ...hold(1), reason: "Refused" },
			at("claude", now),
		),
	"c.nativeTerminal": (now: number) =>
		canonicalEvent(
			"turn.completed",
			"c",
			{ messageId: "m1" },
			at("claude", now, { runId: "r1" }),
		),
	"c.hello": (now: number) =>
		canonicalEvent(
			"evidence.process_started",
			"c",
			{ runnerId: "rn1", label: "rn1", reattached: true },
			at("claude", now),
		),
	"c.runnerLost": (now: number) =>
		canonicalEvent(
			"evidence.process_lost",
			"c",
			{ runnerId: "rn1", retiredAt: now },
			at("claude", now),
		),
	"c.stop": (now: number) => stop("c", now),
	"c.alarm": (now: number) => alarm("c", now),
	"o.started": (now: number) =>
		canonicalEvent(
			"run.started",
			"o",
			{ inputId: "u1", requestedRunId: "r1" },
			at("opencode", now, { runId: "r1" }),
		),
	"o.marker": (now: number) =>
		canonicalEvent(
			"evidence.delivery_indeterminate",
			"o",
			{ runId: "r1", commandId: "c1" },
			at("opencode", now, { runId: "r1" }),
		),
	// Main's fresh-run retry (4.8): a direct send's run.requested is a transmission of Run r1 (D59).
	"o.retry": (now: number) =>
		canonicalEvent(
			"run.requested",
			"o",
			{ runId: "r2", inputId: "u1" },
			at("opencode", now, { runId: "r2" }),
		),
	"o.completed": (now: number) =>
		canonicalEvent(
			"turn.completed",
			"o",
			{ messageId: "m1" },
			at("opencode", now, { runId: "r1" }),
		),
	"o.stop": (now: number) => stop("o", now),
	"o.alarm": (now: number) => alarm("o", now),
} as const;
const NAMES = Object.keys(STEPS) as (keyof typeof STEPS)[];

/** Claude: a send and a steer handed off, the send's Run requested; OpenCode: a send requested. */
const prefix = (): CanonicalEvent[] => [
	makeSessionCreatedEvent("c", { provider: "claude", createdAt: 1000 }),
	makeSessionCreatedEvent("o", { provider: "opencode", createdAt: 1000 }),
	...SESSIONS.flatMap((id) => {
		const provider = id === "c" ? "claude" : "opencode";
		return [
			canonicalEvent(
				"input.admitted",
				id,
				{
					sessionId: id,
					inputId: "u1",
					delivery: "queue",
					request: { text: "a", images: [] },
				},
				at(provider, 1001),
			),
			canonicalEvent(
				"input.sent",
				id,
				{ sessionId: id, inputId: "u1" },
				at(provider, 1002),
			),
			canonicalEvent(
				"run.requested",
				id,
				{ runId: "r1", inputId: "u1" },
				at(provider, 1003, { runId: "r1" }),
			),
		];
	}),
	canonicalEvent(
		"input.admitted",
		"c",
		{
			sessionId: "c",
			inputId: "u2",
			delivery: "steer",
			request: { text: "b", images: [] },
		},
		at("claude", 1004),
	),
	canonicalEvent(
		"input.sent",
		"c",
		{ sessionId: "c", inputId: "u2", steer: true },
		at("claude", 1005),
	),
];

const Trace = Schema.Array(
	Schema.Struct({
		step: Schema.Literals([...NAMES, "restart"]),
		crash: Schema.Literals(["none", "entry", "batch"]),
	}),
).check(Schema.isMinLength(6), Schema.isMaxLength(16));

const tables = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		entries: yield* sql<{
			session_id: string;
			entry_seq: number;
			event_sequence: number;
			entry_json: string;
		}>`SELECT session_id, entry_seq, event_sequence, entry_json FROM run_ledger_entries
			ORDER BY session_id, entry_seq`,
		sessions:
			yield* sql`SELECT session_id, provider, state, alarm_at FROM run_ledger_sessions ORDER BY session_id`,
	};
});
const views = Effect.forEach(SESSIONS, loadLedgerView);

/** Hits per step kind, per crash that rolled a fold back, and per restart, over every evaluation. */
const hits = new Map<string, number>();
const hit = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1);

/** 1 over a session's final ends, then the first view that breaks 2 or 3. */
const spec = (
	trace: readonly { view: LedgerView; ended: readonly string[] }[],
) => {
	const ends = trace.at(-1)?.ended ?? [];
	if (new Set(ends).size < ends.length) return `1: a Run ended twice (${ends})`;
	const unknown = new Set<string>();
	const starts = new Map<string, Set<string>>();
	for (const [step, { view, ended }] of trace.entries()) {
		if (view.active && ended.includes(view.active.runId))
			return `2: Tombstoned ${view.active.runId} active at view ${step}`;
		for (const issue of view.live) {
			if (
				"runId" in issue.effect &&
				issue.effect.runId !== null &&
				ended.includes(issue.effect.runId)
			)
				return `2: ${issue.effect.kind} live for Tombstoned ${issue.effect.runId} at view ${step}`;
			if (issue.effect.kind !== "start") continue;
			const inputId = issue.effect.inputId;
			const key = issue.tag === "Main" ? issue.commandId : issue.token;
			const seen = starts.get(inputId) ?? new Set();
			if (!seen.has(key) && unknown.has(inputId))
				return `3: ${inputId} transmitted again after delivery unknown, view ${step}`;
			starts.set(inputId, seen.add(key));
		}
		for (const input of view.active?.inputs ?? [])
			if (
				input.state.tag === "Delivered" &&
				input.state.certainty === "unknown"
			)
				unknown.add(input.inputId);
	}
	return undefined;
};

/** One evaluation on its own file. */
const evaluate = (steps: typeof Trace.Type) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-interleave-"))),
		(dir) =>
			Effect.gen(function* () {
				const file = join(dir, "events.db");
				const committed = prefix();
				const traces = new Map<string, { view: LedgerView; ended: string[] }[]>(
					SESSIONS.map((id) => [id, []]),
				);
				// One graph per part: a restart ends one and starts the next.
				const parts: {
					step: keyof typeof STEPS;
					crash: (typeof steps)[number]["crash"];
					at: number;
				}[][] = [[]];
				for (const [index, { step, crash }] of steps.entries())
					if (step === "restart") parts.push([]);
					else parts.at(-1)?.push({ step, crash, at: 2000 + 1000 * index });
				let before: readonly (LedgerView | undefined)[] = [];
				for (const [index, part] of parts.entries()) {
					const found = yield* Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const commit = yield* makeCommitAndSignal;
						if (index === 0) yield* commit(committed);
						else {
							hit("restart");
							// 5: a restart's load is the view before it.
							if (JSON.stringify(yield* views) !== JSON.stringify(before))
								return `5: restart ${index} loads another view`;
						}
						const record = Effect.gen(function* () {
							const loaded = yield* views;
							const { entries } = yield* tables;
							for (const [position, id] of SESSIONS.entries()) {
								const view = loaded[position];
								const ended = entries
									.filter((entry) => entry.session_id === id)
									.map((entry) => JSON.parse(entry.entry_json))
									.filter((entry) => entry.kind === "end")
									.map((entry) => String(entry.runId));
								if (view) traces.get(id)?.push({ view, ended });
							}
							return loaded;
						});
						before = yield* record;
						for (const { step, crash, at: now } of part) {
							const event = STEPS[step](now);
							hit(step);
							if (crash !== "none") {
								// 4: the write aborts after the event's insert, then the event comes again.
								const prior = yield* tables;
								if (crash === "entry")
									yield* sql`CREATE TRIGGER crash BEFORE INSERT ON run_ledger_entries
										BEGIN SELECT RAISE(ABORT, 'crash'); END`;
								else
									yield* sql`CREATE TRIGGER crash BEFORE INSERT ON projector_cursors
										WHEN NEW.projector_name LIKE '@batch:%'
										BEGIN SELECT RAISE(ABORT, 'crash'); END`;
								const crashed = yield* Effect.exit(commit([event]));
								yield* sql`DROP TRIGGER crash`;
								if (crashed._tag === "Failure") {
									hit(`rollback:${crash}`);
									if (
										JSON.stringify(yield* tables) !== JSON.stringify(prior) ||
										JSON.stringify(yield* views) !== JSON.stringify(before)
									)
										return `4: ${step}'s rolled-back write left a trace`;
									yield* commit([event]);
								}
							} else yield* commit([event]);
							committed.push(event);
							before = yield* record;
						}
						return undefined;
					}).pipe(
						Effect.provide(makePersistenceEffectLayer(file, "test-project")),
					);
					if (found) return found;
				}
				const live = yield* tables.pipe(
					Effect.provide(makePersistenceEffectLayer(file, "test-project")),
				);
				// 6: one replay of the committed events on a second file folds the same tables.
				const replayed = yield* Effect.gen(function* () {
					yield* (yield* EventStoreEffectTag).appendBatch(committed);
					yield* (yield* ProjectionRunnerEffectTag).recover();
					return yield* tables;
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(join(dir, "replay.db"), "test-project"),
					),
				);
				if (JSON.stringify(replayed) !== JSON.stringify(live))
					return "6: the replay folds other tables";
				for (const id of SESSIONS) {
					const found = spec(traces.get(id) ?? []);
					if (found) return `${id} ${found}`;
				}
				return undefined;
			}),
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	).pipe(
		Effect.flatMap((found) =>
			found === undefined ? Effect.succeed(true) : Effect.fail(found),
		),
	);

const seed = Number(process.env["RUN_LEDGER_SQLITE_SEED"] ?? 82_103_400);
const runs = Number(process.env["RUN_LEDGER_SQLITE_RUNS"] ?? 60);

describe("Run Ledger generated interleavings on SQLite (11.2)", () => {
	it.effect(
		"keeps the spec properties across generated interleavings, crashes and restarts",
		() =>
			Arbitrary.checkEffect(Arbitrary.schema(Trace), evaluate, {
				seed,
				runs,
				maxShrinks: 60,
			}).pipe(
				Effect.tap((result) =>
					Effect.sync(() => {
						// Beside the test, ignored by git.
						const artifacts = join(import.meta.dirname, "artifacts");
						mkdirSync(artifacts, { recursive: true });
						writeFileSync(
							join(artifacts, "run-ledger-interleavings.json"),
							`${JSON.stringify(
								{
									seed,
									runs,
									hits: Object.fromEntries([...hits].sort()),
									result:
										result._tag === "Falsified"
											? {
													shrunk: result.shrunkInput,
													failure: Arbitrary.formatCheckFailure(result),
												}
											: result,
								},
								null,
								"\t",
							)}\n`,
						);
						expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
						// The coverage gate: every step kind, a rolled-back fold and a restart were reached.
						expect(
							[...NAMES, "rollback:entry", "rollback:batch", "restart"].filter(
								(key) => !hits.has(key),
							),
						).toEqual([]);
					}),
				),
			),
		300_000,
	);
});
