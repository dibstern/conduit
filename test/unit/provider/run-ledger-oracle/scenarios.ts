import { expect } from "vitest";
import type {
	Evidence,
	InputView,
	IssuedEffect,
	LedgerCommand,
	ProviderKind,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import type { TraceDriver } from "./harness.js";

export interface OracleScenario {
	readonly id: string;
	readonly title: string;
	readonly provider: ProviderKind;
	readonly run: (driver: TraceDriver) => void;
}

function step(d: TraceDriver, command: LedgerCommand, now = d.now) {
	const decision = d.step(command, now);
	expect(decision.tag, decision.diagnostic).toBe("Accepted");
	return decision;
}

function observe(
	d: TraceDriver,
	send: IssuedEffect,
	evidence: Evidence,
	now = d.now,
) {
	return step(
		d,
		{ verb: "observe", observation: { token: send.token, ...evidence } },
		now,
	);
}

function admit(d: TraceDriver, inputId: string, runNow = false) {
	return step(d, { verb: "admit", inputId, runNow });
}

function running(d: TraceDriver, inputId = "A") {
	admit(d, inputId);
	const send = d.latest("start");
	observe(d, send, { kind: "started" });
	observe(d, send, {
		kind: "input_accepted",
		nativeMessageId: `native-${inputId}`,
	});
	expect(d.view().active).toMatchObject({ tag: "Running" });
	return send;
}

function fire(d: TraceDriver, at = d.alarmAt) {
	expect(at).toBeDefined();
	return step(d, { verb: "settle", settlement: { kind: "alarm_fired" } }, at);
}

function visibleInput(d: TraceDriver, inputId: string): InputView | undefined {
	return [...(d.view().active?.inputs ?? []), ...d.view().inbox].find(
		(input) => input.inputId === inputId,
	);
}

function transmissions(d: TraceDriver, inputId: string) {
	return d.issued.filter(
		({ effect }) =>
			(effect.kind === "start" || effect.kind === "steer") &&
			effect.inputId === inputId,
	);
}

function ask(d: TraceDriver, query: IssuedEffect, interactionId = "q") {
	observe(d, query, {
		kind: "interaction_requested",
		interactionId,
		interactionKind: "question",
	});
	step(d, {
		verb: "control",
		control: { kind: "answer", interactionId, answer: "yes" },
	});
	return d.latest("deliver_answer");
}

function complete(d: TraceDriver, query: IssuedEffect) {
	const result = observe(d, query, { kind: "result", outcome: "completed" });
	const closed = observe(d, query, { kind: "query_ended" });
	return {
		...closed,
		effects: [...result.effects, ...closed.effects],
		ended: [...result.ended, ...closed.ended],
	};
}

function noLifecycleChange(d: TraceDriver, command: LedgerCommand) {
	const before = d.view();
	const decision = step(d, command);
	expect(decision.effects).toEqual([]);
	expect(decision.ended).toEqual([]);
	expect(d.view()).toEqual(before);
}

function stop(d: TraceDriver) {
	const decision = step(d, { verb: "control", control: { kind: "stop" } });
	expect(d.view()).toMatchObject({
		paused: true,
		active: { tag: "Interrupting", deadline: { kind: "interrupt" } },
	});
	expect(
		decision.effects.some(({ effect }) => effect.kind === "interrupt"),
	).toBe(true);
	return d.latest("interrupt");
}

export const scenarios: readonly OracleScenario[] = [
	{
		id: "RL-003",
		title:
			"[step1] a spurious alarm after process loss leaves a newer Run before its deadline",
		provider: "claude",
		run(d) {
			const a = running(d);

			ask(d, a);
			step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", token: a.token },
			});
			admit(d, "B", true);
			const before = d.view();
			const late = fire(d, d.now);
			expect(late.ended).toEqual([]);
			expect(late.effects).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	},
	{
		id: "RL-010",
		title: "[2C] an owned idle boundary cannot accept a delivered steer",
		provider: "opencode",
		run(d) {
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, { kind: "effect_outcome", outcome: { tag: "succeeded" } });
			expect(visibleInput(d, "B")?.state.tag).toBe("Delivered");
			complete(d, b);
			expect(visibleInput(d, "B")).toMatchObject({
				inputId: "B",
				uncertain: true,
			});
			expect(visibleInput(d, "B")?.state.tag).not.toBe("Accepted");
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "RL-013",
		title: "[5C] a new authorization after a retryable result gets a fresh Run",
		provider: "cursor",
		run(d) {
			const a = running(d);
			const ended = observe(d, a, {
				kind: "result",
				outcome: "error",
				error: { code: "Transient", retryable: true },
			});
			expect(ended.ended).toMatchObject([
				{
					outcome: "error",
					reason: { kind: "provider_error", code: "Transient" },
				},
			]);
			admit(d, "B", true);
			const b = d.latest("start");
			expect(b.effect).toMatchObject({ kind: "start", inputId: "B" });
			expect(b.effect).not.toMatchObject({
				runId: a.effect.kind === "start" ? a.effect.runId : "",
			});
			noLifecycleChange(d, {
				verb: "observe",
				observation: { token: a.token, kind: "activity" },
			});
			expect(d.view().active).toMatchObject({
				tag: "Starting",
				deadline: { kind: "start" },
			});
		},
	},
	{
		id: "RL-014",
		title: "[2C] OpenCode tool progress is activity rather than a terminal",
		provider: "opencode",
		run(d) {
			const a = running(d);
			// The public alphabet represents a nonterminal tool-step as activity.
			const progress = observe(d, a, { kind: "activity" }, d.now + 10);
			expect(progress.ended).toEqual([]);
			expect(d.view().active).toMatchObject({
				tag: "Running",
				deadline: { kind: "liveness", at: d.now + 10_000 },
			});
		},
	},
	{
		id: "RL-017",
		title: "[5C] a successful OpenCode tool-step cannot mask the final failure",
		provider: "opencode",
		run(d) {
			const a = running(d);
			observe(d, a, { kind: "activity" });
			observe(d, a, {
				kind: "result",
				outcome: "error",
				error: { code: "MessageAbortedError", retryable: false },
			});
			const failed = observe(d, a, { kind: "query_ended" });
			expect(failed.ended).toMatchObject([
				{
					outcome: "error",
					reason: { kind: "provider_error", code: "MessageAbortedError" },
				},
			]);
			expect(d.view().active).toBeUndefined();
		},
	},
	{
		id: "RL-019",
		title: "[2C] a Claude failure before started retains the Starting owner",
		provider: "claude",
		run(d) {
			admit(d, "A");
			const a = d.latest("start");
			const failed = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "IteratorFailed" },
			});
			expect(failed.ended).toMatchObject([
				{ outcome: "error", reason: { code: "IteratorFailed" } },
			]);
			expect(d.view().active).toBeUndefined();
			expect(
				failed.effects.every(({ effect }) => effect.kind !== "start"),
			).toBe(true);
		},
	},
	{
		id: "RL-021",
		title: "[step1] unknown OpenCode intake keeps its deadline and probes",
		provider: "opencode",
		run(d) {
			admit(d, "A");
			const a = d.latest("start");
			const unknown = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			expect(unknown.effects.map(({ effect }) => effect)).toContainEqual(
				expect.objectContaining({
					kind: "probe",
					target: { tag: "input", inputId: "A" },
				}),
			);
			expect(d.view().active?.deadline).toBeDefined();
			expect(visibleInput(d, "A")).toMatchObject({ uncertain: true });
			expect(transmissions(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "RL-025",
		title: "[step1] recalling an uncertain steer never ends its running owner",
		provider: "claude",
		run(d) {
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const recalled = step(d, {
				verb: "control",
				control: { kind: "cancel_input", inputId: "B" },
			});
			expect(recalled.ended).toEqual([]);
			expect(
				recalled.effects.some(({ effect }) =>
					["interrupt", "end_session", "close"].includes(effect.kind),
				),
			).toBe(false);
			expect(d.view().active?.tag).toBe("Running");
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "RL-027",
		title: "[2C] a successful SDK handoff proves delivery, never acceptance",
		provider: "claude",
		run(d) {
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			observe(d, b, { kind: "effect_outcome", outcome: { tag: "succeeded" } });
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Delivered",
				certainty: "sent",
			});
			complete(d, b);
			expect(visibleInput(d, "B")).toMatchObject({ uncertain: true });
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "RL-028",
		title: "[step1] an alarm before the successor deadline cannot interrupt it",
		provider: "cursor",
		run(d) {
			const a = running(d);

			complete(d, a);
			admit(d, "B");
			const before = d.view();
			const delayed = fire(d, d.now);
			expect(delayed.effects).toEqual([]);
			expect(delayed.ended).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	},
	{
		id: "RL-030",
		title: "[step1] uncertain intake does not block durable later admission",
		provider: "opencode",
		run(d) {
			running(d);
			admit(d, "B");
			observe(d, d.latest("steer"), {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			admit(d, "C");
			expect(visibleInput(d, "C")).toBeDefined();
			expect(visibleInput(d, "B")).toMatchObject({ uncertain: true });
			expect(d.view().active?.deadline).toBeDefined();
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "RL-031",
		title: "[6C] an unknown OpenCode send cannot accept the only pending input",
		provider: "opencode",
		run(d) {
			admit(d, "A");
			const a = d.latest("start");
			observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					token: "foreign-native-echo" as SendToken,
					kind: "input_accepted",
					nativeMessageId: "foreign",
				},
			});
			expect(visibleInput(d, "A")?.state.tag).toBe("Delivered");
			expect(visibleInput(d, "A")?.uncertain).toBe(true);
		},
	},
	{
		id: "RL-033",
		title:
			"[2C] replacement intake waits for the stopped native query to close",
		provider: "claude",
		run(d) {
			const a = running(d);
			stop(d);
			fire(d);
			const close = d.latest("close");
			admit(d, "B", true);
			expect(transmissions(d, "B")).toHaveLength(0);
			expect(d.view().active?.tag).toBe("Queued");
			const released = observe(d, close, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(
				released.effects.some(
					({ effect }) => effect.kind === "start" && effect.inputId === "B",
				),
			).toBe(true);
			expect(d.view().active?.runId).not.toBe(
				a.effect.kind === "start" ? a.effect.runId : undefined,
			);
		},
	},
	{
		id: "RL-034",
		title: "[2C] a pre-intake native Claude result ends its exact Starting Run",
		provider: "claude",
		run(d) {
			admit(d, "A");
			const a = d.latest("start");
			const result = observe(d, a, { kind: "result", outcome: "completed" });
			expect(result.ended).toMatchObject([
				{ outcome: "completed", reason: { kind: "completed" } },
			]);
			expect(d.view().active).toBeUndefined();
			expect(d.alarmAt).toBe(d.now + 3_000);
			const closed = observe(d, a, { kind: "query_ended" });
			expect(closed.ended).toEqual([]);
			expect(d.alarmAt).toBeUndefined();
		},
	},
	{
		id: "RL-036",
		title:
			"[7B] usage-limit failover settles the session with its typed reason once",
		provider: "claude",
		run(d) {
			running(d);
			const failover: LedgerCommand = {
				verb: "settle",
				settlement: { kind: "session_ended", cause: "usage_limit_failover" },
			};
			const first = step(d, failover);
			expect(first.ended).toMatchObject([
				{
					outcome: "error",
					reason: { kind: "session_ended", cause: "usage_limit_failover" },
				},
			]);
			expect(d.view().active).toBeUndefined();
			expect(d.view().live).toEqual([]);
			expect(step(d, failover).ended).toEqual([]);
		},
	},
	{
		id: "RL-037",
		title:
			"[5C] a classified provider error preserves outcome and typed reason",
		provider: "cursor",
		run(d) {
			const a = running(d);
			const result = observe(d, a, {
				kind: "result",
				outcome: "error",
				error: { code: "OwnedFailure", retryable: false },
			});
			expect(result.ended).toMatchObject([
				{
					outcome: "error",
					reason: {
						kind: "provider_error",
						code: "OwnedFailure",
						retryable: false,
					},
				},
			]);
			noLifecycleChange(d, {
				verb: "observe",
				observation: { token: a.token, kind: "result", outcome: "completed" },
			});
		},
	},
	{
		id: "RL-038",
		title: "[2C] an old input limit result cannot settle the replacement Run",
		provider: "claude",
		run(d) {
			const a = running(d);
			complete(d, a);
			admit(d, "B", true);
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					token: a.token,
					kind: "result",
					outcome: "error",
					error: { code: "blocking_limit", retryable: false },
				},
			});
			expect(visibleInput(d, "B")).toBeDefined();
		},
	},
	{
		id: "RL-039",
		title: "[2C] a slow Stop acknowledgement cannot consume resumed work",
		provider: "cursor",
		run(d) {
			const a = running(d);
			const interrupt = stop(d);
			complete(d, a);
			step(d, { verb: "control", control: { kind: "resume" } });
			admit(d, "B");
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					token: interrupt.token,
					kind: "effect_outcome",
					outcome: { tag: "succeeded" },
				},
			});
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "RL-040",
		title:
			"[2C] an unowned OpenCode assistant error cannot settle the active Run",
		provider: "opencode",
		run(d) {
			running(d);
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					token: "unknown-assistant-parent" as SendToken,
					kind: "result",
					outcome: "error",
					error: { code: "ForeignFailure", retryable: false },
				},
			});
			expect(d.view().active?.tag).toBe("Running");
		},
	},
	{
		id: "RL-041",
		title:
			"[9B] ordinary Stop returns the unaccepted steer behind the persistent pause",
		provider: "claude",
		run(d) {
			running(d);
			admit(d, "B");
			stop(d);
			const timeout = fire(d);
			expect(timeout.ended).toMatchObject([
				{
					outcome: "interrupted",
					reason: { kind: "interrupted", by: "stop", forced: true },
				},
			]);
			expect(d.view().paused).toBe(true);
			expect(d.view().inbox).toContainEqual(
				expect.objectContaining({ inputId: "B", uncertain: true }),
			);
			observe(d, d.latest("close"), {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			admit(d, "C");
			expect(transmissions(d, "B")).toHaveLength(1);
			expect(transmissions(d, "C")).toHaveLength(0);
			expect(d.view().active).toBeUndefined();
		},
	},
	{
		id: "RL-045",
		title:
			"[step1] Run now joins an existing Stop and makes progress after close",
		provider: "claude",
		run(d) {
			running(d);
			stop(d);
			const interruptDeadline = d.alarmAt;
			admit(d, "B", true);
			expect(d.view().active?.tag).toBe("Interrupting");
			fire(d, interruptDeadline);
			expect(transmissions(d, "B")).toHaveLength(0);
			const close = d.latest("close");
			observe(d, close, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(transmissions(d, "B")).toHaveLength(1);
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "RL-054",
		title: "[2C] Cursor steer delivery acknowledgement is not a Run result",
		provider: "cursor",
		run(d) {
			running(d);
			admit(d, "B");
			const b = d.latest("steer");
			const delivered = observe(d, b, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(delivered.ended).toEqual([]);
			expect(d.view().active?.tag).toBe("Running");
			expect(visibleInput(d, "B")?.state.tag).toBe("Delivered");
		},
	},
	{
		id: "RL-055",
		title:
			"[step1] provider-handled uncertain delivery probes instead of creating a second start",
		provider: "cursor",
		run(d) {
			admit(d, "A");
			const a = d.latest("start");
			const unknown = observe(d, a, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			expect(unknown.effects.map(({ effect }) => effect.kind)).toContain(
				"probe",
			);
			expect(transmissions(d, "A")).toHaveLength(1);
			expect(visibleInput(d, "A")).toMatchObject({ uncertain: true });
		},
	},
	{
		id: "RL-056",
		title:
			"[step1] a declined Cursor steer returns to the inbox without pausing",
		provider: "cursor",
		run(d) {
			running(d);
			admit(d, "B");
			const declined = observe(d, d.latest("steer"), {
				kind: "input_declined",
				reason: "steer-declined",
			});
			expect(declined.ended).toEqual([]);
			expect(d.view()).toMatchObject({
				paused: false,
				active: { tag: "Running" },
			});
			expect(d.view().inbox).toContainEqual(
				expect.objectContaining({ inputId: "B", state: { tag: "Queued" } }),
			);
		},
	},
	{
		id: "RL-072",
		title:
			"[10B] permanent answer failure has reconciliation rather than endless delivery retries",
		provider: "opencode",
		run(d) {
			const a = running(d);
			const answer = ask(d, a);
			const failed = observe(d, answer, {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "HTTP400" },
			});
			expect(
				failed.effects.some(({ effect }) => effect.kind === "deliver_answer"),
			).toBe(false);
			expect(d.view().active?.deadline).toBeDefined();
			expect(failed.effects.map(({ effect }) => effect)).toContainEqual(
				expect.objectContaining({
					kind: "probe",
					target: { tag: "interaction", interactionId: "q" },
				}),
			);
			const probe = d.latest("probe");
			expect(failed.alarmAt).toBeLessThan(
				d.view().active?.deadline.at ?? Infinity,
			);
			const retried = fire(d);
			expect(retried.effects.map(({ effect }) => effect)).toEqual([
				probe.effect,
			]);
			expect(d.latest("probe").token).not.toBe(probe.token);
			const stopping = step(d, { verb: "control", control: { kind: "stop" } });
			expect(
				stopping.effects.some(({ effect }) => effect.kind === "interrupt"),
			).toBe(true);
		},
	},
	{
		id: "RL-075",
		title:
			"[step1] a throttled answer is retained and retried with a fresh send token",
		provider: "opencode",
		run(d) {
			const a = running(d);
			const answer = ask(d, a);
			const retryAt = d.now + 50;
			observe(d, answer, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt },
			});
			expect(d.view().active?.interactions).toContainEqual(
				expect.objectContaining({ tag: "Answered", interactionId: "q" }),
			);

			fire(d);
			const retried = d.latest("deliver_answer");
			expect(retried.token).not.toBe(answer.token);
			expect(retried.effect).toEqual(answer.effect);
		},
	},
	{
		id: "RL-079",
		title: "[9B] an idle Stop issues no control that could target future work",
		provider: "claude",
		run(d) {
			const empty = step(d, { verb: "control", control: { kind: "stop" } });
			expect(empty.effects).toEqual([]);
			expect(empty.ended).toEqual([]);
			admit(d, "A", true);
			expect(d.view().active?.tag).toBe("Starting");
			expect(
				d.issued.filter(
					({ effect }) =>
						effect.kind === "interrupt" || effect.kind === "close",
				),
			).toEqual([]);
		},
	},
	{
		id: "RL-080",
		title: "[2C] natural completion makes queued forced retirement obsolete",
		provider: "cursor",
		run(d) {
			const a = running(d);
			stop(d);

			const completed = complete(d, a);
			expect(completed.ended).toHaveLength(1);
			admit(d, "B", true);
			const stale = fire(d, d.now);
			expect(stale.effects).toEqual([]);
			expect(stale.ended).toEqual([]);
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "RL-082",
		title: "[2C] an empty Stop cannot own intake admitted afterwards",
		provider: "cursor",
		run(d) {
			const empty = step(d, { verb: "control", control: { kind: "stop" } });
			expect(empty.effects).toEqual([]);
			admit(d, "A", true);
			const a = d.latest("start");
			observe(d, a, { kind: "effect_outcome", outcome: { tag: "succeeded" } });
			expect(visibleInput(d, "A")?.state.tag).toBe("Delivered");
			expect(d.view().active).toMatchObject({
				tag: "Starting",
				deadline: { kind: "start" },
			});
			expect(
				d.issued.some(
					({ effect }) =>
						effect.kind === "close" || effect.kind === "interrupt",
				),
			).toBe(false);
		},
	},
	{
		id: "RL-083",
		title: "[2C] natural completion retires an unacknowledged runner interrupt",
		provider: "claude",
		run(d) {
			const a = running(d);
			const interrupt = stop(d);
			complete(d, a);
			expect(d.view().live.some(({ token }) => token === interrupt.token)).toBe(
				false,
			);
			admit(d, "B", true);
			const b = d.latest("start");
			observe(d, b, { kind: "started" });
			const answer = ask(d, b, "later-question");
			expect(answer.effect).toMatchObject({
				kind: "deliver_answer",
				interactionId: "later-question",
			});
		},
	},
	{
		id: "RL-089",
		title: "[2C] an owned runner terminal releases the selected Run now input",
		provider: "claude",
		run(d) {
			const a = running(d);
			stop(d);
			admit(d, "B", true);
			const completed = complete(d, a);
			expect(completed.ended).toHaveLength(1);
			expect(transmissions(d, "B")).toHaveLength(1);
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "RL-090",
		title:
			"[2C] an obsolete recovered Stop never sends again after its Run ends",
		provider: "cursor",
		run(d) {
			const a = running(d);
			const interrupt = stop(d);
			complete(d, a);
			admit(d, "B", true);
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					token: interrupt.token,
					kind: "effect_outcome",
					outcome: { tag: "retryable", retryAt: d.now + 1 },
				},
			});
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "R10-1",
		title: "[step1] ROUND10-1 retained close cannot release current cleanup",
		provider: "claude",
		run(d) {
			running(d, "predecessor");
			stop(d);
			fire(d);
			const firstClose = d.latest("close");
			observe(d, firstClose, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			admit(d, "A", true);
			const firstStart = d.latest("start");
			observe(d, firstStart, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			fire(d, d.alarmAt);
			const retry = d.latest("start");
			expect(retry.token).not.toBe(firstStart.token);
			observe(d, retry, { kind: "started" });
			stop(d);
			fire(d);
			const currentClose = d.latest("close");
			expect(currentClose.token).not.toBe(firstClose.token);
			admit(d, "B", true);
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					token: firstClose.token,
					kind: "effect_outcome",
					outcome: { tag: "succeeded" },
				},
			});
			expect(transmissions(d, "B")).toHaveLength(0);
			observe(d, currentClose, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "R10-2",
		title:
			"[9B] a retired input receipt cannot start Run now work on an inactive project",
		provider: "claude",
		run(d) {
			const a = running(d);
			admit(d, "B", true);
			step(d, { verb: "settle", settlement: { kind: "project_inactive" } });
			const receipt = observe(d, a, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			expect(receipt.effects).toEqual([]);
			expect(receipt.ended).toEqual([]);
			expect(transmissions(d, "B")).toHaveLength(0);
			expect(d.view().live).toEqual([]);
		},
	},
	{
		id: "R10-3",
		title:
			"[5C] late first-answer confirmation cannot overwrite an actual error result",
		provider: "claude",
		run(d) {
			const a = running(d);
			const firstAnswer = ask(d, a);
			observe(d, firstAnswer, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			const retryTimer = d.alarmAt;
			const result = observe(d, a, {
				kind: "result",
				outcome: "error",
				error: { code: "ActualFailure", retryable: false },
			});
			fire(d, retryTimer);
			expect(d.latest("deliver_answer").token).not.toBe(firstAnswer.token);
			observe(d, firstAnswer, {
				kind: "interaction_resolved",
				interactionId: "q",
			});
			const closed = observe(d, a, { kind: "query_ended" });
			expect(closed.ended).toEqual([]);
			expect(result.ended).toMatchObject([
				{
					outcome: "error",
					reason: {
						kind: "provider_error",
						code: "ActualFailure",
						retryable: false,
					},
				},
			]);
		},
	},
	{
		id: "R10-4",
		title:
			"[9B] project removal removes an uncertain answer's probe retry deadline",
		provider: "opencode",
		run(d) {
			const a = running(d);
			const answer = ask(d, a);
			observe(d, answer, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const retryTimer = d.alarmAt;
			expect(retryTimer).toBeGreaterThan(d.now);
			expect(retryTimer).toBeLessThan(d.view().active?.deadline.at ?? Infinity);
			step(d, { verb: "settle", settlement: { kind: "project_inactive" } });
			expect(d.alarmAt).toBeUndefined();
			const fired = fire(d, retryTimer);
			expect(fired.effects).toEqual([]);
			expect(fired.ended).toEqual([]);
			expect(d.view().live).toEqual([]);
		},
	},
	{
		id: "R10-5",
		title:
			"[step1] a late receipt leaves the original result settlement deadline unchanged",
		provider: "claude",
		run(d) {
			const a = running(d);
			observe(d, a, { kind: "result", outcome: "completed" });
			const deadline = d.alarmAt;
			expect(deadline).toBe(d.now + 3_000);
			const settlementTimer = d.alarmAt;
			const receipt = observe(
				d,
				a,
				{ kind: "input_accepted", nativeMessageId: "native-A" },
				d.now + 50,
			);
			expect(receipt.effects).toEqual([]);
			expect(d.alarmAt).toBe(deadline);
			const settled = fire(d, settlementTimer);
			expect(settled.ended).toEqual([]);
			expect(settled.effects.map(({ effect }) => effect.kind)).toContain(
				"close",
			);
		},
	},
];

export const sourceOnlyCases = [
	{
		id: "RL-049",
		title:
			"[step1] compatibility can be removed without rewriting surviving logic",
		reason:
			"Deletion-only source removability is not observable through LedgerCommand, LedgerView, terminals or effects; it requires source review, prohibited in this independent lane.",
	},
	{
		id: "RL-050",
		title:
			"[step1] compatibility names and interface documentation remain accurate",
		reason:
			"Comments, imports and naming have no public command-level outcome; source review is required and prohibited in this independent lane.",
	},
	{
		id: "RL-107",
		title:
			"[step1] the configuration-read guard detects computed and injected reads",
		reason:
			"A source configuration guard is outside the four-function ledger interface; no public command exposes filesystem-read enforcement.",
	},
] as const;
