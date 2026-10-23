import { describe, expect, it } from "vitest";
import type {
	Evidence,
	IssuedEffect,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { TraceDriver } from "./harness.js";
import { oracleTest } from "./pending.js";

const observe = (driver: TraceDriver, send: IssuedEffect, evidence: Evidence) =>
	driver.step({
		verb: "observe",
		observation: { token: send.token, ...evidence },
	});

describe.each([
	"reference",
	"decider",
] as const)("[step1] %s correlation contract", (mode) => {
	const check = oracleTest(`[step1] ${mode} correlation contract`);

	check(
		"[step1] native input acceptance cannot be downgraded by a late uncertain transport outcome",
		() => {
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			expect(d.view().active?.inputs).toEqual([
				{
					inputId: "A",
					state: { tag: "Accepted", nativeMessageId: "native-A" },
					uncertain: false,
				},
			]);
		},
	);

	check(
		"[step1] an obsolete retry deadline cannot resend an uncertain input",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: 200 },
			});
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const fired = d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				200,
			);
			expect(
				fired.effects.filter(
					({ effect }) => effect.kind === "start" || effect.kind === "steer",
				),
			).toEqual([]);
		},
	);

	check(
		"[step1] a start retry scheduled before Stop cannot start while interrupting",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: 200 },
			});
			d.step({ verb: "control", control: { kind: "stop" } });
			const fired = d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				200,
			);
			expect(
				fired.effects.filter(
					({ effect }) => effect.kind === "start" || effect.kind === "steer",
				),
			).toEqual([]);
			expect(d.view().active?.tag).toBe("Interrupting");
		},
	);

	check(
		"[8C] a receipt for an earlier admission cannot accept the reused input's new admission",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const old = d.latest("start");
			observe(d, old, {
				kind: "result",
				outcome: "error",
				error: { code: "Old", retryable: false },
			});
			d.step({ verb: "admit", inputId: "A", runNow: true });
			const before = d.view();
			const receipt = observe(d, old, {
				kind: "input_accepted",
				nativeMessageId: "old-native",
			});
			expect(receipt.ended).toEqual([]);
			expect(receipt.effects).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	);

	check(
		"[step1] native acceptance during backoff removes its retry deadline",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: 200 },
			});
			observe(d, start, { kind: "input_accepted" });
			const fired = d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				200,
			);
			expect(fired.effects).toEqual([]);
		},
	);

	check(
		"[10B] an answer confirmation cannot settle a different interaction on the same Run",
		() => {
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			for (const interactionId of ["q1", "q2"]) {
				observe(d, start, {
					kind: "interaction_requested",
					interactionId,
					interactionKind: "question",
				});
				d.step({
					verb: "control",
					control: { kind: "answer", interactionId, answer: "yes" },
				});
			}
			const first = d.latest(
				"deliver_answer",
				(effect) =>
					effect.kind === "deliver_answer" && effect.interactionId === "q1",
			);
			const before = d.view();
			observe(d, first, { kind: "interaction_resolved", interactionId: "q2" });
			expect(d.view()).toEqual(before);
		},
	);

	check(
		"[step1] native answer consumption during backoff removes its retry deadline",
		() => {
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			observe(d, d.latest("start"), {
				kind: "interaction_requested",
				interactionId: "q",
				interactionKind: "question",
			});
			d.step({
				verb: "control",
				control: { kind: "answer", interactionId: "q", answer: "yes" },
			});
			const answer = d.latest("deliver_answer");
			observe(d, answer, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: 200 },
			});
			observe(d, answer, { kind: "interaction_resolved", interactionId: "q" });
			const fired = d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				200,
			);
			expect(fired.effects).toEqual([]);
		},
	);

	check(
		"[4B] native idle removes old cleanup and leaves only the successor deadline",
		() => {
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			d.step({ verb: "control", control: { kind: "stop" } });
			d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				30_200,
			);
			const closeAt = d.alarmAt;
			d.step({ verb: "admit", inputId: "B", runNow: true });
			observe(d, d.latest("probe"), {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(d.view().active?.tag).toBe("Starting");
			const successor = d.latest("start");
			observe(d, successor, { kind: "started" });
			const before = d.view();
			expect(d.alarmAt).toBe(before.active?.deadline.at);
			const fired = d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				closeAt,
			);
			expect(fired.effects).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	);

	check(
		"[8C] uncertainty remains a resend barrier after its Run disappears from the view",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			d.step({
				verb: "settle",
				settlement: { kind: "process_lost", token: start.token },
			});
			const readmit = d.step({ verb: "admit", inputId: "A", runNow: true });
			expect(
				readmit.effects.filter(
					({ effect }) => effect.kind === "start" || effect.kind === "steer",
				),
			).toEqual([]);
		},
	);

	check(
		"[5C] conflicting result evidence cannot replace a recorded failure or extend settlement",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "result",
				outcome: "error",
				error: { code: "ActualFailure", retryable: false },
			});
			const deadline = d.view().active?.deadline;
			const duplicate = observe(d, start, {
				kind: "result",
				outcome: "completed",
			});
			expect(duplicate.effects).toEqual([]);
			expect(d.view().active?.deadline).toEqual(deadline);
			const ended = observe(d, start, { kind: "query_ended" });
			expect(ended.ended).toMatchObject([
				{ outcome: "error", reason: { code: "ActualFailure" } },
			]);
		},
	);

	check(
		"[7B] session end removes deadlines and permits fresh authorized admission",
		() => {
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			d.step({
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			});
			expect(d.view().live).toEqual([]);
			expect(d.alarmAt).toBeUndefined();
			d.step({ verb: "admit", inputId: "B", runNow: true });
			expect(d.latest("start").effect).toMatchObject({ inputId: "B" });
			observe(d, d.latest("start"), { kind: "started" });
			const before = d.view();
			const stale = d.step(
				{
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				},
				1_000,
			);
			expect(stale.effects).toEqual([]);
			expect(stale.ended).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	);

	check(
		"[8C] unknown evidence drops but known incompatible retired sends reject",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			d.step({ verb: "control", control: { kind: "stop" } });
			const interrupt = d.latest("interrupt");
			d.step({
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			});
			const before = d.view();
			const incompatible = observe(d, interrupt, {
				kind: "result",
				outcome: "completed",
			});
			expect(incompatible.tag).toBe("Rejected");
			const unknown = d.step({
				verb: "observe",
				observation: {
					token: "never-issued" as SendToken,
					kind: "result",
					outcome: "completed",
				},
			});
			expect(unknown.tag).toBe("Accepted");
			expect(unknown.effects).toEqual([]);
			expect(unknown.ended).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	);
});

describe.each([
	"reference",
	"decider",
] as const)("[step1] %s amendment", (mode) => {
	const check = oracleTest(`[step1] ${mode} amendment`);
	check(
		"[step1] first admission projects exactly one alarm and issues only start",
		() => {
			const d = new TraceDriver("claude", mode);
			const first = d.step({ verb: "admit", inputId: "A", runNow: false }, 100);
			expect(first.effects.map(({ effect }) => effect.kind)).toEqual(["start"]);
			expect(first.alarmAt).toBe(1_100);
			expect(d.view().live).toEqual(first.effects);
			const before = d.view();
			for (const now of [100, 1_099, 1_099]) {
				const early = d.step(
					{ verb: "settle", settlement: { kind: "alarm_fired" } },
					now,
				);
				expect(early).toMatchObject({
					tag: "Accepted",
					effects: [],
					ended: [],
					alarmAt: 1_100,
				});
				expect(d.lastEventCount).toBe(0);
				expect(d.view()).toEqual(before);
			}
			const expired = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				1_100,
			);
			expect(expired.ended).toMatchObject([
				{ reason: { kind: "deadline_expired", deadline: "start" } },
			]);
			expect(expired.alarmAt).toBe(3_100);
			const lateClose = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				10_000,
			);
			expect(lateClose.effects.map(({ effect }) => effect.kind)).toEqual([
				"kill_and_respawn",
			]);
			expect(lateClose.alarmAt).toBe(12_000);
			const refusedKill = observe(d, d.latest("kill_and_respawn"), {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "CannotKill" },
			});
			expect(refusedKill.effects.map(({ effect }) => effect.kind)).toEqual([
				"quarantine",
			]);
			expect(refusedKill.alarmAt).toBeUndefined();
			const repeated = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				100_000,
			);
			expect(repeated.effects).toEqual([]);
			expect(repeated.ended).toEqual([]);
		},
	);

	check(
		"[step1] a late alarm fires every due obligation in deadline order once",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false }, 100);
			const start = d.latest("start");
			observe(d, start, { kind: "started" });
			observe(d, start, {
				kind: "interaction_requested",
				interactionId: "later",
				interactionKind: "permission",
				timeoutAt: 400,
			});
			observe(d, start, {
				kind: "interaction_requested",
				interactionId: "earlier",
				interactionKind: "permission",
				timeoutAt: 200,
			});
			const alarm = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				500,
			);
			expect(alarm.effects.map(({ effect }) => effect)).toEqual([
				{
					kind: "deliver_answer",
					runId: d.view().active?.runId,
					interactionId: "earlier",
					answer: { decision: "reject", reason: "timeout" },
				},
				{
					kind: "deliver_answer",
					runId: d.view().active?.runId,
					interactionId: "later",
					answer: { decision: "reject", reason: "timeout" },
				},
			]);
			expect(alarm.alarmAt).toBe(10_101);
			const repeated = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				500,
			);
			expect(repeated.effects).toEqual([]);
			expect(d.lastEventCount).toBe(0);
		},
	);

	it.each([
		"input",
		"interaction",
		"native_session",
	] as const)("[R1] an unanswered %s probe owns a deadline from issue and re-probes at it", (target) => {
		const d = new TraceDriver("opencode", mode);
		d.step({ verb: "admit", inputId: "A", runNow: false });
		const start = d.latest("start");
		observe(d, start, { kind: "started" });
		if (target === "input") {
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
		} else if (target === "interaction") {
			observe(d, start, {
				kind: "interaction_requested",
				interactionId: "q",
				interactionKind: "question",
			});
			d.step({
				verb: "control",
				control: { kind: "answer", interactionId: "q", answer: "E" },
			});
			observe(d, d.latest("deliver_answer"), {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
		} else {
			d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				d.alarmAt,
			);
		}
		const probe = d.latest("probe");
		const retryAt = d.alarmAt;
		expect(retryAt).toBeGreaterThan(d.now);
		expect(retryAt).toBeLessThan(d.view().active?.deadline.at ?? Infinity);
		const early = d.step(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			(retryAt ?? 0) - 1,
		);
		expect(early.effects).toEqual([]);
		expect(early.alarmAt).toBe(retryAt);
		const retried = d.step(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			retryAt,
		);
		expect(retried.effects.map(({ effect }) => effect)).toEqual([probe.effect]);
		expect(d.latest("probe").token).not.toBe(probe.token);
		expect(retried.alarmAt).toBeGreaterThan(d.now);
		const repeated = d.step(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			d.now,
		);
		expect(repeated.effects).toEqual([]);
		const transported = observe(d, d.latest("probe"), {
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
		});
		expect(transported.effects).toEqual([]);
		expect(transported.alarmAt).toBe(retried.alarmAt);
	});

	check(
		"[step1] probe retry is data and fulfillment removes its deadline",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			observe(d, d.latest("start"), {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const probe = d.latest("probe");
			const retry = observe(d, probe, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: 200 },
			});
			expect(retry.effects).toEqual([]);
			expect(retry.alarmAt).toBe(200);
			const resent = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				200,
			);
			expect(resent.effects.map(({ effect }) => effect.kind)).toEqual([
				"probe",
			]);
			expect(d.latest("probe").token).not.toBe(probe.token);
			observe(d, d.latest("probe"), {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: 300 },
			});
			observe(d, probe, {
				kind: "probe_result",
				finding: { tag: "input_present", nativeMessageId: "native-A" },
			});
			expect(d.alarmAt).toBe(d.view().active?.deadline.at);
			const alarm = d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				300,
			);
			expect(alarm.effects).toEqual([]);
		},
	);

	check(
		"[2C] Claude result ends the Run while its query fence holds the next start",
		() => {
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false }, 100);
			const start = d.latest("start");
			const result = observe(d, start, {
				kind: "result",
				outcome: "completed",
			});
			expect(result.ended).toMatchObject([{ outcome: "completed" }]);
			expect(d.view().active).toBeUndefined();
			expect(result.alarmAt).toBe(d.now + 3_000);
			const waiting = d.step({ verb: "admit", inputId: "B", runNow: false });
			expect(waiting.effects.map(({ effect }) => effect.kind)).toEqual([
				"probe",
			]);
			expect(d.view().active?.tag).toBe("Queued");
			const closed = observe(d, start, { kind: "query_ended" });
			expect(closed.ended).toEqual([]);
			expect(closed.effects.map(({ effect }) => effect)).toMatchObject([
				{ kind: "start", inputId: "B" },
			]);
			expect(closed.alarmAt).toBe(d.now + 1_000);
		},
	);

	check(
		"[2C] OpenCode result supplies outcome until the owned execution ends",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			expect(
				observe(d, start, { kind: "result", outcome: "completed" }).ended,
			).toEqual([]);
			expect(d.view().active?.tag).toBe("Settling");
			expect(observe(d, start, { kind: "query_ended" }).ended).toMatchObject([
				{ outcome: "completed" },
			]);
			expect(d.alarmAt).toBeUndefined();
		},
	);

	check(
		"[4B] OpenCode idle cannot discharge a request or abort that may still execute",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			d.step({ verb: "control", control: { kind: "stop" } });
			d.step(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				d.alarmAt,
			);
			d.step({ verb: "admit", inputId: "B", runNow: true });
			const before = d.alarmAt;
			const idle = observe(d, d.latest("probe"), {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(idle.effects).toEqual([]);
			expect(d.view().active?.tag).toBe("Queued");
			expect(d.alarmAt).toBe(before);
		},
	);

	for (const outcomes of [
		["completed", "interrupted", "error"],
		["error", "completed", "interrupted"],
		["interrupted", "error", "completed"],
		["completed", "error", "interrupted"],
		["error", "interrupted", "completed"],
		["interrupted", "completed", "error"],
	] as const) {
		check(
			`[5C] failure wins the outcome fold in order ${outcomes.join(",")}`,
			() => {
				const d = new TraceDriver("opencode", mode);
				d.step({ verb: "admit", inputId: "A", runNow: false });
				const start = d.latest("start");
				for (const outcome of outcomes)
					observe(d, start, {
						kind: "result",
						outcome,
						...(outcome === "error"
							? { error: { code: "ActualFailure", retryable: false } }
							: {}),
					});
				const closed = observe(d, start, { kind: "query_ended" });
				expect(closed.ended).toMatchObject([
					{ outcome: "error", reason: { code: "ActualFailure" } },
				]);
			},
		);
	}

	check(
		"[5C] specific beats generic and the first specific code survives later failures",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			for (const code of [undefined, "FirstFailure", "LaterFailure", undefined])
				observe(d, start, {
					kind: "result",
					outcome: "error",
					...(code ? { error: { code, retryable: false } } : {}),
				});
			expect(observe(d, start, { kind: "query_ended" }).ended).toMatchObject([
				{ reason: { code: "FirstFailure" } },
			]);
			d.step({ verb: "admit", inputId: "B", runNow: true });
			const next = d.latest("start");
			observe(d, next, { kind: "result", outcome: "completed" });
			expect(observe(d, next, { kind: "query_ended" }).ended).toMatchObject([
				{ outcome: "completed" },
			]);
		},
	);

	check(
		"[5C] completion beats interrupt fallback and a Tombstone is immutable",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			d.step({ verb: "control", control: { kind: "stop" } });
			observe(d, start, { kind: "result", outcome: "interrupted" });
			observe(d, start, { kind: "result", outcome: "completed" });
			expect(observe(d, start, { kind: "query_ended" }).ended).toMatchObject([
				{ outcome: "completed" },
			]);
			const before = d.view();
			const late = observe(d, start, {
				kind: "result",
				outcome: "error",
				error: { code: "TooLate", retryable: false },
			});
			expect(late.ended).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	);

	check(
		"[6C] native identity fills once and contradictions reject without changing state or alarm",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, { kind: "input_accepted" });
			observe(d, start, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			observe(d, start, { kind: "input_accepted" });
			expect(d.view().active?.inputs[0]?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-A",
			});
			const before = d.view();
			const alarm = d.alarmAt;
			const contradiction = observe(d, start, {
				kind: "input_accepted",
				nativeMessageId: "foreign",
			});
			expect(contradiction.tag).toBe("Rejected");
			expect(contradiction.diagnostic).toBeTruthy();
			expect(d.view()).toEqual(before);
			expect(d.alarmAt).toBe(alarm);
		},
	);

	check(
		"[6C] a contradictory input probe rejects even after native acceptance",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const start = d.latest("start");
			observe(d, start, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const probe = d.latest("probe");
			observe(d, start, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			const before = d.view();
			expect(
				observe(d, probe, {
					kind: "probe_result",
					finding: { tag: "input_present", nativeMessageId: "foreign" },
				}).tag,
			).toBe("Rejected");
			expect(d.view()).toEqual(before);
		},
	);

	it.each([
		"usage_limit_failover",
		"native_session_vanished",
	] as const)("[7B] ending an empty provider session with %s permits fresh authorization", (cause) => {
		const d = new TraceDriver("claude", mode);
		d.step({ verb: "settle", settlement: { kind: "session_ended", cause } });
		const next = d.step({ verb: "admit", inputId: "B", runNow: true });
		expect(next.effects.map(({ effect }) => effect.kind)).toEqual(["start"]);
		expect(next.alarmAt).toBe(d.now + 1_000);
	});

	check(
		"[8C] very old receipts retain their address and native identity after many finished Runs",
		() => {
			const d = new TraceDriver("cursor", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			const old = d.latest("start");
			observe(d, old, { kind: "result", outcome: "completed" });
			for (let index = 0; index < 24; index++) {
				d.step({ verb: "admit", inputId: `later-${index}`, runNow: true });
				observe(d, d.latest("start"), { kind: "result", outcome: "completed" });
			}
			expect(
				observe(d, old, {
					kind: "input_accepted",
					nativeMessageId: "old-native",
				}).tag,
			).toBe("Accepted");
			const before = d.view();
			expect(
				observe(d, old, {
					kind: "input_accepted",
					nativeMessageId: "contradiction",
				}).tag,
			).toBe("Rejected");
			expect(d.view()).toEqual(before);
		},
	);

	check(
		"[9B] Resume and provider-session end cannot clear project inactivity",
		() => {
			const ordinary = new TraceDriver("claude", mode);
			ordinary.step({ verb: "control", control: { kind: "stop" } });
			ordinary.step({ verb: "admit", inputId: "ordinary", runNow: false });
			expect(ordinary.view().active).toBeUndefined();
			expect(
				ordinary
					.step({ verb: "control", control: { kind: "resume" } })
					.effects.map(({ effect }) => effect.kind),
			).toEqual(["start"]);
			const d = new TraceDriver("claude", mode);
			d.step({ verb: "settle", settlement: { kind: "project_inactive" } });
			d.step({ verb: "admit", inputId: "B", runNow: true });
			d.step({ verb: "control", control: { kind: "resume" } });
			d.step({
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			});
			const resumed = d.step({ verb: "control", control: { kind: "resume" } });
			expect(resumed.effects).toEqual([]);
			expect(d.view().active).toBeUndefined();
			expect(d.view().inbox.map(({ inputId }) => inputId)).toEqual(["B"]);
			expect(d.alarmAt).toBeUndefined();
		},
	);

	check(
		"[10B] permanent refusal stays Pending and reconciliation retries the preserved answer",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			observe(d, d.latest("start"), {
				kind: "interaction_requested",
				interactionId: "q",
				interactionKind: "question",
			});
			d.step({
				verb: "control",
				control: {
					kind: "answer",
					interactionId: "q",
					answer: { choice: "preserved" },
				},
			});
			const first = d.latest("deliver_answer");
			observe(d, first, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "HTTP400" },
			});
			expect(d.view().active?.interactions).toEqual([
				{ tag: "Pending", interactionId: "q", kind: "question" },
			]);
			observe(d, d.latest("probe"), {
				kind: "probe_result",
				finding: { tag: "answer_pending" },
			});
			const retry = d.latest("deliver_answer");
			expect(retry.token).not.toBe(first.token);
			expect(retry.effect).toEqual(first.effect);
		},
	);

	check(
		"[10B] an ambiguous earlier answer is reconciled before retransmission after refusal",
		() => {
			const d = new TraceDriver("opencode", mode);
			d.step({ verb: "admit", inputId: "A", runNow: false });
			observe(d, d.latest("start"), {
				kind: "interaction_requested",
				interactionId: "q",
				interactionKind: "question",
			});
			d.step({
				verb: "control",
				control: { kind: "answer", interactionId: "q", answer: "saved" },
			});
			const first = d.latest("deliver_answer");
			observe(d, first, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			observe(d, first, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "Refused" },
			});
			const attempted = d.step({
				verb: "control",
				control: { kind: "answer", interactionId: "q", answer: "saved" },
			});
			expect(
				attempted.effects.filter(
					({ effect }) => effect.kind === "deliver_answer",
				),
			).toEqual([]);
			observe(d, d.latest("probe"), {
				kind: "probe_result",
				finding: { tag: "answer_consumed" },
			});
			expect(
				d.issued.filter(({ effect }) => effect.kind === "deliver_answer"),
			).toHaveLength(1);
			expect(d.view().active?.interactions).toMatchObject([
				{ tag: "Answered", delivery: "settled" },
			]);
		},
	);
});
