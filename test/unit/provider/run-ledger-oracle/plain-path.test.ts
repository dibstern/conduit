import fc from "fast-check";
import { assert, describe, expect, it } from "vitest";
import type { EvidenceTable } from "../../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import * as decider from "../../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	Decision,
	Evidence,
	LedgerCommand,
	LedgerView,
	ProviderKind,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	driver,
	referenceImplementation,
	writeTraceArtifact,
} from "./harness.js";
import {
	admit,
	ask,
	begin,
	claimOf,
	complete,
	Driver,
	fire,
	main,
	noLifecycleChange,
	observe,
	request,
	running,
	scenarios,
	step,
	stop,
	tokenOf,
	transmissions,
	unsolicited,
	visibleInput,
} from "./scenarios.js";

/** Inputs the 32.2.7 slice leaves to a later lane; a trace that reaches one stops there. */
const notBuilt = /^not yet built \(32\.2\.11\): /;

/** What the oracle and the real decider must agree on at every step (3.1). */
const publicStep = (decision: Decision<unknown>, view: LedgerView) =>
	decision.tag === "Rejected"
		? { tag: decision.tag, view }
		: {
				tag: decision.tag,
				alarmAt: decision.alarmAt,
				effects: decision.effects,
				ended: decision.ended,
				view,
			};

/**
 * The oracle and the real decider fed one trace in lockstep. Each step also checks LI4 (the view is
 * its entries' replay) and that decide mutates nothing, through the harness driver. Returns false
 * once the decider reaches a lane it has not built.
 */
function lockstep(provider: ProviderKind) {
	assert(referenceImplementation, "the oracle is available");
	const expected = driver(referenceImplementation, provider, "reference");
	const actual = driver(decider, provider, "reference");
	return (
		command: LedgerCommand,
		now: number,
	): { decision: Decision<unknown>; view: LedgerView } | undefined => {
		const want = expected.step(command, now);
		const got = actual.step(command, now);
		if (got.tag === "Rejected" && notBuilt.test(got.diagnostic))
			return undefined;
		assert.deepEqual(
			publicStep(got, actual.view()),
			publicStep(want, expected.view()),
			`${JSON.stringify(command)} at ${now}`,
		);
		return { decision: got, view: actual.view() };
	};
}

/** A Driver that records the commands a scenario steps, its constructor's included. */
class Recording extends Driver {
	declare log: [LedgerCommand, number][] | undefined;
	override step(command: LedgerCommand, now = this.now + 1) {
		(this.log ??= []).push([command, now]);
		return super.step(command, now);
	}
}

describe("[32.2.5] plain Run path differential", () => {
	it.each(
		scenarios.map((scenario) => [scenario.id, scenario] as const),
	)("fixed trace %s agrees with the oracle up to its first unbuilt input", (_id, scenario) => {
		const recorded = new Recording(scenario.provider);
		scenario.run(recorded);
		const step = lockstep(scenario.provider);
		for (const [command, now] of recorded.log ?? [])
			if (step(command, now) === undefined) return;
	});

	const inputs = ["A", "B"] as const;
	const runIds = inputs.flatMap((input) => [`${input}1`, `${input}2`]);
	const tokens = [...runIds, "h1", "h2", "h3"].map(
		(token) => token as SendToken,
	);
	/** The harness mints decide's probe tokens as `reference:n` on both sides of the lockstep. */
	const probeTokens = ["reference:1", "reference:2", "reference:3"].map(
		(token) => token as SendToken,
	);
	const commandIds = ["c1", "c2"];
	/** 32.2.7: Stop, Run now and end controls, each answered by main's (commandId, transmission) claims. */
	const controlIds = ["s1", "s2"];
	/** 32.2.8: answer controls, claimed the same way, and the interactions they answer. */
	const answerIds = ["a1", "a2"];
	const interactionIds = ["q1", "q2"] as const;
	const labels = ["r1:1", "r1:2", "r2:1", "r3:1"] as const;
	const claims = [...controlIds, ...answerIds].flatMap((commandId) =>
		[0, 1, 2].map((transmission) => ({ commandId, transmission })),
	);
	/** A generated answer to its round's own send. */
	const own = "own" as SendToken;
	const retryAt = fc.constantFrom(600, 9_000);
	const code = fc.constantFrom("Refused", "native_resume_rejected");
	const evidence: fc.Arbitrary<Evidence> = fc.oneof(
		fc.constantFrom<Evidence>(
			{ kind: "started" },
			{ kind: "activity" },
			{ kind: "accounting" },
			{ kind: "query_ended" },
			{ kind: "input_accepted" },
			{ kind: "input_accepted", nativeMessageId: "n1" },
			{ kind: "input_accepted", nativeMessageId: "n2" },
			{ kind: "input_declined", reason: "busy" },
			{ kind: "result", outcome: "completed" },
			{ kind: "result", outcome: "interrupted" },
			{
				kind: "result",
				outcome: "error",
				error: { code: "rate_limited", retryable: true },
			},
			{ kind: "runner_reply", outcome: { tag: "succeeded" } },
			{
				kind: "runner_reply",
				outcome: { tag: "failed", code: "IteratorFailed" },
			},
			{ kind: "effect_outcome", outcome: { tag: "succeeded" } },
			{ kind: "effect_outcome", outcome: { tag: "delivery_unknown" } },
			{ kind: "delivery_indeterminate" },
			{ kind: "run_released", reason: "ResumeRejected" },
			{ kind: "run_released", reason: "NotSent" },
			{ kind: "run_released", reason: { tag: "Refused", why: "retiring" } },
			{ kind: "run_released", reason: { tag: "Refused", why: "interrupted" } },
			{ kind: "journal_answer", answer: "absent" },
			{ kind: "journal_answer", answer: "running" },
			{ kind: "journal_answer", answer: "finished" },
			{ kind: "journal_answer", answer: "uncertain" },
			{
				kind: "interaction_requested",
				interactionId: "q1",
				interactionKind: "permission",
			},
			{
				kind: "interaction_requested",
				interactionId: "q2",
				interactionKind: "question",
			},
			{ kind: "interaction_resolved", interactionId: "q1" },
		),
		fc.tuple(retryAt, fc.option(code, { nil: undefined })).map(
			([at, refusal]): Evidence => ({
				kind: "effect_outcome",
				outcome: {
					tag: "retryable",
					retryAt: at,
					...(refusal === undefined ? {} : { code: refusal }),
				},
			}),
		),
		retryAt.map(
			(at): Evidence => ({
				kind: "effect_outcome",
				outcome: { tag: "not_sent", retryAt: at },
			}),
		),
		code.map(
			(permanent): Evidence => ({
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: permanent },
			}),
		),
	);
	const findings = fc.constantFrom<Evidence>(
		{ kind: "probe_result", finding: { tag: "input_present" } },
		{
			kind: "probe_result",
			finding: { tag: "input_present", nativeMessageId: "n1" },
		},
		{ kind: "probe_result", finding: { tag: "input_absent" } },
		{ kind: "probe_result", finding: { tag: "native_idle" } },
		{ kind: "probe_result", finding: { tag: "native_busy" } },
	);
	/** 9, D21: a held start's or steer's receipts, by its hold's commandId or another. */
	const lifecycle = fc
		.tuple(
			fc.constantFrom(...commandIds),
			fc.constantFrom("queued", "started", "completed", "cancelled" as const),
		)
		.map(
			([commandId, state]): Evidence => ({
				kind: "command_lifecycle",
				commandId,
				state,
			}),
		);
	const answer = (
		token: fc.Arbitrary<SendToken>,
		kinds = evidence,
	): fc.Arbitrary<LedgerCommand> =>
		fc.tuple(token, kinds).map(([to, fields]) => ({
			verb: "observe",
			observation: { tag: "Answer", token: to, ...fields },
		}));
	const commandFor = (provider: ProviderKind): fc.Arbitrary<LedgerCommand> =>
		fc.oneof(
			{
				weight: 3,
				arbitrary: fc
					.tuple(
						fc.constantFrom(...inputs),
						fc.constantFrom("queue", "steer" as const),
					)
					.map(
						([inputId, delivery]): LedgerCommand => ({
							verb: "admit",
							inputId,
							delivery,
							request: { text: inputId },
						}),
					),
			},
			{
				// 3.9: main starts an input in the Run it requested, its own Run if that one ended.
				weight: 1,
				arbitrary: fc
					.tuple(
						fc.nat(5),
						fc.constantFrom(...inputs),
						fc.constantFrom(...runIds),
					)
					.map(
						([event, inputId, requestedRunId]): LedgerCommand => ({
							verb: "observe",
							observation: {
								tag: "Main",
								eventId: `s${event}`,
								kind: "run_started",
								inputId,
								requestedRunId,
							},
						}),
					),
			},
			{
				weight: 2,
				arbitrary: fc
					.tuple(
						fc.constantFrom(...answerIds),
						fc.constantFrom(...interactionIds),
						fc.constantFrom("allow", "deny"),
					)
					.map(
						([commandId, interactionId, reply]): LedgerCommand => ({
							verb: "control",
							control: {
								kind: "answer",
								commandId,
								interactionId,
								answer: reply,
							},
						}),
					),
			},
			{
				// 3.10, D61: an interaction its label names, and its native or confirming resolution.
				weight: 1,
				arbitrary: fc
					.tuple(
						fc.nat(5),
						fc.constantFrom(...labels),
						fc.constantFrom(...interactionIds),
						fc.boolean(),
					)
					.map(
						([event, label, interactionId, resolved]): LedgerCommand => ({
							verb: "observe",
							observation: resolved
								? {
										tag: "Unsolicited",
										label,
										eventId: `u${event}`,
										kind: "interaction_resolved",
										interactionId,
									}
								: {
										tag: "Unsolicited",
										label,
										eventId: `u${event}`,
										kind: "interaction_requested",
										interactionId,
										interactionKind: "question",
									},
						}),
					),
			},
			{
				weight: 3,
				arbitrary: fc.tuple(fc.nat(5), fc.constantFrom(...runIds)).map(
					([event, runId]): LedgerCommand => ({
						verb: "observe",
						observation: {
							tag: "Main",
							eventId: `e${event}`,
							kind: "run_requested",
							runId,
							inputId: runId.slice(0, 1),
							direct: provider === "opencode",
						},
					}),
				),
			},
			{
				weight: 1,
				arbitrary: fc
					.tuple(
						fc.nat(5),
						fc.constantFrom(...runIds),
						fc.constantFrom("completed", "error", "interrupted" as const),
						fc.option(fc.constant("main_error"), { nil: undefined }),
					)
					.map(
						([event, runId, outcome, error]): LedgerCommand => ({
							verb: "observe",
							observation: {
								tag: "Main",
								eventId: `t${event}`,
								kind: "run_terminal",
								runId,
								outcome,
								...(error === undefined ? {} : { code: error }),
							},
						}),
					),
			},
			{
				weight: 3,
				arbitrary: fc
					.tuple(
						fc.constantFrom(...tokens.slice(runIds.length)),
						fc.constantFrom(...runIds),
						fc.constantFrom("r1", "r2", "r3"),
						fc.constantFrom(...commandIds),
						fc.integer({ min: 1, max: 3 }),
					)
					.map(
						([
							token,
							runId,
							runnerId,
							commandId,
							transmission,
						]): LedgerCommand => ({
							verb: "observe",
							observation: {
								tag: "Answer",
								token,
								kind: "run_dispatched",
								runId,
								runnerId,
								commandId,
								transmission,
							},
						}),
					),
			},
			{
				weight: 6,
				arbitrary: answer(fc.constantFrom(...tokens)),
			},
			{
				weight: 1,
				arbitrary: answer(fc.constantFrom(...tokens), lifecycle),
			},
			{
				weight: 3,
				arbitrary: answer(
					fc.constantFrom(...probeTokens),
					fc.oneof({ weight: 3, arbitrary: findings }, evidence),
				),
			},
			{
				weight: 2,
				arbitrary: fc
					.tuple(
						fc.constantFrom("stop", "run_now", "end" as const),
						fc.constantFrom(...controlIds),
						fc.constantFrom(null, 9_000),
						fc.constantFrom(...inputs),
					)
					.map(
						([kind, commandId, deadlineAt, inputId]): LedgerCommand => ({
							verb: "control",
							control:
								kind === "run_now"
									? { kind, commandId, deadlineAt, inputId }
									: { kind, commandId, deadlineAt },
						}),
					),
			},
			{
				weight: 2,
				arbitrary: fc
					.tuple(
						fc.constantFrom(...claims),
						fc.oneof(
							fc.constant({ tag: "succeeded" as const }),
							fc
								.tuple(retryAt, fc.option(code, { nil: undefined }))
								.map(([at, refusal]) => ({
									tag: "retryable" as const,
									retryAt: at,
									...(refusal === undefined ? {} : { code: refusal }),
								})),
							code.map((permanent) => ({
								tag: "permanent" as const,
								code: permanent,
							})),
							fc.constant({ tag: "delivery_unknown" as const }),
						),
					)
					.map(
						([transmission, outcome]): LedgerCommand => ({
							verb: "observe",
							observation: {
								tag: "Answer",
								token:
									`${transmission.commandId}:${transmission.transmission}` as SendToken,
								kind: "effect_outcome",
								outcome,
								transmission,
							},
						}),
					),
			},
			{
				weight: 2,
				arbitrary: fc.oneof(
					fc.constant<LedgerCommand>({
						verb: "settle",
						settlement: { kind: "alarm_fired" },
					}),
					fc.constantFrom(...commandIds).map(
						(commandId): LedgerCommand => ({
							verb: "settle",
							settlement: { kind: "hold_exhausted", commandId },
						}),
					),
				),
			},
			{
				weight: 2,
				arbitrary: fc.oneof(
					fc
						.tuple(
							fc.constantFrom(...runIds),
							fc.constantFrom(...commandIds),
							fc.oneof(
								retryAt.map((at) => ({
									tag: "retryable" as const,
									retryAt: at,
								})),
								retryAt.map((at) => ({
									tag: "not_sent" as const,
									retryAt: at,
								})),
								code.map((permanent) => ({
									tag: "permanent" as const,
									code: permanent,
								})),
							),
						)
						.map(
							([runId, commandId, outcome]): LedgerCommand => ({
								verb: "settle",
								settlement: {
									kind: "unheld_outcome",
									runId,
									commandId,
									outcome,
								},
							}),
						),
					fc
						.tuple(fc.constantFrom("r1", "r2"), fc.integer({ min: 1, max: 2 }))
						.map(
							([runnerId, retiredAt]): LedgerCommand => ({
								verb: "settle",
								settlement: { kind: "process_lost", runnerId, retiredAt },
							}),
						),
					fc.constantFrom(...labels).map(
						(label): LedgerCommand => ({
							verb: "settle",
							settlement: { kind: "process_started", label, reattached: false },
						}),
					),
					fc.constantFrom<LedgerCommand>(
						{
							verb: "settle",
							settlement: {
								kind: "session_ended",
								cause: "native_session_vanished",
							},
						},
						{ verb: "settle", settlement: { kind: "alarm_fired" } },
					),
				),
			},
		);

	/** 3.10: an interaction requested, answered, and its answer's first claim settled. */
	const interactionRound = (
		commandId: string,
		interactionId: string,
		outcome: "succeeded" | "retryable" | "permanent",
		eventId: string,
	): LedgerCommand[] => [
		{
			verb: "observe",
			observation: {
				tag: "Unsolicited",
				label: "r1:1",
				eventId,
				kind: "interaction_requested",
				interactionId,
				interactionKind: "permission",
			},
		},
		{
			verb: "control",
			control: { kind: "answer", commandId, interactionId, answer: "allow" },
		},
		{
			verb: "observe",
			observation: {
				tag: "Answer",
				token: `${commandId}:1` as SendToken,
				kind: "effect_outcome",
				outcome:
					outcome === "succeeded"
						? { tag: "succeeded" }
						: outcome === "retryable"
							? { tag: "retryable", retryAt: 600, code: "Refused" }
							: { tag: "permanent", code: "Refused" },
				transmission: { commandId, transmission: 1 },
			},
		},
	];

	for (const [provider, seed] of [
		["claude", 822501],
		["cursor", 822502],
		["opencode", 822503],
	] as const)
		it(`${provider} generated plain-path traces agree with the oracle at every step, seed ${seed}`, ({
			task,
		}) => {
			const reached = { views: new Set<string>(), ends: new Set<string>() };
			let stopped = 0;
			fc.assert(
				fc.property(
					// Rounds of main's plain path (admit, run.requested, mostly a runner's hold) under
					// noise that mostly answers the round's own send, written as the `own` token.
					fc.array(
						fc.record({
							runId: fc.constantFrom(...runIds),
							token: fc.constantFrom(...tokens.slice(runIds.length)),
							runnerId: fc.constantFrom("r1", "r2"),
							commandId: fc.constantFrom(...commandIds),
							held: fc.boolean(),
							delivery: fc.constantFrom("queue", "queue", "steer" as const),
							// 3.10: an interaction on r1's first label, answered, and the answer's claim outcome.
							ask: fc.option(
								fc.constantFrom("succeeded", "retryable", "permanent" as const),
								{ nil: undefined },
							),
							// 3.7: the round's own send answered delivery_unknown, then its recovery deadline.
							unknown: fc.boolean(),
							noise: fc.array(
								fc.tuple(
									fc.oneof(
										{ weight: 3, arbitrary: answer(fc.constant(own)) },
										{ weight: 2, arbitrary: commandFor(provider) },
									),
									fc.constantFrom(1, 500, 7_000, 8_000),
								),
								{ maxLength: 8 },
							),
						}),
						{ maxLength: 5 },
					),
					(rounds) => {
						const direct = provider === "opencode";
						const trace = rounds.flatMap((round, index) => {
							const token = (direct ? round.runId : round.token) as SendToken;
							const skeleton: LedgerCommand[] = [
								{
									verb: "admit",
									inputId: round.runId.slice(0, 1),
									delivery: round.delivery,
									request: { text: round.runId },
								},
								{
									verb: "observe",
									observation: {
										tag: "Main",
										eventId: `round${index}`,
										kind: "run_requested",
										runId: round.runId,
										inputId: round.runId.slice(0, 1),
										direct,
									},
								},
								...(direct || !round.held
									? []
									: [
											{
												verb: "observe",
												observation: {
													tag: "Answer",
													token,
													kind: "run_dispatched",
													runId: round.runId,
													runnerId: round.runnerId,
													commandId: round.commandId,
													transmission: 1,
												},
											} satisfies LedgerCommand,
										]),
								...(round.ask === undefined
									? []
									: interactionRound(
											answerIds[index % 2] ?? "a1",
											interactionIds[index % 2] ?? "q1",
											round.ask,
											`ask${index}`,
										)),
							];
							return [
								...skeleton.map((command) => [command, 1] as const),
								...(round.unknown
									? ([
											[
												{
													verb: "observe",
													observation: {
														tag: "Answer",
														token,
														kind: "effect_outcome",
														outcome: { tag: "delivery_unknown" },
													},
												},
												1,
											],
											[
												{ verb: "settle", settlement: { kind: "alarm_fired" } },
												500,
											],
										] as const)
									: []),
								...round.noise.map(
									([command, elapsed]) =>
										[
											command.verb === "observe" &&
											command.observation.tag === "Answer" &&
											command.observation.token === own
												? {
														...command,
														observation: { ...command.observation, token },
													}
												: command,
											elapsed,
										] as const,
								),
							];
						});
						const step = lockstep(provider);
						let now = 100;
						step(
							{
								verb: "settle",
								settlement: {
									kind: "process_started",
									label: "r1:1",
									reattached: false,
								},
							},
							now,
						);
						let queued: string | undefined;
						for (const [command, elapsed] of trace) {
							now += elapsed;
							const stepped = step(command, now);
							if (stepped === undefined) {
								stopped += 1;
								return;
							}
							const active = stepped.view.active;
							// 3.6: a relaunch is a Queued Run starting again under its runId.
							if (
								queued !== undefined &&
								active?.runId === queued &&
								active.tag !== "Queued"
							)
								reached.views.add("relaunched");
							queued = active?.tag === "Queued" ? active.runId : undefined;
							reached.views.add(active?.tag ?? "idle");
							// 3.13: main's Stop and end rows, and decide's own cancel_request, are live.
							for (const { effect } of stepped.view.live)
								if (
									effect.kind === "interrupt" ||
									effect.kind === "end_session" ||
									effect.kind === "cancel_request" ||
									effect.kind === "steer" ||
									effect.kind === "deliver_answer"
								)
									reached.views.add(effect.kind);
							// 3.10: interactions Pending, refused and Answered.
							for (const interaction of stepped.view.interactions)
								reached.views.add(
									interaction.tag === "Pending" &&
										interaction.lastRefusal !== undefined
										? "lastRefusal"
										: interaction.tag,
								);
							if (
								active?.inputs.some(
									({ state }) =>
										state.tag === "Delivered" && state.certainty === "unknown",
								)
							)
								reached.views.add("delivery unknown");
							if (stepped.decision.tag === "Accepted") {
								if (
									stepped.decision.effects.some(
										({ effect }) => effect.kind === "probe",
									)
								)
									reached.views.add("probed");

								for (const ended of stepped.decision.ended)
									reached.ends.add(ended.reason.tag);
							}
						}
					},
				),
				{ seed, numRuns: 300 },
			);
			writeTraceArtifact(
				`plain-path-${provider}-${seed}`,
				{
					seed,
					numRuns: 300,
					stopped,
					views: [...reached.views].sort(),
					ends: [...reached.ends].sort(),
				},
				task.id,
			);
			// The generator reaches the plain path's phases and endings, not only rejections.
			expect([...reached.views]).toEqual(
				expect.arrayContaining([
					"Starting",
					"Running",
					"Queued",
					"relaunched",
					"delivery unknown",
					"probed",
					"Interrupting",
					"interrupt",
					"end_session",
					"steer",
					"deliver_answer",
					"Pending",
					"lastRefusal",
					"Answered",
					...(provider === "opencode" ? ["Settling", "cancel_request"] : []),
				]),
			);
			expect([...reached.ends]).toEqual(
				expect.arrayContaining([
					"completed",
					"provider_error",
					"refused",
					"process_lost",
					"interrupted",
				]),
			);
		});
});

/**
 * Runs a trace on the real decider for its assertions, runs it again on the oracle, and replays
 * the oracle's commands through the lockstep, so every step is also green against the oracle.
 */
function agreed(provider: ProviderKind, trace: (d: Driver) => void) {
	const d = new Driver(provider, "decider");
	trace(d);
	const recorded = new Recording(provider);
	trace(recorded);
	const step = lockstep(provider);
	for (const [command, now] of recorded.log ?? [])
		assert(step(command, now), `${JSON.stringify(command)} is built`);
	return d;
}
const scenario = (id: string) => {
	const found = scenarios.find((candidate) => candidate.id === id);
	assert(found, `scenario ${id}`);
	return found;
};

describe("[32.2.6] core delivery, fences and refusal: the bead's acceptance criteria", () => {
	it("R5's fixed trace is green and reaches the race a start refused with an accepted sibling", () => {
		const r5 = scenario("R5");
		const d = agreed(r5.provider, r5.run);
		expect(d.coverage.races["start refused with an accepted sibling"]).toBe(1);
	});

	it("an unknown delivery settled by a probe (RL-021) is reached and green", () => {
		const rl021 = scenario("RL-021");
		const d = agreed(rl021.provider, rl021.run);
		expect(d.coverage.races["unknown delivery settled by a probe"]).toBe(1);
	});

	it("a late acceptance after a Tombstone restores its send's work to its label (3.8, D54)", () => {
		const d = agreed("claude", (d) => {
			const a = begin(d);
			const refused = observe(d, a.token, {
				kind: "runner_reply",
				outcome: { tag: "failed", code: "IteratorFailed" },
			});
			expect(refused.ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "refused" } },
			]);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
			const late = observe(d, a.token, {
				kind: "input_accepted",
				nativeMessageId: "native-A",
			});
			// The Run stays ended; the label's work is the accepted send again.
			expect(late.ended).toEqual([]);
			expect(d.view()).toMatchObject({
				anythingMayAct: true,
				live: [{ effect: { kind: "start", runId: a.runId, inputId: "A" } }],
			});
		});
		expect(d.coverage.races["late acceptance after a Tombstone"]).toBe(1);
	});

	it("a direct delivery_unknown send with no later proof is never re-sent, only probed up to the cap (3.5, 4.8)", () => {
		agreed("opencode", (d) => {
			const a = begin(d);
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			// A later retryable answer cannot resend a send that may have reached the provider.
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 300 },
			});
			const issued = [];
			for (let alarm = 0; alarm < 10 && d.alarmAt !== undefined; alarm += 1) {
				const fired = fire(d);
				expect(fired.ended).toEqual([]);
				issued.push(...fired.issued);
			}
			expect(d.alarmAt).toBeUndefined();
			expect(issued.map(({ effect }) => effect.kind)).toEqual(
				Array.from({ length: 5 }, () => "probe"),
			);
			expect(transmissions(d, "A")).toHaveLength(1);
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
		});
	});

	it("a probe's not_sent transmission does not count toward its cap of 5 (4.8)", () => {
		agreed("opencode", (d) => {
			const a = begin(d);
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			const [first] = fire(d).issued;
			assert(first?.tag === "Tokened", "the recovery probe is decide's");
			observe(d, first.token, {
				kind: "effect_outcome",
				outcome: { tag: "not_sent", retryAt: d.now + 1 },
			});
			let probes = 1;
			for (let alarm = 0; alarm < 10 && d.alarmAt !== undefined; alarm += 1)
				probes += fire(d).issued.length;
			expect(probes).toBe(6);
		});
	});

	it("an unknown delivery blocks the automatic resend until a probe's input_absent settles it (3.5, 4.8)", () => {
		agreed("opencode", (d) => {
			const a = begin(d);
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 300 },
			});
			const [probe] = fire(d).issued;
			assert(probe?.tag === "Tokened", "the recovery probe is decide's");
			expect(visibleInput(d, "A")?.state).toMatchObject({
				certainty: "unknown",
			});
			observe(d, probe.token, {
				kind: "probe_result",
				finding: { tag: "input_absent" },
			});
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Queued" });
			expect(d.view().live).toEqual([]);
		});
	});

	it("a retryable send row returns to the queue and is re-sent from there (4.8)", () => {
		agreed("opencode", (d) => {
			const a = begin(d);
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 300 },
			});
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Queued" });
			expect(d.view().live).toEqual([]);
			main(
				d,
				{ kind: "run_requested", runId: a.runId, inputId: "A", direct: true },
				"requested-again",
			);
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Dispatching" });
			expect(d.view().live).toMatchObject([
				{ effect: { kind: "start", runId: a.runId, inputId: "A" } },
			]);
		});
		agreed("claude", (d) => {
			const a = begin(d);
			observe(d, a.token, { kind: "run_released", reason: "NotSent" });
			expect(d.view()).toMatchObject({
				live: [],
				active: { runId: a.runId, tag: "Queued" },
			});
		});
	});
});

describe("[32.2.5] activity throttling (3.8) and the evidence registry (3.2)", () => {
	/** A Run with one start transmitted, answering under its token. */
	function launched(provider: ProviderKind) {
		const d = driver(decider, provider, "throttle");
		let now = 100;
		const step = (command: LedgerCommand) => {
			const decision = d.step(command, (now += 1));
			assert.equal(decision.tag, "Accepted", JSON.stringify(decision));
			return d.lastEventCount;
		};
		const direct = provider === "opencode";
		step({
			verb: "settle",
			settlement: { kind: "process_started", label: "r1:1", reattached: false },
		});
		step({
			verb: "admit",
			inputId: "A",
			delivery: "queue",
			request: { text: "A" },
		});
		step({
			verb: "observe",
			observation: {
				tag: "Main",
				eventId: "e1",
				kind: "run_requested",
				runId: "A1",
				inputId: "A",
				direct,
			},
		});
		if (!direct)
			step({
				verb: "observe",
				observation: {
					tag: "Answer",
					token: "h1" as SendToken,
					kind: "run_dispatched",
					runId: "A1",
					runnerId: "r1",
					commandId: "c1",
					transmission: 1,
				},
			});
		const token = (direct ? "A1" : "h1") as SendToken;
		return {
			d,
			now: () => now,
			answer: (evidence: Evidence) =>
				step({
					verb: "observe",
					observation: { tag: "Answer", token, ...evidence },
				}),
		};
	}

	it("a stream of activity frames in one phase records one activity entry", () => {
		const { d, answer } = launched("claude");
		expect(answer({ kind: "started" })).toBe(1);
		expect(answer({ kind: "activity" })).toBe(1);
		for (let frame = 0; frame < 5; frame += 1)
			expect(answer({ kind: "activity" })).toBe(0);
		expect(d.view().active?.tag).toBe("Running");
		expect(d.alarmAt).toBeUndefined();
	});

	it("OpenCode activity after a result records a new phase and shows Running again", () => {
		const { d, now, answer } = launched("opencode");
		expect(answer({ kind: "activity" })).toBe(1);
		expect(answer({ kind: "activity" })).toBe(0);
		expect(answer({ kind: "result", outcome: "completed" })).toBe(1);
		expect(d.view().active?.tag).toBe("Settling");
		expect(d.alarmAt).toBe(now() + 7_000);
		expect(answer({ kind: "activity" })).toBe(1);
		expect(d.view().active?.tag).toBe("Running");
		expect(d.alarmAt).toBeUndefined();
		expect(answer({ kind: "activity" })).toBe(0);
		// The owned execution's end is the Run's end: the fact and its Tombstone.
		expect(answer({ kind: "query_ended" })).toBe(2);
		expect(d.view().active).toBeUndefined();
	});

	it("a registry missing an evidence kind is a compile error", () => {
		const missing = {} as Omit<EvidenceTable, "accounting">;
		// @ts-expect-error The registry is keyed by every Evidence kind (3.2).
		const registry: EvidenceTable = missing;
		expect(registry).toEqual({});
	});
});

describe("[32.2.7] core authority and stopping: the bead's acceptance criteria", () => {
	const lose = (d: Driver, runnerId: string) =>
		step(d, {
			verb: "settle",
			settlement: { kind: "process_lost", runnerId, retiredAt: d.now },
		});
	const started = (d: Driver, label: string) =>
		step(d, {
			verb: "settle",
			settlement: { kind: "process_started", label, reattached: false },
		});
	const end = (d: Driver, deadlineAt: number | null = null) =>
		step(d, {
			verb: "control",
			control: { kind: "end", commandId: `end-${d.next()}`, deadlineAt },
		});
	const runNow = (
		d: Driver,
		inputId: string,
		deadlineAt: number | null = null,
	) =>
		step(d, {
			verb: "control",
			control: {
				kind: "run_now",
				commandId: `run-now-${d.next()}`,
				inputId,
				deadlineAt,
			},
		});
	/** Claude's held start for an admitted input, dispatched to `runnerId` (3.4, 4.11). */
	const dispatchedTo = (d: Driver, runnerId: string) => {
		admit(d, "A");
		return request(d, "A", runnerId);
	};

	it("the races process loss mid-Run, runner release and evidence on both sides of a Tombstone are hit and green", () => {
		const lost = agreed("claude", (d) => {
			const a = running(d);
			lose(d, "r1");
			observe(d, a.token, { kind: "activity" });
		});
		const released = agreed("claude", (d) => {
			const a = begin(d);
			observe(d, a.token, { kind: "run_released", reason: "NotSent" });
		});
		expect(lost.coverage.races["process loss mid-Run"]).toBe(1);
		expect(lost.coverage.races["evidence on both sides of a Tombstone"]).toBe(
			1,
		);
		expect(released.coverage.races["runner release"]).toBe(1);
	});

	it("no fixed trace the decider builds issues a quarantine effect (5.1)", () => {
		const kinds = new Set<string>();
		for (const fixed of scenarios) {
			const d = new Driver(fixed.provider, "decider");
			try {
				fixed.run(d);
			} catch (error) {
				if (!String(error).match(/not yet built/)) throw error;
			}
			for (const { effect } of d.issued) kinds.add(effect.kind);
		}
		expect(kinds).not.toContain("quarantine");
		expect([...kinds].sort()).toEqual(
			expect.arrayContaining(["end_session", "interrupt", "probe", "start"]),
		);
	});

	it("process_lost ends a Run that reached the agent on its runner process_lost (L1)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			expect(lose(d, "r1").ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "process_lost" } },
			]);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
	});

	it("a second runner's process_started with no prior loss retires the first as its process_lost (L1 totality)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			expect(started(d, "r2:1").ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "process_lost" } },
			]);
			// Retired is final: the first runner's later start is an older label.
			noLifecycleChange(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r1:2",
					reattached: false,
				},
			});
			end(d);
			expect(d.latest("end_session").effect).toEqual({
				kind: "end_session",
				runId: null,
				label: "r2:1",
			});
		});
	});

	it("an end_session with no current process is pending with label null and resolves to the next runner (L2 case 3)", () => {
		agreed("claude", (d) => {
			lose(d, "r1");
			end(d);
			expect(d.latest("end_session").effect).toEqual({
				kind: "end_session",
				runId: null,
				label: null,
			});
			started(d, "r2:1");
			// Resolved, not covered: it may still act on the next runner.
			expect(d.view().live).toMatchObject([
				{ effect: { kind: "end_session" } },
			]);
		});
	});

	it("an end_session for a Run goes to its execution's runner, even after a replacement started (L2 case 2)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			end(d, 9_000);
			expect(d.latest("end_session").effect).toEqual({
				kind: "end_session",
				runId: a.runId,
				label: "r1:1",
			});
			expect(d.view().active).toMatchObject({ tag: "Interrupting", by: "end" });
			// The replacement retires r1: the end_session addressed to r1 is covered, never re-addressed,
			// and the asked Run ends interrupted (3.8).
			expect(started(d, "r2:1").ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "interrupted" } },
			]);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
	});

	it("a Run dispatched to a runner not yet started addresses its end_session there with label null (L2 case 2, r3-1)", () => {
		agreed("claude", (d) => {
			lose(d, "r1");
			const a = dispatchedTo(d, "r2");
			observe(d, a.token, { kind: "started" });
			end(d, 9_000);
			expect(d.latest("end_session").effect).toEqual({
				kind: "end_session",
				runId: a.runId,
				label: null,
			});
			// r2's start fixes the label and covers nothing.
			started(d, "r2:1");
			expect(d.view().live.map(({ effect }) => effect.kind)).toContain(
				"end_session",
			);
		});
	});

	it("labels split at the last ':' before a decimal; two OpenCode runners are distinct and the second is live (L1)", () => {
		agreed("opencode", (d) => {
			started(d, "opencode:a:0");
			lose(d, "opencode:a");
			started(d, "opencode:b:0");
			// opencode:a is retired, so its later start is an older label.
			noLifecycleChange(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "opencode:a:1",
					reattached: false,
				},
			});
			end(d);
			expect(d.latest("end_session").effect).toMatchObject({
				label: "opencode:b:0",
			});
			const a = running(d);
			expect(d.view().active).toMatchObject({ runId: a.runId, tag: "Running" });
		});
		agreed("claude", (d) => {
			// An older host's label has no querySeq: the whole label is the runnerId.
			started(d, "host");
			lose(d, "host");
			end(d);
			expect(d.latest("end_session").effect).toMatchObject({ label: null });
		});
	});

	it("run_dispatched to an unstarted runner then its process_lost ends the Run process_lost, recording no lost work (L1, r3-1)", () => {
		agreed("claude", (d) => {
			lose(d, "r1");
			const a = dispatchedTo(d, "r2");
			expect(lose(d, "r2").ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "process_lost" } },
			]);
			expect(d.view()).toMatchObject({ lostWork: [], anythingMayAct: false });
		});
	});

	it("a released start then its runner's process_lost relaunches under the same commandId to the next runner (D50)", () => {
		agreed("claude", (d) => {
			const a = begin(d);
			observe(d, a.token, { kind: "run_released", reason: "NotSent" });
			lose(d, "r1");
			expect(d.view().active).toMatchObject({ runId: a.runId, tag: "Queued" });
			started(d, "r2:1");
			const t2 = "hold-A-2" as SendToken;
			observe(d, t2, {
				kind: "run_dispatched",
				runId: a.runId,
				runnerId: "r2",
				commandId: "cmd-A-1",
				transmission: 2,
			});
			expect(d.view().active).toMatchObject({
				runId: a.runId,
				tag: "Starting",
			});
			// A later release of the first transmission is stale.
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: a.token,
					kind: "run_released",
					reason: "NotSent",
				},
			});
			observe(d, t2, { kind: "input_accepted", nativeMessageId: "native-A" });
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-A",
			});
		});
	});

	it("retirement unlaunches a not-yet-delivered Run with no released token (L1 item 2, 3.6)", () => {
		agreed("claude", (d) => {
			// Main's run.requested with no run.dispatched: a held start no transmission reached.
			admit(d, "A");
			const runId = `main-A-${d.next()}`;
			main(d, { kind: "run_requested", runId, inputId: "A", direct: false });
			expect(lose(d, "r1").ended).toEqual([]);
			expect(d.view().active).toMatchObject({ runId, tag: "Queued" });
		});
	});

	it("a Refused release after the Run ended process lost finds it Ended, and the input runs on a new Run (F40)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			lose(d, "r1");
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: a.token,
					kind: "run_released",
					reason: { tag: "Refused", why: "retiring" },
				},
			});
			started(d, "r2:1");
			admit(d, "A");
			const again = request(d, "A", "r2");
			expect(again.runId).not.toBe(a.runId);
			expect(d.view().active).toMatchObject({ runId: again.runId });
		});
	});

	it("Stop and Run now interrupt the Run, naming main's runs in the interrupt (R5 r1, 5.1)", () => {
		for (const commit of ["stop", "run_now"] as const)
			agreed("claude", (d) => {
				const a = running(d);
				if (commit === "stop") stop(d);
				else runNow(d, "B");
				expect(d.view().active).toMatchObject({
					runId: a.runId,
					tag: "Interrupting",
					by: commit,
				});
				expect(d.latest("interrupt").effect).toEqual({
					kind: "interrupt",
					runId: a.runId,
					runIds: [a.runId],
				});
				expect(complete(d, a.token)).toMatchObject([
					{ runId: a.runId, outcome: "completed" },
				]);
			});
		// A Run nothing of which may act ends at once with no effect.
		agreed("claude", (d) => {
			const a = begin(d);
			observe(d, a.token, { kind: "run_released", reason: "NotSent" });
			expect(stop(d).ended).toMatchObject([
				{ runId: a.runId, reason: { tag: "interrupted", forced: false } },
			]);
			expect(d.view().live).toEqual([]);
		});
	});

	it("OpenCode Stop issues cancel_request and a native_session probe with its interrupt (5.1)", () => {
		agreed("opencode", (d) => {
			const a = running(d);
			const stopped = stop(d);
			expect(stopped.issued.map(({ effect }) => effect.kind).sort()).toEqual([
				"cancel_request",
				"interrupt",
				"probe",
			]);
			expect(d.view().live).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						tag: "Main",
						effect: expect.objectContaining({
							kind: "interrupt",
							runId: a.runId,
						}),
					}),
					expect.objectContaining({
						tag: "Tokened",
						effect: { kind: "cancel_request", runId: a.runId },
					}),
				]),
			);
		});
	});

	it("one Stop rule over the inbox and claimed rows: a retry-pending start is never re-sent and a claimed, untransmitted start ends with its Run (32.2.6 AC5, 5.4)", () => {
		// Coverage is main's stopCovers (5.2, 5.4); the ledger reads only the folded Stop and holds no
		// re-send of its own: a retry is main's next transmission (3.4, 3.7).
		agreed("opencode", (d) => {
			const a = begin(d);
			observe(d, a.token, { kind: "started" });
			const retryAt = d.now + 300;
			observe(d, a.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt },
			});
			stop(d);
			expect(d.view().active).toMatchObject({ tag: "Interrupting" });
			expect(d.alarmAt).not.toBe(retryAt);
			expect(transmissions(d, "A")).toHaveLength(1);
		});
		// A held start main claimed but never transmitted ends with its Run at the Stop.
		agreed("claude", (d) => {
			admit(d, "A");
			const runId = `main-A-${d.next()}`;
			main(d, { kind: "run_requested", runId, inputId: "A", direct: false });
			expect(stop(d).ended).toMatchObject([
				{ runId, reason: { tag: "interrupted", forced: false } },
			]);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
	});

	it("a Stop or end with a deadlineAt and no label work outside main's runs opens no ledger stop deadline (L6)", () => {
		// CONTRACT.md 793-794: with no such work the arm opens none. Work with no open main run is a wake
		// execution (32.2.11) or a send of an ended main run, and main's terminal seals the latter.
		agreed("opencode", (d) => {
			const a = running(d);
			stop(d, 5_000);
			expect(d.alarmAt).not.toBe(5_000);
			expect(d.view().active).not.toHaveProperty("deadlineAt");
			main(d, { kind: "run_terminal", runId: a.runId, outcome: "interrupted" });
			stop(d, 9_000);
			expect(d.alarmAt).not.toBe(9_000);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
	});

	it("on Claude, input_accepted on a re-dispatched transmission 2 accepts the input (3.4, 4.3)", () => {
		agreed("claude", (d) => {
			const a = begin(d);
			const t2 = "hold-A-again" as SendToken;
			observe(d, t2, {
				kind: "run_dispatched",
				runId: a.runId,
				runnerId: "r1",
				commandId: "cmd-A-1",
				transmission: 2,
			});
			observe(d, t2, { kind: "input_accepted", nativeMessageId: "native-A" });
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-A",
			});
		});
	});
});

describe("[32.2.8] core answers, steers, OpenCode and Cursor: the bead's acceptance criteria", () => {
	/** The fixed traces that reach a wake or a background task, both 32.2.11's (scenarios.test.ts). */
	const wakes = new Set(["L6-2", "L6-3", "PL-1", "PL-2", "PL-6"]);
	const settle = (
		d: Driver,
		settlement: Extract<LedgerCommand, { verb: "settle" }>["settlement"],
	) => step(d, { verb: "settle", settlement });
	const lose = (d: Driver, runnerId: string) =>
		settle(d, { kind: "process_lost", runnerId, retiredAt: d.now });
	const answer = (d: Driver, interactionId: string, commandId: string) =>
		d.step({
			verb: "control",
			control: { kind: "answer", commandId, interactionId, answer: "no" },
		});
	/** One label's interaction, read by the Run, and one its runner raised unsolicited (3.10). */
	const twoPending = (d: Driver) => {
		const a = running(d);
		observe(d, a.token, {
			kind: "interaction_requested",
			interactionId: "q",
			interactionKind: "permission",
		});
		unsolicited(d, {
			kind: "interaction_requested",
			interactionId: "p",
			interactionKind: "question",
		});
		expect(d.view().interactions.map(({ tag }) => tag)).toEqual([
			"Pending",
			"Pending",
		]);
		return a;
	};

	// AC: per-provider harness runs green vs oracle for Claude, Cursor and OpenCode. The generated
	// half is "<provider> generated plain-path traces agree with the oracle at every step" above.
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("every fixed %s trace runs to its end in lockstep with the oracle, but for 32.2.11's wakes", (provider) => {
		const fixed = scenarios.filter(
			(candidate) => candidate.provider === provider,
		);
		expect(fixed.length).toBeGreaterThan(0);
		for (const trace of fixed)
			if (!wakes.has(trace.id)) agreed(provider, trace.run);
	});

	it("a sibling steer's unsettled delivery_unknown blocks its input's automatic resend until a probe settles it (32.2.6 AC3, 3.5)", () => {
		agreed("opencode", (d) => {
			running(d);
			const b1 = begin(d, "B", "steer");
			observe(d, b1.token, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
			// 3.6: main tries B again under its own runId; the retryable sibling would return B to the queue.
			const b2 = request(d, "B");
			observe(d, b2.token, {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 1 },
			});
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Delivered",
				certainty: "unknown",
			});
			const [probe] = fire(d).issued;
			assert(probe?.tag === "Tokened", "the recovery probe is decide's");
			expect(probe.effect).toMatchObject({
				kind: "probe",
				target: { tag: "input", inputId: "B" },
			});
			expect(transmissions(d, "B")).toHaveLength(1);
			observe(d, probe.token, {
				kind: "probe_result",
				finding: { tag: "input_absent" },
			});
			expect(visibleInput(d, "B")?.state).toEqual({ tag: "Queued" });
		});
	});

	it("a runner retired before its process_started is recorded retired, and that process_started changes nothing (L1)", () => {
		// CONTRACT.md 349-350: retirement is final and runnerIds are never reused.
		agreed("claude", (d) => {
			lose(d, "r2");
			noLifecycleChange(d, {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "r2:1",
					reattached: false,
				},
			});
			step(d, {
				verb: "control",
				control: { kind: "end", commandId: "end-1", deadlineAt: null },
			});
			expect(d.latest("end_session").effect).toEqual({
				kind: "end_session",
				runId: null,
				label: "r1:1",
			});
		});
	});

	it("a steer its Run's end left unconsumed is a Run of its own at main's run.started (3.9)", () => {
		// CONTRACT.md 978-981: from that end it is a Run of its own, its reservation's, Launched.
		agreed("opencode", (d) => {
			const a = running(d);
			const b = begin(d, "B", "steer");
			complete(d, a.token);
			expect(d.view().active).toBeUndefined();
			main(d, { kind: "run_started", inputId: "B", requestedRunId: b.runId });
			expect(d.view().active).toMatchObject({
				runId: b.runId,
				tag: "Running",
			});
			expect(
				main(d, { kind: "run_terminal", runId: b.runId, outcome: "completed" })
					.ended,
			).toMatchObject([{ runId: b.runId, reason: { tag: "completed" } }]);
		});
	});

	it("the first answer wins, and a refused answer stays Pending with its lastRefusal (3.10)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			const first = ask(d, a.token, "q1");
			expect(first.effect).toMatchObject({
				kind: "deliver_answer",
				label: "r1:1",
				interactionId: "q1",
			});
			const second = answer(d, "q1", "answer-again");
			expect(second.issued).toEqual([]);
			observe(d, tokenOf(first), {
				kind: "effect_outcome",
				outcome: { tag: "retryable", retryAt: d.now + 100, code: "Refused" },
				transmission: claimOf(first),
			});
			expect(d.view().interactions).toEqual([
				{
					tag: "Pending",
					interactionId: "q1",
					kind: "question",
					lastRefusal: { attempt: claimOf(first), code: "Refused" },
				},
			]);
		});
	});

	it.each([
		["its runner's retirement", (d: Driver) => lose(d, "r1")],
		["a Stop's commit", (d: Driver) => stop(d)],
		[
			"the session's end",
			(d: Driver) => {
				step(d, {
					verb: "control",
					control: { kind: "end", commandId: "end-1", deadlineAt: null },
				});
				const end = d.latest("end_session");
				observe(d, tokenOf(end), {
					kind: "effect_outcome",
					outcome: { tag: "succeeded" },
					transmission: claimOf(end),
				});
			},
		],
	])("unanswered interactions resolve at %s (3.10)", (_when, resolve) => {
		agreed("claude", (d) => {
			twoPending(d);
			resolve(d);
			expect(d.view().interactions).toEqual([]);
		});
	});
});
