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
	Settlement,
	Task,
	TaskKey,
	Unsolicited,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { traceAction } from "./fake-provider.js";
import {
	DifferentialTrace,
	driver,
	policy,
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
	terminal,
	tokenOf,
	transmissions,
	unsolicited,
	visibleInput,
	wake,
} from "./scenarios.js";

/** 8.2: a shell, a subagent under a native run_id, and an ambient monitor (kind and class from task_type). */
const shell = {
	key: { taskId: "t1" },
	taskType: "local_bash",
	description: "build",
	ambient: false,
};
const subagent = {
	key: { taskId: "t2", runId: "run-b" },
	taskType: "local_agent",
	description: "review",
	ambient: false,
};
const monitor = {
	key: { taskId: "t3", runId: "run-a" },
	taskType: "monitor",
	description: "watch",
	ambient: true,
};

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
 * its entries' replay) and that decide mutates nothing, through the harness driver.
 */
function lockstep(provider: ProviderKind) {
	assert(referenceImplementation, "the oracle is available");
	const expected = driver(referenceImplementation, provider, "reference");
	const actual = driver(decider, provider, "reference");
	return (
		command: LedgerCommand,
		now: number,
	): { decision: Decision<unknown>; view: LedgerView } => {
		const want = expected.step(command, now);
		const got = actual.step(command, now);
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
	)("fixed trace %s agrees with the oracle at every step", (_id, scenario) => {
		const recorded = new Recording(scenario.provider);
		scenario.run(recorded);
		const step = lockstep(scenario.provider);
		for (const [command, now] of recorded.log ?? []) step(command, now);
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
	/** 32.2.11: native commands (8.5), claimed the same way. */
	const nativeIds = ["n1", "n2"];
	const claims = [...controlIds, ...answerIds, ...nativeIds].flatMap(
		(commandId) =>
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
								// The fake's steer joins and the named join test cover a distinct started run.
								runId: requestedRunId,
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
				// 8.2, 8.3, 8.5: the background alphabet on a label, with no Send Token (3.4): snapshots, task
				// events, wake turns, a Claude wake's own end, wake evidence and native command receipts (D61).
				weight: 6,
				arbitrary: fc
					.tuple(
						fc.nat(40),
						fc.constantFrom(...labels),
						fc.constantFrom<Unsolicited>(
							{ kind: "tasks_snapshot", tasks: [] },
							{ kind: "tasks_snapshot", tasks: [shell] },
							{ kind: "tasks_snapshot", tasks: [monitor, subagent] },
							{ kind: "task_event", key: subagent.key, event: "notification" },
							{ kind: "task_event", key: shell.key, event: "completed" },
							{ kind: "turn_started" },
							{ kind: "turn_started", wakeTask: subagent.key },
							{ kind: "turn_ended" },
							{ kind: "activity" },
							{ kind: "result", outcome: "completed" },
							{ kind: "query_ended" },
							...nativeIds.flatMap((commandId): Unsolicited[] => [
								{ kind: "command_lifecycle", commandId, state: "queued" },
								{ kind: "command_lifecycle", commandId, state: "started" },
								{ kind: "command_result", commandId },
							]),
						),
					)
					.map(
						([event, label, evidence]): LedgerCommand => ({
							verb: "observe",
							observation: {
								tag: "Unsolicited",
								label,
								eventId: `w${event}`,
								...evidence,
							},
						}),
					),
			},
			{
				// 8.4, 8.5: Stop tasks and main's native commands (D60).
				weight: 3,
				arbitrary: fc.oneof(
					fc
						.tuple(
							fc.constantFrom(...nativeIds),
							fc.constantFrom("/goal clear", "/goal pause"),
						)
						.map(
							([commandId, text]): LedgerCommand => ({
								verb: "control",
								control: { kind: "native_command", commandId, text },
							}),
						),
					fc.constantFrom<LedgerCommand>(
						{ verb: "control", control: { kind: "stop_tasks", tasks: "all" } },
						{
							verb: "control",
							control: { kind: "stop_tasks", tasks: [shell.key] },
						},
					),
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
					// 8.3: a reattach's tasks are unknown until its snapshot.
					fc.tuple(fc.constantFrom(...labels), fc.boolean()).map(
						([label, reattached]): LedgerCommand => ({
							verb: "settle",
							settlement: { kind: "process_started", label, reattached },
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
		["codex", 822505],
	] as const)
		it(`${provider} generated plain-path traces agree with the oracle at every step, seed ${seed}`, ({
			task,
		}) => {
			const reached = { views: new Set<string>(), ends: new Set<string>() };
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
							// 8.3: a self-started turn on r1's first label before the round's admit (CONTRACT.md
							// 2808-2809: Cursor starts none).
							wake: fc.boolean().map((wake) => wake && provider !== "cursor"),
							// 8.5: a goal command after the round's request, and the receipts r1:1 gives it.
							native: fc.option(
								fc.constantFrom<readonly ("queued" | "started" | "result")[]>(
									[],
									["result"],
									["started", "result"],
									["queued", "started", "result"],
									["queued"],
								),
								{ nil: undefined },
							),
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
								...(round.wake
									? [
											{
												verb: "observe",
												observation: {
													tag: "Unsolicited",
													label: "r1:1",
													eventId: `wake${index}`,
													kind: "turn_started",
												},
											} satisfies LedgerCommand,
										]
									: []),
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
								...(round.native === undefined
									? []
									: [
											{
												verb: "control",
												control: {
													kind: "native_command",
													commandId: `goal${index}`,
													text: "/goal clear",
												},
											} satisfies LedgerCommand,
											...round.native.map(
												(receipt): LedgerCommand => ({
													verb: "observe",
													observation: {
														tag: "Unsolicited",
														label: "r1:1",
														eventId: `goal${index}-${receipt}`,
														...(receipt === "result"
															? {
																	kind: "command_result",
																	commandId: `goal${index}`,
																}
															: {
																	kind: "command_lifecycle",
																	commandId: `goal${index}`,
																	state: receipt,
																}),
													},
												}),
											),
										]),
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
							// 8.2 to 8.5: wake Runs, tasks and native commands.
							if (active?.origin === "wake") reached.views.add("wake");
							reached.views.add(`tasks:${stepped.view.tasks.tag}`);
							for (const command of stepped.view.nativeCommands)
								reached.views.add(`native:${command.tag}`);
							// 3.13: main's Stop and end rows, and decide's own cancel_request, are live.
							for (const { effect } of stepped.view.live)
								if (
									effect.kind === "interrupt" ||
									effect.kind === "end_session" ||
									effect.kind === "cancel_request" ||
									effect.kind === "steer" ||
									effect.kind === "deliver_answer" ||
									effect.kind === "stop_task" ||
									effect.kind === "send_native_command"
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
					// 32.2.11: tasks, wake Runs and native commands (8.2 to 8.5).
					"tasks:none",
					"send_native_command",
					"native:Sent",
					"native:Unconfirmed",
					"native:Failed",
					...(provider === "cursor" ? [] : ["wake"]),
					// 8.2: Claude's tasks and Codex's background terminals.
					...(provider === "claude" || provider === "codex"
						? ["tasks:unknown", "tasks:live", "stop_task"]
						: []),
					...(provider === "claude"
						? ["native:Queued", "native:Started", "native:Completed"]
						: []),
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
			// A generated trace takes 4 to 7 s alone, so the 10 s default fails it under the
			// pre-commit hook's parallel build and typecheck.
		}, 30_000);

	it("a run.dispatched after its Run ended, by a native terminal or a Stop before the claim, binds no live start (H3, 12A)", () => {
		for (const end of ["nativeTerminal", "stop"] as const)
			agreed("claude", (d) => {
				admit(d, "A");
				const runId = `main-A-${d.next()}`;
				main(d, { kind: "run_requested", runId, inputId: "A", direct: false });
				if (end === "stop") stop(d);
				else terminal(d, runId);
				expect(d.view().active).toBeUndefined();
				for (const transmission of [1, 2])
					noLifecycleChange(d, {
						verb: "observe",
						observation: {
							tag: "Answer",
							token: `hold-A-${transmission}` as SendToken,
							kind: "run_dispatched",
							runId,
							runnerId: "r1",
							commandId: "cmd-A",
							transmission,
						},
					});
				expect(
					d.view().live.filter((issue) => issue.effect.kind === "start"),
				).toEqual([]);
			});
	});

	it("a relaunch's run.dispatched moves its input from Queued to Dispatching, with or without main's fresh-run run.requested (3.6, 3.9, 4.11)", () => {
		for (const fresh of [false, true])
			agreed("claude", (d) => {
				const a = begin(d);
				observe(d, a.token, { kind: "run_released", reason: "NotSent" });
				expect(visibleInput(d, "A")?.state).toEqual({ tag: "Queued" });
				// Main's retry on a fresh run names the Run its input holds and transmits nothing (3.4).
				const runId = fresh ? `main-A-${d.next()}` : a.runId;
				if (fresh)
					main(d, {
						kind: "run_requested",
						runId,
						inputId: "A",
						direct: false,
					});
				expect(visibleInput(d, "A")?.state).toEqual({ tag: "Queued" });
				const t2 = "hold-A-2" as SendToken;
				observe(d, t2, {
					kind: "run_dispatched",
					runId,
					runnerId: "r1",
					commandId: "cmd-A-1",
					transmission: 2,
				});
				expect(d.view().active).toMatchObject({
					runId: a.runId,
					tag: "Starting",
				});
				expect(visibleInput(d, "A")?.state).toEqual({ tag: "Dispatching" });
				observe(d, t2, { kind: "input_accepted", nativeMessageId: "native-A" });
				expect(visibleInput(d, "A")?.state).toEqual({
					tag: "Accepted",
					nativeMessageId: "native-A",
				});
			});
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
	for (const [command, now] of recorded.log ?? []) step(command, now);
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
			fixed.run(d);
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

	it("a raced retryable after a sweep ended a control row joins its chains and revives nothing (3.4, 3.5)", () => {
		// Long seed 82103201 (codex), failure mode 120: Failed beats Retrying in the transport join, so
		// the row stays ended and main never claims it again (CONTRACT.md 465, 476, 560-561).
		agreed("claude", (d) => {
			lose(d, "r1");
			end(d);
			const issue = d.latest("end_session");
			const answer = (
				outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
			) =>
				observe(d, tokenOf(issue), {
					kind: "effect_outcome",
					outcome,
					transmission: claimOf(issue),
				});
			answer({ tag: "permanent", code: "provider_process_gone" });
			answer({ tag: "retryable", retryAt: d.now + 100, code: "late" });
			expect(d.view().live).toEqual([]);
			expect(d.view().anythingMayAct).toBe(false);
		});
	});

	it("coverage withdraws a declined start's retry, so its runner's loss ends a Run whose query already ended (3.6, 3.8)", () => {
		// Long seed 82103200 (opencode), failure mode 126: the query's end had already ended the start's
		// work, so retirement's coverage left no mark the retry check read, and the Run waited on a
		// retry nothing could send. Coverage withdraws a retry (CONTRACT.md 699-701), and a covered
		// send that possibly reached ends its Run process lost (CONTRACT.md 845-847, 863-866).
		agreed("opencode", (d) => {
			const { token } = begin(d);
			observe(d, token, { kind: "query_ended" });
			observe(d, token, { kind: "input_declined", reason: "busy" });
			expect(lose(d, "r1").ended).toMatchObject([
				{ reason: { tag: "process_lost" } },
			]);
		});
	});

	it("a result naming no input answers no send that never started, a released one included (3.4)", () => {
		// Long seed 82103201 (claude), failure mode 124: a released start's chains read past None, so a
		// result naming none, with no wake, answered it and showed its input sent. It names only the
		// starts and steers that have started on that query (CONTRACT.md 501-505).
		agreed("claude", (d) => {
			const { token } = begin(d);
			observe(d, token, { kind: "run_released", reason: "JournalAbsent" });
			unsolicited(d, { kind: "result", outcome: "completed" });
			expect(visibleInput(d, "A")).toEqual({
				inputId: "A",
				state: { tag: "Queued" },
			});
		});
	});

	it("a repeated unsolicited event whose first arrival changed nothing is still a repeat (3.4, 3.1)", () => {
		// Long seed 82103300 (claude), failure mode 122: a turn start that joined the outstanding
		// wake execution recorded nothing, so the same (label, event id) after the Run ended opened
		// another wake Run. Its identity is the pair; a repeat is Accepted with no events
		// (CONTRACT.md 496-497).
		agreed("claude", (d) => {
			wake(d);
			const repeat: LedgerCommand = {
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "r1:1",
					eventId: "again",
					kind: "turn_started",
				},
			};
			step(d, repeat);
			stop(d, d.now + 100);
			fire(d);
			expect(d.view().active).toBeUndefined();
			step(d, repeat);
			expect(d.view().active).toBeUndefined();
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
		agreed("claude", (d) => {
			// What follows the last ':' is not decimal, so the whole label is the runnerId (L1).
			started(d, "host:abc");
			lose(d, "host:abc");
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

	/** A runner-held start that ended before any hold, so main's run.dispatched never came (3.4, 4.4). */
	const unheld = (
		d: Driver,
		outcome: Extract<Settlement, { kind: "unheld_outcome" }>["outcome"],
	) => {
		admit(d, "A");
		const runId = `main-A-${d.next()}`;
		main(d, { kind: "run_requested", runId, inputId: "A", direct: false });
		return step(d, {
			verb: "settle",
			settlement: {
				kind: "unheld_outcome",
				runId,
				commandId: "cmd-A-1",
				outcome,
			},
		});
	};
	const released = (
		d: Driver,
		reason: Extract<Evidence, { kind: "run_released" }>["reason"],
	) => observe(d, begin(d).token, { kind: "run_released", reason });

	// The relaunch's run.dispatched counts holds per commandId; an unheld try took none (4.3).
	it.each<readonly [string, (d: Driver) => Decision<unknown>, number]>([
		["a NotSent release", (d) => released(d, "NotSent"), 2],
		["a JournalAbsent release", (d) => released(d, "JournalAbsent"), 2],
		["a ResumeRejected release", (d) => released(d, "ResumeRejected"), 2],
		...(["exiting", "retiring", "interrupted"] as const).map(
			(why) =>
				[
					`a Refused ${why} release`,
					(d: Driver) => released(d, { tag: "Refused", why }),
					2,
				] as const,
		),
		[
			"a retryable try before any hold",
			(d) => unheld(d, { tag: "retryable", retryAt: d.now + 50 }),
			1,
		],
		[
			"a not_sent try before any hold",
			(d) => unheld(d, { tag: "not_sent", retryAt: d.now + 50 }),
			1,
		],
	])("(32.2.5 D50) %s unlaunches the Run to Queued, and main's relaunch under the same commandId is its next transmission (CONTRACT.md 664-670)", (_, cause, transmission) => {
		agreed("claude", (d) => {
			expect(cause(d)).toMatchObject({ tag: "Accepted", ended: [] });
			const runId = "main-A-1";
			expect(d.view().active).toMatchObject({ runId, tag: "Queued" });
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Queued" });
			const t2 = "hold-A-relaunch" as SendToken;
			observe(d, t2, {
				kind: "run_dispatched",
				runId,
				runnerId: "r1",
				commandId: "cmd-A-1",
				transmission,
			});
			expect(d.view().active).toMatchObject({ runId, tag: "Starting" });
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Dispatching" });
			observe(d, t2, { kind: "input_accepted", nativeMessageId: "native-A" });
			expect(visibleInput(d, "A")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-A",
			});
		});
	});

	it("(32.2.5 D50) a permanent try before any hold ends the Run refused instead of unlaunching it (3.8, CONTRACT.md 667-668)", () => {
		agreed("claude", (d) => {
			expect(
				unheld(d, { tag: "permanent", code: "project_inactive" }).ended,
			).toMatchObject([
				{
					runId: "main-A-1",
					outcome: "error",
					reason: { tag: "refused", code: "project_inactive" },
				},
			]);
			expect(d.view().active).toBeUndefined();
		});
	});

	it("(32.2.5 D50) Run now on a Run not yet delivered ends it interrupted at once with no effect (CONTRACT.md 664-666)", () => {
		const queued = (d: Driver) => {
			admit(d, "A");
			const runId = `main-A-${d.next()}`;
			main(d, { kind: "run_requested", runId, inputId: "A", direct: false });
			lose(d, "r1");
			return runId;
		};
		const launched = (d: Driver) => {
			const a = begin(d);
			observe(d, a.token, { kind: "run_released", reason: "NotSent" });
			return a.runId;
		};
		for (const notDelivered of [queued, launched])
			agreed("claude", (d) => {
				const runId = notDelivered(d);
				admit(d, "B");
				const committed = runNow(d, "B");
				expect(committed.ended).toMatchObject([
					{ runId, reason: { tag: "interrupted", forced: false } },
				]);
				expect(committed.issued).toEqual([]);
			});
	});

	it("(32.2.6) a steer the unlaunched Run issued is tried again in the relaunched execution after its start (3.9, L2 case 2, CONTRACT.md 680-681)", () => {
		agreed("claude", (d) => {
			const a = begin(d);
			const b = begin(d, "B", "steer");
			// The release covers every send of the Run, so none was handed over (4.5, D50).
			for (const token of [a.token, b.token])
				observe(d, token, { kind: "run_released", reason: "NotSent" });
			expect(d.view().active).toMatchObject({ runId: a.runId, tag: "Queued" });
			expect(visibleInput(d, "B")?.state).toEqual({ tag: "Queued" });
			const relaunched = (input: string, runId: string, commandId: string) => {
				const token = `hold-${input}-relaunch` as SendToken;
				observe(d, token, {
					kind: "run_dispatched",
					runId,
					runnerId: "r1",
					commandId,
					transmission: 2,
				});
				return token;
			};
			const a2 = relaunched("A", a.runId, "cmd-A-1");
			const b2 = relaunched("B", b.runId, "cmd-B-2");
			expect(d.view().active).toMatchObject({
				runId: a.runId,
				tag: "Starting",
			});
			expect(visibleInput(d, "B")?.state).toEqual({ tag: "Dispatching" });
			observe(d, a2, { kind: "started" });
			observe(d, a2, { kind: "input_accepted", nativeMessageId: "native-A" });
			observe(d, b2, { kind: "input_accepted", nativeMessageId: "native-B" });
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-B",
			});
			expect(complete(d, a2)).toMatchObject([
				{ runId: a.runId, outcome: "completed" },
			]);
		});
	});

	it("(32.2.14 R5 r2) a Claude follow-up after a completed Run launches at once into the live query, with no wait and no close (9, D59)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			// Claude's work ends at its result, so the fence lifts with no query_ended (9).
			expect(
				observe(d, a.token, { kind: "result", outcome: "completed" }).ended,
			).toMatchObject([{ runId: a.runId, outcome: "completed" }]);
			const b = begin(d, "B");
			expect(d.view().active).toMatchObject({
				runId: b.runId,
				tag: "Starting",
			});
			expect(visibleInput(d, "B")?.state).toEqual({ tag: "Dispatching" });
			expect(d.label).toBe("r1:1");
			expect(
				d.issued.filter(({ effect }) =>
					["end_session", "interrupt"].includes(effect.kind),
				),
			).toEqual([]);
			observe(d, b.token, {
				kind: "input_accepted",
				nativeMessageId: "native-B",
			});
			expect(visibleInput(d, "B")?.state).toEqual({
				tag: "Accepted",
				nativeMessageId: "native-B",
			});
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

	it("an OpenCode query_ended ends the Run's start, not its Stop's cancel_request, which a probe issued after it ends (CONTRACT.md 334-338, 3101-3106)", () => {
		agreed("opencode", (d) => {
			const a = running(d);
			const probe = stop(d).issued.find(
				(entry) => entry.effect.kind === "probe",
			);
			assert(probe?.tag === "Tokened", "the Stop's probe");
			const cancel = expect.objectContaining({
				tag: "Tokened",
				effect: { kind: "cancel_request", runId: a.runId },
			});
			observe(d, a.token, { kind: "query_ended" });
			expect(d.view().live).toEqual(expect.arrayContaining([cancel]));
			observe(d, probe.token, {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(d.view().live).not.toEqual(expect.arrayContaining([cancel]));
		});
	});

	it("main's OpenCode terminal ends the Run, but its Stop's cancel_request whose call has not returned stays a fence member until the call returns, a probe issued after it, or a stop_unconfirmed terminal (CONTRACT.md 788-789, 797-799, 3101-3106)", () => {
		const cancelOf = (runId: string) =>
			expect.objectContaining({
				tag: "Tokened",
				effect: { kind: "cancel_request", runId },
			});
		agreed("opencode", (d) => {
			const a = running(d);
			const probe = stop(d).issued.find(
				(entry) => entry.effect.kind === "probe",
			);
			assert(probe?.tag === "Tokened", "the Stop's probe");
			expect(terminal(d, a.runId, "interrupted").ended).toMatchObject([
				{ runId: a.runId },
			]);
			expect(d.view().live).toEqual(
				expect.arrayContaining([cancelOf(a.runId)]),
			);
			observe(d, probe.token, {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
		agreed("opencode", (d) => {
			const a = running(d);
			stop(d);
			main(d, {
				kind: "run_terminal",
				runId: a.runId,
				outcome: "interrupted",
				code: "stop_unconfirmed",
			});
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
		agreed("opencode", (d) => {
			const a = running(d);
			const cancel = stop(d).issued.find(
				(entry) => entry.effect.kind === "cancel_request",
			);
			assert(cancel?.tag === "Tokened", "the Stop's cancel_request");
			terminal(d, a.runId, "interrupted");
			expect(d.view().live).toEqual(
				expect.arrayContaining([cancelOf(a.runId)]),
			);
			observe(d, cancel.token, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
			expect(d.view().live).not.toEqual(
				expect.arrayContaining([cancelOf(a.runId)]),
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

	it("(32.2.8 8-A) an end with a deadlineAt and no active Run adds nothing to the stop, where a Stop would add its label work (8.4, CONTRACT.md 2889-2898)", () => {
		for (const commit of ["end", "stop"] as const)
			agreed("opencode", (d) => {
				// A send of an ended main run is label work no open main run owns (788-789).
				const a = running(d);
				stop(d, 5_000);
				main(d, {
					kind: "run_terminal",
					runId: a.runId,
					outcome: "interrupted",
				});
				expect(d.view().active).toBeUndefined();
				const committed = commit === "stop" ? stop(d, 9_000) : end(d, 9_000);
				// The Stop's own probe deadline fires first (3.7).
				while ((d.alarmAt ?? 9_000) < 9_000) fire(d);
				if (commit === "stop") expect(d.alarmAt).toBe(9_000);
				else {
					expect(committed.issued.map(({ effect }) => effect.kind)).toEqual([
						"end_session",
					]);
					expect(d.alarmAt).not.toBe(9_000);
				}
			});
	});

	it("a Stop or end with a deadlineAt and no label work outside main's runs opens no ledger stop deadline (L6)", () => {
		// CONTRACT.md 793-794: with no such work the arm opens none. Work with no open main run is a wake
		// execution (the [32.2.11] block shows it opening) or a send of an ended main run, which main's
		// terminal seals.
		agreed("opencode", (d) => {
			const a = running(d);
			stop(d, 5_000);
			expect(d.alarmAt).not.toBe(5_000);
			expect(d.view().active).not.toHaveProperty("deadlineAt");
			// The stop's deadline step: main's stop_unconfirmed terminal ends the aborts too (797-799).
			main(d, {
				kind: "run_terminal",
				runId: a.runId,
				outcome: "interrupted",
				code: "stop_unconfirmed",
			});
			stop(d, 9_000);
			expect(d.alarmAt).not.toBe(9_000);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
		// Any other terminal leaves the abort and cancel_request open, a send whose run main has ended,
		// so the next Stop's deadline bounds them (788-789, 3101-3106).
		agreed("opencode", (d) => {
			const a = running(d);
			stop(d, 5_000);
			main(d, { kind: "run_terminal", runId: a.runId, outcome: "interrupted" });
			stop(d, 9_000);
			fire(d, 8_999);
			expect(d.view().live).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						effect: { kind: "cancel_request", runId: a.runId },
					}),
				]),
			);
			fire(d, 9_000);
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
	] as const)("every fixed %s trace runs to its end in lockstep with the oracle", (provider) => {
		const fixed = scenarios.filter(
			(candidate) => candidate.provider === provider,
		);
		expect(fixed.length).toBeGreaterThan(0);
		for (const trace of fixed) agreed(provider, trace.run);
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
			main(d, {
				kind: "run_started",
				runId: b.runId,
				inputId: "B",
				requestedRunId: b.runId,
			});
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

	it("a run main started for a native message and joined a requested Run into names that Run, so its terminal ends it (CONTRACT.md 148, 956)", () => {
		// 3.9: main joins the requested Run into the run it observed open; its run.started names that
		// run as metadata.runId and the Run as requestedRunId, and main's terminal comes under the former.
		agreed("opencode", (d) => {
			const a = running(d);
			main(d, {
				kind: "run_started",
				runId: "observed-run",
				inputId: "A",
				requestedRunId: a.runId,
			});
			expect(
				main(d, {
					kind: "run_terminal",
					runId: "observed-run",
					outcome: "completed",
				}).ended,
			).toMatchObject([{ runId: a.runId, reason: { tag: "completed" } }]);
			expect(d.view().active).toBeUndefined();
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
			"a Run now's commit (8-A)",
			(d: Driver) =>
				step(d, {
					verb: "control",
					control: {
						kind: "run_now",
						commandId: "run-now-1",
						inputId: "B",
						deadlineAt: null,
					},
				}),
		],
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

describe("[32.2.11] core background tasks, wake Runs and native commands: the bead's acceptance criteria", () => {
	type Snapshot = Extract<Unsolicited, { kind: "tasks_snapshot" }>;
	const lose = (d: Driver, runnerId: string) =>
		step(d, {
			verb: "settle",
			settlement: { kind: "process_lost", runnerId, retiredAt: d.now },
		});
	const started = (d: Driver, label: string, reattached = false) =>
		step(d, {
			verb: "settle",
			settlement: { kind: "process_started", label, reattached },
		});
	const native = (d: Driver, commandId: string, text: string) =>
		step(d, {
			verb: "control",
			control: { kind: "native_command", commandId, text },
		});
	const stopTasks = (d: Driver, tasks: "all" | readonly TaskKey[]) =>
		d.step({ verb: "control", control: { kind: "stop_tasks", tasks } });
	const snapshot = (d: Driver, tasks: Snapshot["tasks"], label = "r1:1") =>
		unsolicited(d, { kind: "tasks_snapshot", tasks }, label);
	/** A native command's receipt at `now`, unsolicited under its label (D61). */
	const receipt = (
		d: Driver,
		evidence: Extract<
			Unsolicited,
			{ kind: "command_lifecycle" | "command_result" }
		>,
		now?: number,
	) =>
		step(
			d,
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: d.label,
					eventId: `receipt-${d.next()}`,
					...evidence,
				},
			},
			now,
		);
	const viewed = (
		task: Snapshot["tasks"][number],
		kind: string,
		taskClass: Task["class"],
	): Task => ({
		...task,
		kind,
		class: taskClass,
	});

	it('Claude goal probe "Pause on idle did nothing": an idle native command issues at once, starts no Run and its zero-turn result completes it (8.5, LI6, LI8, LI10)', () => {
		agreed("claude", (d) => {
			const issued = native(d, "n1", "/goal pause").issued;
			const sent = {
				tag: "Main",
				commandId: "n1",
				effect: {
					kind: "send_native_command",
					commandId: "n1",
					text: "/goal pause",
				},
			};
			// LI6 (D60): in live and nativeCommands in the decision that folds its control.
			expect(issued).toEqual([sent]);
			expect(d.view()).toMatchObject({
				live: [sent],
				anythingMayAct: true,
				nativeCommands: [
					{
						commandId: "n1",
						tag: "Sent",
						deadline: {
							owner: "NativeCommand",
							commandId: "n1",
							at: d.now + policy.nativeCommandMs,
						},
					},
				],
			});
			expect(d.view().active).toBeUndefined();
			// LI10: a zero-turn result never ends or starts a Run.
			const done = receipt(d, { kind: "command_result", commandId: "n1" });
			expect(done.ended).toEqual([]);
			expect(d.view().active).toBeUndefined();
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Completed" },
			]);
		});
	});

	it("Claude goal probe: a clear sent mid-turn is held by Claude, never times out while queued, then resumes with the time it had left (8.5)", () => {
		const d = agreed("claude", (d) => {
			running(d);
			native(d, "n1", "/goal clear");
			const issuedAt = d.now;
			receipt(
				d,
				{ kind: "command_lifecycle", commandId: "n1", state: "queued" },
				issuedAt + 300,
			);
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Queued" },
			]);
			expect(d.alarmAt).toBeUndefined();
			receipt(
				d,
				{ kind: "command_lifecycle", commandId: "n1", state: "started" },
				issuedAt + 60_000,
			);
			expect(d.view().nativeCommands).toEqual([
				{
					commandId: "n1",
					tag: "Started",
					deadline: {
						owner: "NativeCommand",
						commandId: "n1",
						at: issuedAt + 60_000 + policy.nativeCommandMs - 300,
					},
				},
			]);
			const done = receipt(d, { kind: "command_result", commandId: "n1" });
			expect(done.ended).toEqual([]);
			expect(d.view().active).toMatchObject({
				tag: "Running",
				origin: "input",
			});
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Completed" },
			]);
		});
		expect(d.coverage.races["a clear held by Claude"]).toBe(1);
	});

	it("Claude goal probe: an idle clear completes with no Run (8.5)", () => {
		const d = agreed("claude", (d) => {
			native(d, "n1", "/goal clear");
			receipt(d, { kind: "command_result", commandId: "n1" });
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Completed" },
			]);
			expect(d.view().active).toBeUndefined();
		});
		expect(d.coverage.races["an idle clear"]).toBe(1);
	});

	it("a native command with no confirmation is Unconfirmed at its deadline, and a reply after it completes it (8.5)", () => {
		agreed("claude", (d) => {
			native(d, "n1", "/goal clear");
			expect(d.alarmAt).toBe(d.now + policy.nativeCommandMs);
			fire(d);
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Unconfirmed" },
			]);
			expect(d.alarmAt).toBeUndefined();
			receipt(d, { kind: "command_result", commandId: "n1" }, d.now + 10_000);
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Completed" },
			]);
		});
	});

	it("a permanent effect_outcome gives Failed{code} and finishes the send; a native command never gets not_sent (8.5, D34)", () => {
		const d = agreed("claude", (d) => {
			native(d, "n1", "/goal clear");
			const sent = d.latest("send_native_command");
			expect(
				d.step({
					verb: "observe",
					observation: {
						tag: "Answer",
						token: tokenOf(sent),
						kind: "effect_outcome",
						outcome: { tag: "not_sent", retryAt: d.now },
						transmission: claimOf(sent),
					},
				}).tag,
			).toBe("Rejected");
			observe(d, tokenOf(sent), {
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "Refused" },
				transmission: claimOf(sent),
			});
			expect(d.view()).toMatchObject({
				live: [],
				anythingMayAct: false,
				nativeCommands: [{ commandId: "n1", tag: "Failed", code: "Refused" }],
			});
			expect(d.alarmAt).toBeUndefined();
		});
		expect(d.coverage.races["a native command refused at delivery"]).toBe(1);
	});

	it.each([
		["process_lost", (d: Driver) => lose(d, "r1")],
		[
			"session_ended",
			(d: Driver) =>
				step(d, {
					verb: "settle",
					settlement: {
						kind: "session_ended",
						cause: "native_session_vanished",
					},
				}),
		],
	])("a covered native command gives Failed{%s} by its covering cause (8.5)", (code, cover) => {
		agreed("claude", (d) => {
			native(d, "n1", "/goal pause");
			cover(d);
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Failed", code },
			]);
		});
	});

	it.each([
		["process_lost", (d: Driver) => lose(d, "r1")],
		[
			"session_ended",
			(d: Driver) =>
				step(d, {
					verb: "settle",
					settlement: {
						kind: "session_ended",
						cause: "native_session_vanished",
					},
				}),
		],
	])("a covered native command carries no deadline, so no alarm fires it, whatever its waiting variant (%s, 8.5)", (code, cover) => {
		agreed("claude", (d) => {
			native(d, "n1", "/goal pause");
			const sentDeadline = d.now + policy.nativeCommandMs;
			native(d, "n2", "/goal clear");
			receipt(d, {
				kind: "command_lifecycle",
				commandId: "n2",
				state: "started",
			});
			native(d, "n3", "/goal resume");
			receipt(d, {
				kind: "command_lifecycle",
				commandId: "n3",
				state: "queued",
			});
			cover(d);
			// A late start for the covered, queued n3 must not re-arm its paused deadline.
			receipt(d, {
				kind: "command_lifecycle",
				commandId: "n3",
				state: "started",
			});
			expect(d.view().nativeCommands).toEqual(
				["n1", "n2", "n3"].map((commandId) => ({
					commandId,
					tag: "Failed",
					code,
				})),
			);
			expect(d.alarmAt).toBeUndefined();
			expect(fire(d, sentDeadline + 60_000).events).toEqual([]);
		});
	});

	it("a native command issued with no process is pending and resolves at the next process_started, whose loss covers it (L2 case 3, 8.5)", () => {
		agreed("claude", (d) => {
			lose(d, "r1");
			native(d, "n1", "/goal pause");
			expect(d.view()).toMatchObject({
				tasks: { tag: "none" },
				nativeCommands: [{ commandId: "n1", tag: "Sent" }],
			});
			started(d, "r2:1");
			expect(d.view().nativeCommands).toMatchObject([
				{ commandId: "n1", tag: "Sent" },
			]);
			lose(d, "r2");
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Failed", code: "process_lost" },
			]);
		});
	});

	it("snapshots and a wake turn start are accepted with no Send Token; the wake Run starts nothing and names the last task notified, by arrival order (3.4, 8.2, 8.3, LI9)", () => {
		agreed("claude", (d) => {
			snapshot(d, [monitor, subagent]);
			// run-b arrives before run-a: arrival order names the waking task, never run_id order.
			unsolicited(d, {
				kind: "task_event",
				key: subagent.key,
				event: "notification",
			});
			unsolicited(d, {
				kind: "task_event",
				key: monitor.key,
				event: "notification",
			});
			const woken = wake(d);
			expect(woken.issued).toEqual([]);
			const active = d.view().active;
			expect(active).toMatchObject({
				origin: "wake",
				wakeTask: monitor.key,
				inputs: [],
			});
			// LI9: one wake Run per self-started turn; a repeat joins it.
			expect(wake(d).issued).toEqual([]);
			expect(d.view().active?.runId).toBe(active?.runId);
		});
	});

	it("a turn_started during an active input Run joins it, with no wake Run (8.3)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			const joined = wake(d);
			expect(joined.issued).toEqual([]);
			expect(d.view().active).toMatchObject({
				runId: a.runId,
				origin: "input",
			});
		});
	});

	it("races: a wake turn while an input is queued, and a snapshot during Interrupting", () => {
		// 8.3 (CONTRACT.md 2808-2809): Cursor starts no unsolicited turn, so wakes run on the others.
		const queued = agreed("opencode", (d) => {
			admit(d, "B");
			wake(d);
			expect(d.view().active).toMatchObject({ origin: "wake", inputs: [] });
		});
		expect(queued.coverage.races["a wake turn while an input is queued"]).toBe(
			1,
		);
		const interrupting = agreed("claude", (d) => {
			running(d);
			stop(d);
			expect(d.view().active).toMatchObject({ tag: "Interrupting" });
			snapshot(d, []);
		});
		expect(interrupting.coverage.races["a snapshot during Interrupting"]).toBe(
			1,
		);
	});

	it("task kind and class come from task_type and ambient, in snapshot arrival order (8.2)", () => {
		agreed("claude", (d) => {
			expect(d.view().tasks).toEqual({ tag: "none" });
			snapshot(d, [subagent, monitor, shell]);
			expect(d.view().tasks).toEqual({
				tag: "live",
				label: "r1:1",
				tasks: [
					viewed(subagent, "subagent", "work"),
					viewed(monitor, "monitor", "monitoring"),
					viewed(shell, "shell", "work"),
				],
			});
		});
	});

	it("a task with a live linked server reads serving unless the server is declared awaited, and falls back when it goes (8.2, 8.7)", () => {
		// Decider only: the oracle does not model servers (reference.ts server cases noop).
		const d = new Driver("claude", "decider");
		const server = (port: number, taskId: string) => ({
			server: { pid: port, startedAt: 1, port },
			command: "node server.js",
			cwd: "/w",
			taskKey: { taskId },
		});
		const seen = (
			port: number,
			taskId: string,
			extra: { source: "detected" | "declared"; role?: "serving" | "awaited" },
		) =>
			d.step({
				verb: "settle",
				settlement: { kind: "server_seen", ...server(port, taskId), ...extra },
			});
		const classes = () => {
			const tasks = d.view().tasks;
			return tasks.tag === "live"
				? tasks.tasks.map((task) => [task.key.taskId, task.class])
				: tasks.tag;
		};
		snapshot(d, [subagent, monitor, shell]);
		seen(3000, "t1", { source: "detected" });
		seen(3001, "t3", { source: "detected" });
		seen(3002, "t9", { source: "detected" });
		expect(classes()).toEqual([
			["t2", "work"],
			["t3", "monitoring"],
			["t1", "serving"],
		]);
		seen(3000, "t1", { source: "declared", role: "awaited" });
		expect(classes()).toEqual([
			["t2", "work"],
			["t3", "monitoring"],
			["t1", "work"],
		]);
		seen(3000, "t1", { source: "declared", role: "serving" });
		expect(classes()).toContainEqual(["t1", "serving"]);
		d.step({
			verb: "settle",
			settlement: { kind: "server_gone", server: server(3000, "t1").server },
		});
		expect(classes()).toEqual([
			["t2", "work"],
			["t3", "monitoring"],
			["t1", "work"],
		]);
	});

	it("tasks: none after a fresh launch and with no process, unknown on a reattach until its snapshot, and after a replacement only the new process's (8.3, 8.4)", () => {
		agreed("claude", (d) => {
			snapshot(d, []);
			lose(d, "r1");
			expect(d.view().tasks).toEqual({ tag: "none" });
			started(d, "r2:1", true);
			expect(d.view().tasks).toEqual({ tag: "unknown", label: "r2:1" });
			// A retired runner's late snapshot changes nothing (L1.4).
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "r1:1",
					eventId: "late",
					kind: "tasks_snapshot",
					tasks: [shell],
				},
			});
			snapshot(d, [monitor], "r2:1");
			expect(d.view().tasks).toEqual({
				tag: "live",
				label: "r2:1",
				tasks: [viewed(monitor, "monitor", "monitoring")],
			});
		});
	});

	it.each<Unsolicited>([
		{ kind: "turn_started" },
		{ kind: "tasks_snapshot", tasks: [shell] },
		{ kind: "task_event", key: shell.key, event: "notification" },
		{ kind: "activity" },
		{ kind: "result", outcome: "completed" },
		{ kind: "query_ended" },
	])("LI7: older-label $kind changes neither authority nor liveness (8.3)", (evidence) => {
		agreed("claude", (d) => {
			snapshot(d, []);
			// 8.4, L5: r1:2 raises the runner, ending r1:1's scope.
			unsolicited(d, { kind: "activity" }, "r1:2");
			snapshot(d, [], "r1:2");
			running(d);
			noLifecycleChange(d, {
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "r1:1",
					eventId: "older",
					...evidence,
				},
			});
		});
	});

	it('stop_tasks: "all" stops the live tasks and a named key its own; a task is gone only when a later snapshot omits it (8.4, LI8)', () => {
		agreed("claude", (d) => {
			snapshot(d, [shell, subagent]);
			const all = stopTasks(d, "all");
			assert(all.tag === "Accepted");
			expect(all.issued.map(({ effect }) => effect)).toEqual([
				{ kind: "stop_task", key: shell.key },
				{ kind: "stop_task", key: subagent.key },
			]);
			expect(d.view().anythingMayAct).toBe(true);
			unsolicited(d, { kind: "task_event", key: shell.key, event: "killed" });
			expect(d.view().tasks).toMatchObject({ tasks: [shell, subagent] });
			snapshot(d, [subagent]);
			expect(d.view().tasks).toMatchObject({ tasks: [subagent] });
		});
		agreed("claude", (d) => {
			snapshot(d, [shell, subagent]);
			const named = stopTasks(d, [subagent.key]);
			assert(named.tag === "Accepted");
			expect(named.issued.map(({ effect }) => effect)).toEqual([
				{ kind: "stop_task", key: subagent.key },
			]);
		});
	});

	it.each([
		["none", "claude", () => {}],
		[
			"unknown",
			"claude",
			(d: Driver) => {
				snapshot(d, []);
				unsolicited(d, { kind: "activity" }, "r1:2");
			},
		],
		["unsupported", "cursor", () => {}],
		["unsupported", "opencode", () => {}],
		["no current process", "claude", (d: Driver) => lose(d, "r1")],
	] as const)("stop_tasks is rejected with tasks %s on %s and issues nothing (8.4)", (_tasks, provider, arrange) => {
		agreed(provider, (d) => {
			arrange(d);
			const before = d.view();
			expect(stopTasks(d, "all").tag).toBe("Rejected");
			expect(d.view()).toEqual(before);
		});
	});

	it("L6: a Stop with a wake Run opens the ledger stop deadline, a later Stop keeps it, and its alarm ends the wake forced", () => {
		agreed("opencode", (d) => {
			wake(d);
			const runId = d.view().active?.runId;
			stop(d, 5_000);
			expect(d.view().active).toMatchObject({
				origin: "wake",
				deadline: { owner: "Stop", at: 5_000 },
			});
			stop(d, 9_000);
			expect(d.view().active).toMatchObject({
				deadline: { owner: "Stop", at: 5_000 },
			});
			// OpenCode's Stop probes (3.7) fire first; only the stop deadline ends the wake.
			while ((d.alarmAt ?? 5_000) < 5_000) expect(fire(d).ended).toEqual([]);
			expect(d.alarmAt).toBe(5_000);
			expect(fire(d).ended).toMatchObject([
				{ runId, reason: { tag: "interrupted", forced: true } },
			]);
			expect(d.view().active).toBeUndefined();
		});
		// Claude's alarm is the same; its wake Run's view shows no deadline (gap, CONTRACT.md 787-794).
		agreed("claude", (d) => {
			wake(d);
			const runId = d.view().active?.runId;
			stop(d, 5_000);
			stop(d, 9_000);
			expect(d.alarmAt).toBe(5_000);
			expect(fire(d).ended).toMatchObject([
				{ runId, reason: { tag: "interrupted", forced: true } },
			]);
			expect(d.alarmAt).toBeUndefined();
		});
	});

	it("L6, REDESIGN-11: a hung wake past the deadline ends forced with no process loss, and main's input Run started meanwhile stays open", () => {
		agreed("claude", (d) => {
			wake(d);
			const runId = d.view().active?.runId;
			stop(d, 5_000);
			const a = begin(d);
			const fired = fire(d);
			expect(fired.ended).toMatchObject([
				{ runId, reason: { tag: "interrupted", forced: true } },
			]);
			expect(fired.ended).toHaveLength(1);
			expect(d.view().active).toMatchObject({
				runId: a.runId,
				origin: "input",
			});
		});
	});

	it("(11-C) after a restart, a hung wake past the deadline ends forced, and the owner Run open at the Stop stays main's with no process loss or ledger effect (REDESIGN-11, CONTRACT.md 807-816)", () => {
		agreed("claude", (d) => {
			wake(d);
			const wakeRunId = d.view().active?.runId;
			const a = begin(d);
			stop(d, 5_000);
			const owner = d.view().active;
			d.restart();
			expect(d.alarmAt).toBe(5_000);
			const fired = fire(d);
			expect(fired.ended).toEqual([
				expect.objectContaining({
					runId: wakeRunId,
					reason: expect.objectContaining({ tag: "interrupted", forced: true }),
				}),
			]);
			expect(fired.issued).toEqual([]);
			expect(d.view().active).toEqual(owner);
			expect(d.view().active?.runId).toBe(a.runId);
		});
	});

	it("a wake Run's interrupt is addressed to its turn_started label's runner and covered when that runner retires (3.3, L2 case 2)", () => {
		agreed("claude", (d) => {
			wake(d);
			const runId = d.view().active?.runId;
			stop(d);
			expect(d.view().live).toMatchObject([
				{ effect: { kind: "interrupt", runId } },
			]);
			expect(lose(d, "r1").ended).toMatchObject([
				{ runId, reason: { tag: "process_lost" } },
			]);
			expect(d.view()).toMatchObject({ live: [], anythingMayAct: false });
		});
	});

	it("(11-A) a second Stop adds the wake work started since the first and keeps the first's deadline (L6, REDESIGN-7)", () => {
		agreed("claude", (d) => {
			wake(d);
			const runId = d.view().active?.runId;
			stop(d, 5_000);
			// A turn joining the wake Run under a newer label is a wake execution of its own (D28).
			wake(d, "r1:2");
			stop(d, 9_000);
			expect(d.alarmAt).toBe(5_000);
			expect(fire(d).ended).toMatchObject([
				{ runId, reason: { tag: "interrupted", forced: true } },
			]);
			expect(d.view()).toMatchObject({ live: [] });
			expect(d.view().active).toBeUndefined();
			expect(d.alarmAt).toBeUndefined();
		});
	});

	it("(11-B) an interaction on a label no Run reads stays Pending and is answered with a null runId (3.10)", () => {
		agreed("claude", (d) => {
			const a = running(d);
			unsolicited(d, {
				kind: "interaction_requested",
				interactionId: "p",
				interactionKind: "question",
			});
			complete(d, a.token);
			expect(d.view().active).toBeUndefined();
			expect(d.view().interactions).toMatchObject([
				{ tag: "Pending", interactionId: "p" },
			]);
			step(d, {
				verb: "control",
				control: {
					kind: "answer",
					commandId: "answer-p",
					interactionId: "p",
					answer: "yes",
				},
			});
			expect(d.latest("deliver_answer").effect).toEqual({
				kind: "deliver_answer",
				runId: null,
				label: "r1:1",
				interactionId: "p",
				answer: "yes",
			});
		});
	});

	it("(11-D) a Run main launches under a Stop with no foreground Run waits at the Claude wake's fence, and the wake's turn_ended leaves it no deadline to force it (D59, L6)", () => {
		agreed("claude", (d) => {
			wake(d);
			const wakeRunId = d.view().active?.runId;
			stop(d, 5_000);
			admit(d, "A");
			const runId = `main-A-${d.next()}`;
			main(d, { kind: "run_requested", runId, inputId: "A", direct: false });
			// Main launched A after the commit; its start waits at the wake's fence (8.3, L6).
			const waiting = {
				runId,
				origin: "input",
				tag: "Starting",
				inputs: [{ inputId: "A", state: { tag: "Queued" } }],
			};
			expect(d.view().active).toEqual(waiting);
			const ended = unsolicited(d, { kind: "turn_ended" });
			expect(ended.ended).toMatchObject([
				{ runId: wakeRunId, reason: { tag: "interrupted", forced: false } },
			]);
			expect(d.view().active).toEqual(waiting);
			// The wake was the stop's only work, so no deadline is left to force A.
			expect(d.alarmAt).toBeUndefined();
			observe(d, `hold-A-${runId}` as SendToken, {
				kind: "run_dispatched",
				runId,
				runnerId: "r1",
				commandId: "cmd-A",
				transmission: 1,
			});
			expect(visibleInput(d, "A")?.state).toEqual({ tag: "Dispatching" });
		});
	});

	it("D59: a Claude wake's turn_ended is its own end, interrupted and not forced after a Stop; other providers' turn_ended is Rejected", () => {
		agreed("claude", (d) => {
			wake(d);
			const runId = d.view().active?.runId;
			stop(d, 5_000);
			expect(unsolicited(d, { kind: "turn_ended" }).ended).toMatchObject([
				{ runId, reason: { tag: "interrupted", forced: false } },
			]);
		});
		agreed("opencode", (d) => {
			wake(d);
			expect(
				d.step({
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: "r1:1",
						eventId: "turn-ended",
						kind: "turn_ended",
					},
				}).tag,
			).toBe("Rejected");
		});
		// 8.3 (CONTRACT.md 2808): Cursor starts no unsolicited turn and has no turn_ended.
		agreed("cursor", (d) => {
			started(d, "r1:1");
			for (const kind of ["turn_started", "turn_ended"] as const)
				expect(
					d.step({
						verb: "observe",
						observation: {
							tag: "Unsolicited",
							label: "r1:1",
							eventId: kind,
							kind,
						},
					}).tag,
				).toBe("Rejected");
			expect(d.view().active).toBeUndefined();
		});
	});

	it("a Pause native command plus a wake Run leaves foreground authority unchanged, and a Stop issues no native command (8.5)", () => {
		const d = agreed("claude", (d) => {
			native(d, "n1", "/goal pause");
			wake(d);
			const active = d.view().active;
			expect(active).toMatchObject({ origin: "wake" });
			const done = receipt(d, { kind: "command_result", commandId: "n1" });
			expect(done.ended).toEqual([]);
			expect(d.view().active).toEqual(active);
			expect(stop(d).issued.map(({ effect }) => effect.kind)).not.toContain(
				"send_native_command",
			);
		});
		expect(
			d.coverage.races[
				"Pause native command plus wake Run leaves foreground authority unchanged"
			],
		).toBe(1);
	});

	it.each([
		["claude", 821101],
		["cursor", 821102],
		["opencode", 821103],
		["codex", 821104],
	] as const)("LI5 to LI10 hold against the fake on %s's generated traces, seed %i", (provider, seed) => {
		// The fake checks LI1 to LI10 at every step (assertStep). Every trace runs through; one is
		// discarded only where the oracle itself fails the fake (the pended convergence suite).
		const tally = { checked: 0, oracle: 0, gated: 0, lost: 0 };
		const kinds = new Set<string>();
		fc.assert(
			fc.property(fc.array(traceAction, { maxLength: 60 }), (actions) => {
				const real = new DifferentialTrace(
					provider,
					referenceImplementation,
					decider,
				);
				try {
					real.step({
						verb: "settle",
						settlement: {
							kind: "process_started",
							label: real.expected.label,
							reattached: false,
						},
					});
					for (const action of actions) {
						const { expected } = real;
						const packet = expected.host.next(action, {
							issued: expected.issued,
							view: expected.view(),
							now: expected.now,
							alarmAt: expected.alarmAt,
						});
						real.step(packet.command, packet.now);
						if (real.actual.view().pendingConfirm) tally.gated += 1;
					}
					if (real.actual.view().lostWork.length > 0) tally.lost += 1;
					tally.checked += 1;
				} catch (error) {
					if (real.actual.commands.length < real.expected.commands.length)
						tally.oracle += 1;
					else throw error;
				} finally {
					for (const [kind, count] of Object.entries(
						real.actual.coverage.kinds,
					))
						if (count > 0) kinds.add(kind);
				}
			}),
			{ seed, numRuns: 200 },
		);
		writeTraceArtifact(`background-fake-${provider}-${seed}`, {
			seed,
			tally,
			kinds: [...kinds].sort(),
		});
		expect(tally.checked).toBeGreaterThan(tally.oracle);
		// 32.2.12, 32.2.13: Claude's tasks and Codex's background terminals reach the confirm gate and
		// lost work on the real decider (8.4, L5).
		if (provider === "claude" || provider === "codex") {
			expect(tally.gated).toBeGreaterThan(0);
			expect(tally.lost).toBeGreaterThan(0);
		}
		expect([...kinds]).toEqual(
			expect.arrayContaining([
				"activity",
				...(provider === "cursor" ? [] : ["turn_started"]),
				...(provider === "claude" || provider === "codex"
					? ["tasks_snapshot", "task_event"]
					: []),
				...(provider === "claude"
					? ["command_lifecycle", "command_result"]
					: []),
			]),
		);
	});
});

describe("[32.2.12] core destructive confirm and lost work: the bead's acceptance criteria", () => {
	const settle = (
		d: Driver,
		settlement: Extract<LedgerCommand, { verb: "settle" }>["settlement"],
	) => step(d, { verb: "settle", settlement });
	const lose = (d: Driver, runnerId: string) =>
		settle(d, { kind: "process_lost", runnerId, retiredAt: d.now });
	const started = (d: Driver, label: string, reattached = false) =>
		settle(d, { kind: "process_started", label, reattached });
	const snapshot = (d: Driver, tasks: (typeof shell)[], label = d.label) =>
		unsolicited(d, { kind: "tasks_snapshot", tasks }, label);
	const end = (d: Driver, deadlineAt: number | null = null) =>
		step(d, {
			verb: "control",
			control: { kind: "end", commandId: `end-${d.next()}`, deadlineAt },
		});
	/** Confirms the gate the view shows, or a stale snapshotEntry when given (D45). */
	const confirm = (
		d: Driver,
		snapshotEntry = d.view().pendingConfirm?.snapshotEntry,
	) => {
		assert(snapshotEntry !== undefined, "a pending confirm is shown");
		return d.step({
			verb: "control",
			control: { kind: "confirm_escalation", snapshotEntry },
		});
	};
	const endSessions = (d: Driver) =>
		d.issued.filter(({ effect }) => effect.kind === "end_session");
	const liveShell = {
		tag: "live",
		label: "r1:1",
		tasks: [{ ...shell, kind: "shell", class: "work" }],
	} as const;
	const lostShell = {
		label: "r1:1",
		tag: "known",
		tasks: liveShell.tasks,
	} as const;

	describe("each destructive path gives the right confirm, or one lost-work fact per label (8.4, L3, L5)", () => {
		it("restart: an interrupted Run with live tasks waits on a retire confirm, and the relaunch's process_started records the old label's lost work once", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				running(d);
				stop(d, 9_000);
				expect(d.view().pendingConfirm).toEqual({
					step: "retire",
					labels: ["r1:1"],
					snapshotEntry: 2,
					tasks: liveShell,
				});
				expect(confirm(d)).toMatchObject({ tag: "Accepted", effects: [] });
				expect(d.view().pendingConfirm).toBeUndefined();
				started(d, "r2:1");
				expect(d.view().lostWork).toEqual([lostShell]);
				lose(d, "r2");
				expect(d.view().lostWork).toEqual([lostShell]);
			});
		});

		it("kill: the confirmed retire step's process_lost records the label's live tasks once", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				const a = running(d);
				stop(d, 9_000);
				expect(d.view().pendingConfirm?.step).toBe("retire");
				confirm(d);
				expect(lose(d, "r1").ended).toMatchObject([{ runId: a.runId }]);
				expect(d.view()).toMatchObject({ lostWork: [lostShell] });
				expect(d.view().pendingConfirm).toBeUndefined();
			});
		});

		it("end-session: end_session issues only at the confirm, addressed then, and session_ended records lost work once", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				end(d);
				expect(d.view().pendingConfirm).toMatchObject({ step: "end_session" });
				expect(endSessions(d)).toEqual([]);
				confirm(d);
				expect(endSessions(d)).toMatchObject([
					{ effect: { kind: "end_session", runId: null, label: "r1:1" } },
				]);
				settle(d, { kind: "session_ended", cause: "native_session_vanished" });
				settle(d, { kind: "session_ended", cause: "native_session_vanished" });
				expect(d.view().lostWork).toEqual([lostShell]);
			});
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				const a = running(d);
				end(d, 9_000);
				expect(d.view()).toMatchObject({
					active: { tag: "Interrupting", by: "end" },
					pendingConfirm: { step: "end_session" },
				});
				expect(endSessions(d)).toEqual([]);
				confirm(d);
				expect(endSessions(d)).toMatchObject([
					{ effect: { kind: "end_session", runId: a.runId, label: "r1:1" } },
				]);
			});
		});

		it("ignored interrupt: the Run stays Interrupting with its retire step gated, and nothing destroys on its own", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				const a = running(d);
				stop(d, 9_000);
				// The provider ignores the interrupt: its Run keeps working.
				expect(observe(d, a.token, { kind: "activity" }).issued).toEqual([]);
				expect(d.view()).toMatchObject({
					active: { tag: "Interrupting", runId: a.runId },
					pendingConfirm: { step: "retire", tasks: liveShell },
					tasks: liveShell,
					lostWork: [],
				});
			});
		});

		it("ignored interrupt while paused: a paused goal's ignored interrupt waits on the same retire confirm", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				step(d, {
					verb: "control",
					control: {
						kind: "native_command",
						commandId: "n1",
						text: "/goal pause",
					},
				});
				running(d);
				stop(d, 9_000);
				expect(d.view().pendingConfirm).toMatchObject({
					step: "retire",
					tasks: liveShell,
				});
			});
		});

		it("process loss: unplanned loss records lost work without asking, unknown for a reattached label", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				lose(d, "r1");
				expect(d.view().pendingConfirm).toBeUndefined();
				expect(d.view().lostWork).toEqual([lostShell]);
				started(d, "r2:1", true);
				lose(d, "r2");
				expect(d.view().lostWork).toEqual([
					lostShell,
					{ label: "r2:1", tag: "unknown" },
				]);
			});
		});

		it("pending kill: a destruction addressed to pending records nothing", () => {
			agreed("claude", (d) => {
				snapshot(d, [shell]);
				lose(d, "r1");
				end(d);
				expect(d.view().pendingConfirm).toBeUndefined();
				expect(d.latest("end_session").effect).toMatchObject({ label: null });
				started(d, "r2:1");
				expect(d.view().lostWork).toEqual([lostShell]);
			});
		});
	});

	it("a confirm after a process replacement issues the step to the current process (L3, L2)", () => {
		agreed("claude", (d) => {
			snapshot(d, [shell]);
			end(d);
			started(d, "r2:1", true);
			expect(d.view().pendingConfirm).toEqual({
				step: "end_session",
				labels: ["r2:1"],
				snapshotEntry: 3,
				tasks: { tag: "unknown", label: "r2:1" },
			});
			confirm(d);
			expect(endSessions(d)).toMatchObject([
				{ effect: { runId: null, label: "r2:1" } },
			]);
			expect(d.view().lostWork).toEqual([lostShell]);
		});
	});

	it("a step whose every address is retired issues nothing: its Run's end drops it (8.4, D43)", () => {
		agreed("claude", (d) => {
			snapshot(d, [shell]);
			const a = running(d);
			end(d);
			expect(d.view().pendingConfirm).toMatchObject({ step: "end_session" });
			expect(lose(d, "r1").ended).toMatchObject([{ runId: a.runId }]);
			expect(d.view().pendingConfirm).toBeUndefined();
			expect(endSessions(d)).toEqual([]);
		});
	});

	it("a confirm and clearing evidence issue the same effects (L3)", () => {
		const gated = (clear: (d: Driver) => void) =>
			endSessions(
				agreed("claude", (d) => {
					snapshot(d, [shell]);
					end(d);
					clear(d);
					expect(d.view().pendingConfirm).toBeUndefined();
				}),
			);
		const confirmed = gated((d) => confirm(d));
		expect(confirmed).toHaveLength(1);
		expect(gated((d) => snapshot(d, []))).toEqual(confirmed);
		// A clearing process_started: a newer label of the gated runner ends the gated label's scope
		// (L5, D44). The same end_session issues, addressed to the runner's latest label (L2, 3.3).
		expect(gated((d) => started(d, "r1:2"))).toEqual([
			{
				...confirmed[0],
				effect: { kind: "end_session", runId: null, label: "r1:2" },
			},
		]);
	});

	it("lost work is decided once per label, and a later scope end of a decided label records nothing (L5)", () => {
		agreed("claude", (d) => {
			snapshot(d, [shell]);
			// A newer querySeq ends r1:1's scope; its tasks are unknown until its first snapshot (D44).
			unsolicited(d, { kind: "activity" }, "r1:2");
			expect(d.view().lostWork).toEqual([lostShell]);
			lose(d, "r1");
			settle(d, { kind: "session_ended", cause: "native_session_vanished" });
			expect(d.view().lostWork).toEqual([
				lostShell,
				{ label: "r1:2", tag: "unknown" },
			]);
			started(d, "r2:1");
			settle(d, { kind: "session_ended", cause: "native_session_vanished" });
			lose(d, "r2");
			expect(d.view().lostWork).toHaveLength(2);
		});
	});

	it("a gate open on the current process releases when it is lost; a Run-less end_session goes to pending (PL-6)", () => {
		const pl6 = scenario("PL-6");
		agreed(pl6.provider, pl6.run);
	});

	it.each([
		"cursor",
		"opencode",
	] as const)("a reattached %s process never opens a gate, and its kill or process_lost records no lost work (8.3)", (provider) => {
		agreed(provider, (d) => {
			started(d, "r1:2", true);
			running(d);
			stop(d, 9_000);
			expect(d.view().active).toMatchObject({ tag: "Interrupting" });
			expect(d.view().pendingConfirm).toBeUndefined();
			end(d);
			expect(d.view().pendingConfirm).toBeUndefined();
			expect(endSessions(d)).toHaveLength(1);
			lose(d, "r1");
			expect(d.view().lostWork).toEqual([]);
		});
	});

	it("a Known-empty Claude kill opens no gate and records no lost work (L5, 8.3)", () => {
		agreed("claude", (d) => {
			running(d);
			stop(d, 9_000);
			expect(d.view().pendingConfirm).toBeUndefined();
			lose(d, "r1");
			expect(d.view().lostWork).toEqual([]);
		});
	});

	it("an end_session success and a rejected resume record no lost work (L5)", () => {
		agreed("claude", (d) => {
			snapshot(d, [shell]);
			end(d);
			confirm(d);
			const sent = d.latest("end_session");
			observe(d, tokenOf(sent), {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
				transmission: claimOf(sent),
			});
			expect(d.view().lostWork).toEqual([]);
		});
		agreed("claude", (d) => {
			snapshot(d, [shell]);
			const a = begin(d);
			observe(d, a.token, {
				kind: "run_released",
				reason: "ResumeRejected",
			});
			expect(d.view().lostWork).toEqual([]);
		});
	});

	it("the coverage gate's races: a stale confirm is rejected, and a label change mid-interrupt releases the gate (11.2, D45)", () => {
		const stale = agreed("claude", (d) => {
			snapshot(d, [shell]);
			running(d);
			stop(d, 9_000);
			const shown = d.view().pendingConfirm?.snapshotEntry;
			snapshot(d, [shell, monitor]);
			expect(confirm(d, shown)).toMatchObject({
				tag: "Rejected",
				diagnostic: "stale confirm (8.4)",
			});
			expect(d.view().pendingConfirm?.snapshotEntry).toBe((shown ?? 0) + 1);
			expect(confirm(d).tag).toBe("Accepted");
		});
		expect(stale.coverage.races["a stale confirm"]).toBe(1);
		const relabelled = agreed("claude", (d) => {
			snapshot(d, [shell]);
			running(d);
			stop(d, 9_000);
			started(d, "r2:1");
			expect(d.view().pendingConfirm).toBeUndefined();
			expect(d.view().lostWork).toEqual([lostShell]);
		});
		expect(relabelled.coverage.races["a label change mid-interrupt"]).toBe(1);
	});
});

describe("[32.2.13] core Codex policy: the bead's acceptance criteria", () => {
	const native = (d: Driver, commandId: string, text: string) =>
		step(d, {
			verb: "control",
			control: { kind: "native_command", commandId, text },
		});
	const snapshot = (d: Driver, tasks: (typeof shell)[]) =>
		unsolicited(d, { kind: "tasks_snapshot", tasks }, d.label);
	const result = (d: Driver, token: SendToken) =>
		observe(d, token, { kind: "result", outcome: "completed" });
	/** An unsolicited observation's decision tag, Rejected included. */
	const offered = (d: Driver, evidence: Unsolicited) =>
		d.step({
			verb: "observe",
			observation: {
				tag: "Unsolicited",
				label: d.label,
				eventId: `offered-${d.next()}`,
				...evidence,
			},
		}).tag;
	const goalPause = {
		tag: "Main",
		commandId: "n1",
		effect: {
			kind: "send_native_command",
			commandId: "n1",
			text: "/goal pause",
		},
	} as const;

	it("a turn_started that matches no pending host turn request is a wake Run; one while a host turn request is pending or running joins that Run (8.3, OPEN-6)", () => {
		// Codex sends no continuation marker: an idle self-started turn is a wake Run.
		agreed("codex", (d) => {
			expect(wake(d).issued).toEqual([]);
			expect(d.view().active).toMatchObject({ origin: "wake", inputs: [] });
		});
		// An admitted input main has not requested is no pending host turn request.
		const queued = agreed("codex", (d) => {
			admit(d, "A");
			wake(d);
			expect(d.view().active).toMatchObject({ origin: "wake", inputs: [] });
		});
		expect(queued.coverage.races["a wake turn while an input is queued"]).toBe(
			1,
		);
		agreed("codex", (d) => {
			const pending = begin(d);
			expect(wake(d).issued).toEqual([]);
			expect(d.view().active).toMatchObject({
				runId: pending.runId,
				origin: "input",
			});
			observe(d, pending.token, { kind: "started" });
			wake(d);
			expect(d.view().active).toMatchObject({
				runId: pending.runId,
				origin: "input",
			});
		});
	});

	it("the runner's result ends a Codex Run (9: CONTRACT.md 3087)", () => {
		agreed("codex", (d) => {
			const a = running(d);
			expect(result(d, a.token).ended).toMatchObject([
				{ runId: a.runId, outcome: "completed" },
			]);
			expect(d.view()).toMatchObject({ anythingMayAct: false });
			expect(d.view().active).toBeUndefined();
		});
	});

	it("must not happen: Stop pausing the goal. Stop interrupts only, and the goal stays active, so its next turn is a wake Run (8.1, 8.6, 11.2)", () => {
		agreed("codex", (d) => {
			// The idle-Stop goal-pause stopgap is deleted (8.1).
			stop(d);
			const a = running(d);
			expect(stop(d).issued.map(({ effect }) => effect.kind)).toEqual([
				"interrupt",
			]);
			expect(
				observe(d, a.token, { kind: "result", outcome: "interrupted" }).ended,
			).toMatchObject([{ runId: a.runId, outcome: "interrupted" }]);
			expect(
				d.issued.filter(({ effect }) => effect.kind === "send_native_command"),
			).toEqual([]);
			expect(d.view().nativeCommands).toEqual([]);
			wake(d);
			expect(d.view().active).toMatchObject({ origin: "wake", inputs: [] });
		});
	});

	it("background terminals are tasks: thread/backgroundTerminals/list is the snapshot and stop_tasks issues stop_task per terminal (8.2, 8.4)", () => {
		agreed("codex", (d) => {
			expect(d.view().tasks).toEqual({ tag: "none" });
			snapshot(d, [shell]);
			expect(d.view()).toMatchObject({
				anythingMayAct: true,
				tasks: {
					tag: "live",
					label: d.label,
					tasks: [{ ...shell, kind: "shell", class: "work" }],
				},
			});
			const stopped = step(d, {
				verb: "control",
				control: { kind: "stop_tasks", tasks: "all" },
			});
			expect(stopped.issued).toMatchObject([
				{ tag: "Tokened", effect: { kind: "stop_task", key: shell.key } },
			]);
		});
	});

	it("late terminal events after the turn ends update the snapshot only: no Run reopens and none is Rejected, a terminated terminal reading failed (8.2)", () => {
		agreed("codex", (d) => {
			const a = running(d);
			snapshot(d, [shell]);
			result(d, a.token);
			const late = unsolicited(d, {
				kind: "task_event",
				key: shell.key,
				event: "failed",
			});
			expect(late).toMatchObject({ issued: [], ended: [] });
			const reread = snapshot(d, []);
			expect(reread).toMatchObject({ issued: [], ended: [] });
			expect(d.view().active).toBeUndefined();
			expect(d.view().tasks).toEqual({ tag: "none" });
		});
	});

	it("a Codex wake ends at its result; turn_ended and command receipts are not Codex evidence (8.3, D46, 9)", () => {
		agreed("codex", (d) => {
			wake(d);
			expect(offered(d, { kind: "turn_ended" })).toBe("Rejected");
			const ended = unsolicited(d, { kind: "result", outcome: "completed" });
			expect(ended.ended).toMatchObject([{ outcome: "completed" }]);
			expect(d.view().active).toBeUndefined();
			native(d, "n1", "/goal clear");
			for (const receipt of [
				{ kind: "command_lifecycle", commandId: "n1", state: "started" },
				{ kind: "command_result", commandId: "n1" },
			] as const)
				expect(offered(d, receipt)).toBe("Rejected");
		});
	});

	it("a goal command issues at once with no Run and, with no receipts, is Unconfirmed at its deadline (8.5, LI6, LI10)", () => {
		agreed("codex", (d) => {
			expect(native(d, "n1", "/goal pause").issued).toEqual([goalPause]);
			expect(d.view()).toMatchObject({
				live: [goalPause],
				anythingMayAct: true,
			});
			expect(d.view().active).toBeUndefined();
			expect(d.alarmAt).toBe(d.now + policy.nativeCommandMs);
			fire(d);
			expect(d.view().nativeCommands).toEqual([
				{ commandId: "n1", tag: "Unconfirmed" },
			]);
			expect(d.view().active).toBeUndefined();
		});
	});

	describe("the Pause race: the ledger's side is the Pause's send and the turn's result (8.6, OPEN-6)", () => {
		it("a successor turn that wins the Pause race is a wake Run, ending at its result, and moves no foreground authority", () => {
			agreed("codex", (d) => {
				const a = running(d);
				native(d, "n1", "/goal pause");
				expect(result(d, a.token).ended).toMatchObject([{ runId: a.runId }]);
				wake(d);
				expect(d.view().active).toMatchObject({ origin: "wake", inputs: [] });
				expect(
					unsolicited(d, { kind: "result", outcome: "completed" }).ended,
				).toMatchObject([{ outcome: "completed" }]);
				expect(d.view().nativeCommands).toMatchObject([
					{ commandId: "n1", tag: "Sent" },
				]);
			});
		});

		// Gap (CONTRACT.md 3461-3463 against the bead's fourth criterion): Codex Pause then
		// budgetLimited is the goal tracker's (32.27), outside this ledger's coverage gate; the ledger
		// has no goal status, so its side is a Run ended at its result and no successor.
		it("Pause then budgetLimited: no successor turn, so the Run's result leaves only the Pause acting, Unconfirmed at its deadline for the tracker's thread/goal/get (11.2)", () => {
			agreed("codex", (d) => {
				const a = running(d);
				native(d, "n1", "/goal pause");
				result(d, a.token);
				expect(d.view().active).toBeUndefined();
				expect(d.view().live).toEqual([goalPause]);
				fire(d);
				// Gap (CONTRACT.md 2930-2934): with no receipts a Codex native command's send never
				// finishes, so it may act until coverage, as the oracle holds.
				expect(d.view()).toMatchObject({
					anythingMayAct: true,
					live: [goalPause],
					nativeCommands: [{ commandId: "n1", tag: "Unconfirmed" }],
				});
			});
		});
	});

	it("Codex's policy is its own row, not Claude's with flags: its evidence differs from every other provider's (9, OPEN-6)", () => {
		const row = (provider: ProviderKind) => {
			const tags: string[] = [];
			agreed(provider, (d) => {
				tags.length = 0;
				tags.push(offered(d, { kind: "tasks_snapshot", tasks: [shell] }));
				tags.push(offered(d, { kind: "turn_started" }));
				tags.push(offered(d, { kind: "turn_ended" }));
				native(d, "n1", "/goal clear");
				tags.push(offered(d, { kind: "command_result", commandId: "n1" }));
			});
			return tags.join(" ");
		};
		expect({
			claude: row("claude"),
			codex: row("codex"),
			cursor: row("cursor"),
			opencode: row("opencode"),
		}).toEqual({
			claude: "Accepted Accepted Accepted Accepted",
			codex: "Accepted Accepted Rejected Rejected",
			// 8.3 (CONTRACT.md 2808): Cursor starts no unsolicited turn.
			cursor: "Rejected Rejected Rejected Rejected",
			opencode: "Rejected Accepted Rejected Rejected",
		});
	});
});
