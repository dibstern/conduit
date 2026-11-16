import assert from "node:assert/strict";
import { expect } from "vitest";
import type {
	Evidence,
	IssuedEffect,
	LedgerCommand,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { type Send, splitLabel } from "./fake-provider.js";
import type { TraceDriver } from "./harness.js";
import type { OracleScenario } from "./scenarios.js";

function step(d: TraceDriver, command: LedgerCommand, now = d.now) {
	const result = d.step(command, now);
	expect(result.tag, result.diagnostic).toBe("Accepted");
	return result;
}

function observe(
	d: TraceDriver,
	send: IssuedEffect | Send,
	evidence: Evidence,
	now = d.now,
) {
	const result = d.observe(send, evidence, now);
	expect(result.tag, result.diagnostic).toBe("Accepted");
	return result;
}

function admit(d: TraceDriver, inputId: string, runNow = false) {
	if (!d.host.groundTruth().processAlive)
		step(d, {
			verb: "settle",
			settlement: {
				kind: "process_started",
				label:
					d.commands.length === 0
						? d.label
						: `review-host-${d.commands.length}:1`,
				reattached: false,
			},
		});
	// D58: the user picks the delivery; an input sent while a Run is open steers into it (3.9).
	const admitted = step(d, {
		verb: "admit",
		inputId,
		delivery: d.view().active && !runNow ? "steer" : "queue",
		request: { text: inputId },
	});
	// G2: Run now carries its stop commit's deadlineAt (L6, 3.13).
	if (runNow)
		step(d, {
			verb: "control",
			control: {
				kind: "run_now",
				commandId: `run-now-${inputId}`,
				inputId,
				deadlineAt: d.now + 1_000,
			},
		});
	main(d, 0);
	return admitted;
}

/**
 * D60: main claims its inbox (0), starts (1), ends (2) or relaunches (3) a run through the fake's own
 * draw, else makes the next move it can; a step with nothing for main to do draws no command. Variant 7
 * with an odd input is OpenCode's turn.error: main's error terminal, then its query_ended next.
 */
export function main(d: TraceDriver, variant: number, input = 0) {
	const { command } = d.host.next(
		{ operation: 28, selection: 0, index: 0, variant, input, advance: 0 },
		{ issued: d.issued, view: d.view(), now: d.now, alarmAt: d.alarmAt },
	);
	return command.verb === "observe" ? step(d, command) : undefined;
}

function running(d: TraceDriver) {
	admit(d, "A");
	main(d, 1);
	const send = d.latest("start");
	observe(d, send, { kind: "started" });
	observe(d, send, { kind: "input_accepted", nativeMessageId: "native-A" });
	return send;
}

/** A's start, issued and not yet confirmed. */
function unconfirmed(d: TraceDriver) {
	admit(d, "A");
	main(d, 1);
	return d.latest("start");
}

/**
 * AMENDMENT-2026-11-16 E1, E2, E4: OpenCode's turn.error terminal folds first and ends A's Run; its start
 * stays a member, and the native_session probe it issued is returned.
 */
function terminalFirst(d: TraceDriver) {
	expect(main(d, 7, 1)?.ended).toHaveLength(1);
	return d.latest(
		"probe",
		(effect) =>
			effect.kind === "probe" && effect.target.tag === "native_session",
	);
}

function fire(d: TraceDriver, at = d.alarmAt) {
	assert(at !== undefined, "the outstanding obligation has an alarm");
	return step(d, { verb: "settle", settlement: { kind: "alarm_fired" } }, at);
}

function input(d: TraceDriver, inputId: string) {
	return (d.view().active?.inputs ?? []).find(
		(value) => value.inputId === inputId,
	);
}

function starts(d: TraceDriver, inputId: string) {
	return d.issued.filter(
		({ effect }) => effect.kind === "start" && effect.inputId === inputId,
	);
}

export const reviewTraces: readonly OracleScenario<TraceDriver>[] = [
	{
		id: "R1-1",
		title:
			"[5.1 replaces quarantine; 3.8] failed kill-and-respawn releases completed work's fence without changing its Tombstone",
		provider: "claude",
		run(d) {
			// HL-K R1 finding 1, art-hlk2r/run.log:7328-7329. Quarantine was deleted by 5.1.
			const a = running(d);
			const runA = d.view().active?.runId;
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, {
				kind: "input_accepted",
				nativeMessageId: "native-B",
			});
			const completed = observe(d, a, { kind: "result", outcome: "completed" });
			expect(completed.ended).toMatchObject([
				{ outcome: "completed", reason: { tag: "completed" } },
			]);
			// J1, J4 (AMENDMENT-2026-11-16): A's result did not take B, so B is a Run of its own; main's
			// late join names the Ended A and starts it. Run now stops it, and its work is main's until
			// main's terminal for B's run, so no ledger stop deadline arms (D59, L6, CONTRACT.md 777-783).
			main(d, 2);
			admit(d, "C", true);
			const own = d.view().active;
			expect(own).toMatchObject({ tag: "Interrupting", by: "run_now" });
			expect(own?.runId).not.toBe(runA);
			expect(starts(d, "C")).toHaveLength(0);
			expect(d.alarmAt).toBeUndefined();
			// REDESIGN-7 deleted close and D59 kill_and_respawn: retirement is main's act, seen as
			// process_lost (3.13); it ends B's Run with its Stop's outcome. Its successor is main's claim after the terminal (D60).
			const released = step(d, {
				verb: "settle",
				settlement: {
					kind: "process_lost",
					runnerId: splitLabel(d.label).runnerId,
					retiredAt: d.now,
				},
			});
			expect(released.ended).toMatchObject([
				{ runId: own?.runId, reason: { tag: "interrupted" } },
			]);
			main(d, 2);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			const before = d.view();
			const late = observe(d, b, { kind: "query_ended" });
			expect(late.ended).toEqual([]);
			expect(late.effects).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	},
	{
		id: "R1-2",
		title:
			"[3.4, 3.5, 3.8] an old transport failure cannot rehome a successor's admission or re-arm its deadline",
		provider: "opencode",
		run(d) {
			// HL-K R1 finding 2, art-hlk2r/run.log:7331-7332. AMENDMENT-2026-11-16: an OpenCode steer is
			// its own Run (J1, J3), so the finding is seeded on A's start. A confirmed start, so query_ended
			// ends its work (9; an unconfirmed one may still run late, 655-662).
			const a = running(d);
			observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			observe(d, a, { kind: "query_ended" });
			admit(d, "C", true);
			const before = d.view();
			const alarm = d.alarmAt;
			for (const now of [d.now + 10, d.now + 20]) {
				const late = observe(
					d,
					a,
					{
						kind: "effect_outcome",
						outcome: { tag: "permanent", code: "OldTransportFailed" },
					},
					now,
				);
				expect(late.ended).toEqual([]);
				expect(late.effects).toEqual([]);
				expect(d.view()).toEqual(before);
				expect(d.alarmAt).toBe(alarm);
			}
			// A's Run ended at its query end (3.8 condition 2); C waits for main's terminal (D60).
			expect(starts(d, "C")).toHaveLength(0);
		},
	},
	{
		id: "R1-3",
		title:
			"[3.5, 3.8, 9] a late retained OpenCode result permits covering idle proof and preserves the Tombstone",
		provider: "opencode",
		run(d) {
			// HL-K R1 finding 3, art-hlk2r/run.log:7334-7335, seeded on A's start (AMENDMENT-2026-11-16).
			const a = unconfirmed(d);
			observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			// E1, E2, E4: main's terminal ends the Run; the start stays a member and a probe is issued.
			const probe = terminalFirst(d);
			// E5: a late result changes no Tombstone, but confirms delivery.
			const late = observe(d, a, { kind: "result", outcome: "completed" });
			expect(late.ended).toEqual([]);
			expect(d.view().active).toBeUndefined();
			// E3, E4: the query_ended folded next ends no start, and the outstanding probe is not doubled.
			admit(d, "C");
			expect(
				d.issued.filter(({ effect }) => effect.kind === "probe"),
			).toHaveLength(1);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(0);
			expect(d.view().anythingMayAct).toBe(true);
			const released = observe(d, probe, {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(released.ended).toEqual([]);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
		},
	},
	{
		id: "R1-4",
		title:
			"[3.5 replaces retained retryable work; 9] an unaccepted retryable send is never re-sent and cannot strand the native fence",
		provider: "opencode",
		run(d) {
			// HL-K R1 finding 4, art-hlk2r/run.log:7337; 11.2 supplies its behavioural summary. Seeded on
			// A's start, terminal first (AMENDMENT-2026-11-16 E2, E3).
			const a = unconfirmed(d);
			const probe = terminalFirst(d);
			admit(d, "C");
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(0);
			// E3: idle covers only a confirmed send.
			observe(d, probe, {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(0);
			expect(d.view().anythingMayAct).toBe(true);
			// 3.5: a retryable outcome on an unconsumed send means it was not reached, so it leaves the
			// fence; retryPending refuses a mainEnded send, so it is never sent again.
			const retryable = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			expect(retryable.ended).toEqual([]);
			expect(retryable.effects).toEqual([]);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			expect(starts(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "R2-1",
		title:
			"[3.5, 3.8, 9] late native acceptance survives retryable transport until covering idle proof",
		provider: "opencode",
		run(d) {
			// HL-K R2 finding 1, art-hlk2g/run.log:2016-2017, seeded on A's start, terminal first
			// (AMENDMENT-2026-11-16 E2, E5).
			const a = unconfirmed(d);
			const probe = terminalFirst(d);
			const accepted = observe(d, a, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			expect(accepted.ended).toEqual([]);
			const retryable = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			expect(retryable.ended).toEqual([]);
			admit(d, "C");
			expect(starts(d, "C")).toHaveLength(0);
			expect(d.view().anythingMayAct).toBe(true);
			expect(d.alarmAt).toBeDefined();
			const covered = observe(d, probe, {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(covered.ended).toEqual([]);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			expect(starts(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "R2-2",
		title:
			"[3.4, 3.8, 9] process loss releases retained work of an Ended owner before advancing its successor",
		provider: "opencode",
		run(d) {
			// HL-K R2 finding 2, art-hlk2g/run.log:2019; 11.2 supplies its behavioural summary. Seeded on
			// A's start, terminal first (AMENDMENT-2026-11-16 E2, E3, E5).
			const a = unconfirmed(d);
			observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			terminalFirst(d);
			expect(d.view().active).toBeUndefined();
			admit(d, "C");
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(0);
			const lost = step(d, {
				verb: "settle",
				settlement: {
					kind: "process_lost",
					runnerId: splitLabel(d.label).runnerId,
					retiredAt: d.now,
				},
			});
			expect(lost.ended).toEqual([]);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			const late = observe(d, a, { kind: "result", outcome: "completed" });
			expect(late.effects).toEqual([]);
			expect(late.ended).toEqual([]);
		},
	},
	// HL-K R3 finding 1 (B1's acceptance retains no failed B2) is scenarios.ts R3: its B2 is main's
	// direct re-send (3.6, CONTRACT.md 692-698), which the fake's main does not draw.
	{
		id: "R4-1",
		title:
			"[3.4, 3.5, 3.9] an input-present transmission keeps its Run through a permanent outcome that fails its input",
		provider: "opencode",
		run(d) {
			// HL-K R4 finding 1, art-hlk2r4/run.log:7538-7539.
			admit(d, "A");
			const a = d.latest("start");
			observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			fire(d);
			observe(
				d,
				d.latest(
					"probe",
					(effect) => effect.kind === "probe" && effect.target.tag === "input",
				),
				{
					kind: "probe_result",
					finding: { tag: "input_present", nativeMessageId: "native-A" },
				},
			);
			// 3.4 (CONTRACT.md 1988), 3.5 (562-564): input_present is consumption Observed, not acceptance.
			const observed = { tag: "Delivered", certainty: "sent" };
			expect(input(d, "A")?.state).toEqual(observed);
			const runId = d.view().active?.runId;
			const failed = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "LateTransportFailure" },
			});
			// 3.9 (CONTRACT.md 973-975): a permanent outcome fails the input, final; 3.5 (586-590): the
			// Observed transmission may still act, so its Run neither ends nor releases the fence.
			expect(failed.ended).toEqual([]);
			expect(input(d, "A")?.state.tag).toBe("Failed");
			expect(d.view().active?.runId).toBe(runId);
			expect(d.view().anythingMayAct).toBe(true);
			expect(starts(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "R4-2",
		title:
			"[3.5, 4.11, 9] journal-finished proof retains work through a rejected resume's failed transport",
		provider: "claude",
		run(d) {
			// HL-K R4 finding 2, art-hlk2r4/run.log:7541; 11.2 supplies its behavioural summary.
			admit(d, "A");
			const a = d.latest("start");
			observe(d, a, { kind: "journal_answer", answer: "finished" });
			const runId = d.view().active?.runId;
			// 3.4 (CONTRACT.md 465-471): a runner-held start has no effect_outcome; its failed transport is
			// a rejected resume's release, Transport Failed (4.11, 1985).
			const failed = observe(d, a, {
				kind: "run_released",
				reason: "ResumeRejected",
			});
			expect(failed.ended).toEqual([]);
			expect(d.view().active?.runId).toBe(runId);
			// 3.9 (CONTRACT.md 913-916): the view shows the Observed input Delivered/sent, its transport
			// Failed inside the chain; neither implies Accepted.
			expect(input(d, "A")?.state).toEqual({
				tag: "Delivered",
				certainty: "sent",
			});
			expect(d.view().anythingMayAct).toBe(true);
			// 4.11: finished is consumption proof only; an actual result still owns Run end.
			const ended = observe(d, a, { kind: "result", outcome: "completed" });
			expect(ended.ended).toMatchObject([
				{ outcome: "completed", reason: { tag: "completed" } },
			]);
			expect(starts(d, "A")).toHaveLength(1);
		},
	},
];
