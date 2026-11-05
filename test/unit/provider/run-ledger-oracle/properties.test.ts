import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
	Evidence,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	Observation,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	FakeProvider,
	splitLabel,
	type TraceAction,
	traceAction,
} from "./fake-provider.js";
import {
	answer,
	Coverage,
	DifferentialTrace,
	type LedgerImplementation,
	namedRaces,
	observationKinds,
	PublicNames,
	policy,
	referenceImplementation,
	TraceDriver,
	translateCommand,
	writeTraceArtifact,
} from "./harness.js";
import { pendingCases, pendingSuite } from "./pending.js";
import { main } from "./review-traces.js";
import { Driver, scenarios } from "./scenarios.js";

const providers = ["claude", "codex", "cursor", "opencode"] as const;
const count = (name: string, fallback: number) => {
	const value = Number(process.env[name] ?? fallback);
	assert(
		Number.isSafeInteger(value) && value > 0,
		`${name} must be a positive integer`,
	);
	return value;
};
// The original six seeds remain stable; Codex has its own two seeds. RUN_LEDGER_TRACE_SEED_BASE
// swaps in eight consecutive seeds from that base, for a run on seeds no earlier run used.
const seedBase =
	process.env["RUN_LEDGER_TRACE_SEED_BASE"] === undefined
		? undefined
		: count("RUN_LEDGER_TRACE_SEED_BASE", 1);
const fixedSeeds: readonly [number, ...number[]] =
	seedBase === undefined
		? [
				82_103_200, 82_103_201, 82_103_202, 82_103_300, 82_103_301, 82_103_302,
				82_103_203, 82_103_303,
			]
		: [seedBase, ...Array.from({ length: 7 }, (_, i) => seedBase + i + 1)];
const runs = count("RUN_LEDGER_TRACE_RUNS", 100);
// A seed takes about 2.5 s alone at 100 runs, so the 10 s default fails it under the pre-commit
// hook's parallel build and typecheck; a long-seed run scales the bound with its run count.
const seedTimeout = 30_000 * Math.max(1, runs / 100);
const maxCommands = count("RUN_LEDGER_TRACE_COMMANDS", 80);
const oracleCoverage = new Coverage();
const emptyView = (): LedgerView => ({
	live: [],
	tasks: { tag: "none" },
	anythingMayAct: false,
	lostWork: [],
	nativeCommands: [],
	interactions: [],
});
function liveFake(
	provider: FakeProvider["provider"],
	totality = false,
): FakeProvider {
	const fake = new FakeProvider(provider, totality);
	fake.observe(
		{
			verb: "settle",
			settlement: {
				kind: "process_started",
				label: fake.label,
				reattached: false,
			},
		},
		emptyView(),
	);
	return fake;
}
const action: TraceAction = {
	operation: 6,
	selection: 0,
	index: 0,
	variant: 0,
	input: 0,
	advance: 0,
};

interface GenerationRun {
	readonly fake: FakeProvider;
	/** The fixture, then main's starts and steers as the fake plays main (D60). */
	readonly issued: IssuedEffect[];
	readonly packets: LedgerCommand[];
	readonly shapes: Record<string, number>;
	/** Host facts read from the packet stream only, for shape counting. */
	readonly hosts: {
		serving: string | undefined;
		readonly labels: Set<string>;
		readonly started: Set<string>;
		readonly retired: Set<string>;
	};
}
class GenerationCommand implements fc.Command<{ now: number }, GenerationRun> {
	constructor(readonly action: TraceAction) {}
	check(): boolean {
		return true;
	}
	run(model: { now: number }, real: GenerationRun): void {
		const view = {
			...emptyView(),
			live: real.issued.slice(1),
			anythingMayAct: true,
		};
		const packet = real.fake.next(this.action, {
			issued: real.issued,
			view,
			now: model.now,
			alarmAt: 1_100,
		});
		real.packets.push(packet.command);
		const hit = (shape: string) => {
			real.shapes[shape] = (real.shapes[shape] ?? 0) + 1;
		};
		const command = packet.command;
		const { hosts } = real;
		if (packet.now < model.now) hit("clock:backwards");
		if (command.verb === "settle") {
			const settlement = command.settlement;
			hit(`settlement:${settlement.kind}`);
			if (settlement.kind === "process_started") {
				const { runnerId, querySeq } = splitLabel(settlement.label);
				hit(
					`process_started:${settlement.reattached ? "reattached" : "fresh"}`,
				);
				if (runnerId.includes(":")) hit("process_started:runnerId-colon");
				if (querySeq === undefined) hit("process_started:no-querySeq");
				// A redelivered label is a duplicate, not a new start (6.9).
				if (hosts.labels.has(settlement.label))
					hit("process_started:duplicate");
				else hosts.serving = runnerId;
				hosts.labels.add(settlement.label);
				hosts.started.add(runnerId);
			}
			if (settlement.kind === "process_lost") {
				hit(
					settlement.runnerId === hosts.serving
						? "process_lost:serving"
						: !hosts.started.has(settlement.runnerId)
							? "process_lost:not-started"
							: hosts.serving === undefined
								? "process_lost:retired-none-serving"
								: "process_lost:known-non-current",
				);
				hosts.retired.add(settlement.runnerId);
				if (hosts.serving === settlement.runnerId) hosts.serving = undefined;
			}
		}
		if (command.verb === "control" && command.control.kind === "stop_tasks") {
			const tasks = command.control.tasks;
			hit(
				`stop_tasks:${tasks === "all" ? "all" : tasks.length > 1 ? "several" : "one"}`,
			);
		}
		if (command.verb === "admit") hit(`admit:${command.delivery}`);
		if (command.verb === "control") {
			const control = command.control;
			// G2 and L6: a stop commit's deadlineAt, or null for a commit L6 does not fold.
			hit(
				control.kind === "stop" ||
					control.kind === "end" ||
					control.kind === "run_now"
					? `control:${control.kind}:${control.deadlineAt === null ? "null" : "at"}`
					: `control:${control.kind}`,
			);
			// 3.4, 8.4 (round 2d): an end with a Run active, each row its own Control.
			const end = real.fake.ends.get(command);
			if (end) hit(`control:end:${end}`);
		}
		if (command.verb === "observe") {
			const e = command.observation;
			// D60: main's events, a steer's start joined to its open parent, and repeats by event id.
			if (e.tag === "Main") {
				const main = real.packets
					.slice(0, -1)
					.flatMap((p) =>
						p.verb === "observe" && p.observation.tag === "Main"
							? [p.observation]
							: [],
					);
				hit(
					main.some((m) => m.eventId === e.eventId)
						? "main:repeat"
						: e.kind === "run_requested"
							? `main:run_requested:${e.direct ? "direct" : "held"}`
							: e.kind === "run_terminal"
								? `main:run_terminal:${e.outcome}`
								: `main:run_started:${e.runId === e.requestedRunId ? "own" : "joined"}`,
				);
			}
			// 3.4: OpenCode's turn.error pair folds back to back, in either order.
			const previous = real.packets.at(-2);
			const prior =
				previous?.verb === "observe" ? previous.observation : undefined;
			if (
				e.tag === "Main" &&
				e.kind === "run_terminal" &&
				e.code === "TraceTurnError" &&
				prior?.tag === "Answer" &&
				prior.kind === "query_ended"
			)
				hit("main:opencode_pair:query_ended_first");
			if (
				e.tag === "Answer" &&
				e.kind === "query_ended" &&
				prior?.tag === "Main" &&
				prior.kind === "run_terminal" &&
				prior.code === "TraceTurnError"
			)
				hit("main:opencode_pair:terminal_first");
			if (e.tag === "Answer" && e.kind === "command_lifecycle") {
				const held = real.issued.find(
					(item) => real.fake.isHeld(item) && item.commandId === e.commandId,
				);
				if (held) hit(`answer:command_lifecycle:${held.effect.kind}`);
				if (
					held?.tag === "Main" &&
					!real.fake
						.bindingsFor(held)
						.some(({ send }) => send.token === e.token)
				)
					hit("answer:command_lifecycle:foreign-commandId");
			}
			if (e.tag === "Answer") {
				// Read the fake's transmissions without binding: bound() would claim an unclaimed control (3.4).
				const send = real.issued
					.flatMap((item) =>
						item.tag === "Tokened"
							? [item]
							: real.fake.bindingsFor(item).map(({ send }) => send),
					)
					.find(({ token }) => token === e.token);
				const address = send && splitLabel(real.fake.labelFor(send)).runnerId;
				if (address !== undefined && hosts.retired.has(address))
					hit("answer:retired-address");
			}
			if (e.tag === "Unsolicited")
				hit(
					`unsolicited:${e.kind}:${e.label === real.fake.label ? "own" : "other"}`,
				);
			// D61: an answer's confirming interaction_resolved and a native command's receipts are
			// unsolicited, before or after the control's outcome; on the control's token, adversarial.
			const control =
				e.tag === "Unsolicited" &&
				(e.kind === "interaction_resolved" ||
					e.kind === "command_lifecycle" ||
					e.kind === "command_result")
					? real.issued.find(
							({ effect }) =>
								(e.kind === "interaction_resolved" &&
									effect.kind === "deliver_answer" &&
									effect.interactionId === e.interactionId) ||
								(e.kind !== "interaction_resolved" &&
									effect.kind === "send_native_command" &&
									effect.commandId === e.commandId),
						)
					: undefined;
			if (control?.tag === "Main")
				hit(
					`unsolicited:${e.kind}:${control.effect.kind === "deliver_answer" ? "answer" : "native"}:${
						real.packets.some(
							(p) =>
								p.verb === "observe" &&
								p.observation.kind === "effect_outcome" &&
								p.observation.transmission?.commandId === control.commandId,
						)
							? "after"
							: "before"
					}`,
				);
			if (
				e.tag === "Answer" &&
				e.kind !== "effect_outcome" &&
				real.issued.some(
					(item) =>
						item.tag === "Main" &&
						!real.fake.isHeld(item) &&
						real.fake
							.bindingsFor(item)
							.some(({ send }) => send.token === e.token),
				)
			)
				hit("answer:control:evidence");
			if (e.tag === "Unsolicited" && e.kind === "result")
				hit(`unsolicited:result:${e.outcome}`);
			if (e.kind === "run_dispatched" && e.transmission > 1)
				hit("run_dispatched:transmission>1");
			if (e.kind === "run_dispatched" && !hosts.started.has(e.runnerId))
				hit("run_dispatched:before-runner-start");
			if (e.kind === "effect_outcome" && e.outcome.tag === "retryable")
				hit(
					e.outcome.retryAt > packet.now + policy.probeMs
						? "retryable:after-probe-deadline"
						: "retryable:before-probe-deadline",
				);
			if (e.kind === "tasks_snapshot" && e.tasks.length > 1)
				hit("tasks_snapshot:several");
			if (e.kind === "interaction_requested")
				hit(`interaction:${e.interactionKind}`);
		}
		real.fake.observe(packet.command, view);
		real.issued.push(...real.fake.takeMainIssues().map(({ issue }) => issue));
		// 8.5: with no decide here, a native command stands in for its send_native_command row.
		if (command.verb === "control" && command.control.kind === "native_command")
			real.issued.push({
				tag: "Main",
				commandId: command.control.commandId,
				effect: {
					kind: "send_native_command",
					commandId: command.control.commandId,
					text: command.control.text,
				},
			});
		model.now = packet.now;
	}
	toString(): string {
		return `generate(${JSON.stringify(this.action)})`;
	}
}

describe.each(providers)("%s fixed-seed alphabet generation", (provider) => {
	it("runs fc.commands/modelRun in CI, writes actual generated kinds and reproducible seeds", ({
		task,
	}) => {
		const kinds = { ...observationKinds };
		const outcomes: Record<string, number> = {};
		const shapes: Record<string, number> = {};
		const issued: IssuedEffect[] = [
			{
				tag: "Main",
				commandId: "old",
				effect: {
					kind: "start",
					runId: "old-run",
					inputId: "A",
					mode: "resume",
				},
			},
			{
				tag: "Main",
				commandId: "current",
				effect: { kind: "start", runId: "R", inputId: "B", mode: "fresh" },
			},
			{
				tag: "Main",
				commandId: "steer",
				effect: { kind: "steer", runId: "R", inputId: "C" },
			},
			{
				tag: "Tokened",
				token: "probe" as SendToken,
				effect: {
					kind: "probe",
					runId: "R",
					target: { tag: "input", inputId: "B" },
				},
			},
			{
				tag: "Main",
				commandId: "end-run",
				effect: { kind: "end_session", runId: "R", label: "host-0:1" },
			},
			{
				tag: "Main",
				commandId: "end-session",
				effect: { kind: "end_session", runId: null, label: "host-0:1" },
			},
			// Every control type main issues, so outcome:control:* counts each (3.4).
			{
				tag: "Main",
				commandId: "interrupt",
				effect: { kind: "interrupt", runId: "R", runIds: ["R"] },
			},
			{
				tag: "Main",
				commandId: "answer",
				effect: {
					kind: "deliver_answer",
					runId: "R",
					label: "host-0:1",
					interactionId: "question:0",
					answer: "yes",
				},
			},
			{
				tag: "Main",
				commandId: "native",
				effect: {
					kind: "send_native_command",
					commandId: "native",
					text: "/goal",
				},
			},
		];
		const seeds: unknown[] = [];
		for (const seed of fixedSeeds) {
			const digest = createHash("sha256");
			const executedCommandsPerRun: number[] = [];
			const result = fc.check(
				fc.property(
					fc.commands([traceAction.map((a) => new GenerationCommand(a))], {
						maxCommands,
						size: "max",
					}),
					(commands) => {
						const real: GenerationRun = {
							fake: liveFake(provider),
							issued: [...issued],
							packets: [],
							shapes,
							hosts: {
								serving: "host-0",
								labels: new Set(["host-0:1"]),
								started: new Set(["host-0"]),
								retired: new Set(),
							},
						};
						try {
							fc.modelRun(() => ({ model: { now: 100 }, real }), commands);
						} finally {
							executedCommandsPerRun.push(real.packets.length);
						}
						digest.update(JSON.stringify(real.packets));
						for (const command of real.packets) {
							if (command.verb !== "observe") continue;
							kinds[command.observation.kind]++;
							if (command.observation.kind === "effect_outcome") {
								const key = command.observation.outcome.tag;
								outcomes[key] = (outcomes[key] ?? 0) + 1;
								const { token, transmission } = command.observation;
								// 3.4: a control's claims are its transmissions, n 0 names its row alone; a hold's are its
								// run.dispatched. Read without binding, so nothing is claimed here.
								const effect = real.issued.find((item) =>
									item.tag === "Tokened"
										? item.token === token
										: real.fake
												.bindingsFor(item)
												.some(({ send }) => send.token === token) ||
											(transmission?.transmission === 0 &&
												transmission.commandId === item.commandId),
								)?.effect.kind;
								const sweep = real.fake.sweeps.get(command);
								for (const name of [
									...(effect ? [`${effect}:${key}`] : []),
									...(transmission === undefined
										? []
										: [
												`control:${key}`,
												...(transmission.transmission > 1
													? ["control:transmission>1"]
													: transmission.transmission === 0
														? ["control:sweep_n0"]
														: []),
											]),
									...(sweep ? [`sweep:${sweep.shape}`] : []),
								])
									outcomes[name] = (outcomes[name] ?? 0) + 1;
							}
						}
					},
				),
				{ seed, numRuns: runs },
			);
			seeds.push({
				seed,
				digest: digest.digest("hex"),
				shrunkFailures: result.failed
					? [
							{
								path: result.counterexamplePath,
								commands: result.counterexample?.map(String),
								error: String(result.errorInstance),
							},
						]
					: [],
			});
			writeTraceArtifact(
				`generation-${provider}-${seed}`,
				{
					test: { id: task.id, name: task.name, file: task.file.filepath },
					stage: "generation only, not oracle proof",
					seed,
					runs,
					maxCommands,
					execution: {
						attemptedRuns: executedCommandsPerRun.length,
						completedRuns: result.numRuns - (result.failed ? 1 : 0),
						shrinks: result.numShrinks,
						executedCommands: executedCommandsPerRun.reduce(
							(total, length) => total + length,
							0,
						),
						executedCommandsPerRun,
					},
					result: seeds.at(-1),
					kinds,
					outcomes,
					shapes,
				},
				task.id,
			);
			assert.equal(result.failed, false, String(result.errorInstance));
			assert.equal(result.numRuns, runs, "generation requested run count");
			assert.equal(
				executedCommandsPerRun.length,
				runs,
				"generation modelRun count",
			);
		}
		// Coverage gate over the 3.13 input alphabet (D60): every expressible input kind is produced,
		// or waits with its reason; a kind a provider cannot express is listed with its clause, and a
		// kind its provider cannot produce is produced as an adversarial input decide Rejects (3.4).
		const produced: Record<string, number> = {
			...shapes,
			...Object.fromEntries(
				Object.entries(kinds).map(([kind, hits]) => [`observe:${kind}`, hits]),
			),
			...Object.fromEntries(
				Object.entries(outcomes).map(([key, hits]) => [`outcome:${key}`, hits]),
			),
		};
		const alphabet = [
			...Object.keys(observationKinds).map((kind) => `observe:${kind}`),
			"admit:queue",
			"admit:steer",
			"control:stop:at",
			"control:stop:null",
			"control:end:at",
			"control:end:null",
			"control:run_now:at",
			"control:run_now:null",
			"control:answer",
			"control:stop_tasks",
			"control:confirm_escalation",
			"control:native_command",
			// 3.4, 8.4 (round 2d): an end with a Run active commits each row as its own Control.
			"control:end:after_stop",
			"control:end:as_stop",
			"control:end:retire",
			// D61: an answer's confirmation and a native command's receipts, before and after its outcome.
			...[
				"interaction_resolved:answer",
				"command_lifecycle:native",
				"command_result:native",
			].flatMap((kind) =>
				["before", "after"].map((order) => `unsolicited:${kind}:${order}`),
			),
			"answer:control:evidence",
			"settlement:alarm_fired",
			"settlement:hold_exhausted",
			"settlement:unheld_outcome",
			"settlement:process_started",
			"settlement:process_lost",
			"settlement:session_ended",
			"main:run_requested:held",
			"main:run_requested:direct",
			"main:run_started:own",
			"main:run_started:joined",
			"main:run_terminal:completed",
			"main:run_terminal:error",
			"main:run_terminal:interrupted",
			"main:repeat",
			"outcome:not_sent",
			...[
				"succeeded",
				"permanent",
				"retryable",
				"delivery_unknown",
				"not_sent",
			].map((outcome) => `outcome:end_session:${outcome}`),
			...["interrupt", "deliver_answer", "send_native_command"].flatMap(
				(effect) =>
					["succeeded", "permanent", "retryable"].map(
						(outcome) => `outcome:${effect}:${outcome}`,
					),
			),
			// 3.4: a control's effect_outcome per (commandId, n), n from 1.
			...[
				"succeeded",
				"permanent",
				"retryable",
				"not_sent",
				"transmission>1",
				"sweep_n0",
			].map((outcome) => `outcome:control:${outcome}`),
			// 3.4, 3.12: a sweep's outcome names the row's latest claim, a row not running included, or n 0
			// for a row no claim reached; the refusal sweep and drain write the same input. An executor's
			// outcome after the sweep, on the same transmission, joins its chains.
			...["project_inactive", "provider_process_gone"].flatMap((code) =>
				["claimed", "n0"].map((shape) => `outcome:sweep:${code}:${shape}`),
			),
			"outcome:sweep:not_running",
			"outcome:sweep:adversarial:succeeded",
			"outcome:sweep:adversarial:retryable",
			// 3.4, 3.8 GAP 5: OpenCode's turn.error writes main's terminal and query_ended together.
			"main:opencode_pair:query_ended_first",
			"main:opencode_pair:terminal_first",
		];
		const adversarial: Record<string, string> = {
			// Round 2d: main's gate precedes its claim, so a control's not_sent names a transmission (3.4).
			"outcome:control:not_sent":
				"a control's not_sent naming its transmission (3.4, D48 amended, round 2d)",
			"outcome:end_session:not_sent":
				"a control's not_sent naming its transmission (3.4, D48 amended, round 2d)",
			"answer:control:evidence":
				"any but effect_outcome on a control main issues (3.4, D61)",
			...(provider === "cursor" || provider === "opencode"
				? {
						"observe:tasks_snapshot":
							"task evidence from Cursor or OpenCode (3.4, 8.1)",
						"observe:task_event":
							"task evidence from Cursor or OpenCode (3.4, 8.1)",
					}
				: {}),
			...(provider === "claude"
				? {}
				: {
						"observe:command_lifecycle":
							"command_lifecycle from any provider but Claude (3.4, D46)",
						"unsolicited:command_lifecycle:native:before":
							"command_lifecycle from any provider but Claude (3.4, D46)",
						"unsolicited:command_lifecycle:native:after":
							"command_lifecycle from any provider but Claude (3.4, D46)",
						"observe:command_result":
							"command_result from any provider but Claude (3.4, D46, round 2e)",
						"unsolicited:command_result:native:before":
							"command_result from any provider but Claude (3.4, D46, round 2e)",
						"unsolicited:command_result:native:after":
							"command_result from any provider but Claude (3.4, D46, round 2e)",
						"observe:turn_ended":
							"turn_ended from any provider but Claude (3.4, 2.1 row 215, 8.3)",
					}),
		};
		const waiting: Record<string, string> = {};
		// D60: OpenCode's run_requested is its transmission; the others' is a held dispatch.
		const notExpressible: Record<string, string> = {
			"outcome:end_session:delivery_unknown":
				"main writes no delivery_unknown for a control (3.4)",
			...(provider === "opencode"
				? {}
				: {
						"main:opencode_pair:query_ended_first":
							"only OpenCode's turn.error ends a turn and its query in one write (3.4)",
						"main:opencode_pair:terminal_first":
							"only OpenCode's turn.error ends a turn and its query in one write (3.4)",
					}),
			...(provider === "opencode"
				? {
						"main:run_requested:held":
							"OpenCode main dispatches directly (D60, 4.11)",
						"admit:steer":
							"OpenCode queues steers; its composer never offers one (CONTRACT.md 4431-4432, 5901)",
						"main:run_started:joined":
							"only a steer's run.started names another Run, and OpenCode never steers (3.9; CONTRACT.md 4431-4432, 5901)",
					}
				: {
						"main:run_requested:direct":
							"only OpenCode main dispatches directly (D60, 4.11)",
					}),
			...(provider === "cursor"
				? {
						"observe:turn_started":
							"Cursor starts no unsolicited turn (8.3, cursor-runner-payload.ts)",
					}
				: {}),
		};
		const listed = (reasons: Record<string, string>) =>
			alphabet.flatMap((kind) => {
				const reason = reasons[kind];
				return reason === undefined ? [] : [{ kind, reason }];
			});
		const gate = {
			produced: alphabet.filter((kind) => (produced[kind] ?? 0) > 0),
			adversarial: listed(adversarial),
			waiting: listed(waiting),
			notExpressible: listed(notExpressible),
			missing: alphabet.filter(
				(kind) =>
					(produced[kind] ?? 0) === 0 &&
					waiting[kind] === undefined &&
					notExpressible[kind] === undefined,
			),
		};
		writeTraceArtifact(`generation-${provider}`, {
			stage: "generation only, not oracle proof",
			gate,
			seeds,
			runs,
			maxCommands,
			size: "max",
			kinds,
			outcomes,
			shapes,
			fixtureEffects: issued,
			policy,
			races: new Coverage().races,
		});
		// OpenCode and Cursor report no background tasks (8.1, 8.3): their task kinds are generated
		// as Rejected-path inputs (3.4), so every kind is reached for every provider.
		const taskless =
			provider === "cursor" || provider === "opencode"
				? ["tasks_snapshot", "task_event"]
				: [];
		expect(gate.missing).toEqual([]);
		expect(
			alphabet.filter(
				(kind) =>
					notExpressible[kind] !== undefined && (produced[kind] ?? 0) > 0,
			),
		).toEqual([]);
		for (const kind of ["activity", "result", "query_ended"])
			for (const label of ["own", "other"])
				expect(
					shapes[`unsolicited:${kind}:${label}`],
					`${kind}:${label}`,
				).toBeGreaterThan(0);
		const runnerHeld = provider !== "opencode";
		for (const shape of [
			"settlement:hold_exhausted",
			"run_dispatched:transmission>1",
			"answer:command_lifecycle:start",
			"answer:command_lifecycle:steer",
			// Round 9 input kinds (input-kinds.md), each with its clause.
			"clock:backwards", // 6.1 clock is a fact, not monotonic
			"process_started:fresh", // 6.9
			"process_started:reattached", // 6.9, 8.3
			"process_started:duplicate", // 6.9 redelivery
			"process_lost:serving", // 6.9 H1
			"process_lost:known-non-current", // L1, REDESIGN generator note: an old runner while another serves
			"process_lost:retired-none-serving", // L1 retired is final
			"process_lost:not-started", // L1 never-issued runner
			"stop_tasks:all", // 3.13 Control
			"stop_tasks:one",
			"stop_tasks:several",
			"answer:command_lifecycle:foreign-commandId", // D21
			"answer:retired-address", // 3.4, L1
			"settlement:unheld_outcome", // 4.4, D49 a Held send settled before holdRun, by its queue key
			"unsolicited:result:completed", // 3.4 Unsolicited
			"unsolicited:result:error",
			"unsolicited:result:interrupted",
			"retryable:before-probe-deadline", // 3.7
			"retryable:after-probe-deadline",
			"interaction:question", // 3.13 interaction_requested; main owns the timeout (3.10)
			"interaction:permission",
			...(runnerHeld
				? [
						"process_started:no-querySeq", // 3.4 older host label, REDESIGN r2-2
					]
				: ["process_started:runnerId-colon"]), // L1 split, 9 OpenCode adapter
			...(taskless.length === 0 ? ["tasks_snapshot:several"] : []), // 8.2
		])
			expect(shapes[shape] ?? 0, shape).toBeGreaterThan(0);
		expect(
			issued.flatMap(({ effect }) =>
				effect.kind === "start" ? [effect.mode] : [],
			),
		).toEqual(["resume", "fresh"]);
		expect(
			issued.some(
				({ effect }) => effect.kind === "end_session" && effect.runId === null,
			),
		).toBe(true);
		expect(policy.probeMs).toBeGreaterThan(0);
		expect(policy.nativeCommandMs).toBeGreaterThan(0);
		for (const outcome of [
			"delivery_unknown",
			"permanent",
			"retryable",
			"succeeded",
		])
			expect(outcomes[outcome] ?? 0, outcome).toBeGreaterThan(0);
		const sample = () =>
			fc
				.sample(
					fc.commands([traceAction.map((a) => new GenerationCommand(a))], {
						maxCommands,
						size: "max",
					}),
					{ seed: fixedSeeds[0], numRuns: 3 },
				)
				.map(String);
		expect(sample()).toEqual(sample());
	});
});

type HostEvent =
	| LedgerCommand
	| {
			readonly verb: "issued";
			readonly effect: IssuedEffect;
			readonly token: SendToken;
			/** A runner-held start or steer (3.13 Main, D60); a control claim is not held. */
			readonly held: boolean;
	  };
/**
 * Independent host-fact checker over a generated packet log (6.9 H1, H2; 4.4 H3). It keeps its own
 * runner facts and never reads the fake. A redelivered process_started of an already started label
 * is a duplicate, not a new start. A held send, or main's unheld start or steer, is transmitted when it is issued to a serving runner
 * or, if pending, at the next start; a later run_dispatched for it is a report of that transmission
 * and must name the same runner. A run_dispatched for any other token is a transmission now (a
 * rebind or a spawn) and must not name a retired runner.
 */
function hostFacts(
	initialLabel: string,
	log: readonly HostEvent[],
	shapes: Record<string, number>,
): readonly string[] {
	const violations: string[] = [];
	const hit = (shape: string) => {
		shapes[shape] = (shapes[shape] ?? 0) + 1;
	};
	const startedLabels = new Set([initialLabel]);
	const startedRunners = new Set([splitLabel(initialLabel).runnerId]);
	const retired = new Set<string>();
	let serving: string | undefined = splitLabel(initialLabel).runnerId;
	const transmitted = new Map<SendToken, string | undefined>();
	const pendingRuns = new Set<string>();
	for (const [step, event] of log.entries()) {
		if (event.verb === "issued") {
			const effect = event.effect.effect;
			const pending = [...transmitted.values()].includes(undefined);
			if (effect.kind === "end_session" && serving === undefined && pending)
				hit("issued:end_session-while-sends-pending"); // L2 a pending destruction covers pending sends
			if (
				effect.kind === "steer" &&
				serving === undefined &&
				pendingRuns.has(effect.runId)
			)
				hit("issued:steer-while-start-pending"); // L2 case 2
			if (effect.kind === "start" && serving === undefined) {
				hit("issued:start-pending");
				pendingRuns.add(effect.runId);
			}
			// Main's own unheld start or steer (D60) goes to the serving runner at issue, like a held one.
			if (event.held || effect.kind === "start" || effect.kind === "steer")
				transmitted.set(event.token, serving);
			continue;
		}
		if (event.verb === "settle") {
			const settlement = event.settlement;
			const spawned = [...transmitted.values()].some(
				(runner) => runner !== undefined && !startedRunners.has(runner),
			);
			if (settlement.kind === "alarm_fired" && spawned)
				hit("alarm:between-dispatch-and-start"); // REDESIGN r3-1
			if (settlement.kind === "process_lost") {
				if (
					!startedRunners.has(settlement.runnerId) &&
					[...transmitted.values()].includes(settlement.runnerId)
				)
					hit("process_lost:dispatched-before-start"); // REDESIGN r3-1
				retired.add(settlement.runnerId);
				if (serving === settlement.runnerId) serving = undefined;
			}
			if (settlement.kind !== "process_started") continue;
			pendingRuns.clear();
			startedRunners.add(splitLabel(settlement.label).runnerId);
			const runner = splitLabel(settlement.label).runnerId;
			const duplicate = startedLabels.has(settlement.label);
			startedLabels.add(settlement.label);
			if (duplicate) continue;
			if (retired.has(runner))
				violations.push(`${step}: H2/L1 start of retired runner ${runner}`);
			else {
				// L1 totality: another runner's start retires every other runner, started or not.
				if (serving !== undefined && serving !== runner) {
					violations.push(
						`${step}: H1 ${runner} started while ${serving} serves`,
					);
					retired.add(serving);
				}
				for (const other of new Set(transmitted.values()))
					if (
						other !== undefined &&
						other !== runner &&
						!startedRunners.has(other) &&
						!retired.has(other)
					) {
						violations.push(
							`${step}: H1 ${runner} started while dispatched ${other} is unlost`,
						);
						retired.add(other);
					}
				serving = runner;
				for (const [token, runnerId] of transmitted)
					if (runnerId === undefined) transmitted.set(token, runner);
			}
			continue;
		}
		if (event.verb !== "observe") continue;
		const observation = event.observation;
		if (observation.tag !== "Answer" || observation.kind !== "run_dispatched")
			continue;
		const runner = transmitted.get(observation.token);
		if (runner !== undefined && runner !== observation.runnerId)
			violations.push(
				`${step}: H3 report names ${observation.runnerId}, sent to ${runner}`,
			);
		// A report of a transmission made before its runner retired; it covers the send (L2, 4073cc6b).
		if (runner !== undefined && retired.has(observation.runnerId))
			hit("run_dispatched:retired-runner");
		if (runner === undefined && retired.has(observation.runnerId))
			violations.push(
				`${step}: H3 dispatch to retired runner ${observation.runnerId}`,
			);
		if (runner === undefined && !startedRunners.has(observation.runnerId))
			hit("run_dispatched:before-runner-start"); // REDESIGN r3-1, H1
		if (runner === undefined)
			transmitted.set(observation.token, observation.runnerId);
	}
	return violations;
}
interface HostFactRun {
	readonly fake: FakeProvider;
	readonly issued: IssuedEffect[];
	readonly log: HostEvent[];
	serial: number;
}
class HostFactCommand implements fc.Command<{ now: number }, HostFactRun> {
	constructor(
		readonly action: TraceAction,
		readonly issue: number,
	) {}
	check(): boolean {
		return true;
	}
	run(model: { now: number }, real: HostFactRun): void {
		const { fake } = real;
		const n = real.serial++;
		const runId = `R${Math.floor(n / 3)}`;
		const truth = fake.groundTruth();
		const effect: IssuedEffect | undefined = [
			{
				tag: "Main",
				commandId: `start:${n}`,
				effect: { kind: "start", runId, inputId: `in:${n}`, mode: "fresh" },
			} as const,
			{
				tag: "Main",
				commandId: `steer:${n}`,
				effect: { kind: "steer", runId, inputId: `in:${n}` },
			} as const,
			{
				tag: "Main",
				commandId: `end:${n}`,
				effect: {
					kind: "end_session",
					runId,
					label: truth.processAlive ? truth.label : null,
				},
			} as const,
		][this.issue % 8];
		if (effect) {
			real.issued.push(effect);
			const [send] = fake.issued([effect]);
			assert(send);
			real.log.push({
				verb: "issued",
				effect,
				token: send.token,
				held: fake.isHeld(effect),
			});
		}
		const view = {
			...emptyView(),
			live: real.issued,
			anythingMayAct: true,
		};
		const packet = fake.next(this.action, {
			issued: real.issued,
			view,
			now: model.now,
			alarmAt: 1_100,
		});
		// Main's own starts and steers (D60, 3.4) are sends the checker must see issued.
		for (const { issue, token } of fake.takeMainIssues()) {
			real.issued.push(issue);
			real.log.push({
				verb: "issued",
				effect: issue,
				token,
				held: fake.isHeld(issue),
			});
		}
		real.log.push(packet.command);
		fake.observe(packet.command, view);
		model.now = packet.now;
	}
	toString(): string {
		return `host(${JSON.stringify(this.action)},${this.issue})`;
	}
}
const hostFactRun = (
	provider: (typeof providers)[number],
	totality: boolean,
	seed: number,
	shapes: Record<string, number> = {},
) => {
	const violations: string[] = [];
	const result = fc.check(
		fc.property(
			fc.commands(
				[
					fc
						.tuple(traceAction, fc.nat({ max: 15 }))
						.map(([a, issue]) => new HostFactCommand(a, issue)),
				],
				{ maxCommands, size: "max" },
			),
			(commands) => {
				const fake = liveFake(provider, totality);
				const real: HostFactRun = { fake, issued: [], log: [], serial: 0 };
				fc.modelRun(() => ({ model: { now: 100 }, real }), commands);
				violations.push(...hostFacts("host-0:1", real.log, shapes));
			},
		),
		{ seed, numRuns: runs },
	);
	assert.equal(result.failed, false, String(result.errorInstance));
	return violations;
};

describe.each(providers)("%s generated host facts (H1 to H3)", (provider) => {
	// test-waits-allow timeout-override: eight seeds at about 0.2 ms a run alone; 2000 runs took 19 s beside a second loaded long-seed run, so the seed bound, which scales with runs.
	it(
		"never starts a second serving runner, reattaches a retired one or dispatches a covered send",
		{ timeout: seedTimeout },
		({ task }) => {
			const shapes: Record<string, number> = {};
			for (const seed of fixedSeeds) {
				const violations = hostFactRun(provider, false, seed, shapes);
				expect(violations.slice(0, 5), `seed ${seed}`).toEqual([]);
			}
			writeTraceArtifact(
				`host-facts-${provider}`,
				{ seeds: fixedSeeds, runs, maxCommands, shapes },
				task.id,
			);
			// Sends issued with no serving process (L2): these kinds need ledger-issued sends.
			for (const shape of [
				"issued:start-pending",
				"issued:steer-while-start-pending",
				"issued:end_session-while-sends-pending",
				...(provider === "opencode"
					? []
					: [
							"run_dispatched:before-runner-start",
							"run_dispatched:retired-runner",
							"process_lost:dispatched-before-start",
							"alarm:between-dispatch-and-start",
						]),
			])
				expect(shapes[shape] ?? 0, shape).toBeGreaterThan(0);
		},
	);
	it("produces another runner's start while one serves only in the explicit totality property (L1 totality)", () => {
		const violations = hostFactRun(provider, true, fixedSeeds[0]);
		expect(violations.some((v) => v.includes(": H1 "))).toBe(true);
		expect(violations.filter((v) => !v.includes(": H1 "))).toEqual([]);
	});
});

interface TraceModel {
	readonly scheduler: FakeProvider;
	executedCommands: number;
}
class ProviderCommand implements fc.Command<TraceModel, DifferentialTrace> {
	constructor(readonly action: TraceAction) {}
	check(): boolean {
		return true;
	}
	run(model: TraceModel, real: DifferentialTrace): void {
		model.executedCommands++;
		const d = real.expected;
		const packet = model.scheduler.next(this.action, {
			issued: d.issued,
			view: d.view(),
			now: d.now,
			alarmAt: d.alarmAt,
		});
		real.step(packet.command, packet.now);
	}
	toString(): string {
		return `provider(${JSON.stringify(this.action)})`;
	}
}

/** A scripted public implementation tests the driver, never ledger behavior. */
function fixture(
	effects: readonly IssuedEffect[] = [],
	alarmAt?: number,
): LedgerImplementation<unknown, unknown> {
	return {
		initialSessionLedgerState: () => null,
		decide: () => ({
			tag: "Accepted",
			events: [],
			effects,
			ended: [],
			...(alarmAt === undefined ? {} : { alarmAt }),
		}),
		evolve: (state) => state,
		viewLedger: () => ({
			...emptyView(),
			live: effects,
			anythingMayAct: effects.length > 0,
		}),
	};
}

describe("trace driver mechanics", () => {
	it("writes to this run's own mkdtemp directory, silently, when RUN_LEDGER_ARTIFACT_DIR is unset", () => {
		vi.stubEnv("RUN_LEDGER_ARTIFACT_DIR", undefined);
		const log = vi.spyOn(console, "log");
		const warn = vi.spyOn(console, "warn");
		try {
			const first = writeTraceArtifact("artifact-dir-unset", { trace: ["a"] });
			const second = writeTraceArtifact("artifact-dir-unset-2", { trace: [] });
			const directory = dirname(first);
			expect(dirname(second)).toBe(directory);
			expect(dirname(directory)).toBe(tmpdir());
			expect(basename(directory)).toMatch(/^run-ledger-artifacts-\w{6}$/);
			expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({ trace: ["a"] });
			expect([...log.mock.calls, ...warn.mock.calls]).toEqual([]);
		} finally {
			log.mockRestore();
			warn.mockRestore();
			vi.unstubAllEnvs();
		}
	});
	it("keeps artifacts from separate tests of the same seed", ({ task }) => {
		const first = writeTraceArtifact(
			"artifact-collision-82103301",
			{ trace: ["LI5"] },
			`${task.id}-first`,
		);
		const second = writeTraceArtifact(
			"artifact-collision-82103301",
			{ trace: ["LI8"] },
			`${task.id}-second`,
		);
		expect(first).not.toBe(second);
		expect(JSON.parse(readFileSync(first, "utf8"))).toEqual({ trace: ["LI5"] });
		expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({
			trace: ["LI8"],
		});
	});
	it.each([
		"start",
		"steer",
	] as const)("accepts D5 tokened lifecycle for a held %s and translates its command id", (kind) => {
		const effect =
			kind === "start"
				? { kind, runId: "R", inputId: "A", mode: "resume" as const }
				: { kind, runId: "R", inputId: "A" };
		const left = new TraceDriver(
			"claude",
			"reference",
			fixture([{ tag: "Main", commandId: "left", effect }]),
		);
		const right = new TraceDriver(
			"claude",
			"decider",
			fixture([{ tag: "Main", commandId: "right", effect }]),
		);
		for (const d of [left, right])
			d.step({ verb: "settle", settlement: { kind: "alarm_fired" } });
		const send = left.bound(left.latest(kind));
		const observation = answer(send, {
			kind: "command_lifecycle",
			commandId: "left",
			state: "cancelled",
		});
		const translated = translateCommand(
			{ verb: "observe", observation },
			left,
			right,
		);
		expect(translated).toMatchObject({
			observation: {
				tag: "Answer",
				token: right.bound(right.latest(kind)).token,
				commandId: "right",
			},
		});
		const mismatched = translateCommand(
			{
				verb: "observe",
				observation: answer(send, {
					kind: "command_lifecycle",
					commandId: "not-this-hold",
					state: "cancelled",
				}),
			},
			left,
			right,
		);
		expect(mismatched).toMatchObject({
			observation: { commandId: "not-this-hold" },
		});
	});
	it("translates a run_dispatched answering a tokened OpenCode start as a Rejected-path input (3.4, L2 case 3)", () => {
		const effect = {
			kind: "start" as const,
			runId: "R",
			inputId: "A",
			mode: "resume" as const,
		};
		const left = new TraceDriver(
			"opencode",
			"reference",
			fixture([{ tag: "Tokened", token: "left" as SendToken, effect }]),
		);
		const right = new TraceDriver(
			"opencode",
			"decider",
			fixture([{ tag: "Tokened", token: "right" as SendToken, effect }]),
		);
		for (const d of [left, right])
			d.step({ verb: "settle", settlement: { kind: "alarm_fired" } });
		const send = left.bound(left.latest("start"));
		const translated = translateCommand(
			{
				verb: "observe",
				observation: answer(send, {
					kind: "run_dispatched",
					runId: "R",
					runnerId: "host-1",
					commandId: "A",
					transmission: 1,
				}),
			},
			left,
			right,
		);
		expect(translated).toMatchObject({
			observation: { token: right.bound(right.latest("start")).token },
		});
	});
	it("shrinks a differential mismatch and records its replay data", () => {
		const command: fc.Command<{ fixture: boolean }, DifferentialTrace> = {
			check: () => true,
			run: (_model, real) =>
				real.step({ verb: "settle", settlement: { kind: "alarm_fired" } }),
			toString: () => "alarm",
		};
		const seed = fixedSeeds[0];
		const result = fc.check(
			fc.property(
				fc.commands([fc.constant(command)], { maxCommands: 10 }),
				(commands) => {
					fc.modelRun(
						() => ({
							model: { fixture: true },
							real: new DifferentialTrace(
								"claude",
								fixture([], 100),
								fixture([], 101),
							),
						}),
						commands,
					);
				},
			),
			{ seed, numRuns: 30 },
		);
		expect(result.failed).toBe(true);
		assert(result.counterexample);
		expect(String(result.counterexample[0]).match(/alarm/g)).toHaveLength(1);
		writeTraceArtifact("shrunk-harness-proof", {
			stage: "intentional fixture mismatch, not ledger behavior",
			seeds: [seed],
			kinds: observationKinds,
			races: new Coverage().races,
			shrunkFailures: [
				{
					seed: result.seed,
					path: result.counterexamplePath,
					commands: result.counterexample.map(String),
					error: String(result.errorInstance),
				},
			],
		});
	});
	it("keeps native task identities and user answer payloads exact", () => {
		const names = new PublicNames();
		const payload = {
			key: { taskId: "T", runId: "native-run" },
			wakeTask: { taskId: "W", runId: "wake-native" },
			answer: { runId: "user-value", token: "user-token" },
		};
		expect(names.normalize(payload)).toEqual(payload);
	});
	it("aligns held and tokened effects by issue order and translates only Answer tokens", () => {
		const issued = (prefix: string): IssuedEffect[] => [
			{
				tag: "Main",
				commandId: `${prefix}:command`,
				effect: {
					kind: "start",
					runId: `${prefix}:run`,
					inputId: "A",
					mode: "resume",
				},
			},
			{
				tag: "Tokened",
				token: `${prefix}:probe` as SendToken,
				effect: {
					kind: "probe",
					runId: `${prefix}:run`,
					target: { tag: "native_session" },
				},
			},
		];
		const a = new TraceDriver("claude", "reference", fixture(issued("a")));
		const b = new TraceDriver("claude", "decider", fixture(issued("b")));
		const command: LedgerCommand = {
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		};
		a.step(command);
		b.step(command);
		const namesA = new PublicNames();
		const namesB = new PublicNames();
		namesA.register(a);
		namesB.register(b);
		expect(namesA.normalize(a.view())).toEqual(namesB.normalize(b.view()));
		const held = a.latest("start");
		const observation = answer(a.bound(held), { kind: "started" });
		const translated = translateCommand({ verb: "observe", observation }, a, b);
		expect(translated).toMatchObject({
			observation: { token: b.bound(b.latest("start")).token },
		});
		expect("token" in held).toBe(false);
		expect(a.bound(held)).toBe(a.bound(held));
		const unsolicited: LedgerCommand = {
			verb: "observe",
			observation: {
				tag: "Unsolicited",
				label: a.label,
				eventId: "snapshot",
				kind: "tasks_snapshot",
				tasks: [],
			},
		};
		expect(translateCommand(unsolicited, a, b)).toBe(unsolicited);
	});
	it("detects exact alarm and effect mismatches instead of normalizing them away", () => {
		const d = new DifferentialTrace(
			"claude",
			fixture([], 100),
			fixture([], 101),
		);
		expect(() =>
			d.step({ verb: "settle", settlement: { kind: "alarm_fired" } }),
		).toThrow(/alarmAt exactly/);
		const start = {
			kind: "start",
			runId: "R",
			inputId: "A",
			mode: "resume",
		} as const;
		const mismatch = new DifferentialTrace(
			"claude",
			fixture([{ tag: "Main", commandId: "cmd", effect: start }]),
			fixture([
				{ tag: "Main", commandId: "cmd", effect: { ...start, inputId: "B" } },
			]),
		);
		expect(() =>
			mismatch.step({ verb: "settle", settlement: { kind: "alarm_fired" } }),
		).toThrow(/issued effects/);
	});
	// Default run claude-82103301 (phase 2): the gate is a host fact, not an input (H4, D48), so a
	// differential trace's second host must answer from the same registry as the first. Round 2d: a
	// control never gets not_sent, so the gate's answer is the removed refusal naming main's claim (3.4).
	it("gives a differential trace's second host the first host's gate (H4)", () => {
		assert(referenceImplementation);
		const d = new DifferentialTrace(
			"claude",
			referenceImplementation,
			referenceImplementation,
		);
		d.step({
			verb: "settle",
			settlement: {
				kind: "process_started",
				label: d.expected.label,
				reattached: false,
			},
		});
		d.expected.host.setGate("removed");
		d.step({
			verb: "control",
			control: {
				kind: "native_command",
				commandId: "command:0",
				text: "/goal clear",
			},
		});
		const issue = d.expected.issued.at(-1);
		assert(issue?.tag === "Main");
		// 3.4: main's claim of the native command is its transmission 1.
		const claim = d.expected.host.bindingsFor(issue).at(-1);
		assert(claim);
		expect(() =>
			d.step({
				verb: "observe",
				observation: {
					tag: "Answer",
					token: claim.send.token,
					kind: "effect_outcome",
					outcome: { tag: "permanent", code: "project_inactive" },
					transmission: {
						commandId: issue.commandId,
						transmission: claim.transmission,
					},
				},
			}),
		).not.toThrow();
	});
	it("rejects an evidence kind that the send cannot produce at the test intake boundary", () => {
		expect(() =>
			answer(
				{
					token: "probe" as SendToken,
					effect: {
						kind: "probe",
						runId: "R",
						target: { tag: "native_session" },
					},
				},
				{ kind: "result", outcome: "completed" },
			),
		).toThrow(/cannot produce result/);
	});
});

describe("fake provider scheduling and ground truth", () => {
	it("keeps an unconfirmed OpenCode send after query end and a covering idle sample (9)", () => {
		const fake = liveFake("opencode");
		const [accepted, pending] = fake.issued([
			{
				tag: "Tokened",
				token: "accepted" as SendToken,
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
			{
				tag: "Tokened",
				token: "pending" as SendToken,
				effect: { kind: "steer", runId: "R", inputId: "B" },
			},
		]);
		assert(accepted && pending);
		fake.observe(
			{
				verb: "observe",
				observation: answer(accepted, { kind: "input_accepted" }),
			},
			emptyView(),
		);
		fake.observe(
			{
				verb: "observe",
				observation: answer(pending, {
					kind: "effect_outcome",
					outcome: { tag: "delivery_unknown" },
				}),
			},
			emptyView(),
		);
		fake.observe(
			{
				verb: "observe",
				observation: answer(pending, { kind: "query_ended" }),
			},
			emptyView(),
		);
		// 9, D26: query end ends accepted work; an unconfirmed send may still run late (3128-3132).
		expect(fake.groundTruth().unfinished).toEqual([pending.token]);
		const [probe] = fake.issued([
			{
				tag: "Tokened",
				token: "idle" as SendToken,
				effect: {
					kind: "probe",
					runId: "R",
					target: { tag: "native_session" },
				},
			},
		]);
		assert(probe);
		fake.observe(
			{
				verb: "observe",
				observation: answer(probe, {
					kind: "probe_result",
					finding: { tag: "native_idle" },
				}),
			},
			emptyView(),
		);
		expect(fake.groundTruth().unfinished).toEqual([pending.token]);
	});
	it("keeps transmitted native work through a removal's gate until its runner is lost (H4, 3.11)", () => {
		const fake = liveFake("claude");
		const [send] = fake.issued([
			{
				tag: "Main",
				commandId: "retired",
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
		]);
		assert(send);
		fake.observe(
			{
				verb: "observe",
				observation: answer(send, { kind: "input_accepted" }),
			},
			emptyView(),
		);
		// H4: a transmitted send is never refused, so the removed gate leaves it accepted.
		fake.setGate("removed");
		expect(fake.isGated(send.token)).toBe(false);
		expect(fake.groundTruth().acceptedUnended).toEqual([send.token]);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		expect(fake.groundTruth().unfinished).toEqual([]);
	});
	it("keeps journal finished as observed consumption without inventing a native result (4.11)", () => {
		const fake = liveFake("claude");
		const [send] = fake.issued([
			{
				tag: "Main",
				commandId: "journal",
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
		]);
		assert(send);
		fake.observe(
			{
				verb: "observe",
				observation: answer(send, {
					kind: "effect_outcome",
					outcome: { tag: "retryable", retryAt: 100 },
				}),
			},
			emptyView(),
		);
		expect(fake.groundTruth().unfinished).toEqual([]);
		fake.observe(
			{
				verb: "observe",
				observation: answer(send, {
					kind: "journal_answer",
					answer: "finished",
				}),
			},
			emptyView(),
		);
		expect(fake.groundTruth().acceptedUnended).toEqual([send.token]);
		fake.observe(
			{
				verb: "observe",
				observation: answer(send, { kind: "result", outcome: "completed" }),
			},
			emptyView(),
		);
		expect(fake.groundTruth().unfinished).toEqual([]);
	});
	it.each(
		providers,
	)("correlates the %s native result to its named Claude input or latest query send (3.4)", (provider) => {
		const fake = liveFake(provider);
		const [start, steer] = fake.issued([
			{
				tag: "Main",
				commandId: "A",
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
			{
				tag: "Main",
				commandId: "B",
				effect: { kind: "steer", runId: "R", inputId: "B" },
			},
		]);
		assert(start && steer);
		for (const send of [start, steer])
			fake.observe(
				{
					verb: "observe",
					observation: answer(send, { kind: "input_accepted" }),
				},
				emptyView(),
			);
		fake.observe(
			{
				verb: "observe",
				observation: answer(start, { kind: "result", outcome: "completed" }),
			},
			emptyView(),
		);
		expect(fake.groundTruth().acceptedUnended).toEqual(
			provider === "opencode"
				? [start.token, steer.token]
				: provider === "cursor"
					? []
					: [provider === "claude" ? steer.token : start.token],
		);
	});
	it("uses recorded runner loss and query sequence for older labels, preserving the send's own-label exception (3.4)", () => {
		const fake = liveFake("opencode");
		const [send] = fake.issued([
			{
				tag: "Tokened",
				token: "old-send" as SendToken,
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
		]);
		assert(send);
		fake.observe(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "host-0:2",
					reattached: false,
				},
			},
			emptyView(),
		);
		fake.observe(
			{
				verb: "observe",
				observation: answer(send, { kind: "input_accepted" }),
			},
			emptyView(),
		);
		expect(fake.groundTruth().acceptedUnended).toEqual([send.token]);
		fake.observe(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "unrelated:1",
					reattached: false,
				},
			},
			emptyView(),
		);
		const before = emptyView();
		fake.assertStep(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					eventId: "different-runner",
					label: "host-1:1",
					kind: "activity",
				},
			},
			before,
			{ ...before, anythingMayAct: true },
			[],
			[],
		);
		expect(() =>
			fake.assertStep(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						eventId: "older-query",
						label: "host-0:1",
						kind: "activity",
					},
				},
				before,
				{ ...before, anythingMayAct: true },
				[],
				[],
			),
		).toThrow(/LI7/);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "lost", retiredAt: 0 },
			},
			emptyView(),
		);
		expect(() =>
			fake.assertStep(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						eventId: "lost-runner",
						label: "lost:99",
						kind: "activity",
					},
				},
				before,
				{ ...before, anythingMayAct: true },
				[],
				[],
			),
		).toThrow(/LI7/);
	});
	it.each([
		"claude",
		"codex",
	] as const)("models %s clear and continuation independently of ledger state", (provider) => {
		const fake = liveFake(provider);
		fake.observe(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: fake.label,
					reattached: false,
				},
			},
			emptyView(),
		);
		fake.setGoal();
		const [start] = fake.issued([
			{
				tag: "Main",
				commandId: "A",
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
		]);
		assert(start);
		fake.observe(
			{
				verb: "observe",
				observation: answer(start, { kind: "started" }),
			},
			emptyView(),
		);
		fake.observe(
			{
				verb: "control",
				control: { kind: "stop", commandId: "stop", deadlineAt: null },
			},
			emptyView(),
		);
		expect(fake.groundTruth().goal).toBe("active");
		fake.issued([
			{
				tag: "Main",
				commandId: "clear",
				effect: {
					kind: "send_native_command",
					commandId: "clear",
					text: "/goal clear",
				},
			},
		]);
		expect(fake.groundTruth().runningTurn).toBe(true);
		if (provider === "claude") {
			expect(fake.groundTruth().queuedCommands).toEqual(["clear"]);
			expect(fake.groundTruth().goal).toBe("active");
		} else {
			expect(fake.groundTruth().queuedCommands).toEqual([]);
			expect(fake.groundTruth().goal).toBe("cleared");
		}
		fake.pendingObservations();
		fake.observe(
			{
				verb: "observe",
				observation: answer(start, { kind: "result", outcome: "completed" }),
			},
			emptyView(),
		);
		expect(fake.groundTruth().goal).toBe("cleared");
		expect(
			fake.pendingObservations().filter((e) => e.kind === "turn_started"),
		).toEqual([]);
		fake.setGoal();
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: fake.label,
					eventId: "new-wake-turn",
					kind: "turn_started",
				},
			},
			emptyView(),
		);
		fake.observe(
			{
				verb: "observe",
				observation: answer(start, { kind: "result", outcome: "completed" }),
			},
			emptyView(),
		);
		expect(
			fake.pendingObservations().filter((e) => e.kind === "turn_started"),
		).toHaveLength(1);
	});
	it.each(
		providers,
	)("fires %s alarms at the deadline, before, long after and repeatedly", (provider) => {
		const fake = liveFake(provider);
		const snapshot = {
			issued: [],
			view: emptyView(),
			now: 100,
			alarmAt: 1_100,
		};
		for (const [variant, now] of [
			[0, 1_100],
			[1, 1_099],
			[2, 101_100],
			[3, 100],
		] as const) {
			expect(fake.next({ ...action, variant }, snapshot)).toEqual({
				command: { verb: "settle", settlement: { kind: "alarm_fired" } },
				now,
			});
		}
		expect(fake.next(action, snapshot)).toEqual(fake.next(action, snapshot));
	});
	it.each(
		providers,
	)("selects live, stale, very old and never-issued %s tokens", (provider) => {
		const fake = liveFake(provider);
		const issued: IssuedEffect[] = [0, 1, 2, 3].map((index) => ({
			tag: "Tokened",
			token: `send:${index}` as SendToken,
			effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
		}));
		const snapshot = {
			issued,
			view: { ...emptyView(), live: issued.slice(2) },
			now: 100,
		};
		const token = (selection: number) => {
			const command = fake.next(
				{ ...action, operation: 3, variant: 3, selection },
				snapshot,
			).command;
			return command.verb === "observe" && command.observation.tag === "Answer"
				? command.observation.token
				: undefined;
		};
		expect(token(0)).toBe("send:2");
		expect(token(1)).toBe("send:0");
		expect(token(2)).toBe("send:0");
		expect(token(3)).toMatch(/^never-issued:/);
		// Delayed packets retain their original target and can arrive out of order.
		fake.next({ ...action, operation: 5, selection: 1, variant: 3 }, snapshot);
		fake.next(
			{ ...action, operation: 5, selection: 0, index: 1, variant: 3 },
			snapshot,
		);
		const replayToken = (operation: number, index: number) => {
			const command = fake.next(
				{ ...action, operation, index, variant: 3 },
				snapshot,
			).command;
			return command.verb === "observe" && command.observation.tag === "Answer"
				? command.observation.token
				: undefined;
		};
		expect(replayToken(9, 1)).toBe("send:3");
		expect(replayToken(9, 0)).toBe("send:0");
		expect(replayToken(10, 0)).toBe("send:2");
	});
	it("catches a planted LI8 false-idle view from independent native task facts", () => {
		const fake = liveFake("claude");
		const command: LedgerCommand = {
			verb: "observe",
			observation: {
				tag: "Unsolicited",
				label: fake.label,
				eventId: "task-snapshot",
				kind: "tasks_snapshot",
				tasks: [
					{
						key: { taskId: "task" },
						taskType: "local_bash",
						description: "live shell",
						ambient: false,
					},
				],
			},
		};
		expect(() =>
			fake.assertStep(command, emptyView(), emptyView(), [], []),
		).toThrow(/LI8/);
		fake.assertStep(
			command,
			emptyView(),
			{ ...emptyView(), anythingMayAct: true },
			[],
			[],
		);
	});
	it("catches a planted LI1 overlapping start and LI3 second terminal", () => {
		const fake = liveFake("claude");
		const start: IssuedEffect = {
			tag: "Main",
			commandId: "A",
			effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
		};
		const [send] = fake.issued([start]);
		assert(send);
		fake.observe(
			{
				verb: "observe",
				observation: answer(send, { kind: "input_accepted" }),
			},
			emptyView(),
		);
		expect(() =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				emptyView(),
				{ ...emptyView(), anythingMayAct: true },
				[{ ...start, commandId: "B" }],
				[],
			),
		).toThrow(/LI1/);
		const terminal = {
			runId: "R",
			outcome: "completed",
			reason: { tag: "completed" },
		} as const;
		const idle = new FakeProvider("claude");
		idle.assertStep(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			emptyView(),
			emptyView(),
			[],
			[terminal],
		);
		expect(() =>
			idle.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				emptyView(),
				emptyView(),
				[],
				[terminal],
			),
		).toThrow(/LI3/);
	});
});

describe("trace coverage gate", () => {
	it("fails with zero hits for any evidence kind or named race", () => {
		const coverage = new Coverage();
		expect(() => coverage.assertComplete()).toThrow(
			/evidence kinds with zero hits/,
		);
		for (const kind of Object.keys(observationKinds) as Observation["kind"][])
			coverage.kinds[kind] = 1;
		expect(() => coverage.assertComplete()).toThrow(
			/named races with zero hits/,
		);
		for (const race of namedRaces) coverage.races[race] = 1;
		coverage.assertComplete();
		coverage.kinds.activity = 0;
		expect(() => coverage.assertComplete()).toThrow(
			/evidence kinds with zero hits/,
		);
	});
	it("writes seeds, counters and shrunk failures as JSON", () => {
		const artifact = {
			seeds: fixedSeeds,
			evidence: observationKinds,
			races: new Coverage().races,
			shrunkFailures: [],
			runs,
			maxCommands,
			size: "max",
		};
		const path = writeTraceArtifact("manifest", artifact);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(artifact);
	});
	// Opt-in failing invocations produce the requested red logs without editing files.
	it.runIf(process.env["RUN_LEDGER_PROBE"] === "missing-evidence")(
		"red: omitted evidence fails the gate",
		() => {
			const coverage = new Coverage();
			for (const kind of Object.keys(observationKinds) as Observation["kind"][])
				coverage.kinds[kind] = 1;
			for (const race of namedRaces) coverage.races[race] = 1;
			coverage.kinds.activity = 0;
			coverage.assertComplete();
		},
	);
	it.runIf(process.env["RUN_LEDGER_PROBE"] === "missing-race")(
		"red: omitted race fails the gate",
		() => {
			const coverage = new Coverage();
			for (const kind of Object.keys(observationKinds) as Observation["kind"][])
				coverage.kinds[kind] = 1;
			for (const race of namedRaces) coverage.races[race] = 1;
			coverage.races[
				"Pause native command plus wake Run leaves foreground authority unchanged"
			] = 0;
			coverage.assertComplete();
		},
	);
	it.runIf(process.env["RUN_LEDGER_PROBE"] === "li8")(
		"red: planted provider violation is detected",
		() => {
			const fake = new FakeProvider("claude");
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "process_started",
						label: fake.label,
						reattached: true,
					},
				},
				emptyView(),
				emptyView(),
				[],
				[],
			);
		},
	);
});

describe.each(providers)("%s model-based public traces", (provider) => {
	for (const seed of fixedSeeds) {
		pendingSuite(`[convergence] ${provider} oracle traces, seed ${seed}`)(
			`oracle LI1-LI10 and full coverage, seed ${seed}`,
			({ task }) => {
				const coverage = new Coverage();
				let lastTrace: TraceDriver | undefined;
				const property = fc.property(
					fc.commands([traceAction.map((a) => new ProviderCommand(a))], {
						maxCommands,
						size: "max",
					}),
					(commands) => {
						assert(referenceImplementation);
						const real = new DifferentialTrace(
							provider,
							referenceImplementation,
							referenceImplementation,
						);
						const model = {
							scheduler: real.expected.host,
							executedCommands: 0,
						};
						try {
							real.step({
								verb: "settle",
								settlement: {
									kind: "process_started",
									label: real.expected.label,
									reattached: false,
								},
							});
							fc.modelRun(() => ({ model, real }), commands);
						} catch (error) {
							lastTrace = real.expected;
							throw error;
						} finally {
							coverage.merge(real.coverage);
						}
					},
				);
				const result = fc.check(property, { seed, numRuns: runs });
				oracleCoverage.merge(coverage);
				writeTraceArtifact(
					`oracle-${provider}-${seed}`,
					{
						test: { id: task.id, name: task.name, file: task.file.filepath },
						seed,
						runs,
						maxCommands,
						size: "max",
						evidence: coverage.kinds,
						races: coverage.races,
						shapes: coverage.shapes,
						outcomes: coverage.outcomes,
						shrunkFailures: result.failed
							? [
									{
										seed: result.seed,
										path: result.counterexamplePath,
										commands: result.counterexample?.map(String),
										publicCommands: lastTrace?.commands,
										firstDivergence: lastTrace?.commands.at(-1),
										error: String(result.errorInstance),
									},
								]
							: [],
					},
					task.id,
				);
				assert.equal(result.failed, false, String(result.errorInstance));
			},
			seedTimeout,
		);
		// The differential also checks the oracle against the fake, so a seed pended for their
		// convergence stays pended here.
		const convergence = `[convergence] ${provider} oracle traces, seed ${seed}`;
		const pended = pendingCases.has(convergence)
			? convergence
			: `[checkpoint] ${provider} run-ledger-differential`;
		pendingSuite(pended)(
			`real decider agrees at every step, seed ${seed}`,
			({ task }) => {
				const coverage = new Coverage();
				let lastTrace: TraceDriver | undefined;
				const result = fc.check(
					fc.property(
						fc.commands([traceAction.map((a) => new ProviderCommand(a))], {
							maxCommands,
							size: "max",
						}),
						(commands) => {
							const real = new DifferentialTrace(provider);
							try {
								real.step({
									verb: "settle",
									settlement: {
										kind: "process_started",
										label: real.expected.label,
										reattached: false,
									},
								});
								fc.modelRun(
									() => ({
										model: {
											scheduler: real.expected.host,
											executedCommands: 0,
										},
										real,
									}),
									commands,
								);
							} catch (error) {
								lastTrace = real.expected;
								throw error;
							} finally {
								coverage.merge(real.coverage);
							}
						},
					),
					{ seed, numRuns: runs },
				);
				writeTraceArtifact(
					`differential-${provider}-${seed}`,
					{
						test: { id: task.id, name: task.name, file: task.file.filepath },
						seed,
						runs,
						maxCommands,
						size: "max",
						evidence: coverage.kinds,
						races: coverage.races,
						shrunkFailures: result.failed
							? [
									{
										seed: result.seed,
										path: result.counterexamplePath,
										commands: result.counterexample?.map(String),
										publicCommands: lastTrace?.commands,
										firstDivergence: lastTrace?.commands.at(-1),
										error: String(result.errorInstance),
									},
								]
							: [],
					},
					task.id,
				);
				assert.equal(result.failed, false, String(result.errorInstance));
			},
			seedTimeout,
		);
	}
	it("LI2 joins commute across send outcomes and receipt orders", ({
		task,
	}) => {
		const comparisons: unknown[] = [];
		for (const outcome of [
			{ tag: "succeeded" },
			{ tag: "delivery_unknown" },
			{ tag: "retryable", retryAt: 500 },
			{ tag: "permanent", code: "Refused" },
		] as const) {
			const drivers = [new TraceDriver(provider), new TraceDriver(provider)];
			const tombstonedBetween: string[][] = [[], []];
			for (const [index, d] of drivers.entries()) {
				d.step(
					{
						verb: "settle",
						settlement: {
							kind: "process_started",
							label: d.label,
							reattached: false,
						},
					},
					100,
				);
				d.step({
					verb: "admit",
					inputId: "A",
					delivery: "queue",
					request: { text: "A" },
				});
				// D60: main, not decide, starts the Run; the start reaches the log through `live`.
				main(d, 0);
				const send = d.latest("start");
				const evidence: Evidence[] = [
					{ kind: "input_accepted", nativeMessageId: "native-A" },
					{ kind: "effect_outcome", outcome },
				];
				for (const [factIndex, e] of (index === 0
					? evidence
					: evidence.reverse()
				).entries()) {
					const decision = d.observe(send, e, 100);
					if (factIndex === 0)
						tombstonedBetween[index] = decision.ended.map(({ runId }) => runId);
				}
				d.observe(send, { kind: "accounting" }, 100);
				d.observe(send, { kind: "accounting" }, 100);
				expect(
					d.lastEventCount,
					"11.2: duplicate accounting receipt produces no events",
				).toBe(0);
			}
			const views = drivers.map((d) => {
				const n = new PublicNames();
				n.register(d);
				const view = d.view();
				return { view, n };
			});
			const [leftEnded, rightEnded] = tombstonedBetween;
			assert(leftEnded && rightEnded);
			const asymmetric = new Set([
				...leftEnded.filter((runId) => !rightEnded.includes(runId)),
				...rightEnded.filter((runId) => !leftEnded.includes(runId)),
			]);
			const normalized = views.map(({ view, n }) => {
				// D14 permits only this Run's absence from active. LedgerView has
				// no outcome fields; every other field is compared exactly.
				if (view.active && asymmetric.has(view.active.runId)) {
					const { active: _active, ...rest } = view;
					return n.normalize(rest);
				}
				return n.normalize(view);
			});
			comparisons.push({
				outcome,
				tombstonedBetween,
				views: views.map(({ view }) => view),
				normalized,
			});
			writeTraceArtifact(`li2-${provider}`, { comparisons }, task.id);
			expect(normalized[0]).toEqual(normalized[1]);
		}
	});
});

describe.each(providers)("%s long public traces", (provider) => {
	for (const lane of ["oracle", "differential"] as const)
		it.runIf(process.env["RUN_LEDGER_LONG_PROOF"] === "1")(
			`${lane} executes every requested independent run with exact command lengths`,
			({ task }) => {
				const seed = fixedSeeds[0];
				let modelRunInvocations = 0;
				const samples: {
					generatedCommands: number;
					executedCommands: number;
					completedCommands: number;
					expectedDriverCommands: number;
					actualDriverCommands: number;
					completed: boolean;
					firstDivergence?: TraceDriver["commands"][number] | undefined;
					publicCommands?: TraceDriver["commands"];
					error?: string;
				}[] = [];
				const result = fc.check(
					fc.property(
						fc.array(
							traceAction.map((a) => new ProviderCommand(a)),
							{
								minLength: maxCommands,
								maxLength: maxCommands,
							},
						),
						(commands) => {
							assert(referenceImplementation);
							const real =
								lane === "oracle"
									? new DifferentialTrace(
											provider,
											referenceImplementation,
											referenceImplementation,
										)
									: new DifferentialTrace(provider);
							const model = {
								scheduler: real.expected.host,
								executedCommands: 0,
							};
							let failed = false;
							let error: unknown;
							try {
								modelRunInvocations++;
								fc.modelRun(() => {
									real.step({
										verb: "settle",
										settlement: {
											kind: "process_started",
											label: real.expected.label,
											reattached: false,
										},
									});
									return { model, real };
								}, commands);
							} catch (caught) {
								// Keep the first divergence, then try every remaining independent run.
								// The final assertion still fails if any trace diverges.
								failed = true;
								error = caught;
							}
							samples.push({
								generatedCommands: Array.from(commands).length,
								executedCommands: model.executedCommands,
								completedCommands: Math.max(
									0,
									model.executedCommands - (failed ? 1 : 0),
								),
								expectedDriverCommands: Math.max(
									0,
									real.expected.commands.length - 1,
								),
								actualDriverCommands: Math.max(
									0,
									real.actual.commands.length - 1,
								),
								completed: !failed,
								...(failed
									? {
											firstDivergence: real.expected.commands.at(-1),
											publicCommands: real.expected.commands,
											error: String(error),
										}
									: {}),
							});
						},
					),
					{
						seed,
						numRuns:
							process.env["RUN_LEDGER_PROBE"] === "run-count" ? runs - 1 : runs,
					},
				);
				const failures = samples.filter(({ completed }) => !completed);
				writeTraceArtifact(
					`long-${lane}-${provider}`,
					{
						test: { id: task.id, name: task.name, file: task.file.filepath },
						stage: lane,
						seed,
						requestedRuns: runs,
						requestedCommandsPerRun: maxCommands,
						attemptedRuns: samples.length,
						modelRunInvocations,
						completedRuns: samples.length - failures.length,
						failedRuns: failures.length,
						commandCountsExcludeInitialProcessStarted: true,
						generatedCommands: samples.reduce(
							(total, sample) => total + sample.generatedCommands,
							0,
						),
						executedCommands: samples.reduce(
							(total, sample) => total + sample.executedCommands,
							0,
						),
						completedCommands: samples.reduce(
							(total, sample) => total + sample.completedCommands,
							0,
						),
						expectedDriverCommands: samples.reduce(
							(total, sample) => total + sample.expectedDriverCommands,
							0,
						),
						actualDriverCommands: samples.reduce(
							(total, sample) => total + sample.actualDriverCommands,
							0,
						),
						fastCheckRuns: result.numRuns,
						fastCheckShrinks: result.numShrinks,
						samples,
					},
					task.id,
				);
				assert.equal(result.failed, false, String(result.errorInstance));
				assert.equal(result.numRuns, runs, "long trace requested run count");
				assert.equal(samples.length, runs, "long trace attempted run count");
				assert.equal(modelRunInvocations, runs, "long trace modelRun count");
				assert(
					samples.every(
						({ generatedCommands }) => generatedCommands === maxCommands,
					),
					"long trace requested commands per run",
				);
				assert.equal(
					failures.length,
					0,
					`${failures.length}/${runs} independent traces diverged; first: ${failures[0]?.error}`,
				);
			},
		);
});

describe("generated D34 coverage", () => {
	// The property generator, not only the D34 scenario, must reach a refused native command (8.5, D34).
	it("generated traces refuse a native command at delivery", () => {
		assert(
			oracleCoverage.races["a native command refused at delivery"] > 0,
			"D34: no generated trace refused a native command",
		);
	});
	// Round 9 phase 2: the generator, not a scenario, reaches each shape (input-kinds.md).
	for (const shape of [
		"D43 gated Run ended, gate dropped", // D43, 5.1, 8.4
		"process_lost while gated", // 8.4 release by retirement, REDESIGN r2-1
		"older wake label Run-end evidence", // 8.3: clears that execution only
		// D61: an Unsolicited receipt by its native command's key counts, as main's control row is answered
		// only by its effect_outcome (3.4).
		"native-token command_lifecycle", // 8.5, D21, D61
		"native-token command_result", // 8.5, D21, D61
		"native_resume_rejected", // 3.4, 3.7
		"probe input_present without id", // 3.5
		"OpenCode absent reading settled by the idle read after it", // 3128-3132
		"OpenCode lost prompt sent again", // 3.9 965-973, 3128-3132
		"query replacement", // 6.1, L1, D44
		"confirm copied before a query replacement", // 8.4, D45
		"turn joined to an input Run", // 8.3, D47
		"input Run ended by its start under a joined turn", // 8.3, D47
		// Round 13: every gate answer variant (H4, 4.4, D48) and the 3.6 unlaunch transition.
		"not_sent Held start", // H4, 4.4 gate before holdRun
		"not_sent Held steer", // H4, 4.4
		"not_sent probe", // H4, 3.5, 4.8
		// Round 2d: a row main's executor runs, a direct start's, a steer's or a control's, gets no
		// not_sent (3.4 465-471), and the native clock no longer pauses for one (8.5), so "not_sent
		// no-hold start", "not_sent no-hold steer", "not_sent interrupt", "not_sent native command" and
		// "native clock paused at not_sent" name no accepted input.
		"not_sent other send", // H4
		"removed Held start", // H4 removed, 4.4 Send Settlement
		// "removed Held steer" is counted, not barred here: the default run (100 x 80) reaches it 0 times,
		// the round 12 long config 100 times (H4 removed, 4.4).
		"removed no-hold send", // H4 removed, 3.7 permanent
		"removed native command", // 4.4, 8.5 Failed{code}
		"not_sent after a joined turn", // 3.6 Otherwise, 8.3
		"long not_sent run", // 4.8 no cap for not_sent
		"unlaunch", // 3.6
		"not_sent start ended its Run", // 3.6 Otherwise, 8.3
		"removal process_lost", // H4, 6.3
		"Registering restart turn", // H4 Registering, 6.1 adopted runner
		// Round 14: D49 unheld_outcome, 3.13 releases, D50 unlaunch and not yet delivered, Q28, D48 amended.
		"unheld_outcome retryable", // D49, 3.13, 4.4
		"unheld_outcome permanent start failure", // D49, 4.4
		"unheld_outcome after a Stop", // D49, 3.4
		"unheld_outcome after a reissue", // D49 latest issue of the commandId
		"unheld_outcome after its runner retired", // D49, L1
		"unheld_outcome unknown runId", // D49
		"release Refused exiting", // 4.5, 4.6 idle exit
		"release Refused retiring", // 4.5, F40 self-retire
		"release Refused interrupted", // 4.5, 4.6
		"release NotSent", // 3.13, 4.5
		"release JournalAbsent", // 3.13, 4.5
		"release reasons mixed", // 3.13
		"release of a reached Run", // 3.6, 3.13
		"unlaunch by Refused", // 3.6 D50
		"unlaunch by NotSent", // 3.6 D50
		"unlaunch by JournalAbsent", // 3.6 D50
		"unlaunch by ResumeRejected", // 3.6 D50, 4.5
		"unlaunch by retryable", // 3.6 D50
		"unlaunch by not_sent", // 3.6 D50, G4 option B
		"unlaunch by retirement", // 3.6 D50, L1
		"relaunch after unlaunch", // 3.6 D50, 3.7
		"Stop on a not-yet-delivered Run", // 3.6 D50
		"Run now on a not-yet-delivered Run", // 3.6 D50
		"End on a not-yet-delivered Run", // 3.6, 5.1
		"permanent start outcome refused an undelivered Run", // 3.6 D50
		"joined Run's not_sent start retried in its execution", // 3.6, H4, 8.3
		"joined Run ended by its runner's retirement", // 3.6, L1
		"Q28 adoption with not_received", // Q28, 7.2
		"Q28 journal settle", // Q28, 7.3
		"Q28 removed with a surviving runner", // 4.4, Q28
		// Rounds 16 and 17 (CONTRACT.md 4070-4085): REDESIGN-7 review round 1 and REDESIGN-9's kinds.
		"message sent while Interrupting", // L6, 3.9 D53
		"held wake turn just before a Stop commit", // 8.3, L6
		"async question at a Stop commit", // 3.10, L6
		"runner failure with a steer possibly reached and an input queued", // 3.9 D53, L1
		"held wake turn just after a Stop commit", // 8.3, L6
		"answer in delivery at a Stop commit", // 3.10, L6
		"async question at a retirement", // 3.10, L1
		"end_session issued after the stop's deadline step", // L6, 3.4
		"Claude steer started after its Run completed", // 3.9 978-985
		"Stop of a late steer's turn", // 3.9, L6
		"steer send failure with inputs queued", // 3.9 D53
		"next start after a Cursor abandonment, then retirement", // 3113-3117
		// 3.10: every answer path (CONTRACT.md 999-1050).
		"prompt asked", // 3.10 1001-1006
		"answer submitted", // 3.10 1007-1008
		"timeout answer", // 3.10 1009-1012
		"answer after the first answer won", // 3.10 1007-1012
		"refused answer retrying", // 3.10 1015-1018
		"answer refused for good", // 3.10 1019-1022
		"answer refused through the retry cap", // 3.10 1015-1022
		"prompt reopened after its answer failed for good", // 3.10 1019-1022
		"late outcome for a reopened prompt's old answer", // 3.10 1019-1022, 3.4
		// Round 2d: the native clock no longer pauses at not_sent, so neither its pause nor its resume at
		// re-issue is a shape (8.5).
	] as const)
		pendingSuite(`[convergence] generated traces reach ${shape}`)(
			`generated traces reach ${shape}`,
			() => {
				expect(oracleCoverage.shapes[shape], shape).toBeGreaterThan(0);
			},
		);
	// 8.3 (oracle round 8 clarifications): older wake execution labels never end the Run.
	it("generated older wake label Run-end evidence never ends the Run", () => {
		expect(oracleCoverage.shapes["older wake label Run end"]).toBe(0);
	});
});

describe("fixed catalogue coverage", () => {
	pendingSuite("[convergence] fixed catalogue race gate")(
		"executes every fixed trace and gates actual race hits",
		() => {
			const coverage = new Coverage();
			coverage.merge(oracleCoverage);
			// The race gate reads generated coverage and each scenario Driver's races; scenarios.test.ts
			// reports each scenario's divergence.
			const failed: string[] = [];
			for (const scenario of scenarios) {
				const d = new Driver(scenario.provider);
				try {
					scenario.run(d);
				} catch {
					failed.push(scenario.id);
				} finally {
					coverage.merge(d.coverage);
				}
			}
			writeTraceArtifact("fixed-coverage", {
				seeds: fixedSeeds,
				evidence: coverage.kinds,
				races: coverage.races,
				generatedShapes: oracleCoverage.shapes,
				failedScenarios: failed,
				shrunkFailures: [],
			});
			coverage.assertComplete();
			assert.deepEqual(
				failed,
				[],
				"fixed scenarios that fail against the oracle",
			);
		},
	);
});
