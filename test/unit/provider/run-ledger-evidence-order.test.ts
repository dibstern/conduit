import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
	Evidence,
	IssuedEffect,
	LedgerView,
	SendToken,
} from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	admit,
	Driver,
	fire,
	observe,
	request,
	running,
	type Stepped,
	step,
} from "./run-ledger-oracle/scenarios.js";

/**
 * CONTRACT.md 3465-3466: the six seed 82_103_204 evidence-order permutations, in new-model terms. A
 * direct steer B joins A's open Run (main's run.requested, D60); with a retry, main sends B again under
 * a fresh runId (3.6, 692-698). Every order of each fact set on B's transmission at one instant (the
 * native stream's activity before its result, 11A), then the native
 * probe's idle, A's query end and an alarm, leaves the same public decisions on both the oracle and
 * the decider.
 */
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
				outcome: { tag: "retryable", retryAt: 10_000 },
			};
		case "permanent":
			return {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "B_failed" },
			};
		case "succeeded":
		case "delivery_unknown":
			return { kind: "effect_outcome", outcome: { tag: fact } };
	}
};

function replay(
	mode: "reference" | "decider",
	order: readonly Fact[],
	retry: boolean,
	oldAcceptance: boolean,
	preprobed: boolean,
) {
	// The order property alone: every Driver-based test already checks purity and LI4 at each step, and
	// here those checks cost four fifths of 8,000 replays, past the hook's 10s under load.
	const d = new Driver("opencode", mode, undefined, false);
	const a = running(d, "A");
	observe(d, a.token, {
		kind: "effect_outcome",
		outcome: { tag: "succeeded" },
	});
	admit(d, "B", "steer");
	const b1 = request(d, "B").token;
	let b = b1;
	if (retry) {
		observe(d, b1, {
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: d.now + 1 },
		});
		b = request(d, "B").token;
		expect(b).not.toBe(b1);
	}
	// The input probe's obligation is set before its answer is reordered with transport and native proof.
	if (preprobed)
		observe(d, b, {
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
		});
	const probes = d.alarmAt === undefined ? [] : fire(d).issued;
	admit(d, "C");
	const ran = step(d, {
		verb: "control",
		control: {
			kind: "run_now",
			commandId: "run-now-C",
			inputId: "C",
			deadlineAt: null,
		},
	});
	const tokenOf = (
		effects: readonly IssuedEffect[],
		target: "input" | "native_session",
	) => {
		const found = effects.find(
			({ effect }) => effect.kind === "probe" && effect.target.tag === target,
		);
		return found?.tag === "Tokened" ? found.token : undefined;
	};
	const inputProbe = tokenOf(probes, "input");
	const nativeProbe = tokenOf(ran.issued, "native_session");
	if (preprobed) expect(inputProbe).toBeDefined();
	expect(nativeProbe).toBeDefined();
	const cancel = ran.issued.find(
		({ effect }) => effect.kind === "cancel_request",
	);
	if (cancel?.tag === "Tokened")
		observe(d, cancel.token, {
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
		});
	// The batch arrives at one instant, as the redesign's clock held it, so only its order differs.
	const at = d.now + 1;
	for (const fact of order) {
		const token: SendToken | undefined =
			fact === "probe_accepted"
				? inputProbe
				: oldAcceptance && fact === "accepted"
					? b1
					: b;
		if (token !== undefined)
			d.step(
				{
					verb: "observe",
					observation: { tag: "Answer", token, ...evidence(fact) },
				},
				at,
			);
	}
	// Decide's tokens count its issues, so a probe minted at another point of the batch shifts them: an
	// issue is named by its effect.
	const name = (issue: IssuedEffect) =>
		issue.tag === "Tokened" ? { effect: issue.effect } : issue;
	const view = (value: LedgerView) => ({
		...value,
		live: value.live.map(name),
	});
	const decision = (value: Stepped) => ({
		tag: value.tag,
		...(value.tag === "Rejected"
			? {}
			: { effects: value.effects.map(name), ended: value.ended }),
		alarmAt: d.alarmAt,
	});
	const batch = { view: view(d.view()), alarmAt: d.alarmAt };
	const idle = decision(
		d.step({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: nativeProbe ?? ("never" as SendToken),
				kind: "probe_result",
				finding: { tag: "native_idle" },
			},
		}),
	);
	const closed = decision(
		d.step({
			verb: "observe",
			observation: { tag: "Answer", token: a.token, kind: "query_ended" },
		}),
	);
	const alarm = decision(
		d.step({ verb: "settle", settlement: { kind: "alarm_fired" } }),
	);
	return {
		batch,
		idle,
		closed,
		alarm,
		view: view(d.view()),
		ended: d.ended,
		alarmAt: d.alarmAt,
	};
}

describe("Public transmission-evidence permutations (seed 82_103_204)", () => {
	// test-waits-allow timeout-override: replays every order of 100 generated fact sets: 1.5s alone, past 10s beside a loaded 2-worker unit run, so 60s.
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
					{ minLength: 1, maxLength: 4 },
				),
				(set) => {
					// 11A (CONTRACT.md 887-889): activity after a result is a later turn, so the native stream's
					// activity keeps its place before its result; every other fact arrives in any order.
					const orders = [...permutations(set)].filter(
						(order) =>
							order.indexOf("native_completion") < 0 ||
							order.indexOf("observed") < order.indexOf("native_completion"),
					);
					const expected = replay(
						"reference",
						orders[0] ?? [],
						retry,
						oldAcceptance,
						preprobed,
					);
					for (const mode of ["reference", "decider"] as const)
						for (const order of orders)
							expect(
								replay(mode, order, retry, oldAcceptance, preprobed),
								`${mode}, delivery order: ${order.join(", ")}`,
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
	}, 60_000);
});
