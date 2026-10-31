import { assert, expect } from "vitest";
import * as decider from "../../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	Decision,
	Evidence,
	InputView,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	MainRunEvent,
	MainTransmission,
	ProviderKind,
	RunEffect,
	RunEnded,
	RunOutcome,
	SendToken,
	Unsolicited,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { driver, type PublicDriver, policy } from "./harness.js";
import type { Mutation } from "./reference.js";
import * as reference from "./reference.js";

/** A decision with the work it put in `live` or `effects` (3.13). */
export type Stepped = Decision<unknown> & {
	readonly issued: readonly IssuedEffect[];
};

/** Drives one session through public commands and reads only public outputs. */
export class Driver {
	now = 100;
	readonly issued: IssuedEffect[] = [];
	readonly ended: RunEnded[] = [];
	private serial = 0;
	private readonly ledger: PublicDriver;

	constructor(
		readonly provider: ProviderKind,
		mode: "reference" | "decider" = "reference",
		mutation?: Mutation,
	) {
		this.ledger =
			mode === "reference"
				? driver(
						{
							...reference,
							initialSessionLedgerState: (
								sessionId: string,
								kind: ProviderKind,
							) =>
								reference.initialSessionLedgerState(sessionId, kind, mutation),
						},
						provider,
						mode,
					)
				: driver(decider, provider, mode);
		// Every session starts on runner r1's first query; labels read `runnerId:querySeq` (3.3).
		step(this, {
			verb: "settle",
			settlement: { kind: "process_started", label: "r1:1", reattached: false },
		});
	}

	get alarmAt(): number | undefined {
		return this.ledger.alarmAt;
	}

	next(): number {
		this.serial += 1;
		return this.serial;
	}

	view(): LedgerView {
		return this.ledger.view();
	}

	step(command: LedgerCommand, now = this.now + 1): Stepped {
		this.now = now;
		const decision = this.ledger.step(command, now);
		if (decision.tag === "Rejected") return { ...decision, issued: [] };
		this.ended.push(...decision.ended);
		// LI1, LI6 (D60): decide issues only probe, stop_task and cancel_request; a start or steer reaches `live`
		// from its Main observation or run.dispatched Answer (D60), so issued work reads both.
		const known = new Set(this.issued.map((entry) => JSON.stringify(entry)));
		const issued = [...decision.effects, ...this.view().live].filter(
			(entry) => {
				const key = JSON.stringify(entry);
				if (known.has(key)) return false;
				known.add(key);
				return true;
			},
		);
		this.issued.push(...issued);
		return { ...decision, issued };
	}

	latest(kind: RunEffect["kind"]): IssuedEffect {
		const found = [...this.issued]
			.reverse()
			.find(({ effect }) => effect.kind === kind);
		assert(found, `no ${kind} issued`);
		return found;
	}
}

/** A catalogue scenario runs on Driver; a review trace runs on the fake's TraceDriver. */
export interface OracleScenario<D = Driver> {
	readonly id: string;
	readonly title: string;
	readonly provider: ProviderKind;
	readonly run: (d: D) => void;
}

export function step(d: Driver, command: LedgerCommand, now?: number) {
	const decision = d.step(command, now);
	if (decision.tag === "Rejected") assert.fail(decision.diagnostic);
	return decision;
}

/**
 * A send's token: decide's for a Tokened issue; for a Main control's claim n, the host composes it
 * from (commandId, n) (3.4). A runner-held start or steer answers under its run.dispatched token.
 */
export function tokenOf(entry: IssuedEffect, n = 1): SendToken {
	assert(
		entry.tag === "Tokened" ||
			(entry.effect.kind !== "start" && entry.effect.kind !== "steer"),
		"a Main start or steer answers under its run.requested or run.dispatched token",
	);
	return entry.tag === "Tokened"
		? entry.token
		: (`${entry.commandId}:${n}` as SendToken);
}

/** 3.4: a Main control's effect_outcome names its claim n by main's (commandId, transmission). */
export function claimOf(entry: IssuedEffect, n = 1): MainTransmission {
	assert(entry.tag === "Main", "only a Main issue has transmissions");
	return { commandId: entry.commandId, transmission: n };
}

export const observe = (
	d: Driver,
	token: SendToken,
	evidence: Evidence,
	now?: number,
) =>
	step(
		d,
		{ verb: "observe", observation: { tag: "Answer", token, ...evidence } },
		now,
	);

export const unsolicited = (d: Driver, evidence: Unsolicited, label = "r1:1") =>
	step(d, {
		verb: "observe",
		observation: {
			tag: "Unsolicited",
			label,
			eventId: `u-${d.next()}`,
			...evidence,
		},
	});

export const main = (
	d: Driver,
	event: MainRunEvent,
	eventId = `main-${d.next()}`,
) =>
	step(d, { verb: "observe", observation: { tag: "Main", eventId, ...event } });

export const admit = (
	d: Driver,
	inputId: string,
	delivery: "queue" | "steer" = "queue",
) => step(d, { verb: "admit", inputId, delivery, request: { text: inputId } });

/**
 * Main's run.requested for an admitted input (D60): a direct send's is its transmission, its token
 * the runId; a runner-held send's run.dispatched is its first transmission (3.4, 4.11).
 */
export function request(d: Driver, inputId: string, runnerId = "r1") {
	const serial = d.next();
	const runId = `main-${inputId}-${serial}`;
	const direct = d.provider === "opencode";
	main(
		d,
		{ kind: "run_requested", runId, inputId, direct },
		`requested-${runId}`,
	);
	if (direct) return { runId, token: runId as SendToken };
	const token = `hold-${inputId}-${serial}` as SendToken;
	// 3.4: run.dispatched names its Run by main's runId and its issue by commandId.
	observe(d, token, {
		kind: "run_dispatched",
		runId,
		runnerId,
		commandId: `cmd-${inputId}-${serial}`,
		transmission: 1,
	});
	return { runId, token };
}

export function begin(
	d: Driver,
	inputId = "A",
	delivery: "queue" | "steer" = "queue",
) {
	admit(d, inputId, delivery);
	return request(d, inputId);
}

export function running(d: Driver, inputId = "A") {
	const send = begin(d, inputId);
	observe(d, send.token, { kind: "started" });
	observe(d, send.token, {
		kind: "input_accepted",
		nativeMessageId: `native-${inputId}`,
	});
	expect(d.view().active).toMatchObject({ tag: "Running" });
	return send;
}

export function fire(d: Driver, at = d.alarmAt) {
	assert(at !== undefined, "no alarm is open");
	return step(d, { verb: "settle", settlement: { kind: "alarm_fired" } }, at);
}

export const stop = (d: Driver, deadlineAt: number | null = null) =>
	step(d, {
		verb: "control",
		control: { kind: "stop", commandId: `stop-${d.next()}`, deadlineAt },
	});

export const terminal = (
	d: Driver,
	runId: string,
	outcome: RunOutcome = "completed",
) => main(d, { kind: "run_terminal", runId, outcome });

export function ask(d: Driver, token: SendToken, interactionId = "q") {
	observe(d, token, {
		kind: "interaction_requested",
		interactionId,
		interactionKind: "question",
	});
	step(d, {
		verb: "control",
		control: {
			kind: "answer",
			commandId: `answer-${d.next()}`,
			interactionId,
			answer: "yes",
		},
	});
	return d.latest("deliver_answer");
}

export function complete(d: Driver, token: SendToken) {
	const result = observe(d, token, { kind: "result", outcome: "completed" });
	const closed = observe(d, token, { kind: "query_ended" });
	return [...result.ended, ...closed.ended];
}

export function noLifecycleChange(d: Driver, command: LedgerCommand) {
	const before = d.view();
	const decision = step(d, command);
	expect(decision.issued).toEqual([]);
	expect(decision.ended).toEqual([]);
	expect(d.view()).toEqual(before);
}

export const visibleInput = (
	d: Driver,
	inputId: string,
): InputView | undefined =>
	d.view().active?.inputs.find((input) => input.inputId === inputId);

export const transmissions = (d: Driver, inputId: string) =>
	d.issued.filter(
		({ effect }) =>
			(effect.kind === "start" || effect.kind === "steer") &&
			effect.inputId === inputId,
	);

export const wake = (d: Driver, label = "r1:1") =>
	unsolicited(d, { kind: "turn_started" }, label);

export const scenarios: readonly OracleScenario[] = [
	{
		id: "RL-003",
		title:
			"[step1] a spurious alarm after process loss leaves a newer Run before its deadline",
		provider: "claude",
		run(d) {
			const a = running(d);
			ask(d, a.token);
			const lost = step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
			});
			expect(lost.ended).toMatchObject([{ reason: { tag: "process_lost" } }]);
			step(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r2:1",
					reattached: false,
				},
			});
			admit(d, "B");
			request(d, "B", "r2");
			const before = d.view();
			const late = fire(d, d.now);
			expect(late.ended).toEqual([]);
			expect(late.issued).toEqual([]);
			expect(d.view()).toEqual(before);
		},
	},
	{
		id: "RL-010",
		title: "[2C] an owned idle boundary cannot accept a delivered steer",
		provider: "opencode",
		run(d) {
			running(d);
			const b = begin(d, "B", "steer");
			observe(d, b.token, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Delivered",
				certainty: "sent",
			});
			complete(d, b.token);
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
			const first = d.view().active?.runId;
			const ended = observe(d, a.token, {
				kind: "result",
				outcome: "error",
				error: { code: "Transient", retryable: true },
			});
			expect(ended.ended).toMatchObject([
				{
					outcome: "error",
					reason: { tag: "provider_error", code: "Transient", retryable: true },
				},
			]);
			begin(d, "B");
			expect(d.latest("start").effect).toMatchObject({
				kind: "start",
				inputId: "B",
			});
			expect(d.view().active?.runId).not.toBe(first);
			noLifecycleChange(d, {
				verb: "observe",
				observation: { tag: "Answer", token: a.token, kind: "activity" },
			});
			// 3.7: Starting has no deadline.
			expect(d.view().active).toMatchObject({ tag: "Starting" });
			expect(d.view().active).not.toHaveProperty("deadline");
		},
	},
	{
		id: "RL-014",
		title: "[2C] OpenCode tool progress is activity rather than a terminal",
		provider: "opencode",
		run(d) {
			const a = running(d);
			const progress = observe(d, a.token, { kind: "activity" }, d.now + 10);
			expect(progress.ended).toEqual([]);
			// 3.7: Running has no deadline.
			expect(d.view().active).toMatchObject({ tag: "Running" });
			expect(d.view().active).not.toHaveProperty("deadline");
			expect(d.alarmAt).toBeUndefined();
		},
	},
	{
		id: "RL-017",
		title: "[5C] a successful OpenCode tool-step cannot mask the final failure",
		provider: "opencode",
		run(d) {
			const a = running(d);
			observe(d, a.token, { kind: "activity" });
			observe(d, a.token, {
				kind: "result",
				outcome: "error",
				error: { code: "MessageAbortedError", retryable: false },
			});
			const failed = observe(d, a.token, { kind: "query_ended" });
			expect(failed.ended).toMatchObject([
				{
					outcome: "error",
					reason: { tag: "provider_error", code: "MessageAbortedError" },
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
			const a = begin(d);
			const failed = observe(d, a.token, {
				kind: "runner_reply",
				outcome: { tag: "failed", code: "IteratorFailed" },
			});
			expect(failed.ended).toMatchObject([
				{ reason: { code: "IteratorFailed" } },
			]);
			expect(d.view().active).toBeUndefined();
			expect(transmissions(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "RL-021",
		title:
			"[step1] unknown OpenCode intake keeps one transmission and probes at its recovery deadline",
		provider: "opencode",
		run(d) {
			const a = begin(d);
			const unknown = observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			// 3.7, D20: the first recovery probe waits probeMs from the outcome.
			expect(unknown.issued).toEqual([]);
			expect(d.alarmAt).toBe(d.now + policy.probeMs);
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
			const recovered = fire(d);
			expect(recovered.issued.map(({ effect }) => effect)).toContainEqual(
				expect.objectContaining({
					kind: "probe",
					target: { tag: "input", inputId: "A" },
				}),
			);
			expect(transmissions(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "RL-027",
		title: "[2C] a successful SDK handoff proves delivery, never acceptance",
		provider: "claude",
		run(d) {
			const a = running(d);
			const b = begin(d, "B", "steer");
			observe(d, b.token, {
				kind: "runner_reply",
				outcome: { tag: "succeeded" },
			});
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Delivered",
				certainty: "sent",
			});
			complete(d, a.token);
			expect(visibleInput(d, "B")?.state.tag).not.toBe("Accepted");
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "RL-028",
		title: "[step1] an alarm before the successor deadline cannot interrupt it",
		provider: "cursor",
		run(d) {
			const a = running(d);
			complete(d, a.token);
			begin(d, "B");
			const before = d.view();
			const delayed = fire(d, d.now);
			expect(delayed.issued).toEqual([]);
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
			const b = begin(d, "B", "steer");
			observe(d, b.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			admit(d, "C");
			// D58: a queued input waits in main's inbox until its run.requested.
			expect(visibleInput(d, "C")).toBeUndefined();
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
			expect(transmissions(d, "B")).toHaveLength(1);
		},
	},
	{
		id: "RL-031",
		title: "[6C] an unknown OpenCode send cannot accept the only pending input",
		provider: "opencode",
		run(d) {
			const a = begin(d);
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: "foreign-native-echo" as SendToken,
					kind: "input_accepted",
					nativeMessageId: "foreign",
				},
			});
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
		},
	},
	{
		id: "RL-034",
		title: "[2C] a pre-intake native Claude result ends its exact Starting Run",
		provider: "claude",
		run(d) {
			const a = begin(d);
			const result = observe(d, a.token, {
				kind: "result",
				outcome: "completed",
			});
			expect(result.ended).toMatchObject([
				{ outcome: "completed", reason: { tag: "completed" } },
			]);
			expect(d.view().active).toBeUndefined();
			// 3.7: no query-fence deadline remains after the result.
			expect(d.alarmAt).toBeUndefined();
			expect(observe(d, a.token, { kind: "query_ended" }).ended).toEqual([]);
		},
	},
	{
		id: "RL-036",
		title:
			"[7B] a vanished native session settles the session with its typed reason once",
		provider: "claude",
		run(d) {
			running(d);
			const vanished: LedgerCommand = {
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			};
			const first = step(d, vanished);
			expect(first.ended).toMatchObject([{ reason: { tag: "session_ended" } }]);
			expect(d.view().active).toBeUndefined();
			expect(d.view().live).toEqual([]);
			expect(step(d, vanished).ended).toEqual([]);
		},
	},
	{
		id: "RL-037",
		title:
			"[5C] a classified provider error preserves outcome and typed reason",
		provider: "cursor",
		run(d) {
			const a = running(d);
			const result = observe(d, a.token, {
				kind: "result",
				outcome: "error",
				error: { code: "OwnedFailure", retryable: false },
			});
			expect(result.ended).toMatchObject([
				{
					outcome: "error",
					reason: {
						tag: "provider_error",
						code: "OwnedFailure",
						retryable: false,
					},
				},
			]);
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: a.token,
					kind: "result",
					outcome: "completed",
				},
			});
		},
	},
	{
		id: "RL-038",
		title: "[2C] an old input limit result cannot settle the replacement Run",
		provider: "claude",
		run(d) {
			const a = running(d);
			complete(d, a.token);
			begin(d, "B");
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
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
		title: "[2C] a slow Stop acknowledgement cannot consume later work",
		provider: "cursor",
		run(d) {
			const a = running(d);
			stop(d);
			const interrupt = d.latest("interrupt");
			complete(d, a.token);
			begin(d, "B");
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: tokenOf(interrupt),
					kind: "effect_outcome",
					outcome: { tag: "succeeded" },
					transmission: claimOf(interrupt),
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
					tag: "Answer",
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
		id: "RL-045",
		title:
			"[step1] Run now joins the open ledger stop deadline and moves nothing",
		provider: "codex",
		run(d) {
			wake(d);
			stop(d, 5_000);
			expect(d.alarmAt).toBe(5_000);
			expect(d.view().active).toMatchObject({
				origin: "wake",
				deadline: { owner: "Stop", at: 5_000 },
			});
			step(d, {
				verb: "control",
				control: {
					kind: "run_now",
					commandId: "run-now-B",
					inputId: "B",
					deadlineAt: 9_000,
				},
			});
			// L6: a later commit joins the open deadline and moves nothing.
			expect(d.alarmAt).toBe(5_000);
			const forced = fire(d);
			expect(forced.ended).toMatchObject([
				{
					outcome: "interrupted",
					reason: { tag: "interrupted", forced: true },
				},
			]);
			begin(d, "B");
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
			const b = begin(d, "B", "steer");
			const delivered = observe(d, b.token, {
				kind: "runner_reply",
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
			"[step1] provider-handled indeterminate delivery probes instead of creating a second start",
		provider: "cursor",
		run(d) {
			const a = begin(d);
			const unknown = observe(d, a.token, { kind: "delivery_indeterminate" });
			expect(unknown.issued).toEqual([]);
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
			const recovered = fire(d);
			expect(recovered.issued.map(({ effect }) => effect.kind)).toEqual([
				"probe",
			]);
			expect(transmissions(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "RL-056",
		title: "[step1] a declined Cursor steer waits as Queued without pausing",
		provider: "cursor",
		run(d) {
			running(d);
			const b = begin(d, "B", "steer");
			const declined = observe(d, b.token, {
				kind: "input_declined",
				reason: "steer-declined",
			});
			expect(declined.ended).toEqual([]);
			expect(d.view()).toMatchObject({
				paused: false,
				active: { tag: "Running" },
			});
			expect(visibleInput(d, "B")?.state).toEqual({ tag: "Queued" });
		},
	},
	{
		id: "RL-072",
		title:
			"[10B] a permanent answer refusal ends the delivery and resolves the interaction",
		provider: "opencode",
		run(d) {
			const a = running(d);
			const answer = ask(d, a.token);
			const failed = observe(d, tokenOf(answer), {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "HTTP400" },
				transmission: claimOf(answer),
			});
			// 3.10 (amends 10B): no re-delivery and no probe; the interaction is resolved.
			expect(failed.issued).toEqual([]);
			expect(d.view().interactions).not.toContainEqual(
				expect.objectContaining({ tag: "Pending", interactionId: "q" }),
			);
			const stopping = stop(d);
			expect(stopping.issued.map(({ effect }) => effect.kind)).toContain(
				"interrupt",
			);
		},
	},
	{
		id: "RL-075",
		title: "[step1] a throttled answer stays Answered and its retry is main's",
		provider: "opencode",
		run(d) {
			const a = running(d);
			const answer = ask(d, a.token);
			observe(d, tokenOf(answer), {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 50 },
				transmission: claimOf(answer),
			});
			expect(d.view().interactions).toContainEqual(
				expect.objectContaining({ tag: "Answered", interactionId: "q" }),
			);
			// 3.7: a send's retry is not a ledger deadline.
			expect(d.alarmAt).toBeUndefined();
			expect(
				d.issued.filter(({ effect }) => effect.kind === "deliver_answer"),
			).toHaveLength(1);
		},
	},
	{
		id: "RL-079",
		title: "[9B] an idle Stop issues no control that could target future work",
		provider: "claude",
		run(d) {
			const empty = stop(d, 5_000);
			expect(empty.issued).toEqual([]);
			expect(empty.ended).toEqual([]);
			expect(d.alarmAt).toBeUndefined();
			begin(d);
			expect(d.view().active?.tag).toBe("Starting");
			expect(
				d.issued.filter(({ effect }) => effect.kind === "interrupt"),
			).toEqual([]);
		},
	},
	{
		id: "RL-080",
		title: "[2C] natural completion makes a queued forced end obsolete",
		provider: "cursor",
		run(d) {
			const a = running(d);
			stop(d, 5_000);
			expect(complete(d, a.token)).toHaveLength(1);
			begin(d, "B");
			const stale = fire(d, 5_000);
			expect(stale.issued).toEqual([]);
			expect(stale.ended).toEqual([]);
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "RL-082",
		title: "[2C] an empty Stop cannot own intake admitted afterwards",
		provider: "cursor",
		run(d) {
			expect(stop(d).issued).toEqual([]);
			const a = begin(d);
			observe(d, a.token, {
				kind: "runner_reply",
				outcome: { tag: "succeeded" },
			});
			expect(visibleInput(d, "A")?.state.tag).toBe("Delivered");
			expect(d.view().active).toMatchObject({ tag: "Starting" });
			expect(d.view().active).not.toHaveProperty("deadline");
			expect(d.issued.some(({ effect }) => effect.kind === "interrupt")).toBe(
				false,
			);
		},
	},
	{
		id: "RL-083",
		title: "[2C] natural completion retires an unacknowledged runner interrupt",
		provider: "claude",
		run(d) {
			const a = running(d);
			stop(d);
			const interrupt = d.latest("interrupt");
			complete(d, a.token);
			// D59: a runner provider's interrupt ends with the Runs it names.
			expect(d.view().live).not.toContainEqual(interrupt);
			const b = begin(d, "B");
			observe(d, b.token, { kind: "started" });
			expect(ask(d, b.token, "later-question").effect).toMatchObject({
				kind: "deliver_answer",
				interactionId: "later-question",
			});
		},
	},
	{
		id: "RL-089",
		title: "[2C] an owned runner terminal lets main request the Run now input",
		provider: "claude",
		run(d) {
			const a = running(d);
			step(d, {
				verb: "control",
				control: {
					kind: "run_now",
					commandId: "run-now-B",
					inputId: "B",
					deadlineAt: null,
				},
			});
			expect(transmissions(d, "B")).toHaveLength(0);
			expect(complete(d, a.token)).toHaveLength(1);
			// D60: main's run.requested for B, never the commit, issues its start.
			begin(d, "B");
			expect(transmissions(d, "B")).toHaveLength(1);
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "RL-090",
		title: "[2C] an obsolete Stop never sends again after its Run ends",
		provider: "cursor",
		run(d) {
			const a = running(d);
			stop(d);
			const interrupt = d.latest("interrupt");
			complete(d, a.token);
			begin(d, "B");
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: tokenOf(interrupt),
					kind: "effect_outcome",
					outcome: { tag: "retryable", retryAt: d.now + 1 },
					transmission: claimOf(interrupt),
				},
			});
			expect(d.view().active?.tag).toBe("Starting");
		},
	},
	{
		id: "R10-3",
		title:
			"[5C] late first-answer confirmation cannot overwrite an actual error result",
		provider: "claude",
		run(d) {
			const a = running(d);
			const answer = ask(d, a.token);
			observe(d, tokenOf(answer), {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
				transmission: claimOf(answer),
			});
			const result = observe(d, a.token, {
				kind: "result",
				outcome: "error",
				error: { code: "ActualFailure", retryable: false },
			});
			expect(result.ended).toMatchObject([
				{
					outcome: "error",
					reason: {
						tag: "provider_error",
						code: "ActualFailure",
						retryable: false,
					},
				},
			]);
			observe(d, tokenOf(answer), {
				kind: "interaction_resolved",
				interactionId: "q",
			});
			expect(observe(d, a.token, { kind: "query_ended" }).ended).toEqual([]);
			// 3.7: the answer's retry is main's; the ledger issued it once.
			expect(
				d.issued.filter(({ effect }) => effect.kind === "deliver_answer"),
			).toHaveLength(1);
		},
	},
	{
		id: "R10-5",
		title:
			"[step1] a late receipt leaves the original Settling deadline unchanged",
		provider: "opencode",
		run(d) {
			const a = running(d);
			observe(d, a.token, { kind: "result", outcome: "completed" });
			const deadline = d.now + policy.settleMs;
			expect(d.alarmAt).toBe(deadline);
			expect(d.view().active).toMatchObject({
				tag: "Settling",
				deadline: { owner: "Run", at: deadline },
			});
			const receipt = observe(
				d,
				a.token,
				{ kind: "input_accepted", nativeMessageId: "native-A" },
				d.now + 50,
			);
			expect(receipt.issued).toEqual([]);
			expect(d.alarmAt).toBe(deadline);
			const settled = fire(d);
			expect(settled.ended).toEqual([]);
			// 3.7: Settling's expiry probes native_session.
			expect(settled.issued.map(({ effect }) => effect)).toContainEqual(
				expect.objectContaining({
					kind: "probe",
					target: { tag: "native_session" },
				}),
			);
		},
	},
	{
		id: "L6-1",
		title: "[L6] the ledger stop deadline's alarm forces a codex wake",
		provider: "codex",
		run(d) {
			wake(d);
			const stopped = stop(d, 5_000);
			expect(stopped.issued.map(({ effect }) => effect.kind)).toEqual([
				"interrupt",
			]);
			expect(d.alarmAt).toBe(5_000);
			const forced = fire(d);
			expect(forced.ended).toMatchObject([
				{
					outcome: "interrupted",
					reason: { tag: "interrupted", forced: true },
				},
			]);
			expect(d.view().anythingMayAct).toBe(false);
			expect(d.alarmAt).toBeUndefined();
		},
	},
	{
		id: "L6-2",
		title: "[L6] a Claude Stop ends its wake at turn_ended, never forced",
		provider: "claude",
		run(d) {
			wake(d);
			stop(d, 5_000);
			// L6: never a Claude wake shows the stop's deadlineAt.
			expect(d.view().active).not.toHaveProperty("deadline");
			const ended = unsolicited(d, { kind: "turn_ended" });
			expect(ended.ended).toMatchObject([
				{
					outcome: "interrupted",
					reason: { tag: "interrupted", forced: false },
				},
			]);
			expect(d.alarmAt).toBeUndefined();
		},
	},
	{
		id: "L6-3",
		title:
			"[L6] process_lost before the alarm ends a wake unforced; the alarm first forces it",
		provider: "cursor",
		run(d) {
			wake(d);
			stop(d, 5_000);
			const lost = step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
			});
			expect(lost.ended).toMatchObject([{ reason: { tag: "process_lost" } }]);
			expect(d.alarmAt).toBeUndefined();

			const other = new Driver(d.provider);
			wake(other);
			stop(other, 5_000);
			expect(fire(other).ended).toMatchObject([
				{ reason: { tag: "interrupted", forced: true } },
			]);
			const late = step(other, {
				verb: "settle",
				settlement: {
					kind: "process_lost",
					runnerId: "r1",
					retiredAt: other.now,
				},
			});
			expect(late.ended).toEqual([]);
		},
	},
	{
		id: "D60-1",
		title:
			"[D60] run.dispatched is a runner-held send's transmission and a repeat folds nothing",
		provider: "claude",
		run(d) {
			admit(d, "A");
			main(
				d,
				{ kind: "run_requested", runId: "main-A", inputId: "A", direct: false },
				"requested-A",
			);
			// 3.4: a runner-held send's run.requested names its Run; nothing is live until its hold.
			expect(d.view().live).toEqual([]);
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Queued" });
			const dispatched: LedgerCommand = {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: "hold-A" as SendToken,
					kind: "run_dispatched",
					runId: "main-A",
					runnerId: "r1",
					commandId: "cmd-A",
					transmission: 1,
				},
			};
			step(d, dispatched);
			expect(d.view().live).toMatchObject([
				{
					tag: "Main",
					commandId: "cmd-A",
					effect: { kind: "start", inputId: "A" },
				},
			]);
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Dispatching" });
			expect(step(d, dispatched).events).toEqual([]);
		},
	},
	{
		id: "D60-2",
		title:
			"[D60] a direct run.requested is the transmission under the runId; a repeat folds nothing",
		provider: "opencode",
		run(d) {
			admit(d, "A");
			const requested: MainRunEvent = {
				kind: "run_requested",
				runId: "main-A",
				inputId: "A",
				direct: true,
			};
			main(d, requested, "requested-A");
			expect(d.view().live).toMatchObject([
				{
					// 3.13: a direct start is Main under its input's id; its token is the runId (3.4).
					tag: "Main",
					commandId: "A",
					effect: { kind: "start", inputId: "A" },
				},
			]);
			const repeat = main(d, requested, "requested-A");
			expect(repeat.events).toEqual([]);
			expect(repeat.effects).toEqual([]);
			expect(transmissions(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "11A-1",
		title: "[11A] OpenCode activity after a result ends Settling",
		provider: "opencode",
		run(d) {
			const a = running(d);
			observe(d, a.token, { kind: "result", outcome: "completed" });
			expect(d.view().active?.tag).toBe("Settling");
			observe(d, a.token, { kind: "activity" });
			// 3.7: finishing an obligation removes its deadline; nothing extends it.
			expect(d.view().active?.tag).not.toBe("Settling");
			expect(d.alarmAt).toBeUndefined();
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
