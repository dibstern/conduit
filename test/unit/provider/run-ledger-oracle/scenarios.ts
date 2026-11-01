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
import type { Send } from "./fake-provider.js";
import {
	Coverage,
	type CoverageReader,
	driver,
	type PublicDriver,
	policy,
} from "./harness.js";
import type { Mutation } from "./reference.js";
import * as reference from "./reference.js";

/** A decision with the work it put in `live` or `effects` (3.13). */
export type Stepped = Decision<unknown> & {
	readonly issued: readonly IssuedEffect[];
};

/** Drives one session through public commands and reads only public outputs. */
export class Driver implements CoverageReader {
	now = 100;
	label = "r1:1";
	readonly issued: IssuedEffect[] = [];
	readonly ended: RunEnded[] = [];
	/** Races this scenario reached, for the fixed catalogue race gate. */
	readonly coverage = new Coverage();
	private serial = 0;
	private readonly ledger: PublicDriver;
	/** 3.4: a runner-held send's run.dispatched token and a direct send's runId name its Main issue. */
	private readonly commandIds = new Map<SendToken, string>();

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

	/** A Tokened issue by its token; a Main one by its run.dispatched token, direct runId or claim (3.4). */
	answered(
		token: SendToken,
	): { readonly send: Send; readonly label: string } | undefined {
		const commandId =
			this.commandIds.get(token) ?? token.slice(0, token.lastIndexOf(":"));
		const entry = [...this.issued]
			.reverse()
			.find((item) =>
				item.tag === "Tokened"
					? item.token === token
					: item.commandId === commandId,
			);
		return (
			entry && { send: { token, effect: entry.effect }, label: this.label }
		);
	}

	step(command: LedgerCommand, now = this.now + 1): Stepped {
		this.now = now;
		const before = this.view();
		const decision = this.ledger.step(command, now);
		if (decision.tag === "Rejected") {
			this.coverage.record(
				command,
				before,
				before,
				{ ...decision, effects: [], ended: [] },
				this,
			);
			return { ...decision, issued: [] };
		}
		const observation =
			command.verb === "observe" ? command.observation : undefined;
		if (observation?.tag === "Answer" && observation.kind === "run_dispatched")
			this.commandIds.set(observation.token, observation.commandId);
		if (
			observation?.tag === "Main" &&
			observation.kind === "run_requested" &&
			observation.direct
		)
			this.commandIds.set(observation.runId as SendToken, observation.inputId);
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
		this.coverage.record(
			command,
			before,
			this.view(),
			{ ...decision, effects: issued },
			this,
		);
		// Oracle edit (32.2.12): coverage reads the label before this step, as TraceDriver's host
		// does, so a fixed process_started can hit "a label change mid-interrupt".
		if (
			command.verb === "settle" &&
			command.settlement.kind === "process_started"
		)
			this.label = command.settlement.label;
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
			// 3.5 (CONTRACT.md 562-564, 599-604): the probe's input_present settles the unknown delivery as
			// Observed, with no resend.
			const probe = recovered.issued.find(
				({ effect }) => effect.kind === "probe",
			);
			assert(probe, "the recovery probe is issued");
			observe(d, tokenOf(probe), {
				kind: "probe_result",
				finding: { tag: "input_present", nativeMessageId: "native-A" },
			});
			expect(visibleInput(d, "A")?.state).not.toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
			expect(transmissions(d, "A")).toHaveLength(1);
		},
	},
	{
		id: "R5",
		title:
			"[R5] a refused start transmission keeps the native fence while an accepted sibling acts",
		provider: "claude",
		run(d) {
			const a = begin(d);
			const [first] = transmissions(d, "A");
			assert(first?.tag === "Main", "a runner-held start is Main");
			// 3.6 (CONTRACT.md 692-697): a possibly reached start with an absent finding is tried again
			// as a new transmission of the same Run, never unlaunched.
			observe(d, a.token, { kind: "delivery_indeterminate" });
			observe(d, a.token, { kind: "journal_answer", answer: "absent" });
			const retry = "hold-A-retry" as SendToken;
			observe(d, retry, {
				kind: "run_dispatched",
				runId: a.runId,
				runnerId: "r1",
				commandId: first.commandId,
				transmission: 2,
			});
			// 3.5 (CONTRACT.md 597-600), section 9 (3129-3131): a later acceptance beats the absent finding.
			observe(d, a.token, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			// 3.5 (CONTRACT.md 594-595, 605-606): the sibling's refusal neither fails the input nor
			// releases the fence while the accepted transmission may still act.
			const refused = observe(d, retry, {
				kind: "run_released",
				reason: { tag: "Refused", why: "interrupted" },
			});
			expect(refused.ended).toEqual([]);
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-A",
			});
			expect(d.view()).toMatchObject({
				anythingMayAct: true,
				active: { runId: a.runId, tag: "Starting" },
			});
		},
	},
	{
		id: "R3",
		title:
			"[R3] acceptance of one transmission retains only that transmission, not a failed sibling",
		provider: "opencode",
		run(d) {
			running(d);
			const b1 = begin(d, "B", "steer");
			observe(d, b1.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			// 3.6 (CONTRACT.md 692-698): main tries B again, a new transmission under its own runId (3.4).
			const b2 = request(d, "B");
			expect(b2.token).not.toBe(b1.token);
			observe(d, b1.token, {
				kind: "input_accepted",
				nativeMessageId: "native-B",
			});
			// 3.5 (CONTRACT.md 601-602): b2's retryable outcome with consumption None ends b2's work;
			// b1's acceptance keeps only b1's, and the input stays Accepted (594-595).
			observe(d, b2.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-B",
			});
			expect(transmissions(d, "B")).toHaveLength(1);
			const stopped = stop(d, d.now + 1_000);
			expect(d.view().live).toContainEqual(
				expect.objectContaining({
					effect: expect.objectContaining({ kind: "steer", inputId: "B" }),
				}),
			);
			const probe = stopped.issued.find(
				({ effect }) => effect.kind === "probe",
			);
			assert(probe, "an OpenCode Stop probes the native session (5.1)");
			// 9 (CONTRACT.md 3101-3102): the idle covers the confirmed sends, A's and b1; nothing of B is
			// retained past it.
			observe(d, tokenOf(probe), {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(d.view().live).toEqual([]);
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
			// D61: the confirmation is unsolicited, by its interaction.
			unsolicited(d, { kind: "interaction_resolved", interactionId: "q" });
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
		// Cursor starts no unsolicited turn (8.3, CONTRACT.md 2808), so the wake is Codex's.
		provider: "codex",
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
		id: "PL-1",
		title:
			"[L1] a retired runner is final: its later process_started changes nothing and the next runner is current",
		provider: "claude",
		run(d) {
			const lose = (runnerId: string) =>
				step(d, {
					verb: "settle",
					settlement: { kind: "process_lost", runnerId, retiredAt: d.now },
				});
			const end = () =>
				step(d, {
					verb: "control",
					control: {
						kind: "end",
						commandId: `end-${d.next()}`,
						deadlineAt: null,
					},
				});
			lose("r1");
			// L1 (CONTRACT.md 349-353): retired is final, so its later process_started is an older label.
			noLifecycleChange(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r1:2",
					reattached: true,
				},
			});
			// L2 case 3 (CONTRACT.md 372-375): with no current process the end_session is pending.
			end();
			expect(d.latest("end_session").effect).toMatchObject({
				runId: null,
				label: null,
			});
			step(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r2:1",
					reattached: false,
				},
			});
			step(d, {
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "r2:1",
					eventId: `u-${d.next()}`,
					kind: "tasks_snapshot",
					tasks: [],
				},
			});
			end();
			expect(d.latest("end_session").effect).toMatchObject({
				runId: null,
				label: "r2:1",
			});
		},
	},
	{
		id: "PL-2",
		title: "[8.3/D41] a killed runner's label wakes no Run",
		provider: "claude",
		run(d) {
			step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
			});
			// D41 (CONTRACT.md 3851), 8.3 (2817-2833): a retired runner's labels are older, so a
			// turn_started on one starts no wake execution and opens no wake Run.
			wake(d, "r1:1");
			expect(d.view().active).toBeUndefined();
			expect(d.view().anythingMayAct).toBe(false);
			// L1 (353-355): nor does a label of a runner not started.
			wake(d, "r2:1");
			expect(d.view().active).toBeUndefined();
		},
	},
	{
		id: "PL-3",
		title:
			"[L5] a retirement records may-have-been-lost for an unsnapshotted label and nothing for a Known-empty one",
		provider: "claude",
		run(d) {
			const lose = (driver: Driver, runnerId: string) =>
				step(driver, {
					verb: "settle",
					settlement: { kind: "process_lost", runnerId, retiredAt: driver.now },
				});
			// L5 (CONTRACT.md 2902-2907): a fresh launch is Known with none live, so it records nothing.
			lose(d, "r1");
			expect(d.view().lostWork).toEqual([]);

			// A reattach leaves its label's tasks unknown (8.3), so retiring it may have lost them.
			const reattached = new Driver(d.provider);
			step(reattached, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r1:2",
					reattached: true,
				},
			});
			lose(reattached, "r1");
			expect(reattached.view().lostWork).toEqual([
				{ label: "r1:2", tag: "unknown" },
			]);

			// Every Cursor and OpenCode label is Known with none live (8.3).
			for (const provider of ["cursor", "opencode"] as const) {
				const other = new Driver(provider);
				lose(other, "r1");
				expect(other.view().lostWork).toEqual([]);
			}
		},
	},
	{
		id: "PL-4",
		title:
			"[D50] a stop commit's release read before its process_lost unlaunches the Run, and the relaunch addresses the next runner",
		provider: "claude",
		run(d) {
			const a = begin(d);
			const [first] = transmissions(d, "A");
			assert(first?.tag === "Main", "a runner-held start is Main");
			// L1 (CONTRACT.md 361-364), D50 (660-672): the commit's release precedes its process_lost.
			observe(d, a.token, {
				kind: "run_released",
				reason: { tag: "Refused", why: "retiring" },
			});
			const lost = step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
			});
			expect(lost.ended).toEqual([]);
			expect(d.view().active).toMatchObject({ tag: "Queued", runId: a.runId });
			step(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r2:1",
					reattached: false,
				},
			});
			// 3.4: main relaunches under the same commandId, a new transmission of the same Run.
			const relaunch = "hold-A-relaunch" as SendToken;
			observe(d, relaunch, {
				kind: "run_dispatched",
				runId: a.runId,
				runnerId: "r2",
				commandId: first.commandId,
				transmission: 2,
			});
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Dispatching" });
			observe(d, relaunch, { kind: "started" });
			// L2: the relaunch is r2's, so r2's retirement covers it and ends the reached Run.
			const relost = step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r2", retiredAt: d.now },
			});
			expect(relost.ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "process_lost" } },
			]);
		},
	},
	{
		id: "PL-5",
		title:
			"[L2 case 3] an OpenCode start with no current process is pending and resolves to the next process_started",
		provider: "opencode",
		run(d) {
			step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
			});
			const a = begin(d);
			observe(d, a.token, { kind: "started" });
			step(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r2:1",
					reattached: false,
				},
			});
			// L2 (CONTRACT.md 372-379): resolved once to r2, so r2's retirement covers it (L1 item 1).
			const lost = step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r2", retiredAt: d.now },
			});
			expect(lost.ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "process_lost" } },
			]);
		},
	},
	{
		id: "PL-6",
		title:
			"[D32] a Run-less end_session gated on live tasks goes to pending when the current process retires",
		provider: "claude",
		run(d) {
			unsolicited(d, {
				kind: "tasks_snapshot",
				tasks: [
					{
						key: { taskId: "t1" },
						taskType: "local_bash",
						description: "watch",
						ambient: false,
					},
				],
			});
			step(d, {
				verb: "control",
				control: { kind: "end", commandId: "end-1", deadlineAt: null },
			});
			expect(d.view().pendingConfirm).toMatchObject({ step: "end_session" });
			expect(
				d.issued.filter(({ effect }) => effect.kind === "end_session"),
			).toEqual([]);
			// 8.4 (CONTRACT.md 2873-2875), D32 (3842): the current process retiring releases the gate,
			// and the step, addressed when it issues, goes to pending.
			step(d, {
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "r1", retiredAt: d.now },
			});
			expect(d.view().pendingConfirm).toBeUndefined();
			expect(d.latest("end_session")).toMatchObject({
				tag: "Main",
				commandId: "end-1",
				effect: { runId: null, label: null },
			});
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
	{
		id: "D56-202",
		title:
			"[2.1 row 202] an input admitted during a Claude wake waits for the wake to end",
		provider: "claude",
		run(d) {
			// The wake's frames ride the query A's start opened.
			const a = running(d);
			observe(d, a.token, { kind: "result", outcome: "completed" });
			wake(d);
			admit(d, "B");
			// 3.5: the wake's label has work, so the ledger starts nothing.
			expect(transmissions(d, "B")).toEqual([]);
			const b = request(d, "B");
			unsolicited(d, { kind: "turn_ended" });
			observe(d, b.token, { kind: "started" });
			observe(d, b.token, { kind: "result", outcome: "completed" });
		},
	},
	{
		id: "D56-213",
		title:
			"[2.1 row 213] a Claude Stop its turn never answers reaches main's 30s deadline step with a task live",
		provider: "claude",
		run(d) {
			const a = running(d);
			unsolicited(d, {
				kind: "tasks_snapshot",
				tasks: [
					{
						key: { taskId: "t1" },
						taskType: "local_bash",
						description: "watch",
						ambient: false,
					},
				],
			});
			stop(d);
			// A Claude Stop opens no ledger alarm (L6); the turn ends 40s on, past main's 30s wait.
			observe(d, a.token, { kind: "result", outcome: "interrupted" }, 40_000);
		},
	},
	{
		id: "D56-211",
		title: "[2.1 row 211] Claude cancels a start's intake before it starts",
		provider: "claude",
		run(d) {
			admit(d, "A");
			request(d, "A");
			unsolicited(d, {
				kind: "command_lifecycle",
				state: "cancelled",
				commandId: "A",
			});
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
