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
			control: { kind: "run_now", inputId, deadlineAt: d.now + 1_000 },
		});
	main(d, 0);
	return admitted;
}

/**
 * D60: main claims its inbox (0), starts (1), ends (2) or relaunches (3) a run through the fake's own
 * draw, else makes the next move it can; a step with nothing for main to do draws no command.
 */
export function main(d: TraceDriver, variant: 0 | 1 | 2 | 3) {
	const { command } = d.host.next(
		{ operation: 28, selection: 0, index: 0, variant, input: 0, advance: 0 },
		{ issued: d.issued, view: d.view(), now: d.now, alarmAt: d.alarmAt },
	);
	if (command.verb === "observe") step(d, command);
}

function running(d: TraceDriver) {
	admit(d, "A");
	main(d, 1);
	const send = d.latest("start");
	observe(d, send, { kind: "started" });
	observe(d, send, { kind: "input_accepted", nativeMessageId: "native-A" });
	return send;
}

function fire(d: TraceDriver, at = d.alarmAt) {
	assert(at !== undefined, "the outstanding obligation has an alarm");
	return step(d, { verb: "settle", settlement: { kind: "alarm_fired" } }, at);
}

function input(d: TraceDriver, inputId: string) {
	return [...(d.view().active?.inputs ?? []), ...d.view().inbox].find(
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
			admit(d, "C", true);
			expect(starts(d, "C")).toHaveLength(0);
			fire(d);
			// REDESIGN-7 deleted close and D59 kill_and_respawn: retirement is main's act, seen as
			// process_lost (3.13). Its successor is main's claim after the terminal (D60).
			const released = step(d, {
				verb: "settle",
				settlement: {
					kind: "process_lost",
					runnerId: splitLabel(d.label).runnerId,
					retiredAt: d.now,
				},
			});
			expect(released.ended).toEqual([]);
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
			// HL-K R1 finding 2, art-hlk2r/run.log:7331-7332.
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			observe(d, b, { kind: "query_ended" });
			admit(d, "C", true);
			const before = d.view();
			const alarm = d.alarmAt;
			for (const now of [d.now + 10, d.now + 20]) {
				const late = observe(
					d,
					b,
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
			expect(starts(d, "C")).toHaveLength(0);
			expect(input(d, "B")).toMatchObject({ inputId: "B" });
		},
	},
	{
		id: "R1-3",
		title:
			"[3.5, 3.8, 9] a late retained OpenCode result permits covering idle proof and preserves the Tombstone",
		provider: "opencode",
		run(d) {
			// HL-K R1 finding 3, art-hlk2r/run.log:7334-7335.
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const ended = observe(d, b, { kind: "query_ended" });
			expect(ended.ended).toHaveLength(1);
			admit(d, "C", true);
			const late = observe(d, b, { kind: "result", outcome: "completed" });
			expect(late.ended).toEqual([]);
			fire(d);
			const released = observe(
				d,
				d.latest(
					"probe",
					(effect) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				),
				{ kind: "probe_result", finding: { tag: "native_idle" } },
			);
			// D60: C starts as main's claim once A's run ends.
			main(d, 2);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			expect(released.ended).toEqual([]);
		},
	},
	{
		id: "R1-4",
		title:
			"[3.5 replaces retained retryable work; 9] an unaccepted retryable send ends and cannot strand the native fence",
		provider: "opencode",
		run(d) {
			// HL-K R1 finding 4, art-hlk2r/run.log:7337; 11.2 supplies its behavioural summary.
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, { kind: "query_ended" });
			const retryable = observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			expect(retryable.ended).toEqual([]);
			admit(d, "C", true);
			fire(d);
			const released = observe(
				d,
				d.latest(
					"probe",
					(effect) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				),
				{ kind: "probe_result", finding: { tag: "native_idle" } },
			);
			// D60: C starts as main's claim once A's run ends.
			main(d, 2);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			expect(released.ended).toEqual([]);
			expect(
				d.issued.filter(
					({ effect }) => effect.kind === "steer" && effect.inputId === "B",
				),
			).toHaveLength(1);
		},
	},
	{
		id: "R2-1",
		title:
			"[3.5, 3.8, 9] late native acceptance survives retryable transport until covering idle proof",
		provider: "opencode",
		run(d) {
			// HL-K R2 finding 1, art-hlk2g/run.log:2016-2017.
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, { kind: "query_ended" });
			const accepted = observe(d, b, {
				kind: "input_accepted",
				nativeMessageId: "native-B",
			});
			expect(accepted.ended).toEqual([]);
			const retryable = observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			expect(retryable.ended).toEqual([]);
			admit(d, "C", true);
			expect(starts(d, "C")).toHaveLength(0);
			expect(d.view().anythingMayAct).toBe(true);
			expect(d.alarmAt).toBeDefined();
			fire(d);
			const covered = observe(
				d,
				d.latest(
					"probe",
					(effect) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				),
				{ kind: "probe_result", finding: { tag: "native_idle" } },
			);
			expect(covered.ended).toEqual([]);
			// D60: C starts as main's claim once A's run ends.
			main(d, 2);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
		},
	},
	{
		id: "R2-2",
		title:
			"[3.4, 3.8, 9] process loss releases retained work of an Ended owner before advancing its successor",
		provider: "opencode",
		run(d) {
			// HL-K R2 finding 2, art-hlk2g/run.log:2019; 11.2 supplies its behavioural summary.
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const ended = observe(d, b, { kind: "query_ended" });
			const endedRunId = ended.ended[0]?.runId;
			assert(endedRunId !== undefined, "the source Run has ended");
			admit(d, "C", true);
			const lost = step(d, {
				verb: "settle",
				settlement: {
					kind: "process_lost",
					runnerId: splitLabel(d.label).runnerId,
					retiredAt: d.now,
				},
			});
			expect(lost.ended.some(({ runId }) => runId === endedRunId)).toBe(false);
			// D60: C starts as main's claim once A's run ends.
			main(d, 2);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			const late = observe(d, b, { kind: "result", outcome: "completed" });
			expect(late.effects).toEqual([]);
			expect(late.ended).toEqual([]);
		},
	},
	{
		id: "R3-1",
		title:
			"[3.4, 3.5, 9] acceptance of B1 cannot retain an unaccepted failed B2 transmission",
		provider: "opencode",
		run(d) {
			// HL-K R3 finding 1, art-hlk2h/run.log:1765-1766.
			running(d);
			admit(d, "B");
			const b1 = d.latest("steer");
			const outcomeAt = d.now;
			observe(d, b1, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: outcomeAt + 1 },
			});
			fire(d, outcomeAt + 1_000);
			const b2 = d.latest("steer");
			expect(d.bound(b2).token).not.toBe(d.bound(b1).token);
			observe(d, b1, { kind: "input_accepted", nativeMessageId: "native-B" });
			observe(d, b2, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			observe(d, b1, { kind: "query_ended" });
			admit(d, "C", true);
			fire(d);
			observe(
				d,
				d.latest(
					"probe",
					(effect) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				),
				{ kind: "probe_result", finding: { tag: "native_idle" } },
			);
			// D60: C starts as main's claim once A's run ends.
			main(d, 2);
			main(d, 0);
			expect(starts(d, "C")).toHaveLength(1);
			expect(
				d.issued.filter(
					({ effect }) => effect.kind === "steer" && effect.inputId === "B",
				),
			).toHaveLength(2);
		},
	},
	{
		id: "R4-1",
		title:
			"[3.4, 3.5, 9] input-present acceptance survives a permanent outcome for that same transmission",
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
			expect(input(d, "A")?.state.tag).toBe("Accepted");
			const runId = d.view().active?.runId;
			const failed = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "LateTransportFailure" },
			});
			expect(failed.ended).toEqual([]);
			expect(input(d, "A")?.state.tag).toBe("Accepted");
			expect(d.view().active?.runId).toBe(runId);
			expect(d.view().anythingMayAct).toBe(true);
			expect(starts(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "R4-2",
		title:
			"[3.5, 4.11, 9] journal-finished proof retains work without upgrading failed transport to Sent",
		provider: "claude",
		run(d) {
			// HL-K R4 finding 2, art-hlk2r4/run.log:7541; 11.2 supplies its behavioural summary.
			admit(d, "A");
			const a = d.latest("start");
			observe(d, a, { kind: "journal_answer", answer: "finished" });
			const runId = d.view().active?.runId;
			const failed = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "ObservedTransportFailure" },
			});
			expect(failed.ended).toEqual([]);
			expect(d.view().active?.runId).toBe(runId);
			expect(input(d, "A")?.state).not.toEqual({
				tag: "Delivered",
				certainty: "sent",
			});
			expect(input(d, "A")?.state.tag).not.toBe("Accepted");
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
