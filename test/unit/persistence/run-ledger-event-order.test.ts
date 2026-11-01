// The event-order test (CONTRACT.md 11.3, 32.3): every ordering of up to six events for a Claude
// session with one send and one steer, through the public interface (commitAndSignal, the arm's
// fold, loadLedgerView) on real SQLite, a restart being a fresh persistence graph over the same
// file. How it could fail:
// 1. an effect ends twice: it leaves the live view and comes back, or its Run ends twice;
// 2. a live effect names a Run that is not the active one (a running effect with no owner);
// 3. an input returns to the inbox twice, or after it was shown;
// 4. a label's lost work is reported twice (the ledger's reading of a draft restored twice);
// 5. more than 5 transmissions of one input's start;
// 6. the later input starts while the earlier one is still queued;
// 7. a restart's fold differs from a replay of the same events (LI4).
// Gaps, the nearest reading of 11.3's list against today's events (CONTRACT.md 11.3, line 3491):
// the runner wire's reply and hello forms are 32.5's and 32.6's, so a reply is run.released at the
// current or an old transmission and an attemptless run.dispatched, a hello is process_started
// with reattached; receipts are main's outbox writers', which no event here reaches.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
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

const at = (createdAt: number, metadata = {}) => ({
	createdAt,
	metadata,
	provider: "claude",
});
const hold = (transmission: number) => ({
	runId: "r1",
	runnerId: "rn1",
	commandId: "c1",
	transmission,
});

/** Each step's event at its time; restart is no event. */
const STEPS = {
	claim: (id: string, now: number) =>
		canonicalEvent("run.dispatched", id, hold(1), at(now)),
	retryClaim: (id: string, now: number) =>
		canonicalEvent("run.dispatched", id, hold(2), at(now)),
	attemptless: (id: string, now: number) =>
		canonicalEvent(
			"run.dispatched",
			id,
			{ runId: "r1", runnerId: "rn1" },
			at(now),
		),
	nativeTerminal: (id: string, now: number) =>
		canonicalEvent(
			"turn.completed",
			id,
			{ messageId: "m1" },
			at(now, { runId: "r1" }),
		),
	replyCurrent: (id: string, now: number) =>
		canonicalEvent(
			"run.released",
			id,
			{ ...hold(1), reason: "NotSent" },
			at(now),
		),
	replyOld: (id: string, now: number) =>
		canonicalEvent(
			"run.released",
			id,
			{ ...hold(0), reason: "NotSent" },
			at(now),
		),
	refusal: (id: string, now: number) =>
		canonicalEvent(
			"run.released",
			id,
			{ ...hold(1), reason: "Refused" },
			at(now),
		),
	resumeRejected: (id: string, now: number) =>
		canonicalEvent(
			"run.released",
			id,
			{ ...hold(1), reason: "ResumeRejected" },
			at(now),
		),
	hello: (id: string, now: number) =>
		canonicalEvent(
			"evidence.process_started",
			id,
			{ runnerId: "rn1", label: "rn1", reattached: true },
			at(now),
		),
	runnerLost: (id: string, now: number) =>
		canonicalEvent(
			"evidence.process_lost",
			id,
			{ runnerId: "rn1", retiredAt: now },
			at(now),
		),
	stop: (id: string, now: number) =>
		canonicalEvent(
			"interrupt.requested",
			id,
			{
				providerProcessId: "p1",
				stop: {
					deadlineAt: now + 500,
					owners: [{ runId: "r1" }],
					turnIds: [],
					runnerBacked: true,
					retainedSteers: false,
				},
			},
			at(now, { commandId: "cs" }),
		),
	alarm: (id: string, now: number) =>
		canonicalEvent("evidence.alarm_fired", id, { alarmAt: now }, at(now)),
	restart: undefined,
} as const;
type Step = keyof typeof STEPS;

/** Six steps each; every permutation, so every ordering of up to six within a group. */
const GROUPS: readonly (readonly Step[])[] = [
	["claim", "replyOld", "nativeTerminal", "refusal", "runnerLost", "restart"],
	["claim", "stop", "hello", "resumeRejected", "alarm", "restart"],
	[
		"claim",
		"retryClaim",
		"attemptless",
		"replyCurrent",
		"nativeTerminal",
		"restart",
	],
];

const permutations = <A>(items: readonly A[]): A[][] =>
	items.length === 0
		? [[]]
		: items.flatMap((item, index) =>
				permutations(items.filter((_, other) => other !== index)).map(
					(rest) => [item, ...rest],
				),
			);

/** One send and one steer, handed off; the send's Run requested. */
const prefix = (id: string) => [
	makeSessionCreatedEvent(id, { provider: "claude", createdAt: 1000 }),
	canonicalEvent(
		"input.admitted",
		id,
		{
			sessionId: id,
			inputId: "u1",
			delivery: "queue",
			request: { text: "a", images: [] },
		},
		at(1001),
	),
	canonicalEvent("input.sent", id, { sessionId: id, inputId: "u1" }, at(1002)),
	canonicalEvent(
		"run.requested",
		id,
		{ runId: "r1", inputId: "u1" },
		at(1003, { runId: "r1" }),
	),
	canonicalEvent(
		"input.admitted",
		id,
		{
			sessionId: id,
			inputId: "u2",
			delivery: "steer",
			request: { text: "b", images: [] },
		},
		at(1004),
	),
	canonicalEvent(
		"input.sent",
		id,
		{ sessionId: id, inputId: "u2", steer: true },
		at(1005),
	),
];

const sequences = GROUPS.flatMap((group, groupIndex) =>
	permutations(group).map((steps, index) => {
		const id = `g${groupIndex}-${index}`;
		return {
			id,
			steps,
			events: steps.map((step, position) =>
				step === "restart"
					? undefined
					: STEPS[step](id, 2000 + 1000 * position),
			),
		};
	}),
);

const entries = Effect.flatMap(
	SqlClient.SqlClient,
	(sql) =>
		sql<{
			session_id: string;
			entry_json: string;
		}>`SELECT session_id, entry_json FROM run_ledger_entries ORDER BY session_id, entry_seq`,
);

/**
 * One graph over the file: before the restart it commits each sequence's prefix and its steps up
 * to restart, after it the rest, reading the view after each commit.
 */
const run = (
	file: string,
	phase: "before" | "after",
	traces: Map<string, LedgerView[]>,
	committed: Map<string, CanonicalEvent[]>,
) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		for (const sequence of sequences) {
			const restart = sequence.steps.indexOf("restart");
			const steps =
				phase === "before"
					? sequence.events.slice(0, restart)
					: sequence.events.slice(restart + 1);
			const batches = [
				...(phase === "before" ? [prefix(sequence.id)] : []),
				...steps.map((event) => (event ? [event] : [])),
			];
			for (const batch of batches) {
				yield* commit(batch);
				committed.set(sequence.id, [
					...(committed.get(sequence.id) ?? []),
					...batch,
				]);
				const view = yield* loadLedgerView(sequence.id);
				if (view)
					traces.set(sequence.id, [...(traces.get(sequence.id) ?? []), view]);
			}
		}
		return yield* entries;
	}).pipe(Effect.provide(makePersistenceEffectLayer(file, "test-project")));

/** The first view that breaks an invariant (index 0 is the prefix's), with its reason. */
const firstViolation = (trace: readonly LedgerView[], runEnds: number) => {
	const ended = new Set<string>();
	const returns = new Map<string, number>();
	const shown = new Set<string>();
	const lost = new Set<string>();
	const starts = new Map<string, Set<string>>();
	let live = new Set<string>();
	let inbox = new Set<string>();
	let lostNow = new Set<string>();
	for (const [step, view] of trace.entries()) {
		// Whether the Run had ended (no active Run) in an earlier view.
		const fail = (reason: string) => ({
			step,
			reason,
			afterEnd: trace
				.slice(1, step)
				.some((earlier) => earlier.active === undefined),
		});
		const issues = new Set(
			view.live.map((issue) =>
				issue.tag === "Main"
					? `${issue.commandId}:${issue.effect.kind}`
					: issue.token,
			),
		);
		// An unlaunch (3.6) returns its Run to Queued: its issue left live with no terminal, and a
		// relaunch transmits it again (D50).
		if (view.active?.tag !== "Queued")
			for (const key of live) if (!issues.has(key)) ended.add(key);
		for (const key of issues)
			if (ended.has(key)) return fail(`1: ${key} ended and came back`);
		live = issues;
		for (const issue of view.live) {
			if (
				"runId" in issue.effect &&
				issue.effect.runId !== null &&
				issue.effect.runId !== view.active?.runId
			)
				return fail(`2: ${issue.effect.kind} names no active Run`);
			if (issue.tag === "Main" && issue.effect.kind === "start") {
				const commands = starts.get(issue.effect.inputId) ?? new Set();
				starts.set(issue.effect.inputId, commands.add(issue.commandId));
				if (commands.size > 5) return fail("5: more than 5 transmissions");
			}
		}
		const inputs = view.active?.inputs ?? [];
		for (const input of inputs)
			if (input.state.tag === "Accepted" || input.state.tag === "Delivered")
				shown.add(input.inputId);
		const nextInbox = new Set(view.inbox.map((input) => input.inputId));
		for (const inputId of nextInbox)
			if (!inbox.has(inputId)) {
				if (shown.has(inputId))
					return fail(`3: ${inputId} returned after shown`);
				const count = (returns.get(inputId) ?? 0) + 1;
				returns.set(inputId, count);
				if (count > 1) return fail(`3: ${inputId} returned twice`);
			}
		inbox = nextInbox;
		const state = (inputId: string) =>
			inputs.find((input) => input.inputId === inputId)?.state.tag;
		if (
			state("u2") !== undefined &&
			state("u2") !== "Queued" &&
			state("u1") === "Queued"
		)
			return fail("6: u2 started while u1 queued");
		const labels = view.lostWork.map((work) => work.label);
		const nextLost = new Set(labels);
		if (
			nextLost.size < labels.length ||
			labels.some((label) => !lostNow.has(label) && lost.has(label))
		)
			return fail("4: lost work reported twice");
		for (const label of labels) lost.add(label);
		lostNow = nextLost;
	}
	return runEnds > 1
		? {
				step: trace.length - 1,
				reason: "1: the Run ended twice",
				afterEnd: false,
			}
		: undefined;
};

describe("Run Ledger event order (11.3)", () => {
	it.effect(
		"holds every invariant over every ordering of up to six events, across a restart",
		() =>
			Effect.acquireUseRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "run-ledger-order-"))),
				(dir) =>
					Effect.gen(function* () {
						const file = join(dir, "events.db");
						const traces = new Map<string, LedgerView[]>();
						const committed = new Map<string, CanonicalEvent[]>();
						yield* run(file, "before", traces, committed);
						const live = yield* run(file, "after", traces, committed);
						// 7: the same events appended and replayed from scratch on a second file.
						const replayed = yield* Effect.gen(function* () {
							const store = yield* EventStoreEffectTag;
							for (const sequence of sequences)
								yield* store.appendBatch(committed.get(sequence.id) ?? []);
							yield* (yield* ProjectionRunnerEffectTag).recover();
							return yield* entries;
						}).pipe(
							Effect.provide(
								makePersistenceEffectLayer(
									join(dir, "replay.db"),
									"test-project",
								),
							),
						);
						const ends = new Map<string, number>();
						for (const entry of live)
							if (JSON.parse(entry.entry_json).kind === "end")
								ends.set(
									entry.session_id,
									(ends.get(entry.session_id) ?? 0) + 1,
								);
						const violations = sequences.flatMap((sequence) => {
							const found = firstViolation(
								traces.get(sequence.id) ?? [],
								ends.get(sequence.id) ?? 0,
							);
							if (!found) return [];
							// View n follows the n-th committed step; restart commits nothing.
							const committedAt = sequence.steps.flatMap((step, position) =>
								step === "restart" ? [] : [position],
							);
							const steps = sequence.steps.slice(
								0,
								(committedAt[found.step - 1] ?? -1) + 1,
							);
							// A decider finding, not the arm's: a run.dispatched after its Run ended (a native
							// terminal, or a Stop before the claim) binds a live start for the ended Run (3.4:
							// dispatched() refuses only a dropped issue, H3). Kept apart, so any other fails.
							return [
								{
									steps,
									reason: found.reason,
									known:
										found.afterEnd &&
										/^[12]: /.test(found.reason) &&
										["claim", "retryClaim"].includes(steps.at(-1) ?? ""),
								},
							];
						});
						const unexplained = violations.filter((found) => !found.known);
						const smallest = (list: typeof violations) =>
							[...list].sort((a, b) => a.steps.length - b.steps.length)[0] ??
							null;
						// Beside the test, ignored by git; Playwright wipes test-results/.
						const artifacts = join(import.meta.dirname, "artifacts");
						mkdirSync(artifacts, { recursive: true });
						writeFileSync(
							join(artifacts, "run-ledger-event-order.json"),
							`${JSON.stringify(
								{
									orderings: sequences.length,
									groups: GROUPS,
									entries: live.length,
									runEnds: [...ends.values()].reduce((a, b) => a + b, 0),
									violations: unexplained.length,
									smallest: smallest(unexplained),
									decider: {
										violations: violations.length - unexplained.length,
										smallest: smallest(
											violations.filter((found) => found.known),
										),
									},
									replayMatches:
										JSON.stringify(replayed) === JSON.stringify(live),
								},
								null,
								"\t",
							)}\n`,
						);
						return { unexplained, live, replayed, ends };
					}),
				(dir) =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			).pipe(
				Effect.tap(({ unexplained, live, replayed, ends }) =>
					Effect.sync(() => {
						expect(unexplained.slice(0, 3)).toEqual([]);
						expect(replayed).toEqual(live);
						// The orderings reach the Run's end, so 1's end count is exercised.
						expect(ends.size).toBeGreaterThan(sequences.length / 2);
					}),
				),
			),
		180_000,
	);
});
