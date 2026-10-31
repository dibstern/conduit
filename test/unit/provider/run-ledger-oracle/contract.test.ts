import { assert, describe, expect, it } from "vitest";
import type { SendToken } from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { policy } from "./harness.js";
import { pendingSuite } from "./pending.js";
import {
	admit,
	ask,
	begin,
	complete,
	Driver,
	fire,
	observe,
	request,
	running,
	step,
	stop,
	tokenOf,
	transmissions,
	visibleInput,
} from "./scenarios.js";

type Mode = "reference" | "decider";

const check = (mode: Mode) => (name: string, run: () => void) =>
	mode === "reference"
		? it(name, run)
		: pendingSuite("[checkpoint] run-ledger-decider")(name, run);

const startOrSteer = (decision: {
	readonly issued: readonly { readonly effect: { readonly kind: string } }[];
}) =>
	decision.issued.filter(
		({ effect }) => effect.kind === "start" || effect.kind === "steer",
	);

describe.each([
	"reference",
	"decider",
] as const)("[step1] %s correlation contract", (mode) => {
	const test = check(mode);

	test("[step1] native input acceptance cannot be downgraded by a late uncertain transport outcome", () => {
		const d = new Driver("claude", mode);
		const a = begin(d);
		observe(d, a.token, {
			kind: "input_accepted",
			nativeMessageId: "native-A",
		});
		observe(d, a.token, { kind: "delivery_indeterminate" });
		// 3.13 (1241): InputView's `uncertain` is deleted; the state alone shows acceptance.
		expect(d.view().active?.inputs).toEqual([
			{ inputId: "A", state: { tag: "Accepted", nativeMessageId: "native-A" } },
		]);
	});

	test("[step1] an earlier retryable outcome cannot resend an uncertain input", () => {
		// 3.4: a runner-held send answers by runner_reply, never effect_outcome, so this is a direct send.
		const d = new Driver("opencode", mode);
		const a = begin(d);
		observe(d, a.token, {
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: d.now + 50 },
		});
		observe(d, a.token, {
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
		});
		// 3.7 (676-678): a send's retry is main's, never a ledger deadline; the alarm is the recovery probe.
		expect(d.alarmAt).toBe(d.now + policy.probeMs);
		const fired = fire(d);
		expect(startOrSteer(fired)).toEqual([]);
		expect(fired.issued.map(({ effect }) => effect.kind)).toEqual(["probe"]);
		expect(transmissions(d, "A")).toHaveLength(1);
	});

	test("[step1] a start with a retryable outcome cannot start again while Stop interrupts it", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		observe(d, a.token, {
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: d.now + 50 },
		});
		stop(d);
		expect(d.view().active?.tag).toBe("Interrupting");
		// 3.7 (676-678): the retry at retryAt is main's; the ledger holds no deadline for it.
		const fired = step(
			d,
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			d.now + 50,
		);
		expect(startOrSteer(fired)).toEqual([]);
		expect(transmissions(d, "A")).toHaveLength(1);
		expect(d.view().active?.tag).toBe("Interrupting");
	});

	test("[8C] a receipt for an earlier admission cannot accept the reused input's new admission", () => {
		const d = new Driver("cursor", mode);
		const old = begin(d);
		observe(d, old.token, {
			kind: "result",
			outcome: "error",
			error: { code: "Old", retryable: false },
		});
		begin(d, "A");
		const before = d.view();
		const receipt = observe(d, old.token, {
			kind: "input_accepted",
			nativeMessageId: "old-native",
		});
		expect(receipt.ended).toEqual([]);
		expect(receipt.issued).toEqual([]);
		expect(d.view()).toEqual(before);
	});

	test("[10B] an answer confirmation cannot settle a different interaction on the same Run", () => {
		const d = new Driver("claude", mode);
		const a = running(d);
		ask(d, a.token, "q1");
		ask(d, a.token, "q2");
		const first = d.issued.find(
			({ effect }) =>
				effect.kind === "deliver_answer" && effect.interactionId === "q1",
		);
		expect(first).toBeDefined();
		if (first === undefined) return;
		const before = d.view();
		const crossed = d.step({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: tokenOf(first),
				kind: "interaction_resolved",
				interactionId: "q2",
			},
		});
		expect(crossed.tag).toBe("Rejected");
		expect(d.view()).toEqual(before);
	});

	test("[8C] a lost process ends an uncertain Run and the ledger never resends its input", () => {
		const d = new Driver("cursor", mode);
		const a = begin(d);
		observe(d, a.token, { kind: "delivery_indeterminate" });
		const lost = step(d, {
			verb: "settle",
			settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
		});
		expect(lost.ended).toMatchObject([{ reason: { tag: "process_lost" } }]);
		// D58, D60: a re-admission is main's handoff and issues nothing; a resend is only main's run.requested.
		expect(admit(d, "A").issued).toEqual([]);
		expect(transmissions(d, "A")).toHaveLength(1);
	});

	test("[5C] conflicting result evidence cannot replace a recorded failure or extend settlement", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		observe(d, a.token, {
			kind: "result",
			outcome: "error",
			error: { code: "ActualFailure", retryable: false },
		});
		const deadline = d.alarmAt;
		expect(d.view().active).toMatchObject({
			tag: "Settling",
			deadline: { owner: "Run", at: deadline },
		});
		const duplicate = observe(
			d,
			a.token,
			{ kind: "result", outcome: "completed" },
			d.now + 10,
		);
		expect(duplicate.issued).toEqual([]);
		expect(d.alarmAt).toBe(deadline);
		expect(observe(d, a.token, { kind: "query_ended" }).ended).toMatchObject([
			{ outcome: "error", reason: { code: "ActualFailure" } },
		]);
	});

	test("[7B] session end removes deadlines and permits a fresh start", () => {
		const d = new Driver("claude", mode);
		begin(d);
		step(d, {
			verb: "settle",
			settlement: { kind: "session_ended", cause: "native_session_vanished" },
		});
		expect(d.view().live).toEqual([]);
		expect(d.alarmAt).toBeUndefined();
		const b = begin(d, "B");
		expect(d.latest("start").effect).toMatchObject({
			kind: "start",
			inputId: "B",
			mode: "fresh",
		});
		observe(d, b.token, { kind: "started" });
		const before = d.view();
		const stale = fire(d, 1_000);
		expect(stale.issued).toEqual([]);
		expect(stale.ended).toEqual([]);
		expect(d.view()).toEqual(before);
	});

	test("[8C] unknown evidence drops but known incompatible retired sends reject", () => {
		const d = new Driver("opencode", mode);
		running(d);
		stop(d);
		const interrupt = d.latest("interrupt");
		step(d, {
			verb: "settle",
			settlement: { kind: "session_ended", cause: "native_session_vanished" },
		});
		const before = d.view();
		const incompatible = d.step({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: tokenOf(interrupt),
				kind: "result",
				outcome: "completed",
			},
		});
		expect(incompatible.tag).toBe("Rejected");
		const unknown = observe(d, "never-issued" as SendToken, {
			kind: "result",
			outcome: "completed",
		});
		expect(unknown.issued).toEqual([]);
		expect(unknown.ended).toEqual([]);
		expect(d.view()).toEqual(before);
	});
});

describe.each([
	"reference",
	"decider",
] as const)("[step1] %s amendment", (mode) => {
	const test = check(mode);

	test("[step1] admission issues nothing and main's request issues only the start, with no deadline", () => {
		const d = new Driver("claude", mode);
		// D58, D60: admit is main's handoff; the ledger issues nothing and opens no deadline.
		const admitted = admit(d, "A");
		expect(admitted.issued).toEqual([]);
		expect(admitted.alarmAt).toBeUndefined();
		request(d, "A");
		// LI1 (D60): the start reaches `live` from main's run.requested and its run.dispatched Answer.
		expect(d.view().live.map(({ effect }) => effect.kind)).toEqual(["start"]);
		// 3.7 (659): Starting has no deadline.
		expect(d.alarmAt).toBeUndefined();
		const before = d.view();
		for (const now of [d.now, d.now + 1_000, d.now + 100_000]) {
			const early = fire(d, now);
			expect(early).toMatchObject({
				tag: "Accepted",
				events: [],
				effects: [],
				ended: [],
			});
			expect(early.alarmAt).toBeUndefined();
			expect(d.view()).toEqual(before);
		}
	});

	test("[3.10] main's timeout reject folds as any answer; decide issues nothing and arms no timeout", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		observe(d, a.token, {
			kind: "interaction_requested",
			interactionId: "q",
			interactionKind: "permission",
		});
		// 3.10, 3.13: main owns the permission timeout; its reject reaches the ledger as an answer.
		const timedOut = d.step({
			verb: "control",
			control: {
				kind: "answer",
				interactionId: "q",
				answer: { decision: "reject", reason: "timeout" },
			},
		});
		assert(timedOut.tag === "Accepted");
		expect(timedOut.effects).toEqual([]);
		const late = fire(d, d.now + 60_000);
		expect(
			late.issued.filter(({ effect }) => effect.kind === "deliver_answer"),
		).toEqual([]);
	});

	for (const target of ["input", "interaction", "native_session"] as const)
		test(`[R1] an unanswered ${target} probe owns a deadline from issue and re-probes at it`, () => {
			const d = new Driver("opencode", mode);
			const a = running(d);
			if (target === "input") {
				const b = begin(d, "B", "steer");
				observe(d, b.token, {
					kind: "effect_outcome",
					outcome: { tag: "delivery_unknown" },
				});
				fire(d);
			} else if (target === "interaction") {
				const answer = ask(d, a.token);
				observe(d, tokenOf(answer), {
					kind: "effect_outcome",
					outcome: { tag: "delivery_unknown" },
				});
				fire(d);
			} else {
				observe(d, a.token, { kind: "result", outcome: "completed" });
				// 3.7: Settling's expiry probes native_session.
				fire(d);
			}
			const probe = d.latest("probe");
			expect(probe.effect).toMatchObject({ target: { tag: target } });
			const retryAt = d.alarmAt;
			assert(retryAt !== undefined, "the probe owns a deadline");
			// 3.7 (678): a probe's deadline is its issue plus max(probeMs, backoff(n)).
			expect(retryAt).toBeGreaterThanOrEqual(d.now + policy.probeMs);
			const early = fire(d, retryAt - 1);
			expect(early.issued).toEqual([]);
			expect(early.alarmAt).toBe(retryAt);
			const retried = fire(d, retryAt);
			expect(retried.issued.map(({ effect }) => effect)).toEqual([
				probe.effect,
			]);
			expect(tokenOf(d.latest("probe"))).not.toBe(tokenOf(probe));
			expect(retried.alarmAt).toBeGreaterThan(d.now);
			expect(fire(d, d.now).issued).toEqual([]);
			const transported = observe(d, tokenOf(d.latest("probe")), {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(transported.issued).toEqual([]);
			expect(transported.alarmAt).toBe(retried.alarmAt);
		});

	test("[step1] probe retry is data and fulfillment removes its deadline", () => {
		const d = new Driver("opencode", mode);
		const a = begin(d);
		observe(d, a.token, {
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
		});
		fire(d);
		const probe = d.latest("probe");
		const raisedAt = (d.alarmAt ?? 0) + 5_000;
		// 3.7 (678-679, D20): a later retryAt raises the probe's deadline.
		const retry = observe(d, tokenOf(probe), {
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: raisedAt },
		});
		expect(retry.issued).toEqual([]);
		expect(retry.alarmAt).toBe(raisedAt);
		const resent = fire(d, raisedAt);
		expect(resent.issued.map(({ effect }) => effect.kind)).toEqual(["probe"]);
		expect(tokenOf(d.latest("probe"))).not.toBe(tokenOf(probe));
		observe(d, tokenOf(d.latest("probe")), {
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: raisedAt + 5_000 },
		});
		observe(d, tokenOf(probe), {
			kind: "probe_result",
			finding: { tag: "input_present", nativeMessageId: "native-A" },
		});
		// 3.7 (659): Starting has no deadline, so the answered probe leaves none.
		expect(d.alarmAt).toBeUndefined();
		expect(fire(d, raisedAt + 5_000).issued).toEqual([]);
	});

	test("[2C] a Claude result ends the Run with no query-fence deadline", () => {
		const d = new Driver("claude", mode);
		const a = begin(d);
		expect(
			observe(d, a.token, { kind: "result", outcome: "completed" }).ended,
		).toMatchObject([{ outcome: "completed" }]);
		expect(d.view().active).toBeUndefined();
		// 3.7 (659), 3.13 (32.19): no ledger query-fence deadline; the fence is the runner's.
		expect(d.alarmAt).toBeUndefined();
		expect(observe(d, a.token, { kind: "query_ended" }).ended).toEqual([]);
		begin(d, "B");
		expect(transmissions(d, "B")).toHaveLength(1);
		expect(d.view().active?.tag).toBe("Starting");
	});

	test("[2C] OpenCode result supplies outcome until the owned execution ends", () => {
		const d = new Driver("opencode", mode);
		const a = begin(d);
		expect(
			observe(d, a.token, { kind: "result", outcome: "completed" }).ended,
		).toEqual([]);
		expect(d.view().active?.tag).toBe("Settling");
		expect(observe(d, a.token, { kind: "query_ended" }).ended).toMatchObject([
			{ outcome: "completed" },
		]);
		expect(d.alarmAt).toBeUndefined();
	});

	test("[4B] OpenCode idle cannot discharge a request issued after its probe", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		stop(d);
		const probe = d.latest("probe");
		expect(probe.effect).toMatchObject({ target: { tag: "native_session" } });
		complete(d, a.token);
		const b = begin(d, "B");
		const idle = observe(d, tokenOf(probe), {
			kind: "probe_result",
			finding: { tag: "native_idle" },
		});
		expect(idle.issued).toEqual([]);
		expect(idle.ended).toEqual([]);
		expect(d.view().active).toMatchObject({ tag: "Starting", runId: b.runId });
	});

	for (const outcomes of [
		["completed", "interrupted", "error"],
		["error", "completed", "interrupted"],
		["interrupted", "error", "completed"],
		["completed", "error", "interrupted"],
		["error", "interrupted", "completed"],
		["interrupted", "completed", "error"],
	] as const)
		test(`[5C] failure wins the outcome fold in order ${outcomes.join(",")}`, () => {
			const d = new Driver("opencode", mode);
			const a = begin(d);
			for (const outcome of outcomes)
				observe(
					d,
					a.token,
					outcome === "error"
						? {
								kind: "result",
								outcome,
								error: { code: "ActualFailure", retryable: false },
							}
						: { kind: "result", outcome },
				);
			expect(observe(d, a.token, { kind: "query_ended" }).ended).toMatchObject([
				{ outcome: "error", reason: { code: "ActualFailure" } },
			]);
		});

	test("[5C] specific beats generic and the first specific code survives later failures", () => {
		const d = new Driver("opencode", mode);
		const a = begin(d);
		for (const code of [undefined, "FirstFailure", "LaterFailure", undefined])
			observe(
				d,
				a.token,
				code === undefined
					? { kind: "result", outcome: "error" }
					: {
							kind: "result",
							outcome: "error",
							error: { code, retryable: false },
						},
			);
		expect(observe(d, a.token, { kind: "query_ended" }).ended).toMatchObject([
			{ reason: { code: "FirstFailure" } },
		]);
		const b = begin(d, "B");
		observe(d, b.token, { kind: "result", outcome: "completed" });
		expect(observe(d, b.token, { kind: "query_ended" }).ended).toMatchObject([
			{ outcome: "completed" },
		]);
	});

	test("[5C] completion beats interrupt fallback and a Tombstone is immutable", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		stop(d);
		observe(d, a.token, { kind: "result", outcome: "interrupted" });
		observe(d, a.token, { kind: "result", outcome: "completed" });
		expect(observe(d, a.token, { kind: "query_ended" }).ended).toMatchObject([
			{ outcome: "completed" },
		]);
		const before = d.view();
		const late = observe(d, a.token, {
			kind: "result",
			outcome: "error",
			error: { code: "TooLate", retryable: false },
		});
		expect(late.ended).toEqual([]);
		expect(d.view()).toEqual(before);
	});

	test("[6C] native identity fills once and contradictions reject without changing state or alarm", () => {
		const d = new Driver("cursor", mode);
		const a = begin(d);
		observe(d, a.token, { kind: "input_accepted" });
		observe(d, a.token, {
			kind: "input_accepted",
			nativeMessageId: "native-A",
		});
		observe(d, a.token, { kind: "input_accepted" });
		expect(visibleInput(d, "A")?.state).toEqual({
			tag: "Accepted",
			nativeMessageId: "native-A",
		});
		const before = d.view();
		const alarm = d.alarmAt;
		const contradiction = d.step({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: a.token,
				kind: "input_accepted",
				nativeMessageId: "foreign",
			},
		});
		expect(contradiction.tag).toBe("Rejected");
		expect(contradiction.diagnostic).toBeTruthy();
		expect(d.view()).toEqual(before);
		expect(d.alarmAt).toBe(alarm);
	});

	test("[6C] a contradictory input probe rejects even after native acceptance", () => {
		const d = new Driver("cursor", mode);
		const a = begin(d);
		observe(d, a.token, { kind: "delivery_indeterminate" });
		fire(d);
		const probe = d.latest("probe");
		observe(d, a.token, {
			kind: "input_accepted",
			nativeMessageId: "native-A",
		});
		const before = d.view();
		const contradiction = d.step({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: tokenOf(probe),
				kind: "probe_result",
				finding: { tag: "input_present", nativeMessageId: "foreign" },
			},
		});
		expect(contradiction.tag).toBe("Rejected");
		expect(d.view()).toEqual(before);
	});

	// 3.13 (1175): native_session_vanished is session_ended's only cause; usage_limit_failover deleted (4627).
	test("[7B] ending an empty provider session with native_session_vanished permits a fresh start", () => {
		const d = new Driver("claude", mode);
		step(d, {
			verb: "settle",
			settlement: { kind: "session_ended", cause: "native_session_vanished" },
		});
		begin(d, "B");
		expect(transmissions(d, "B").map(({ effect }) => effect)).toMatchObject([
			{ kind: "start", mode: "fresh" },
		]);
		// 3.7 (659): Starting has no deadline.
		expect(d.alarmAt).toBeUndefined();
	});

	test("[8C] very old receipts retain their address and native identity after many finished Runs", () => {
		const d = new Driver("cursor", mode);
		const old = begin(d);
		observe(d, old.token, { kind: "result", outcome: "completed" });
		for (let index = 0; index < 24; index++) {
			const later = begin(d, `later-${index}`);
			observe(d, later.token, { kind: "result", outcome: "completed" });
		}
		observe(d, old.token, {
			kind: "input_accepted",
			nativeMessageId: "old-native",
		});
		const before = d.view();
		const contradiction = d.step({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: old.token,
				kind: "input_accepted",
				nativeMessageId: "contradiction",
			},
		});
		expect(contradiction.tag).toBe("Rejected");
		expect(d.view()).toEqual(before);
	});

	test("[10B] a permanent refusal resolves the interaction and nothing re-delivers it", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		const first = ask(d, a.token);
		const refused = observe(d, tokenOf(first), {
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "HTTP400" },
		});
		// 3.10, A (4386-4389, amends 10B): a permanent refusal ends the delivery and resolves the interaction.
		expect(refused.issued).toEqual([]);
		expect(d.view().interactions).not.toContainEqual(
			expect.objectContaining({ tag: "Pending", interactionId: "q" }),
		);
		expect(d.alarmAt).toBeUndefined();
		expect(
			d.issued.filter(({ effect }) => effect.kind === "deliver_answer"),
		).toEqual([first]);
	});

	test("[10B] an ambiguous answer is reconciled by its probe and never retransmitted", () => {
		const d = new Driver("opencode", mode);
		const a = running(d);
		const first = ask(d, a.token);
		observe(d, tokenOf(first), {
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
		});
		const recovered = fire(d);
		expect(recovered.issued.map(({ effect }) => effect)).toMatchObject([
			{ kind: "probe", target: { tag: "interaction", interactionId: "q" } },
		]);
		observe(d, tokenOf(d.latest("probe")), {
			kind: "probe_result",
			finding: { tag: "answer_consumed" },
		});
		expect(
			d.issued.filter(({ effect }) => effect.kind === "deliver_answer"),
		).toHaveLength(1);
		expect(d.view().interactions).toMatchObject([
			{ tag: "Answered", interactionId: "q", delivery: "settled" },
		]);
	});
});
