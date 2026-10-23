import { describe, expect, it } from "vitest";
import type { IssuedEffect } from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { ledger, missing } from "./run-ledger-scenarios.js";

describe("Transmission-scoped native-work proof", () => {
	it("round 3 audit: permanent ambiguity cannot claim an unknown outcome was already probed", () => {
		const l = ledger("opencode");
		const a = l.start();
		const b = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: b,
			outcome: { tag: "permanent", code: "B_failed" },
		});
		l.observe({ kind: "activity", token: b });
		expect(
			l
				.observe({
					kind: "effect_outcome",
					token: b,
					outcome: { tag: "delivery_unknown" },
				})
				.effects.map(({ effect }) => effect),
		).toEqual([
			{
				kind: "probe",
				runId: a.runId,
				target: { tag: "input", inputId: "B" },
			},
		]);
	});
	it("round 3 audit: native activity cannot forget an already-probed unknown outcome", () => {
		const l = ledger("opencode");
		l.start();
		const b = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: b,
			outcome: { tag: "delivery_unknown" },
		});
		const alarmAt = l.alarmAt;
		l.ctx.now = 101;
		l.observe({ kind: "activity", token: b });
		const work = l.work;
		const repeated = l.observe({
			kind: "effect_outcome",
			token: b,
			outcome: { tag: "delivery_unknown" },
		});
		expect(repeated.effects).toEqual([]);
		expect(repeated.alarmAt).toBe(alarmAt);
		expect(l.work).toEqual(work);
	});
	it.each([
		"delivery_unknown",
		"permanent",
	] as const)("round 3 audit: repeated %s preserves native proof and probe obligations", (tag) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const b = l.admit("B").effects[0]?.token ?? missing;
		l.observe({ kind: "activity", token: b });
		const outcome = tag === "permanent" ? { tag, code: "B_failed" } : { tag };
		l.observe({ kind: "effect_outcome", token: b, outcome });
		const alarmAt = l.alarmAt;
		const work = l.work;
		l.ctx.now = 101;
		const repeated = l.observe({ kind: "effect_outcome", token: b, outcome });
		expect(repeated.effects).toEqual([]);
		expect(repeated.alarmAt).toBe(alarmAt);
		expect(l.work).toEqual(work);
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		expect(
			l
				.observe({ kind: "query_ended", token: a.token })
				.effects.map(({ effect }) => effect),
		).toEqual([{ kind: "start", runId: l.state.active?.runId, inputId: "C" }]);
	});
	describe.each([
		"retryable",
		"delivery_unknown",
		"permanent",
	] as const)("round 3 audit: %s cannot erase direct native proof", (outcome) => {
		it.each([
			"started",
			"activity",
			"interaction_requested",
		] as const)("preserves the named transmission's %s proof", (kind) => {
			const l = ledger("opencode");
			const a = l.start();
			l.observe({ kind: "input_accepted", token: a.token });
			const b = l.admit("B").effects[0]?.token ?? missing;
			l.observe(
				kind === "interaction_requested"
					? {
							kind,
							token: b,
							interactionId: "q",
							interactionKind: "question",
						}
					: { kind, token: b },
			);
			l.observe({
				kind: "effect_outcome",
				token: b,
				outcome:
					outcome === "retryable"
						? { tag: outcome, retryAt: 101 }
						: outcome === "permanent"
							? { tag: outcome, code: "B_failed" }
							: { tag: outcome },
			});
			l.ctx.now = 101;
			expect(
				l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }).effects,
			).toEqual([]);
			const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
			l.observe({
				kind: "effect_outcome",
				token: interrupt?.token ?? missing,
				outcome: { tag: "succeeded" },
			});
			l.observe({ kind: "result", token: a.token, outcome: "completed" });
			expect(
				l
					.observe({ kind: "query_ended", token: a.token })
					.effects.map(({ effect }) => effect),
			).toEqual([
				{ kind: "start", runId: l.state.active?.runId, inputId: "C" },
			]);
			expect(l.work.some(({ token }) => token === b)).toBe(false);
			expect(l.ended).toHaveLength(1);
		});
	});
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("round 3 audit: old start acceptance cannot hide the current %s start refusal", (provider) => {
		const l = ledger(provider);
		const a1 = l.admit("A").effects[0]?.token ?? missing;
		const runId = l.state.active?.runId;
		l.observe({
			kind: "effect_outcome",
			token: a1,
			outcome: { tag: "retryable", retryAt: 101 },
		});
		const a2 = l.fire().effects.find(({ effect }) => effect.kind === "start");
		expect(a2?.token).not.toBe(a1);
		l.observe({ kind: "input_accepted", token: a1 });
		const refused = l.observe({
			kind: "effect_outcome",
			token: a2?.token ?? missing,
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
	it("round 3 audit: B1 acceptance cannot confirm B2's permanent transport outcome", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const b1 = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: b1,
			outcome: { tag: "retryable", retryAt: 101 },
		});
		const b2 = l.fire().effects.find(({ effect }) => effect.kind === "steer");
		l.observe({ kind: "input_accepted", token: b1 });
		l.observe({
			kind: "effect_outcome",
			token: b2?.token ?? missing,
			outcome: { tag: "permanent", code: "B2_failed" },
		});
		expect(l.input("B")?.state).toEqual({ tag: "Accepted" });
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		expect(l.state.active?.tag).toBe("Queued");
		expect(l.work.some(({ token }) => token === b2?.token)).toBe(true);
		const probe =
			[...l.work]
				.reverse()
				.find(
					({ effect }) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				)?.token ?? missing;
		expect(
			l.observe({
				kind: "probe_result",
				token: probe,
				finding: { tag: "native_idle" },
			}).effects,
		).toEqual([]);
		l.observe({
			kind: "effect_outcome",
			token: b2?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		expect(
			l
				.observe({
					kind: "probe_result",
					token: probe,
					finding: { tag: "native_idle" },
				})
				.effects.map(({ effect }) => effect),
		).toEqual([{ kind: "start", runId: l.state.active?.runId, inputId: "C" }]);
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
	});
	it.each([
		"before",
		"after",
	] as const)("round 3: B1 acceptance cannot retain undelivered retry B2 with its outcome %s A ends", (when) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const b1 = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: b1,
			outcome: { tag: "retryable", retryAt: 101 },
		});
		const b2 = l.fire().effects.find(({ effect }) => effect.kind === "steer");
		expect(b2?.token).not.toBe(b1);
		l.observe({ kind: "input_accepted", token: b1 });
		if (when === "before")
			l.observe({
				kind: "effect_outcome",
				token: b2?.token ?? missing,
				outcome: { tag: "retryable", retryAt: 110 },
			});
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		const effects: IssuedEffect[] = [
			...l.observe({ kind: "query_ended", token: a.token }).effects,
		];
		if (when === "after")
			effects.push(
				...l.observe({
					kind: "effect_outcome",
					token: b2?.token ?? missing,
					outcome: { tag: "retryable", retryAt: 110 },
				}).effects,
			);
		// Replay bounded cancellation/abort and repeated idle reconciliation.
		// These are virtual alarms, with every provider response explicit.
		for (let cycle = 0; cycle < 5; cycle++) {
			const probe = [...l.work]
				.reverse()
				.find(
					({ effect }) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				);
			if (probe)
				effects.push(
					...l.observe({
						kind: "probe_result",
						token: probe.token,
						finding: { tag: "native_idle" },
					}).effects,
				);
			if (effects.some(({ effect }) => effect.kind === "start")) break;
			if (l.alarmAt === undefined) break;
			const cleanup = [...l.fire().effects];
			for (const send of cleanup)
				if (["cancel_request", "interrupt"].includes(send.effect.kind))
					cleanup.push(
						...l.observe({
							kind: "effect_outcome",
							token: send.token,
							outcome: { tag: "succeeded" },
						}).effects,
					);
			effects.push(...cleanup);
		}
		expect(l.work.some(({ token }) => token === b2?.token)).toBe(false);
		expect(
			effects.flatMap(({ effect }) =>
				effect.kind === "start" ? [effect.inputId] : [],
			),
		).toEqual(["C"]);
		expect(l.state.active?.tag).toBe("Starting");
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
	});
});
