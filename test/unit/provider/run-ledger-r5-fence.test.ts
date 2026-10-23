import { describe, expect, it } from "vitest";
import {
	decide,
	evolve,
	initialSessionLedgerState,
	viewLedger,
} from "../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	DecideContext,
	LedgerCommand,
} from "../../../src/lib/provider/run-ledger/run-ledger-model.js";

describe.each([
	"claude",
	"cursor",
] as const)("R5 native-session fence: %s", (provider) => {
	for (const evidence of [
		"late acceptance",
		"ambiguous input_present",
	] as const) {
		// The redesign tickets flip these it.fails cases to it.
		it.fails(`${evidence}: refusing A2 preserves the fence and interrupt for A1`, () => {
			let state = initialSessionLedgerState("session", provider);
			let sequence = 0;
			const ctx = {
				now: 100,
				newId: () => `id-${++sequence}`,
				policy: {
					startMs: 10,
					livenessMs: 100,
					interruptMs: 30_000,
					closeMs: 20,
					settleMs: 30,
					fenceMs: 40,
				},
			} satisfies DecideContext;
			const send = (command: LedgerCommand) => {
				const decision = decide(state, command, ctx);
				if (decision.tag === "Rejected") expect.fail(decision.diagnostic);
				state = decision.events.reduce(evolve, state);
				return decision;
			};

			const a1 = send({
				verb: "admit",
				inputId: "A",
				runNow: false,
			}).effects.find(({ effect }) => effect.kind === "start");
			if (!a1) expect.fail("Expected start A1");
			send({
				verb: "observe",
				observation: {
					kind: "effect_outcome",
					token: a1.token,
					outcome: { tag: "retryable", retryAt: 101 },
				},
			});
			ctx.now = 101;
			const a2 = send({
				verb: "settle",
				settlement: { kind: "alarm_fired" },
			}).effects.find(({ effect }) => effect.kind === "start");
			if (!a2) expect.fail("Expected retry start A2");
			expect(a2.effect).toEqual(a1.effect);
			expect(a2.token).not.toBe(a1.token);

			if (evidence === "late acceptance") {
				send({
					verb: "observe",
					observation: { kind: "input_accepted", token: a1.token },
				});
			} else {
				const probe = send({
					verb: "observe",
					observation: {
						kind: "effect_outcome",
						token: a2.token,
						outcome: { tag: "delivery_unknown" },
					},
				}).effects.find(({ effect }) => effect.kind === "probe");
				if (!probe) expect.fail("Expected an input probe for A2");
				expect(probe.effect).toMatchObject({
					kind: "probe",
					target: { tag: "input", inputId: "A" },
				});
				// Neither sibling has a native id, so presence cannot identify its send.
				send({
					verb: "observe",
					observation: {
						kind: "probe_result",
						token: probe.token,
						finding: { tag: "input_present" },
					},
				});
			}
			expect(viewLedger(state).active?.inputs).toContainEqual({
				inputId: "A",
				state: { tag: "Accepted" },
				uncertain: false,
			});

			const queued = send({
				verb: "control",
				control: { kind: "run_now", inputId: "B" },
			});
			const interrupt = queued.effects.find(
				({ effect }) => effect.kind === "interrupt",
			);
			if (!interrupt) expect.fail("Expected an interrupt before starting B");
			expect(viewLedger(state).active?.tag).toBe("Interrupting");
			expect(viewLedger(state).inbox.map(({ inputId }) => inputId)).toEqual([
				"B",
			]);
			expect(viewLedger(state).live).toContainEqual(interrupt);

			// No result, query end or cleanup acknowledgement has ended A1's work.
			const refused = send({
				verb: "observe",
				observation: {
					kind: "effect_outcome",
					token: a2.token,
					outcome: { tag: "permanent", code: "A2_refused" },
				},
			});
			expect
				.soft(
					refused.effects.filter(
						({ effect }) => effect.kind === "start" && effect.inputId === "B",
					),
					"B must wait while accepted sibling A1 may still act",
				)
				.toEqual([]);
			expect
				.soft(
					viewLedger(state).live,
					"The outstanding interrupt must survive A2's refusal",
				)
				.toContainEqual(interrupt);
		});
	}
});
