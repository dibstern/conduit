import { expect } from "vitest";
import {
	decide,
	evolve,
	initialSessionLedgerState,
	viewLedger,
} from "../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	DecideContext,
	Evidence,
	IssuedEffect,
	LedgerCommand,
	Observation,
	ProviderKind,
	SendToken,
} from "../../../src/lib/provider/run-ledger/run-ledger-model.js";

export const missing = "never-issued" as SendToken;
export const token = (value: string) => value as SendToken;
export const variants = {
	effects: [
		"start",
		"steer",
		"interrupt",
		"close",
		"quarantine",
		"kill_and_respawn",
		"end_session",
		"deliver_answer",
		"cancel_request",
		"probe",
	],
	outcomes: ["succeeded", "retryable", "permanent", "delivery_unknown"],
	probeTargets: ["input", "interaction", "native_session"],
} as const;
export function generatedOutcome(
	kind: (typeof variants.outcomes)[number],
	now: number,
): Extract<Evidence, { kind: "effect_outcome" }>["outcome"] {
	return kind === "retryable"
		? { tag: kind, retryAt: now + 1 }
		: kind === "permanent"
			? { tag: kind, code: "Failure" }
			: { tag: kind };
}

export function ledger(provider: ProviderKind = "claude") {
	let sequence = 0;
	let state = initialSessionLedgerState("session", provider);
	const issued: IssuedEffect[] = [];
	let alarmAt: number | undefined;
	const ended: { readonly runId: string }[] = [];
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
	const latest = (predicate: (send: IssuedEffect) => boolean) =>
		[...issued].reverse().find(predicate)?.token ?? missing;
	return {
		ctx,
		get state() {
			return viewLedger(state);
		},
		get work() {
			return viewLedger(state).live;
		},
		get alarmAt() {
			return alarmAt;
		},
		get ended() {
			return ended;
		},
		input(inputId: string) {
			const view = viewLedger(state);
			return [...(view.active?.inputs ?? []), ...view.inbox].find(
				(input) => input.inputId === inputId,
			);
		},
		uncertain(inputId: string) {
			return this.input(inputId)?.uncertain ?? false;
		},
		queryToken(runId?: string) {
			return latest(
				(send) =>
					(send.effect.kind === "start" || send.effect.kind === "steer") &&
					(!runId || send.effect.runId === runId),
			);
		},
		inputToken(inputId: string, runId?: string) {
			return latest(
				(send) =>
					(send.effect.kind === "start" || send.effect.kind === "steer") &&
					send.effect.inputId === inputId &&
					(!runId || send.effect.runId === runId),
			);
		},
		answerToken(interactionId: string, runId?: string) {
			const found = latest(
				(send) =>
					send.effect.kind === "deliver_answer" &&
					send.effect.interactionId === interactionId &&
					(!runId || send.effect.runId === runId),
			);
			return found === missing ? this.queryToken(runId) : found;
		},
		inspect(command: LedgerCommand) {
			return decide(state, command, ctx);
		},
		send(command: LedgerCommand) {
			const decision = decide(state, command, ctx);
			if (decision.tag === "Rejected") expect.fail(decision.diagnostic);
			state = decision.events.reduce(evolve, state);
			alarmAt = decision.alarmAt;
			issued.push(...decision.effects);
			ended.push(...decision.ended);
			return {
				...decision,
				allEffects: decision.effects,
			};
		},
		observe(observation: Observation) {
			return this.send({ verb: "observe", observation });
		},
		admit(inputId: string) {
			return this.send({ verb: "admit", inputId, runNow: false });
		},
		control(control: Extract<LedgerCommand, { verb: "control" }>["control"]) {
			return this.send({ verb: "control", control });
		},
		start(inputId = "A") {
			const admitted = this.admit(inputId);
			const start = admitted.effects.find(
				(send) => send.effect.kind === "start",
			);
			if (!start || !("runId" in start.effect))
				expect.fail("Expected a start transmission");
			this.observe({ kind: "started", token: start.token });
			return { runId: start.effect.runId, token: start.token, admitted };
		},
		fire() {
			if (alarmAt === undefined) expect.fail("Expected an open deadline");
			ctx.now = Math.max(ctx.now, alarmAt);
			return this.send({
				verb: "settle",
				settlement: { kind: "alarm_fired" },
			});
		},
	};
}
