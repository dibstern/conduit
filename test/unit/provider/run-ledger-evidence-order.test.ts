import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
	Evidence,
	IssuedEffect,
	LedgerView,
	SendToken,
} from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { ledger, missing } from "./run-ledger-scenarios.js";

describe("Accumulated transmission evidence", () => {
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("%s an input probe cannot attribute a sibling's known acceptance to its retry", (provider) => {
		const l = ledger(provider);
		const a1 = l.admit("A").effects[0]?.token ?? missing;
		const runId = l.state.active?.runId;
		l.observe({
			kind: "effect_outcome",
			token: a1,
			outcome: { tag: "retryable", retryAt: 101 },
		});
		const a2 =
			l.fire().effects.find(({ effect }) => effect.kind === "start")?.token ??
			missing;
		l.observe({ kind: "input_accepted", token: a1, nativeMessageId: "old-A" });
		const probe =
			l.observe({
				kind: "effect_outcome",
				token: a2,
				outcome: { tag: "delivery_unknown" },
			}).effects[0]?.token ?? missing;
		expect(probe).not.toBe(missing);
		l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "input_present", nativeMessageId: "old-A" },
		});
		const refused = l.observe({
			kind: "effect_outcome",
			token: a2,
			outcome: { tag: "permanent", code: "A2_refused" },
		});
		expect(refused.ended).toEqual([
			{
				runId,
				outcome: "error",
				reason: { kind: "refused", code: "A2_refused" },
			},
		]);
		expect(l.state.active).toBeUndefined();
		expect(l.state.inbox).toEqual([]);
	});
	it.each([
		"claude",
		"cursor",
	] as const)("%s unknown evidence after a failed kill preserves quarantine and its native probe", (provider) => {
		const l = ledger(provider);
		l.start();
		l.control({ kind: "stop" });
		const close =
			l.fire().effects.find(({ effect }) => effect.kind === "close")?.token ??
			missing;
		const kill =
			l.observe({
				kind: "effect_outcome",
				token: close,
				outcome: { tag: "permanent", code: "close_failed" },
			}).effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: kill,
			outcome: { tag: "permanent", code: "kill_failed" },
		});
		expect(l.work.some(({ effect }) => effect.kind === "quarantine")).toBe(
			true,
		);
		const work = l.work;
		const alarmAt = l.alarmAt;
		l.ctx.now++;
		const unknown = l.observe({
			kind: "effect_outcome",
			token: kill,
			outcome: { tag: "delivery_unknown" },
		});
		expect(unknown.effects).toEqual([]);
		expect(unknown.ended).toEqual([]);
		expect(unknown.alarmAt).toBe(alarmAt);
		expect(l.work).toEqual(work);
	});
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("%s repeated unknown cleanup evidence keeps its original native probe and deadline", (provider) => {
		const l = ledger(provider);
		l.start();
		const interrupt = l.control({ kind: "stop" }).effects[0]?.token ?? missing;
		const first = l.observe({
			kind: "effect_outcome",
			token: interrupt,
			outcome: { tag: "delivery_unknown" },
		});
		expect(first.effects.map(({ effect }) => effect.kind)).toEqual(["probe"]);
		const work = l.work;
		const alarmAt = l.alarmAt;
		l.ctx.now++;
		const repeated = l.observe({
			kind: "effect_outcome",
			token: interrupt,
			outcome: { tag: "delivery_unknown" },
		});
		expect(repeated.effects).toEqual([]);
		expect(repeated.alarmAt).toBe(alarmAt);
		expect(l.work).toEqual(work);
	});
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("round 4: %s input-probe acceptance protects its covered start from refusal", (provider) => {
		const l = ledger(provider);
		const a = l.admit("A").effects[0]?.token ?? missing;
		const probe =
			l.observe({
				kind: "effect_outcome",
				token: a,
				outcome: { tag: "delivery_unknown" },
			}).effects[0]?.token ?? missing;
		l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "input_present" },
		});
		expect(l.input("A")?.state).toEqual({ tag: "Accepted" });
		l.control({ kind: "run_now", inputId: "B" });
		const refused = l.observe({
			kind: "effect_outcome",
			token: a,
			outcome: { tag: "permanent", code: "late_refusal" },
		});
		expect(refused.ended).toEqual([]);
		expect(refused.effects).toEqual([]);
		expect(l.state.active?.tag).toBe("Interrupting");
		expect(l.work.some(({ token }) => token === a)).toBe(true);
	});
	it.each([
		"started",
		"activity",
		"interaction_requested",
	] as const)("round 4: OpenCode %s followed by permanent failure does not prove HTTP settlement to idle", (kind) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		l.observe({
			kind: "effect_outcome",
			token: a.token,
			outcome: { tag: "succeeded" },
		});
		const b = l.admit("B").effects[0]?.token ?? missing;
		l.observe(
			kind === "interaction_requested"
				? { kind, token: b, interactionId: "q", interactionKind: "question" }
				: { kind, token: b },
		);
		l.observe({
			kind: "effect_outcome",
			token: b,
			outcome: { tag: "permanent", code: "B_failed" },
		});
		const nativeProbe =
			l
				.fire()
				.effects.find(
					({ effect }) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				)?.token ?? missing;
		expect(nativeProbe).not.toBe(missing);
		const interrupt =
			l.control({ kind: "run_now", inputId: "C" }).effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: interrupt,
			outcome: { tag: "succeeded" },
		});
		const idle = l.observe({
			kind: "probe_result",
			token: nativeProbe,
			finding: { tag: "native_idle" },
		});
		expect(idle.effects).toEqual([]);
		expect(idle.ended).toEqual([]);
		expect(l.state.active?.tag).toBe("Interrupting");
		expect(l.work.some(({ token }) => token === b)).toBe(true);
		// A genuine HTTP success now allows the same covering idle sample to release C.
		l.observe({
			kind: "effect_outcome",
			token: b,
			outcome: { tag: "succeeded" },
		});
		expect(
			l
				.observe({
					kind: "probe_result",
					token: nativeProbe,
					finding: { tag: "native_idle" },
				})
				.effects.map(({ effect }) => effect.kind),
		).toEqual(["start"]);
		expect(l.state.active?.inputs[0]?.inputId).toBe("C");
	});
});

const facts = [
	"accepted",
	"probe_accepted",
	"observed",
	"succeeded",
	"permanent",
	"retryable",
	"delivery_unknown",
	"native_completion",
] as const;
type Fact = (typeof facts)[number];

function* permutations<T>(items: readonly T[]): Generator<readonly T[]> {
	if (items.length === 0) yield [];
	for (const [index, item] of items.entries())
		for (const rest of permutations(items.filter((_, i) => i !== index)))
			yield [item, ...rest];
}

function replay(
	order: readonly Fact[],
	retry: boolean,
	oldAcceptance: boolean,
	preprobed = true,
) {
	const l = ledger("opencode");
	const a = l.start();
	l.observe({ kind: "input_accepted", token: a.token });
	l.observe({
		kind: "effect_outcome",
		token: a.token,
		outcome: { tag: "succeeded" },
	});
	const b1 = l.admit("B").effects[0]?.token ?? missing;
	let b = b1;
	if (retry) {
		l.observe({
			kind: "effect_outcome",
			token: b1,
			outcome: { tag: "retryable", retryAt: 101 },
		});
		b =
			l.fire().effects.find(({ effect }) => effect.kind === "steer")?.token ??
			missing;
		expect(b).not.toBe(b1);
	}
	// Establish the input-probe obligation before reordering its answer with transport/native proof.
	if (preprobed)
		l.observe({
			kind: "effect_outcome",
			token: b,
			outcome: { tag: "delivery_unknown" },
		});
	l.ctx.now = 201;
	const probes = l.send({
		verb: "settle",
		settlement: { kind: "alarm_fired" },
	}).effects;
	const inputProbe =
		probes.find(
			({ effect }) => effect.kind === "probe" && effect.target.tag === "input",
		)?.token ?? missing;
	const nativeProbe =
		probes.find(
			({ effect }) =>
				effect.kind === "probe" && effect.target.tag === "native_session",
		)?.token ?? missing;
	if (preprobed) expect(inputProbe).not.toBe(missing);
	expect(nativeProbe).not.toBe(missing);
	const interrupt =
		l.control({ kind: "run_now", inputId: "C" }).effects[0]?.token ?? missing;
	l.observe({
		kind: "effect_outcome",
		token: interrupt,
		outcome: { tag: "succeeded" },
	});
	const evidence = (fact: Fact): Evidence => {
		switch (fact) {
			case "accepted":
				return { kind: "input_accepted" };
			case "probe_accepted":
				return { kind: "probe_result", finding: { tag: "input_present" } };
			case "observed":
				return { kind: "activity" };
			case "native_completion":
				return { kind: "result", outcome: "completed" };
			case "retryable":
				return {
					kind: "effect_outcome",
					outcome: { tag: "retryable", retryAt: 202 },
				};
			case "permanent":
				return {
					kind: "effect_outcome",
					outcome: { tag: "permanent", code: "B_failed" },
				};
			default:
				return { kind: "effect_outcome", outcome: { tag: fact } };
		}
	};
	const deliver = (fact: Fact, token: SendToken) =>
		l.observe({ ...evidence(fact), token });
	for (const fact of order)
		deliver(
			fact,
			fact === "probe_accepted"
				? inputProbe
				: oldAcceptance && fact === "accepted"
					? b1
					: b,
		);
	const batchView = l.state;
	const batchAlarmAt = l.alarmAt;
	const idle = l.observe({
		kind: "probe_result",
		token: nativeProbe,
		finding: { tag: "native_idle" },
	});
	const closed = l.observe({ kind: "query_ended", token: a.token });
	const alarm = l.send({ verb: "settle", settlement: { kind: "alarm_fired" } });
	// Fresh unknown evidence can mint a probe at different points in the batch.
	// Preserve B1/B2 identity, while naming later effects by their public purpose.
	const runName = (id: string) =>
		preprobed ? id : id === a.runId ? "A" : "successor";
	const name = (send: IssuedEffect) => {
		if (preprobed) return send;
		const effect =
			"runId" in send.effect
				? { ...send.effect, runId: runName(send.effect.runId) }
				: send.effect;
		return {
			effect,
			token:
				send.token === b1
					? "B1"
					: send.token === b
						? "B2"
						: JSON.stringify(effect),
		};
	};
	const view = (value: LedgerView) => ({
		...value,
		...(value.active
			? { active: { ...value.active, runId: runName(value.active.runId) } }
			: {}),
		live: value.live.map(name),
	});
	const terminal = (value: (typeof idle.ended)[number]) => ({
		...value,
		runId: runName(value.runId),
	});
	// Compare public decisions after the evidence batch, including subsequent retry eligibility.
	return {
		batch: { view: view(batchView), alarmAt: batchAlarmAt },
		idle: {
			tag: idle.tag,
			effects: idle.effects.map(name),
			ended: idle.ended.map(terminal),
			alarmAt: idle.alarmAt,
		},
		closed: {
			tag: closed.tag,
			effects: closed.effects.map(name),
			ended: closed.ended.map(terminal),
			alarmAt: closed.alarmAt,
		},
		alarm: {
			tag: alarm.tag,
			effects: alarm.effects.map(name),
			ended: alarm.ended.map(terminal),
			alarmAt: alarm.alarmAt,
		},
		view: view(l.state),
		ended: l.ended.map((value) => ({ ...value, runId: runName(value.runId) })),
		alarmAt: l.alarmAt,
	};
}

describe("Public transmission-evidence permutations", () => {
	it.each([
		"one send",
		"send and retry",
		"send and retry with old acceptance",
		"fresh one send",
		"fresh send and retry",
		"fresh send and retry with old acceptance",
	] as const)("%s converges for every permutation of each generated fact set", (scenario) => {
		const preprobed = !scenario.startsWith("fresh");
		const retry = scenario.includes("retry");
		const oldAcceptance = scenario.includes("old acceptance");
		fc.assert(
			fc.property(
				fc.uniqueArray(
					fc.constantFrom(
						...facts.filter((fact) => preprobed || fact !== "probe_accepted"),
					),
					{
						minLength: 1,
						maxLength: 4,
					},
				),
				(set) => {
					const orders = permutations(set);
					const first = orders.next().value ?? [];
					const expected = replay(first, retry, oldAcceptance, preprobed);
					for (const order of orders)
						expect(
							replay(order, retry, oldAcceptance, preprobed),
							`delivery order: ${order.join(", ")}`,
						).toEqual(expected);
				},
			),
			{
				seed: 82_103_204,
				numRuns: 100,
				examples: [
					[["observed", "permanent"]],
					[[preprobed ? "probe_accepted" : "accepted", "permanent"]],
					[["succeeded", "delivery_unknown"]],
					[["accepted", "delivery_unknown"]],
					[["retryable", "succeeded", "permanent", "observed"]],
				],
			},
		);
	});
});
