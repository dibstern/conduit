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
import { Driver, scenarios } from "./scenarios.js";

/** Inputs the 32.2.5 slice leaves to a later lane; a trace that reaches one stops there. */
const notBuilt = /^not yet built \(32\.2\.(6|7|8|11)\): /;

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
	const commandIds = ["c1", "c2"];
	/** A generated answer to its round's own send. */
	const own = "own" as SendToken;
	const retryAt = fc.constantFrom(600, 9_000);
	const code = fc.constantFrom("Refused", "native_resume_rejected");
	const answer = (
		token: fc.Arbitrary<SendToken>,
	): fc.Arbitrary<LedgerCommand> =>
		fc
			.tuple(
				token,
				fc.oneof(
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
					),
					retryAt.map(
						(at): Evidence => ({
							kind: "effect_outcome",
							outcome: { tag: "retryable", retryAt: at },
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
				),
			)
			.map(([to, fields]) => ({
				verb: "observe",
				observation: { tag: "Answer", token: to, ...fields },
			}));
	const commandFor = (provider: ProviderKind): fc.Arbitrary<LedgerCommand> =>
		fc.oneof(
			{
				weight: 3,
				arbitrary: fc.constantFrom(...inputs).map(
					(inputId): LedgerCommand => ({
						verb: "admit",
						inputId,
						delivery: "queue",
						request: { text: inputId },
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
						fc.constantFrom("r1", "r2"),
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
					fc.constantFrom("r1:1", "r1:2", "r2:1").map(
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
									delivery: "queue",
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
							];
							return [
								...skeleton.map((command) => [command, 1] as const),
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
							if (stepped.decision.tag === "Accepted")
								for (const ended of stepped.decision.ended)
									reached.ends.add(ended.reason.tag);
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
					...(provider === "opencode" ? ["Settling"] : []),
				]),
			);
			expect([...reached.ends]).toEqual(
				expect.arrayContaining([
					"completed",
					"provider_error",
					"refused",
					"process_lost",
				]),
			);
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
