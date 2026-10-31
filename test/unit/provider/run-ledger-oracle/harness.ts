import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import * as production from "../../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	DecideContext,
	Decision,
	Evidence,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	Observation,
	ProviderKind,
	RunEffect,
	RunEnded,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { FakeProvider, type Send, splitLabel } from "./fake-provider.js";
import * as oracleModule from "./reference.js";

/** Each implementation owns its state and entries; the harness only folds entries. */
export interface LedgerImplementation<State, Entry> {
	initialSessionLedgerState(sessionId: string, provider: ProviderKind): State;
	// Gate answers (H4) are LedgerCommand members: `not_sent` and `unheld_outcome` (3.13).
	decide(
		state: State,
		command: LedgerCommand,
		ctx: DecideContext,
	): Decision<Entry>;
	evolve(state: State, entry: Entry): State;
	viewLedger(state: State): LedgerView;
}

function publicImplementation(
	value: unknown,
): value is LedgerImplementation<unknown, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		["initialSessionLedgerState", "decide", "evolve", "viewLedger"].every(
			(key) => key in value && typeof Reflect.get(value, key) === "function",
		)
	);
}
const oracle: unknown = oracleModule;
// Fail loud: an oracle missing the four public functions fails every importer, never skips.
assert(
	publicImplementation(oracle),
	"32.2.3 oracle has not exported the four public functions",
);
/** The oracle reads `unheld_outcome` (D49) and a stop commit's releases (3.13) natively. */
export const referenceImplementation: LedgerImplementation<unknown, unknown> =
	oracle;
/** settleMs is the contract's 7 s (3.7); probeMs and nativeCommandMs are test policy, this folder's one constant. */
export const policy: DecideContext["policy"] = {
	settleMs: 7_000,
	probeMs: 500,
	nativeCommandMs: 800,
};
export interface StepResult {
	readonly tag: "Accepted" | "Rejected";
	readonly effects: readonly IssuedEffect[];
	readonly ended: readonly RunEnded[];
	readonly alarmAt?: number;
	readonly diagnostic?: string;
}
/** What Coverage.record reads of a trace: TraceDriver, and each scenario Driver for the race gate. */
export interface CoverageReader {
	readonly provider: ProviderKind;
	/** The current runner label (3.3). */
	readonly label: string;
	/** The send an Answer's token names, and the label it was addressed to (3.4, L2). */
	answered(
		token: SendToken,
	): { readonly send: Send; readonly label: string } | undefined;
}
export interface PublicDriver {
	step(command: LedgerCommand, now: number): Decision<unknown>;
	view(): LedgerView;
	replay(): LedgerView;
	readonly lastEventCount: number;
	readonly alarmAt: number | undefined;
}
/**
 * The one owner of a ledger step for scenarios and generated traces: decide changes no state, and
 * the view is its entries' replay (3.1, 3.13, LI4).
 */
export function driver<State, Entry>(
	implementation: LedgerImplementation<State, Entry>,
	provider: ProviderKind,
	prefix: string,
): PublicDriver {
	let state = implementation.initialSessionLedgerState(
		"trace-session",
		provider,
	);
	const entries: Entry[] = [];
	let serial = 0;
	let alarmAt: number | undefined;
	let lastEventCount = 0;
	const view = () => implementation.viewLedger(state);
	const replay = () =>
		implementation.viewLedger(
			entries.reduce(
				implementation.evolve,
				implementation.initialSessionLedgerState("trace-session", provider),
			),
		);
	return {
		step(command, now) {
			const before = structuredClone(view());
			const result = implementation.decide(state, command, {
				now,
				policy,
				newId: () => `${prefix}:${++serial}`,
			});
			assert.deepEqual(view(), before, "decide must not mutate its input");
			lastEventCount = result.tag === "Accepted" ? result.events.length : 0;
			if (result.tag === "Rejected") return result;
			state = result.events.reduce(implementation.evolve, state);
			entries.push(...result.events);
			alarmAt = result.alarmAt;
			assert.deepEqual(
				view(),
				replay(),
				"LI4: entries replay to the live public view",
			);
			return result;
		},
		view,
		replay,
		get lastEventCount() {
			return lastEventCount;
		},
		get alarmAt() {
			return alarmAt;
		},
	};
}

/** Dynamic intake validates effect capability before correlating the public union. */
export function answer(send: Send, evidence: Evidence): Observation {
	const query = send.effect.kind === "start" || send.effect.kind === "steer";
	const allowed =
		evidence.kind === "effect_outcome" ||
		(query &&
			[
				"started",
				"input_accepted",
				"input_declined",
				"activity",
				"interaction_requested",
				"interaction_resolved",
				"result",
				"query_ended",
				"accounting",
				"command_lifecycle",
				"run_dispatched",
				"run_released",
				"delivery_indeterminate",
				"runner_reply",
				"journal_answer",
			].includes(evidence.kind)) ||
		(send.effect.kind === "probe" && evidence.kind === "probe_result") ||
		(send.effect.kind === "deliver_answer" &&
			evidence.kind === "interaction_resolved") ||
		(send.effect.kind === "send_native_command" &&
			["command_lifecycle", "command_result"].includes(evidence.kind));
	assert(allowed, `${send.effect.kind} cannot produce ${evidence.kind}`);
	// TypeScript cannot distribute two dynamically correlated unions after the check.
	// An Answer names only its send's token; the send's address owns the label (3.4, L2).
	return {
		tag: "Answer",
		token: send.token,
		...evidence,
	} as Observation;
}

export class TraceDriver {
	now = 100;
	readonly commands: {
		readonly command: LedgerCommand;
		readonly now: number;
	}[] = [];
	readonly host: FakeProvider;
	readonly coverage = new Coverage();
	private readonly dispatched = new Set<string>();
	private readonly wireBindings: {
		readonly issue: number;
		readonly n: number;
		readonly send: Send;
	}[] = [];
	private readonly publicDriver: PublicDriver;
	/** Decide's effects, main's starts and steers (D60), and main calls the arm folded into `live`, in order. */
	private readonly log: IssuedEffect[] = [];
	constructor(
		readonly provider: ProviderKind,
		readonly mode: "reference" | "decider" = "reference",
		implementation?: LedgerImplementation<unknown, unknown>,
	) {
		this.host = new FakeProvider(provider);
		if (implementation)
			this.publicDriver = driver(implementation, provider, mode);
		else if (mode === "decider")
			this.publicDriver = driver(production, provider, mode);
		else this.publicDriver = driver(referenceImplementation, provider, mode);
	}
	step(
		command: LedgerCommand,
		now = this.now + 1,
		mainIssues = this.host.takeMainIssues(),
	): StepResult {
		this.commands.push({ command, now });
		this.now = now;
		// D60: main issued these while it drew the command; the fake already holds and binds them.
		this.log.push(...mainIssues.map(({ issue }) => issue));
		const before = this.view();
		const stepped = this.publicDriver.step(command, now);
		const after = this.view();
		// 3.4, 8.4 (CONTRACT.md 449-455, 2889-2898): a Main issue is its row's commandId and kind; an
		// end's Stop row and a later end_session are separate Controls under distinct commandIds.
		const same = (a: IssuedEffect, b: IssuedEffect) =>
			a.tag === "Main"
				? b.tag === "Main" &&
					a.commandId === b.commandId &&
					a.effect.kind === b.effect.kind
				: b.tag === "Tokened" && a.token === b.token;
		// CONTRACT 1176-1178 (D60): decide issues only probe, stop_task and cancel_request; a main call
		// (interrupt, end_session, deliver_answer, send_native_command) reaches the fake as a new `live` entry.
		const folded =
			stepped.tag === "Accepted"
				? after.live.filter(
						(item) =>
							![...this.log, ...stepped.effects].some((seen) =>
								same(seen, item),
							),
					)
				: [];
		const result: StepResult =
			stepped.tag === "Accepted"
				? { ...stepped, effects: [...stepped.effects, ...folded] }
				: { ...stepped, effects: [], ended: [] };
		this.log.push(...result.effects);
		this.coverage.recordShapes(command, before, after, result, this);
		this.coverage.record(command, before, after, result, this);
		this.host.assertVerdict(command, result.tag);
		if (result.tag === "Accepted")
			this.host.assertStep(
				command,
				before,
				after,
				result.effects,
				result.ended,
				this.replay(),
				now,
			);
		return result;
	}
	view(): LedgerView {
		return this.publicDriver.view();
	}
	replay(): LedgerView {
		return this.publicDriver.replay();
	}
	get issued(): readonly IssuedEffect[] {
		return this.log;
	}
	get lastEventCount(): number {
		return this.publicDriver.lastEventCount;
	}
	get alarmAt(): number | undefined {
		return this.publicDriver.alarmAt;
	}
	get label(): string {
		return this.host.label;
	}
	answered(
		token: SendToken,
	): { readonly send: Send; readonly label: string } | undefined {
		for (const issue of this.issued) this.bound(issue);
		const send = this.wireBindings.find(
			(item) => item.send.token === token,
		)?.send;
		return send && { send, label: this.host.labelFor(send) };
	}
	bound(send: IssuedEffect | Send): Send {
		if (!("tag" in send)) return send;
		const bound = this.host.bound(send);
		// A gated hold has no transmission, so it binds no wire send (H4, 4.4).
		if (this.host.isHeld(send) && this.host.isGated(bound.token)) return bound;
		const issue = this.issued.findIndex((item) =>
			item.tag === "Main" && send.tag === "Main"
				? item.commandId === send.commandId &&
					item.effect.kind === send.effect.kind
				: item === send,
		);
		// 3.4: a control claim or a direct send is named by main's transmission, never by binding order.
		const claimed = send.tag === "Main" && !this.host.isHeld(send);
		if (
			issue >= 0 &&
			!claimed &&
			!this.wireBindings.some((item) => item.send.token === bound.token)
		) {
			const n =
				this.wireBindings.filter((item) => item.issue === issue).length + 1;
			this.wireBindings.push({ issue, n, send: bound });
		}
		if (send.tag === "Main" && issue >= 0)
			for (const binding of this.host.bindingsFor(send))
				if (
					!this.wireBindings.some(
						(item) => item.send.token === binding.send.token,
					)
				)
					this.wireBindings.push({
						issue,
						n: binding.transmission,
						send: binding.send,
					});
		return bound;
	}
	bindTransmission(issue: number, transmission: number): void {
		const held = this.issued[issue];
		assert(
			held !== undefined && this.host.isHeld(held),
			"Only held issues have transmissions",
		);
		this.bound(held);
		while (
			!this.wireBindings.some(
				(item) => item.issue === issue && item.n === transmission,
			)
		) {
			const retry = { ...held };
			this.host.issued([retry]);
			this.bound(retry);
		}
	}
	get bindings(): readonly {
		readonly issue: number;
		readonly n: number;
		readonly send: Send;
	}[] {
		return this.wireBindings;
	}
	redispatch(send: IssuedEffect): Send {
		assert(this.host.isHeld(send), "Only holdRun retries a held send");
		const held = { ...send };
		const retry = this.bound(held);
		this.host.issued([held]);
		this.observe(retry, {
			...this.host.dispatch(retry),
		});
		return retry;
	}
	observe(
		send: IssuedEffect | Send,
		evidence: Evidence,
		now = this.now,
	): StepResult {
		const bound = this.bound(send);
		if (
			"tag" in send &&
			this.host.isHeld(send) &&
			evidence.kind !== "run_dispatched" &&
			!this.dispatched.has(bound.token)
		) {
			const dispatch = this.step(
				{
					verb: "observe",
					observation: answer(bound, this.host.dispatch(bound)),
				},
				now,
			);
			assert.equal(
				dispatch.tag,
				"Accepted",
				dispatch.diagnostic ?? "held dispatch rejected",
			);
			this.dispatched.add(bound.token);
		}
		if (evidence.kind === "run_dispatched") this.dispatched.add(bound.token);
		return this.step(
			{ verb: "observe", observation: answer(bound, evidence) },
			now,
		);
	}
	latest(
		kind: RunEffect["kind"],
		predicate?: (effect: RunEffect) => boolean,
	): IssuedEffect {
		const send = this.issued
			.slice()
			.reverse()
			.find(
				(item) =>
					item.effect.kind === kind && (!predicate || predicate(item.effect)),
			);
		assert(send, `trace has no issued ${kind} matching the selector`);
		return send;
	}
}

/** Identity alignment uses public issue order, never opaque identifier equality. */
export class PublicNames {
	private readonly runs = new Map<string, string>();
	private readonly tokens = new Map<string, string>();
	private readonly commands = new Map<string, string>();
	register(d: TraceDriver): void {
		for (const [index, send] of d.issued.entries()) {
			if (
				"runId" in send.effect &&
				typeof send.effect.runId === "string" &&
				!this.runs.has(send.effect.runId)
			)
				this.runs.set(send.effect.runId, `run:${this.runs.size}`);
			if (send.tag === "Main" && !this.commands.has(send.commandId))
				this.commands.set(send.commandId, `main:${index}`);
			d.bound(send);
		}
		for (const binding of d.bindings)
			this.tokens.set(binding.send.token, `send:${binding.issue}:${binding.n}`);
		const active = d.view().active;
		if (active && !this.runs.has(active.runId))
			this.runs.set(active.runId, `run:${this.runs.size}`);
	}
	normalize(value: unknown, key = ""): unknown {
		if (["key", "wakeTask", "answer"].includes(key)) return value;
		if (typeof value === "string") {
			if (key === "runId") {
				if (!this.runs.has(value))
					this.runs.set(value, `run:${this.runs.size}`);
				return this.runs.get(value);
			}
			if (key === "token") return this.tokens.get(value) ?? value;
			if (key === "commandId") return this.commands.get(value) ?? value;
			return value;
		}
		if (Array.isArray(value))
			return value.map((item: unknown) => this.normalize(item));
		if (typeof value === "object" && value !== null)
			return Object.fromEntries(
				Object.entries(value).map(([field, item]) => [
					field,
					// Main's commandId names an issue; a lastRefusal attempt names one of its transmissions (3.10).
					field === "commandId" &&
					Reflect.get(value, "tag") !== "Main" &&
					key !== "attempt"
						? item
						: this.normalize(item, field),
				]),
			);
		return value;
	}
}
export function translateCommand(
	command: LedgerCommand,
	from: TraceDriver,
	to: TraceDriver,
): LedgerCommand {
	if (
		command.verb === "settle" &&
		(command.settlement.kind === "hold_exhausted" ||
			command.settlement.kind === "unheld_outcome")
	) {
		const settlement = command.settlement;
		// An unheld_outcome names its Run's latest issue of the queue key (D49); an unknown runId stays unknown.
		const runId =
			settlement.kind === "unheld_outcome" ? settlement.runId : undefined;
		const matches = (item: IssuedEffect) =>
			from.host.isHeld(item) && item.commandId === settlement.commandId;
		const named = from.issued.reduce(
			(found, item, i) =>
				matches(item) && "runId" in item.effect && item.effect.runId === runId
					? i
					: found,
			-1,
		);
		const issue = named >= 0 ? named : from.issued.findIndex(matches);
		const target = to.issued[issue];
		if (target === undefined || !to.host.isHeld(target)) return command;
		return settlement.kind === "unheld_outcome"
			? {
					verb: "settle",
					settlement: {
						...settlement,
						commandId: target.commandId,
						...(named >= 0 &&
						"runId" in target.effect &&
						typeof target.effect.runId === "string"
							? { runId: target.effect.runId }
							: {}),
					},
				}
			: {
					verb: "settle",
					settlement: { ...settlement, commandId: target.commandId },
				};
	}
	// Main observations carry main's own ids, which both fakes mint by the same counters (D60).
	if (command.verb !== "observe" || command.observation.tag !== "Answer")
		return command;
	const observation = command.observation;
	for (const send of from.issued) from.bound(send);
	for (const send of to.issued) to.bound(send);
	const binding = from.bindings.find(
		(item) => item.send.token === observation.token,
	);
	// Only a hold has transmissions; run_dispatched on another send is a Rejected-path input (3.4).
	const held = binding && to.issued[binding.issue];
	if (
		binding &&
		held &&
		observation.kind === "run_dispatched" &&
		to.host.isHeld(held)
	)
		to.bindTransmission(binding.issue, observation.transmission);
	const target =
		binding &&
		to.bindings.find(
			(item) => item.issue === binding.issue && item.n === binding.n,
		);
	if (!target) return command;
	const commandId =
		observation.kind === "run_dispatched" ||
		observation.kind === "command_lifecycle"
			? observation.commandId
			: undefined;
	const commandIssue = from.issued.findIndex(
		(issue) => from.host.isHeld(issue) && issue.commandId === commandId,
	);
	const targetCommand = to.issued[commandIssue];
	// The two effect kinds have already been compared at issue.
	return {
		...command,
		observation: {
			...observation,
			token: target.send.token,
			...(commandId !== undefined &&
			targetCommand !== undefined &&
			to.host.isHeld(targetCommand)
				? { commandId: targetCommand.commandId }
				: {}),
		} as Observation,
	};
}

export class DifferentialTrace {
	readonly expected: TraceDriver;
	readonly actual: TraceDriver;
	private readonly expectedNames = new PublicNames();
	private readonly actualNames = new PublicNames();
	constructor(
		provider: ProviderKind,
		expected?: LedgerImplementation<unknown, unknown>,
		actual?: LedgerImplementation<unknown, unknown>,
	) {
		this.expected = new TraceDriver(provider, "reference", expected);
		this.actual = new TraceDriver(provider, "decider", actual);
	}
	step(command: LedgerCommand, now = this.expected.now + 1): void {
		const translated = translateCommand(command, this.expected, this.actual);
		this.actual.host.mirrorRegistry(this.expected.host);
		// D60: main is one host process, so both ledgers see the issues the expected fake drew.
		const mainIssues = this.expected.host.takeMainIssues();
		this.actual.host.issued(mainIssues.map(({ issue }) => issue));
		const expected = this.expected.step(command, now, mainIssues);
		const actual = this.actual.step(translated, now, mainIssues);
		this.expectedNames.register(this.expected);
		this.actualNames.register(this.actual);
		assert.equal(actual.tag, expected.tag, "decision acceptance");
		assert.equal(
			this.actual.alarmAt,
			this.expected.alarmAt,
			"alarmAt exactly, including after rejection",
		);
		assert.deepEqual(
			this.actualNames.normalize(actual.effects),
			this.expectedNames.normalize(expected.effects),
			"issued effects in issue order",
		);
		assert.deepEqual(
			this.actualNames.normalize(actual.ended),
			this.expectedNames.normalize(expected.ended),
			"Run terminals",
		);
		assert.deepEqual(
			this.actualNames.normalize(this.actual.view()),
			this.expectedNames.normalize(this.expected.view()),
			"view after every step",
		);
	}
	get coverage(): Coverage {
		return this.expected.coverage;
	}
}

export const observationKinds = {
	started: 0,
	input_accepted: 0,
	input_declined: 0,
	activity: 0,
	interaction_requested: 0,
	interaction_resolved: 0,
	result: 0,
	query_ended: 0,
	accounting: 0,
	effect_outcome: 0,
	probe_result: 0,
	tasks_snapshot: 0,
	task_event: 0,
	turn_started: 0,
	command_lifecycle: 0,
	command_result: 0,
	run_dispatched: 0,
	run_released: 0,
	delivery_indeterminate: 0,
	runner_reply: 0,
	journal_answer: 0,
	turn_ended: 0,
	// D60: the arm's projections of main's events (3.13).
	run_requested: 0,
	run_started: 0,
	run_terminal: 0,
} satisfies Record<Observation["kind"], number>;
export const namedRaces = [
	"start refused with an accepted sibling",
	"process loss mid-Run",
	"runner release",
	"late acceptance after a Tombstone",
	"unknown delivery settled by a probe",
	"evidence on both sides of a Tombstone",
	"a wake turn while an input is queued",
	"a snapshot during Interrupting",
	"a stale confirm",
	"a label change mid-interrupt",
	"a clear held by Claude",
	"an idle clear",
	"Pause native command plus wake Run leaves foreground authority unchanged",
	"a native command refused at delivery",
] as const;
export type NamedRace = (typeof namedRaces)[number];
export const generatedShapes = [
	"D43 gated Run ended, gate dropped",
	"D43 gated Run ended, gate kept",
	"process_lost while gated",
	"older wake label Run-end evidence",
	"older wake label Run end",
	"native-token command_lifecycle",
	"native-token command_result",
	"native_resume_rejected",
	"probe input_present without id",
	"query replacement",
	"confirm copied before a query replacement",
	"turn joined to an input Run",
	"input Run ended by its start under a joined turn",
	// Round 13, H4 and 4.4: each gate answer by send kind (input-kinds.md).
	"not_sent Held start",
	"not_sent Held steer",
	"not_sent probe",
	"not_sent other send",
	"removed Held start",
	"removed Held steer",
	"removed no-hold send",
	"removed native command",
	"not_sent after a joined turn",
	"long not_sent run",
	"unlaunch",
	"not_sent start ended its Run",
	"removal process_lost",
	"Registering restart turn",
	// Round 14, D49, D50, 3.13, Q28 and D48 amended (input-kinds.md).
	"unheld_outcome retryable",
	"unheld_outcome permanent start failure",
	"unheld_outcome after a Stop",
	"unheld_outcome after a reissue",
	"unheld_outcome after its runner retired",
	"unheld_outcome unknown runId",
	"release Refused exiting",
	"release Refused retiring",
	"release Refused interrupted",
	"release NotSent",
	"release JournalAbsent",
	"release reasons mixed",
	"release of a reached Run",
	"unlaunch by Refused",
	"unlaunch by NotSent",
	"unlaunch by JournalAbsent",
	"unlaunch by ResumeRejected",
	"unlaunch by retryable",
	"unlaunch by not_sent",
	"unlaunch by retirement",
	"relaunch after unlaunch",
	"Stop on a not-yet-delivered Run",
	"Run now on a not-yet-delivered Run",
	"End on a not-yet-delivered Run",
	"permanent start outcome refused an undelivered Run",
	"joined Run's not_sent start retried in its execution",
	"joined Run ended by its runner's retirement",
	"Q28 adoption with not_received",
	"Q28 journal settle",
	"Q28 removed with a surviving runner",
] as const;
export type GeneratedShape = (typeof generatedShapes)[number];
export class Coverage {
	readonly kinds = { ...observationKinds };
	readonly races = Object.fromEntries(
		namedRaces.map((name) => [name, 0]),
	) as Record<NamedRace, number>;
	readonly outcomes: Record<string, number> = {};
	/** Generated input shapes the round 9 harness counts (input-kinds.md), keyed by `generatedShapes`. */
	readonly shapes = Object.fromEntries(
		generatedShapes.map((name) => [name, 0]),
	) as Record<GeneratedShape, number>;
	private readonly ended = new Set<string>();
	private readonly observed = new Set<string>();
	private readonly unknownInputs = new Set<string>();
	private readonly accepted = new Map<
		string,
		{ readonly runId: string; readonly inputId: string }
	>();
	/** Admitted inputs main has not yet requested (D58). */
	private readonly queuedInputs = new Set<string>();
	private readonly clearCommands = new Set<string>();
	private readonly pauseCommands = new Map<string, { wakeRunId?: string }>();
	/** Snapshot entries a query replacement made stale (D45). */
	private readonly replacedEntries = new Set<number>();
	/** Input Runs an unsolicited turn joined (D47). */
	private readonly joinedRuns = new Set<string>();
	/** Gate answers per send key, for a long not_sent run (4.8: no cap). */
	private readonly notSentRuns = new Map<string, number>();
	/** Runs a Stop, Run now or End ended (D49: a later unheld_outcome). */
	private readonly stopped = new Set<string>();
	/** Runs that went back to Queued (D50), until they launch again. */
	private readonly unlaunched = new Set<string>();
	/** How many of the trace's issues the relaunch count has read. */
	private seenIssues = 0;
	/** This runner's release Answers by token and reason, until its process_lost (3.13, 4.5). */
	private readonly releases = new Map<SendToken, string>();
	record(
		command: LedgerCommand,
		before: LedgerView,
		after: LedgerView,
		result: StepResult,
		d: CoverageReader,
	): void {
		const hit = (name: NamedRace) => {
			this.races[name]++;
		};
		// D58: an admitted input waits in main's inbox, which the ledger does not model, until its
		// run.requested (3.4).
		if (result.tag === "Accepted" && command.verb === "admit")
			this.queuedInputs.add(command.inputId);
		if (
			result.tag === "Accepted" &&
			command.verb === "observe" &&
			command.observation.tag === "Main" &&
			command.observation.kind === "run_requested"
		)
			this.queuedInputs.delete(command.observation.inputId);
		if (command.verb === "observe" && result.tag === "Accepted") {
			const e = command.observation;
			this.kinds[e.kind]++;
			const answered = e.tag === "Answer" ? d.answered(e.token) : undefined;
			const send = answered?.send;
			// An Answer's label is its send's address (3.4, L2); only Unsolicited frames carry one.
			const label = e.tag === "Unsolicited" ? e.label : answered?.label;
			if (label !== d.label) {
				for (const terminal of result.ended) this.ended.add(terminal.runId);
				return;
			}
			const runId =
				send && "runId" in send.effect ? send.effect.runId : undefined;
			if (e.kind === "effect_outcome") {
				const outcome = `${send?.effect.kind ?? "unknown"}:${e.outcome.tag}`;
				this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
				if (
					e.outcome.tag === "delivery_unknown" &&
					send &&
					"inputId" in send.effect
				)
					this.unknownInputs.add(`${send.effect.runId}/${send.effect.inputId}`);
			}
			const refused =
				(e.kind === "effect_outcome" && e.outcome.tag === "permanent") ||
				(e.kind === "run_released" &&
					typeof e.reason === "object" &&
					e.reason.tag === "Refused") ||
				(e.kind === "runner_reply" && e.outcome.tag === "failed");
			if (refused && send?.effect.kind === "start") {
				const effect = send.effect;
				if (
					[...this.accepted].some(
						([token, sibling]) =>
							token !== send.token &&
							sibling.runId === effect.runId &&
							sibling.inputId === effect.inputId,
					)
				)
					hit("start refused with an accepted sibling");
			}
			if (
				e.kind === "input_accepted" &&
				runId &&
				send &&
				"inputId" in send.effect
			) {
				this.accepted.set(send.token, { runId, inputId: send.effect.inputId });
				if (this.ended.has(runId)) hit("late acceptance after a Tombstone");
			}
			if (
				e.kind === "probe_result" &&
				send?.effect.kind === "probe" &&
				send.effect.target.tag === "input" &&
				this.unknownInputs.has(
					`${send.effect.runId}/${send.effect.target.inputId}`,
				) &&
				["input_present", "input_absent"].includes(e.finding.tag)
			)
				hit("unknown delivery settled by a probe");
			if (runId && this.ended.has(runId) && this.observed.has(runId))
				hit("evidence on both sides of a Tombstone");
			if (runId) this.observed.add(runId);
			if (e.kind === "run_released" && send) hit("runner release");
			if (
				e.kind === "turn_started" &&
				!before.active &&
				this.queuedInputs.size > 0 &&
				after.active?.origin === "wake"
			)
				hit("a wake turn while an input is queued");
			if (e.kind === "turn_started" && after.active?.origin === "wake")
				for (const pause of this.pauseCommands.values())
					pause.wakeRunId = after.active.runId;
			if (
				e.kind === "command_result" &&
				this.pauseCommands.get(e.commandId)?.wakeRunId ===
					before.active?.runId &&
				before.active?.origin === "wake" &&
				JSON.stringify(before.active) === JSON.stringify(after.active) &&
				result.ended.length === 0 &&
				!result.effects.some(({ effect }) => effect.kind === "start")
			)
				hit(
					"Pause native command plus wake Run leaves foreground authority unchanged",
				);
			if (
				e.kind === "effect_outcome" &&
				e.outcome.tag === "permanent" &&
				send?.effect.kind === "send_native_command"
			) {
				const { commandId } = send.effect;
				const { code } = e.outcome;
				if (
					after.nativeCommands.some(
						(c) =>
							c.commandId === commandId &&
							c.tag === "Failed" &&
							c.code === code,
					)
				)
					hit("a native command refused at delivery");
			}
			if (e.kind === "tasks_snapshot" && before.active?.tag === "Interrupting")
				hit("a snapshot during Interrupting");
			if (
				e.kind === "command_lifecycle" &&
				this.clearCommands.has(e.commandId) &&
				e.state === "queued" &&
				d.provider === "claude" &&
				before.active &&
				after.nativeCommands.some(
					(c) => c.commandId === e.commandId && c.tag === "Queued",
				)
			)
				hit("a clear held by Claude");
			if (
				e.kind === "command_result" &&
				this.clearCommands.has(e.commandId) &&
				!before.active &&
				after.nativeCommands.some(
					(c) => c.commandId === e.commandId && c.tag === "Completed",
				)
			)
				hit("an idle clear");
		}
		if (command.verb === "settle" && result.tag === "Accepted") {
			if (
				command.settlement.kind === "process_lost" &&
				before.active &&
				command.settlement.runnerId === splitLabel(d.label).runnerId
			)
				hit("process loss mid-Run");
			if (
				command.settlement.kind === "process_started" &&
				command.settlement.label !== d.label &&
				before.active?.tag === "Interrupting"
			)
				hit("a label change mid-interrupt");
		}
		if (
			command.verb === "control" &&
			command.control.kind === "confirm_escalation" &&
			before.pendingConfirm &&
			command.control.snapshotEntry !== before.pendingConfirm.snapshotEntry &&
			result.tag === "Rejected"
		)
			hit("a stale confirm");
		if (
			command.verb === "control" &&
			command.control.kind === "native_command" &&
			command.control.text === "/goal pause" &&
			result.tag === "Accepted"
		)
			this.pauseCommands.set(command.control.commandId, {});
		if (
			command.verb === "control" &&
			command.control.kind === "native_command" &&
			command.control.text === "/goal clear" &&
			result.tag === "Accepted"
		)
			this.clearCommands.add(command.control.commandId);
		for (const terminal of result.ended) this.ended.add(terminal.runId);
	}
	/** Generated shapes read the fake's ground truth, so only a TraceDriver records them. */
	recordShapes(
		command: LedgerCommand,
		before: LedgerView,
		after: LedgerView,
		result: StepResult,
		d: TraceDriver,
	): void {
		const hit = (name: GeneratedShape) => {
			this.shapes[name]++;
		};
		// D45: a confirm for an entry taken before a query replacement, whatever its verdict.
		if (
			command.verb === "control" &&
			command.control.kind === "confirm_escalation" &&
			this.replacedEntries.has(command.control.snapshotEntry)
		)
			hit("confirm copied before a query replacement");
		this.recordGate(command, before, after, result, d);
		if (result.tag !== "Accepted") return;
		for (const issue of d.issued) d.bound(issue);
		const runOf = (token: SendToken) => {
			const effect = d.bindings.find((item) => item.send.token === token)?.send
				.effect;
			return effect && "runId" in effect ? effect.runId : undefined;
		};
		const settlement =
			command.verb === "settle" ? command.settlement : undefined;
		const answer =
			command.verb === "observe" && command.observation.tag === "Answer"
				? command.observation
				: undefined;
		// 3.13, 4.5: a stop commit's releases arrive as run_released Answers, then its process_lost.
		const release = answer?.kind === "run_released" ? answer.reason : undefined;
		if (release !== undefined && answer) {
			if (release !== "ResumeRejected")
				hit(
					release === "NotSent"
						? "release NotSent"
						: release === "JournalAbsent"
							? "release JournalAbsent"
							: `release Refused ${release.why}`,
				);
			this.releases.set(
				answer.token,
				typeof release === "string" ? release : release.why,
			);
		}
		if (settlement?.kind === "process_lost") {
			if (new Set(this.releases.values()).size > 1)
				hit("release reasons mixed");
			if (
				[...this.releases.keys()].some((token) =>
					result.ended.some(
						(terminal) =>
							terminal.runId === runOf(token) &&
							terminal.reason.tag === "process_lost",
					),
				)
			)
				hit("release of a reached Run");
			this.releases.clear();
		}
		if (settlement?.kind === "process_lost" && d.host.q28 === "journal")
			hit("Q28 journal settle");
		if (settlement?.kind === "process_started" && d.host.q28 === "adopt")
			hit("Q28 adoption with not_received");
		if (d.host.q28 === "survivor") hit("Q28 removed with a surviving runner");
		if (settlement?.kind === "process_lost")
			for (const terminal of result.ended)
				if (
					this.joinedRuns.has(terminal.runId) &&
					terminal.reason.tag === "process_lost"
				)
					hit("joined Run ended by its runner's retirement");
		// D50: a Launched Run back to Queued (no view active while nothing blocks it), or relaunched at once.
		const unlaunchedRun =
			before.active &&
			before.active.tag !== "Queued" &&
			before.active.tag !== "Interrupting" &&
			!result.ended.some(({ runId }) => runId === before.active?.runId) &&
			(after.active === undefined ||
				(after.active.runId === before.active.runId &&
					(after.active.tag === "Queued" ||
						result.effects.some(
							({ effect }) =>
								effect.kind === "start" &&
								effect.runId === before.active?.runId,
						))))
				? before.active.runId
				: undefined;
		const outcome =
			answer?.kind === "effect_outcome"
				? answer.outcome.tag
				: settlement?.kind === "unheld_outcome"
					? settlement.outcome.tag
					: undefined;
		const trigger =
			unlaunchedRun === undefined
				? undefined
				: release !== undefined
					? typeof release === "string"
						? release
						: release.tag
					: settlement?.kind === "process_lost"
						? "retirement"
						: outcome === "retryable" || outcome === "not_sent"
							? outcome
							: undefined;
		// D60, 3.6: main's relaunch is a new issue of the unlaunched Run's start, drawn after its unlaunch.
		for (const { effect } of d.issued.slice(this.seenIssues))
			if (effect.kind === "start" && this.unlaunched.delete(effect.runId))
				hit("relaunch after unlaunch");
		this.seenIssues = d.issued.length;
		if (unlaunchedRun !== undefined && trigger !== undefined) {
			this.unlaunched.add(unlaunchedRun);
			hit(`unlaunch by ${trigger}`);
		}
		// D50: Stop, Run now or End on a Run nothing may act for yet.
		if (
			command.verb === "control" &&
			(command.control.kind === "stop" ||
				command.control.kind === "run_now" ||
				command.control.kind === "end") &&
			before.active &&
			before.active.tag !== "Interrupting" &&
			(before.active.tag === "Queued" || !d.host.reached(before.active.runId))
		)
			hit(
				command.control.kind === "stop"
					? "Stop on a not-yet-delivered Run"
					: command.control.kind === "run_now"
						? "Run now on a not-yet-delivered Run"
						: "End on a not-yet-delivered Run",
			);
		if (command.verb === "control")
			for (const terminal of result.ended)
				if (terminal.reason.tag === "interrupted")
					this.stopped.add(terminal.runId);
		// D50: any other permanent outcome of a not-yet-delivered Run's start ends it refused (3.8).
		const permanentStart =
			answer?.kind === "effect_outcome" &&
			answer.outcome.tag === "permanent" &&
			d.bindings.find((item) => item.send.token === answer.token)?.send.effect
				.kind === "start"
				? runOf(answer.token)
				: settlement?.kind === "unheld_outcome" &&
						settlement.outcome.tag === "permanent"
					? settlement.runId
					: undefined;
		if (
			permanentStart !== undefined &&
			before.active?.runId === permanentStart &&
			!d.host.reached(permanentStart) &&
			result.ended.some(
				(terminal) =>
					terminal.runId === permanentStart &&
					terminal.reason.tag === "refused",
			)
		)
			hit("permanent start outcome refused an undelivered Run");
		const activeEnded =
			before.active !== undefined &&
			result.ended.some(({ runId }) => runId === before.active?.runId);
		// D43: the gated step's Run Ends by evidence other than the confirm, and the gate drops.
		if (
			before.pendingConfirm &&
			activeEnded &&
			!(
				command.verb === "control" &&
				command.control.kind === "confirm_escalation"
			)
		)
			hit(
				after.pendingConfirm
					? "D43 gated Run ended, gate kept"
					: "D43 gated Run ended, gate dropped",
			);
		if (
			command.verb === "settle" &&
			command.settlement.kind === "process_lost" &&
			before.pendingConfirm
		)
			hit("process_lost while gated");
		if (
			command.verb === "settle" &&
			command.settlement.kind === "process_lost" &&
			d.host.isRemoval(command.settlement.runnerId)
		)
			hit("removal process_lost");
		if (command.verb !== "observe") return;
		const e = command.observation;
		// The host label before this step: the fake observes after coverage records.
		const current = splitLabel(d.host.label);
		if (e.tag === "Unsolicited") {
			const { runnerId, querySeq } = splitLabel(e.label);
			const older =
				runnerId !== current.runnerId ||
				(querySeq ?? -1) < (current.querySeq ?? -1);
			if (
				older &&
				before.active?.origin === "wake" &&
				(e.kind === "result" || e.kind === "query_ended")
			)
				hit(
					activeEnded
						? "older wake label Run end"
						: "older wake label Run-end evidence",
				);
			// Evidence its provider cannot produce is Rejected and never raises the querySeq (L1, 3.4):
			// Cursor and OpenCode task evidence, command_lifecycle from any provider but Claude (D46).
			const rejected =
				((d.host.provider === "cursor" || d.host.provider === "opencode") &&
					(e.kind === "tasks_snapshot" || e.kind === "task_event")) ||
				(d.host.provider !== "claude" && e.kind === "command_lifecycle");
			if (
				runnerId === current.runnerId &&
				(querySeq ?? -1) > (current.querySeq ?? -1) &&
				!rejected &&
				d.host.groundTruth().processAlive
			) {
				hit("query replacement");
				if (before.pendingConfirm)
					this.replacedEntries.add(before.pendingConfirm.snapshotEntry);
			}
			// D47: a turn joined to a launched input Run is outstanding work of its own.
			if (
				e.kind === "turn_started" &&
				before.active?.origin === "input" &&
				after.active?.runId === before.active.runId
			) {
				this.joinedRuns.add(before.active.runId);
				hit("turn joined to an input Run");
			}
			if (e.kind === "turn_started" && d.host.isRestartLabel(e.label))
				hit("Registering restart turn");
			// D61 (CONTRACT.md 486-494): a native command's receipts are unsolicited, by its commandId.
			if (
				(e.kind === "command_lifecycle" || e.kind === "command_result") &&
				result.tag === "Accepted" &&
				d.issued.some(
					({ effect }) =>
						effect.kind === "send_native_command" &&
						effect.commandId === e.commandId,
				)
			)
				hit(`native-token ${e.kind}`);
			return;
		}
		if (e.tag === "Main") return;
		for (const issue of d.issued) d.bound(issue);
		const send = d.bindings.find((item) => item.send.token === e.token)?.send;
		const startRun =
			send?.effect.kind === "start" ? send.effect.runId : undefined;
		// D47: the joined Run Ends by its start's answer, but the joined turn is not that send's.
		if (
			startRun !== undefined &&
			this.joinedRuns.has(startRun) &&
			result.ended.some(({ runId }) => runId === startRun)
		)
			hit("input Run ended by its start under a joined turn");
		if (
			e.kind === "effect_outcome" &&
			e.outcome.tag === "permanent" &&
			e.outcome.code === "native_resume_rejected"
		)
			hit("native_resume_rejected");
		if (
			e.kind === "probe_result" &&
			e.finding.tag === "input_present" &&
			e.finding.nativeMessageId === undefined
		)
			hit("probe input_present without id");
	}
	/** H4 and 4.4: a gate answer, by send kind; 3.6 unlaunch and its Otherwise branch. */
	private recordGate(
		command: LedgerCommand,
		before: LedgerView,
		after: LedgerView,
		result: StepResult,
		d: TraceDriver,
	): void {
		const hit = (name: GeneratedShape) => {
			this.shapes[name]++;
		};
		// A gated Held send answers by commandId; a gated tokened send by its own token (H4).
		const settlement =
			command.verb === "settle" ? command.settlement : undefined;
		const gate =
			settlement?.kind === "unheld_outcome"
				? {
						held: [...d.issued]
							.reverse()
							.find(
								(item) =>
									d.host.isHeld(item) &&
									item.commandId === settlement.commandId &&
									"runId" in item.effect &&
									item.effect.runId === settlement.runId,
							),
						outcome: settlement.outcome,
					}
				: command.verb === "observe" &&
						command.observation.tag === "Answer" &&
						command.observation.kind === "effect_outcome" &&
						d.host.isGated(command.observation.token)
					? { held: undefined, outcome: command.observation.outcome }
					: undefined;
		if (!gate) return;
		const { held } = gate;
		if (settlement?.kind === "unheld_outcome") {
			const { runId, outcome } = settlement;
			if (!held) hit("unheld_outcome unknown runId");
			if (outcome.tag === "retryable") hit("unheld_outcome retryable");
			if (outcome.tag === "permanent" && outcome.code !== "project_inactive")
				hit("unheld_outcome permanent start failure");
			if (this.stopped.has(runId)) hit("unheld_outcome after a Stop");
			const last = d.host.lastUnheld;
			if (held && last && last.held !== held)
				hit("unheld_outcome after a reissue");
			if (held && last && last.held === held && last.retired)
				hit("unheld_outcome after its runner retired");
		}
		const token =
			command.verb === "observe" && command.observation.tag === "Answer"
				? command.observation.token
				: undefined;
		const effect =
			held?.effect ??
			d.bindings.find((item) => item.send.token === token)?.send.effect;
		if (!effect) return;
		const notSent = gate.outcome.tag === "not_sent";
		// Retryable and start-failure outcomes count above; the by-kind shapes are not_sent and removal.
		if (
			gate.outcome.tag === "retryable" ||
			(gate.outcome.tag === "permanent" &&
				gate.outcome.code !== "project_inactive")
		)
			return;
		const steer = effect.kind === "steer";
		const native = effect.kind === "send_native_command";
		if (held)
			hit(
				notSent
					? steer
						? "not_sent Held steer"
						: "not_sent Held start"
					: steer
						? "removed Held steer"
						: "removed Held start",
			);
		else if (!notSent)
			hit(native ? "removed native command" : "removed no-hold send");
		// 3.4 (465-471, round 2d): no row main's executor runs gets a not_sent, so a no-hold start's,
		// steer's, interrupt's or native command's is Rejected, no shape.
		else if (result.tag === "Accepted")
			hit(effect.kind === "probe" ? "not_sent probe" : "not_sent other send");
		// A Rejected not_sent is an adversarial input (3.4), no gate shape.
		if (!notSent || result.tag !== "Accepted") return;
		const runId = "runId" in effect ? effect.runId : null;
		if (runId !== null && this.joinedRuns.has(runId)) {
			hit("not_sent after a joined turn");
			// D50: a reached Run never unlaunches; its start is tried again in the same execution.
			if (
				effect.kind === "start" &&
				after.active?.runId === runId &&
				after.active.tag !== "Queued" &&
				!result.ended.some((terminal) => terminal.runId === runId)
			)
				hit("joined Run's not_sent start retried in its execution");
		}
		// One effect across its tries: an unlaunched start relaunches under a new commandId (3.6), and
		// Run-less native commands differ only by commandId (8.5).
		const key =
			effect.kind === "send_native_command"
				? `native/${effect.commandId}`
				: "inputId" in effect
					? `${effect.kind}/${effect.runId}/${effect.inputId}`
					: `${effect.kind}/${runId}`;
		const count = (this.notSentRuns.get(key) ?? 0) + 1;
		this.notSentRuns.set(key, count);
		if (count === 6) hit("long not_sent run");
		if (result.tag !== "Accepted" || effect.kind !== "start") return;
		if (
			before.active?.runId === effect.runId &&
			before.active.tag === "Starting" &&
			after.active?.runId === effect.runId &&
			after.active.tag === "Queued"
		)
			hit("unlaunch");
		if (result.ended.some((terminal) => terminal.runId === effect.runId))
			hit("not_sent start ended its Run");
	}
	merge(other: Coverage): void {
		for (const shape of generatedShapes)
			this.shapes[shape] += other.shapes[shape];
		for (const kind of Object.keys(this.kinds) as Observation["kind"][])
			this.kinds[kind] += other.kinds[kind];
		for (const race of namedRaces) this.races[race] += other.races[race];
		for (const [outcome, count] of Object.entries(other.outcomes))
			this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + count;
	}
	assertComplete(): void {
		assert.deepEqual(
			Object.entries(this.kinds)
				.filter(([, count]) => count === 0)
				.map(([name]) => name),
			[],
			"coverage: evidence kinds with zero hits",
		);
		assert.deepEqual(
			Object.entries(this.races)
				.filter(([, count]) => count === 0)
				.map(([name]) => name),
			[],
			"coverage: named races with zero hits",
		);
	}
}
let runDirectory: string | undefined;
function runArtifactDirectory(): string {
	runDirectory ??= mkdtempSync(join(tmpdir(), "run-ledger-artifacts-"));
	return runDirectory;
}
// Each test file imports its own copy of this module, so its directory goes when that file ends.
afterAll(() => {
	if (runDirectory !== undefined)
		rmSync(runDirectory, { recursive: true, force: true });
	runDirectory = undefined;
});
export function writeTraceArtifact(
	name: string,
	artifact: unknown,
	testId?: string,
): string {
	// Set RUN_LEDGER_ARTIFACT_DIR to keep artifacts. Unset, each run writes to its own fresh
	// directory, never a shared default, so concurrent runs cannot overwrite each other, and
	// removes it when the file ends.
	const directory =
		process.env["RUN_LEDGER_ARTIFACT_DIR"] || runArtifactDirectory();
	mkdirSync(directory, { recursive: true });
	const suffix =
		testId === undefined ? "" : `-${testId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	const path = join(directory, `${name}${suffix}.json`);
	writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
	return path;
}
