import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	ProviderKind,
	RunEffect,
	RunEnded,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	FakeProvider,
	type TraceAction,
	traceAction,
} from "./fake-provider.js";
import { TraceDriver } from "./harness.js";
import { oracleTest } from "./pending.js";

type Step = ReturnType<TraceDriver["step"]>;
const providers = ["claude", "cursor", "opencode"] as const;

/** The two implementations mint their own identities. Only public issue order aligns them. */
class PublicNames {
	private readonly runs = new Map<string, number>();
	private readonly tokens = new Map<SendToken, number>();

	register(issued: readonly IssuedEffect[]): void {
		for (const send of issued) {
			if (!this.tokens.has(send.token))
				this.tokens.set(send.token, this.tokens.size);
		}
	}

	private run(id: string): number {
		const existing = this.runs.get(id);
		if (existing !== undefined) return existing;
		const ordinal = this.runs.size;
		this.runs.set(id, ordinal);
		return ordinal;
	}

	issued(send: IssuedEffect): unknown {
		const effect = send.effect;
		return {
			token: this.tokens.get(send.token),
			effect:
				"runId" in effect
					? { ...effect, runId: this.run(effect.runId) }
					: effect,
		};
	}

	ended(terminal: RunEnded): unknown {
		return { ...terminal, runId: this.run(terminal.runId) };
	}

	view(view: LedgerView): unknown {
		return {
			...view,
			...(view.active
				? { active: { ...view.active, runId: this.run(view.active.runId) } }
				: {}),
			live: view.live.map((send) => this.issued(send)),
		};
	}
}

function translatedCommand(
	command: LedgerCommand,
	reference: TraceDriver,
	decider: TraceDriver,
): LedgerCommand {
	const translate = (token: SendToken): SendToken => {
		const ordinal = reference.issued.findIndex((send) => send.token === token);
		return ordinal < 0 ? token : (decider.issued[ordinal]?.token ?? token);
	};
	if (command.verb === "observe") {
		return {
			...command,
			observation: {
				...command.observation,
				token: translate(command.observation.token),
			},
		};
	}
	if (command.verb === "settle" && "token" in command.settlement) {
		return {
			...command,
			settlement: {
				...command.settlement,
				token: translate(command.settlement.token),
			},
		};
	}
	return command;
}

function staleLifecycle(
	command: LedgerCommand,
	before: LedgerView,
	known: readonly IssuedEffect[],
	ended: ReadonlySet<string>,
): boolean {
	const token =
		command.verb === "observe"
			? command.observation.token
			: command.verb === "settle" && "token" in command.settlement
				? command.settlement.token
				: undefined;
	if (token === undefined) return false;
	const send = known.find((issued) => issued.token === token);
	if (!send) return true;
	const endedQuery =
		"runId" in send.effect &&
		ended.has(send.effect.runId) &&
		(send.effect.kind === "start" || send.effect.kind === "steer");
	if (before.live.some((item) => item.token === token) && !endedQuery)
		return false;
	if (
		endedQuery &&
		command.verb === "observe" &&
		command.observation.kind === "query_ended"
	)
		return false;
	if (command.verb === "settle") {
		return send.effect.kind === "start" || send.effect.kind === "steer";
	}
	if (command.verb !== "observe") return false;
	const evidence = command.observation;
	return (
		evidence.kind === "effect_outcome" ||
		((send.effect.kind === "start" || send.effect.kind === "steer") &&
			(evidence.kind === "started" ||
				evidence.kind === "activity" ||
				evidence.kind === "result" ||
				evidence.kind === "query_ended" ||
				evidence.kind === "interaction_requested" ||
				evidence.kind === "interaction_resolved")) ||
		(send.effect.kind === "probe" &&
			send.effect.target.tag === "native_session" &&
			evidence.kind === "probe_result" &&
			(evidence.finding.tag === "native_idle" ||
				evidence.finding.tag === "native_busy"))
	);
}

const inputs = (view: LedgerView) => [
	...view.inbox,
	...(view.active?.inputs ?? []),
];

/** These checks use only commands, effects, terminals and viewLedger's public projection. */
class OutputInvariants {
	private readonly ended = new Set<string>();
	private readonly started = new Set<string>();
	private readonly runNowInputs = new Set<string>();
	private readonly tokens = new Set<SendToken>();

	check(
		driver: TraceDriver,
		command: LedgerCommand,
		before: LedgerView,
		known: readonly IssuedEffect[],
		decision: Step,
	): void {
		const after = driver.view();
		if (staleLifecycle(command, before, known, this.ended)) {
			expect(decision.tag).toBe("Accepted");
			expect(driver.lastEventCount).toBe(0);
			expect(decision.effects).toEqual([]);
			expect(decision.ended).toEqual([]);
			expect(after).toEqual(before);
		}
		if (decision.tag === "Rejected") {
			expect(after).toEqual(before);
			return;
		}
		if (command.verb === "admit" && command.runNow)
			this.runNowInputs.add(command.inputId);
		if (command.verb === "control" && command.control.kind === "run_now")
			this.runNowInputs.add(command.control.inputId);
		for (const terminal of decision.ended) {
			expect(this.ended.has(terminal.runId), "one terminal per Run").toBe(
				false,
			);
			this.ended.add(terminal.runId);
			this.started.delete(terminal.runId);
		}
		const uncertain = new Set(
			inputs(before)
				.filter((input) => input.uncertain)
				.map((input) => input.inputId),
		);
		const unknownToken =
			command.verb === "observe" &&
			command.observation.kind === "effect_outcome" &&
			command.observation.outcome.tag === "delivery_unknown"
				? command.observation.token
				: undefined;
		const newlyUnknown = before.live.find(
			({ token }) => token === unknownToken,
		);
		const unknownInput =
			newlyUnknown?.effect.kind === "start" ||
			newlyUnknown?.effect.kind === "steer"
				? newlyUnknown.effect.inputId
				: undefined;
		const priorInput = inputs(before).find(
			({ inputId }) => inputId === unknownInput,
		);
		const needsInputProbe =
			unknownInput !== undefined &&
			!(
				newlyUnknown &&
				"runId" in newlyUnknown.effect &&
				this.ended.has(newlyUnknown.effect.runId)
			) &&
			priorInput?.state.tag !== "Accepted" &&
			priorInput?.state.tag !== "Declined";
		if (needsInputProbe && unknownInput !== undefined)
			uncertain.add(unknownInput);
		for (const issued of decision.effects) {
			expect(
				this.tokens.has(issued.token),
				"every transmission has a fresh token",
			).toBe(false);
			this.tokens.add(issued.token);
			const effect = issued.effect;
			if (effect.kind === "start") this.started.add(effect.runId);
			if ("runId" in effect && this.ended.has(effect.runId)) {
				if (effect.kind === "deliver_answer") {
					expect(
						known.some(
							(prior) =>
								prior.effect.kind === "deliver_answer" &&
								prior.effect.runId === effect.runId &&
								prior.effect.interactionId === effect.interactionId,
						) ||
							(before.active?.runId === effect.runId &&
								before.active.interactions.some(
									(item) => item.interactionId === effect.interactionId,
								)),
						"answer delivery after Run end retains an existing obligation",
					).toBe(true);
				} else
					expect([
						"close",
						"interrupt",
						"quarantine",
						"kill_and_respawn",
						"end_session",
						"cancel_request",
						"probe",
					]).toContain(effect.kind);
			}
			if (effect.kind === "start" || effect.kind === "steer") {
				if (after.paused)
					expect(
						this.runNowInputs.has(effect.inputId),
						`paused admission needs explicit Run now: ${JSON.stringify({ command, effect })}`,
					).toBe(true);
				expect(
					uncertain.has(effect.inputId),
					`uncertain input is never resent: ${JSON.stringify({ command, effect })}`,
				).toBe(false);
			}
		}
		expect(
			this.started.size,
			"public start/terminal history has at most one active Run",
		).toBeLessThanOrEqual(1);
		const active = after.active;
		if (active) {
			expect(this.ended.has(active.runId), "a Tombstone never reopens").toBe(
				false,
			);
			expect(Number.isFinite(active.deadline.at)).toBe(true);
			expect(
				decision.alarmAt,
				"the alarm covers the active deadline",
			).toBeLessThanOrEqual(active.deadline.at);
		}
		expect(new Set(after.live.map(({ token }) => token)).size).toBe(
			after.live.length,
		);
		if (needsInputProbe && unknownInput !== undefined) {
			expect(
				[...decision.effects, ...after.live].some(
					({ effect }) =>
						effect.kind === "probe" &&
						effect.target.tag === "input" &&
						effect.target.inputId === unknownInput,
				),
				"delivery unknown issues an input probe",
			).toBe(true);
		}
	}
}

function runTrace(
	provider: ProviderKind,
	actions: readonly TraceAction[],
	differential: boolean,
	endSession = false,
): void {
	const reference = new TraceDriver(provider);
	const subject = differential
		? new TraceDriver(provider, "decider")
		: undefined;
	const fake = new FakeProvider(provider);
	const referenceNames = new PublicNames();
	const subjectNames = new PublicNames();
	const referenceInvariants = new OutputInvariants();
	const subjectInvariants = new OutputInvariants();
	const apply = (packet: { command: LedgerCommand; now: number }) => {
		const command = subject
			? translatedCommand(packet.command, reference, subject)
			: undefined;
		const before = reference.view();
		const known = [...reference.issued];
		const expected = reference.step(packet.command, packet.now);
		referenceInvariants.check(
			reference,
			packet.command,
			before,
			known,
			expected,
		);
		if (!subject || !command) return;
		const subjectBefore = subject.view();
		const subjectKnown = [...subject.issued];
		const actual = subject.step(command, packet.now);
		subjectInvariants.check(
			subject,
			command,
			subjectBefore,
			subjectKnown,
			actual,
		);
		referenceNames.register(reference.issued);
		subjectNames.register(subject.issued);
		expect(actual.tag).toBe(expected.tag);
		expect(actual.alarmAt).toBe(expected.alarmAt);
		expect(actual.effects.map((send) => subjectNames.issued(send))).toEqual(
			expected.effects.map((send) => referenceNames.issued(send)),
		);
		expect(
			actual.ended.map((terminal) => subjectNames.ended(terminal)),
		).toEqual(expected.ended.map((terminal) => referenceNames.ended(terminal)));
		expect(subjectNames.view(subject.view())).toEqual(
			referenceNames.view(reference.view()),
		);
	};
	apply({
		command: { verb: "admit", inputId: "seed:input", runNow: false },
		now: reference.now,
	});
	const startToken = reference.latest("start").token;
	apply({
		command: {
			verb: "observe",
			observation: { token: startToken, kind: "started" },
		},
		now: reference.now + 1,
	});
	apply({
		command: {
			verb: "observe",
			observation: {
				token: startToken,
				kind: "input_accepted",
				nativeMessageId: "seed:native",
			},
		},
		now: reference.now + 1,
	});
	for (const action of actions) {
		apply(
			fake.next(action, {
				issued: reference.issued,
				view: reference.view(),
				now: reference.now,
				alarmAt: reference.alarmAt,
			}),
		);
	}
	if (endSession) {
		apply({
			command: {
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			},
			now: reference.now + 1,
		});
		apply({
			command: {
				verb: "observe",
				observation: { token: startToken, kind: "activity" },
			},
			now: reference.now + 1,
		});
	}
}

describe.each(providers)("[step1] %s public command traces", (provider) => {
	const check = oracleTest(`[step1] ${provider} public command traces`);
	const activeActions = fc.array(
		traceAction.filter((action) => action.operation !== 8),
		{ minLength: 40, maxLength: 80 },
	);
	const sessionActions = fc.array(traceAction, {
		minLength: 20,
		maxLength: 60,
	});
	check(
		"[step1] keeps active reference traces within public output invariants",
		() => {
			fc.assert(
				fc.property(activeActions, (actions) =>
					runTrace(provider, actions, false),
				),
				{
					seed: 82_103_200 + providers.indexOf(provider),
					numRuns: 200,
				},
			);
		},
	);

	check(
		"[step1] agrees with active reference traces after every command",
		() => {
			fc.assert(
				fc.property(activeActions, (actions) =>
					runTrace(provider, actions, true),
				),
				{
					seed: 82_103_200 + providers.indexOf(provider),
					numRuns: 200,
				},
			);
		},
	);
	check(
		"[step1] keeps session-ending reference traces within public output invariants",
		() => {
			fc.assert(
				fc.property(sessionActions, (actions) =>
					runTrace(provider, actions, false, true),
				),
				{
					seed: 82_103_300 + providers.indexOf(provider),
					numRuns: 100,
				},
			);
		},
	);
	check(
		"[step1] agrees with session-ending reference traces after every command",
		() => {
			fc.assert(
				fc.property(sessionActions, (actions) =>
					runTrace(provider, actions, true, true),
				),
				{
					seed: 82_103_300 + providers.indexOf(provider),
					numRuns: 100,
				},
			);
		},
	);
});

describe("[step1] fake-provider evidence scheduling", () => {
	it("[step1] scheduler fires at the alarm, before it, long after it and repeatedly", () => {
		const fake = new FakeProvider("claude");
		const snapshot = {
			issued: [],
			view: { paused: false, inbox: [], live: [] },
			now: 100,
			alarmAt: 1_100,
		};
		const action = {
			operation: 6,
			selection: 0,
			index: 0,
			variant: 0,
			input: 0,
			advance: 0,
		};
		for (const [variant, now] of [
			[0, 1_100],
			[1, 1_099],
			[2, 101_100],
			[3, 100],
		] as const) {
			const packet = fake.next({ ...action, variant }, snapshot);
			expect(packet).toEqual({
				command: { verb: "settle", settlement: { kind: "alarm_fired" } },
				now,
			});
		}
		const repeated = { ...snapshot, now: 1_100 };
		expect(fake.next(action, repeated)).toEqual(fake.next(action, repeated));
		expect(
			fake.next({ ...action, variant: 3 }, { ...snapshot, alarmAt: undefined })
				.command,
		).toEqual({ verb: "settle", settlement: { kind: "alarm_fired" } });
	});
	it.each(
		providers,
	)("[step1] can hold, reorder, duplicate and fabricate %s evidence without a native process", (provider) => {
		const fake = new FakeProvider(provider);
		const start: RunEffect = { kind: "start", runId: "R", inputId: "A" };
		const issued: IssuedEffect[] = [0, 1, 2, 3].map((index) => ({
			token: `send:${index}` as SendToken,
			effect: start,
		}));
		const view: LedgerView = {
			paused: false,
			inbox: [],
			live: issued.slice(2),
		};
		const snapshot = { issued, view, now: 0 };
		const action = {
			operation: 3,
			selection: 0,
			index: 0,
			variant: 3,
			input: 0,
			advance: 0,
		};
		const token = (packet: ReturnType<FakeProvider["next"]>) =>
			packet.command.verb === "observe"
				? packet.command.observation.token
				: undefined;
		expect(token(fake.next(action, snapshot))).toBe("send:2");
		expect(token(fake.next({ ...action, selection: 1 }, snapshot))).toBe(
			"send:0",
		);
		expect(token(fake.next({ ...action, selection: 2 }, snapshot))).toBe(
			"send:0",
		);
		fake.next({ ...action, operation: 5, selection: 1 }, snapshot);
		fake.next({ ...action, operation: 5, selection: 0, index: 1 }, snapshot);
		expect(
			token(fake.next({ ...action, operation: 9, index: 1 }, snapshot)),
		).toBe("send:3");
		expect(token(fake.next({ ...action, operation: 9 }, snapshot))).toBe(
			"send:0",
		);
		expect(token(fake.next({ ...action, operation: 10 }, snapshot))).toBe(
			"send:2",
		);
		expect(token(fake.next({ ...action, selection: 3 }, snapshot))).toMatch(
			/^fabricated:/,
		);
	});
});
