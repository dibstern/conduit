import assert from "node:assert/strict";
import fc from "fast-check";
import type {
	Evidence,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	MainTransmission,
	Observation,
	ProviderKind,
	RunEffect,
	RunEnded,
	SendToken,
	TaskKey,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";

/** Numeric selectors remain useful after fast-check shrinks a trace. */
export interface TraceAction {
	readonly operation: number;
	readonly selection: number;
	readonly index: number;
	readonly variant: number;
	readonly input: number;
	readonly advance: number;
}

export const traceAction = fc.record({
	operation: fc.integer({ min: 0, max: 28 }),
	selection: fc.integer({ min: 0, max: 4 }),
	index: fc.nat({ max: 100 }),
	variant: fc.integer({ min: 0, max: 54 }),
	input: fc.nat({ max: 12 }),
	advance: fc.integer({ min: 0, max: 2_000 }),
});

export interface ProviderSnapshot {
	readonly issued: readonly IssuedEffect[];
	readonly view: LedgerView;
	readonly now: number;
	readonly alarmAt?: number | undefined;
}

/** The registry's project gate (H4, 3.11): removed refuses, not served answers `not_sent`. */
export type ProjectGate = "served" | "not_served" | "removed";
export type GateOutcome =
	| { readonly tag: "not_sent"; readonly retryAt: number }
	| { readonly tag: "permanent"; readonly code: "project_inactive" };
/** D49: a try settled before any hold (a start failure, `StartLost` or a gate answer), keyed by its Run's queue key (4.4, 4.11). */
export type UnheldOutcome =
	| { readonly tag: "retryable"; readonly retryAt: number }
	| { readonly tag: "permanent"; readonly code: string }
	| { readonly tag: "not_sent"; readonly retryAt: number };
/** A gate answer (H4): a Tokened send's `not_sent`, or `unheld_outcome` (D49), a try with no token. */
export const isGateAnswer = (command: LedgerCommand): boolean =>
	(command.verb === "settle" && command.settlement.kind === "unheld_outcome") ||
	(command.verb === "observe" &&
		command.observation.tag === "Answer" &&
		command.observation.kind === "effect_outcome" &&
		command.observation.outcome.tag === "not_sent");
/** A bound transmission, its token and effect (3.4); D59 removed the model's Send. */
export interface Send {
	readonly token: SendToken;
	readonly effect: RunEffect;
}
type TaskDescription = Extract<
	Evidence,
	{ kind: "tasks_snapshot" }
>["tasks"][number];
export type ReleaseReason = Extract<
	Evidence,
	{ kind: "run_released" }
>["reason"];

export interface TracePacket {
	readonly command: LedgerCommand;
	readonly now: number;
}

export interface ProviderGroundTruth {
	readonly label: string;
	readonly processAlive: boolean;
	readonly runningTurn: boolean;
	readonly acceptedUnended: readonly SendToken[];
	readonly unfinished: readonly SendToken[];
	readonly tasks: "unknown" | readonly TaskDescription[];
	readonly goal: "cleared" | "active" | "paused" | "budgetLimited";
	readonly queuedCommands: readonly string[];
}

type QueryEvidence = Extract<
	Evidence,
	{
		kind:
			| "started"
			| "input_accepted"
			| "input_declined"
			| "activity"
			| "interaction_requested"
			| "interaction_resolved"
			| "result"
			| "query_ended"
			| "accounting"
			| "effect_outcome"
			| "run_dispatched"
			| "run_released"
			| "delivery_indeterminate"
			| "runner_reply"
			| "journal_answer"
			| "command_lifecycle";
	}
>;
type Outcome = Extract<Evidence, { kind: "effect_outcome" }>;
type Probe = Extract<Evidence, { kind: "probe_result" }>;
/** REDESIGN-7 deleted `close` and D59 `kill_and_respawn`: end_session is the one destruction. */
type Destruction = Extract<RunEffect, { kind: "end_session" }>;
const isDestruction = (effect: RunEffect): effect is Destruction =>
	effect.kind === "end_session";
/** One unsolicited turn's outstanding work, per (Run, turn label) as the oracle keeps it (8.3, D47). */
interface WakeExecution {
	readonly runId: string;
	readonly label: string;
	live: boolean;
	fenced: boolean;
	/** The turn_started that last armed the fence. */
	fencedBy: string;
}
interface NativeSend {
	readonly send: Send;
	label: string;
	/** The fenced wake executions when the send was issued: what an idle probe can cover (3.5, D26). */
	readonly wakeFences: readonly WakeExecution[];
	accepted: boolean;
	deliveryConfirmed: boolean;
	lifecycleStarted: boolean;
	unfinished: boolean;
	covered: boolean;
	ended: boolean;
	notConsumed: boolean;
	transportRank: number;
}

const at = <T>(items: readonly T[], index: number): T | undefined =>
	items.length === 0 ? undefined : items[index % items.length];
/** L1 (3.3): split at the last ':' when a decimal querySeq follows; otherwise the whole label is the runnerId. */
export const splitLabel = (
	label: string,
): { readonly runnerId: string; readonly querySeq?: number } => {
	const match = /^(.*):(\d+)$/.exec(label);
	return match?.[1] === undefined
		? { runnerId: label }
		: { runnerId: match[1], querySeq: Number(match[2]) };
};
const runnerOf = (label: string): string => splitLabel(label).runnerId;
type MainIssue = Extract<IssuedEffect, { tag: "Main" }>;
/** A runner-held issue is a start or a steer (3.13 IssuedEffect). */
const heldRunId = ({ effect }: MainIssue): string => {
	assert(
		effect.kind === "start" || effect.kind === "steer",
		"a Held issue is a start or a steer",
	);
	return effect.runId;
};
/** The Run an effect names, if its kind names one (3.13). */
const runIdOf = (effect: RunEffect): string | null | undefined =>
	"runId" in effect ? effect.runId : undefined;
/** An older host's label has no querySeq; it is older only once its runner retires (3.4). */
const querySeqOf = (label: string): number => splitLabel(label).querySeq ?? -1;
const tokened = (token: string): SendToken => token as SendToken;
const outcome = (variant: number, now: number): Outcome => {
	switch (variant % 4) {
		case 0:
			return { kind: "effect_outcome", outcome: { tag: "succeeded" } };
		case 1:
			return {
				kind: "effect_outcome",
				// retryAt past the probe deadline as well as before it (D20 raise, 3.7).
				outcome: {
					tag: "retryable",
					retryAt: now + (variant % 8 === 5 ? 100_000 : 100),
					// 10B: main's receipt error_code, an answer's lastRefusal (3.10).
					...(variant % 16 === 9 ? { code: "answer_refused" } : {}),
				},
			};
		case 2:
			return {
				kind: "effect_outcome",
				outcome: {
					tag: "permanent",
					code: variant % 8 === 6 ? "native_resume_rejected" : "TracePermanent",
				},
			};
		default:
			// 3.13: not_sent, the try was never handed over (3.6, D50).
			return variant % 8 === 7
				? {
						kind: "effect_outcome",
						outcome: { tag: "not_sent", retryAt: now + 100 },
					}
				: { kind: "effect_outcome", outcome: { tag: "delivery_unknown" } };
	}
};
const probe = (variant: number, input: number): Probe => {
	const findings = [
		input % 3 === 0
			? ({ tag: "input_present" } as const)
			: ({ tag: "input_present", nativeMessageId: `native:${input}` } as const),
		{ tag: "input_absent" },
		{ tag: "native_idle" },
		{ tag: "native_busy" },
		// GAP (CONTRACT.md 1235-1236): 3.10 deletes the interaction probe, so these findings answer no
		// probe; generated as inputs decide Rejects.
		{ tag: "answer_consumed" },
		{ tag: "answer_pending" },
	] as const;
	return {
		kind: "probe_result",
		finding: findings[variant % 6] ?? findings[0],
	};
};

/**
 * Independent host facts. No ledger state, entries or provider policy is imported.
 * `bound` is the fake holdRun owner; only it counts runner-held transmissions.
 */
export class FakeProvider {
	private readonly delayed: LedgerCommand[] = [];
	private readonly delivered: LedgerCommand[] = [];
	private readonly notifications: Observation[] = [];
	/** Main's inbox (D58): admitted inputs main has not claimed, in admission order. */
	private readonly mainInbox: {
		readonly inputId: string;
		readonly delivery: "queue" | "steer";
	}[] = [];
	/** Main's open run (3.9): its start's latest issue, whether main started it and whether a stop commit asked it to stop, until main's terminal. */
	private mainRun:
		| {
				readonly runId: string;
				readonly inputId: string;
				issue: IssuedEffect;
				started: boolean;
				stopped: boolean;
		  }
		| undefined;
	/** Steers main sent and has not started (3.9): each joins `parent`, or runs as its own Run once `parent` ended. */
	private readonly mainSteers: {
		readonly inputId: string;
		readonly runId: string;
		readonly parent: string;
	}[] = [];
	/** Main's run events (D60), for a repeat by event id. */
	private readonly mainEvents: Observation[] = [];
	/** Main's starts and steers the driver has not read (D60): decide issues none of them. */
	private readonly mainIssues: { issue: IssuedEffect; token: SendToken }[] = [];
	private readonly bindings = new WeakMap<
		IssuedEffect,
		{ readonly send: Send; readonly transmission: number }
	>();
	private readonly transmissions = new Map<string, number>();
	/**
	 * Main's sends with no hold, by commandId and kind, latest last: a direct start's or steer's
	 * per run.requested, a control's per claim (3.4).
	 */
	private readonly mainSends = new Map<string, Send[]>();
	/** A control's claims per commandId, n from 1: its outbox row's attempt_count (3.4). */
	private readonly claims = new Map<string, number>();
	/** Each control claim's issue and main's name for it (3.4). */
	private readonly mainTransmissions = new Map<
		SendToken,
		{ readonly issue: MainIssue; readonly name: MainTransmission }
	>();
	/** The outcome main wrote for each control claim; a repeat names the same (3.4, 2.1 row 215). */
	private readonly controlOutcomes = new Map<
		SendToken,
		Extract<Evidence, { kind: "effect_outcome" }>["outcome"]
	>();
	private readonly holdBindings = new Map<
		SendToken,
		{
			readonly runId: string;
			readonly commandId: string;
			readonly transmission: number;
		}
	>();
	private readonly sends = new Map<SendToken, NativeSend>();
	private readonly pendingHeld = new Map<SendToken, MainIssue>();
	private readonly pendingNativeCommands = new Map<SendToken, IssuedEffect>();
	/** Held starts resolved by run_dispatched to the spawning runner; its process_started fixes their label (L2, REDESIGN r3-1). */
	private readonly spawnHeld = new Map<SendToken, MainIssue>();
	/** Holds whose run_dispatched the spawn already delivered; the start transmits no second one. */
	private readonly spawnDispatched = new Set<SendToken>();
	/** Holds whose run.dispatched the ledger has read (D50: until then an undispatched issue, never reached). */
	private readonly dispatchRead = new Set<SendToken>();
	private readonly retiredHolds = new Set<string>();
	private readonly terminals = new Map<string, RunEnded>();
	private readonly seenEvents = new Set<string>();
	private readonly processFacts = new Set<string>();
	private readonly lostRunners = new Set<string>();
	/** Labels whose lost work L5 already decided (LI5). */
	private readonly decidedLabels = new Set<string>();
	private readonly latestQuerySeq = new Map<string, number>();
	private readonly wakes = new Map<string, string>();
	/** Execution labels of each wake Run in join order (8.3, D28). */
	private readonly wakeExecutions = new Map<string, string[]>();
	private readonly wakeLabels = new Set<string>();
	private readonly executions: WakeExecution[] = [];
	/** Sends the provider refused at delivery, with the refusal code (D34). */
	private readonly refusedCommands = new Map<string, string>();
	private readonly copiedConfirms: number[] = [];
	private readonly confirmVersions = new Map<number, number>();
	private confirmedSnapshot:
		| { readonly label: string; readonly version: number }
		| undefined;
	private readonly requestedCommands = new Set<string>();
	private readonly commands = new Map<
		string,
		{ readonly text: string; state: "queued" | "started" | "completed" }
	>();
	private taskState: "unknown" | readonly TaskDescription[] = [];
	private taskVersion = 0;
	private serial = 0;
	private hostLabel = "host-0:1";
	private readonly labels: string[] = [this.hostLabel];
	private alive = false;
	/** A fresh runner named by run_dispatched before its process_started (L2, 6.1, REDESIGN r3-1). */
	private spawning: string | undefined;
	/** Fresh runnerIds; a retired runnerId is never reused (L1). */
	private runnerSerial = 1;
	/** Sends issued with no process; each takes the label of the next `process_started` (8.5, D23). */
	private readonly unbound = new Set<SendToken>();
	private gate: ProjectGate = "served";
	/** Gate answers the host owes, delivered by operation 9 (H4). */
	private readonly gateAnswers: {
		readonly target:
			| {
					readonly tag: "Held";
					readonly held: MainIssue;
					/** The runner the gated try was addressed to, if any (D49: an answer after its retirement). */
					readonly runner: string | undefined;
			  }
			| { readonly tag: "Tokened"; readonly token: SendToken };
		readonly removed: boolean;
		/** A start failure before holdRun, not the gate (4.4, D49). */
		readonly failure?: UnheldOutcome;
	}[] = [];
	/** Runs a process_lost unlaunched or must end (D50), checked once its step's terminals are known. */
	private retirement:
		| {
				readonly unlaunched: readonly string[];
				readonly reached: readonly string[];
		  }
		| undefined;
	/** The latest Held answer delivered, for its shape (D49). */
	lastUnheld:
		| {
				readonly held: MainIssue;
				readonly retired: boolean;
		  }
		| undefined;
	/** Q28: the daemon restarted under a live runner, which this step adopts or settles from its journal (7.2, 7.3), or a mid-removal death left it alive (4.4). */
	q28: "adopt" | "journal" | "survivor" | undefined;
	/** The rest of a runner's stop commit, emitted before any other fact (4.5). */
	private readonly commit: LedgerCommand[] = [];
	/** The time of the packet being drawn: a stop commit's retiredAt (6.5). */
	private clock = 0;
	/** Gated holds: a phantom send with no transmission (4.4, 4.8). */
	private readonly gatedHolds = new WeakMap<IssuedEffect, Send>();
	/**
	 * Sends that met the gate, by token, with the address the gate read: never transmitted, so no
	 * evidence names them (H4), yet their own label's query ending still covers a close or interrupt (3.3).
	 */
	private readonly gatedTokens = new Map<
		SendToken,
		{ readonly send: Send; readonly label: string | undefined }
	>();
	/** Holds covered at issue: holdRun returned Covered, so nothing was transmitted (L2 case 2, H3). */
	private readonly coveredHolds = new Set<SendToken>();
	/**
	 * Gated native commands and the runner each was addressed to, for their view (8.5, D34). Its
	 * runner's retirement covers one, so a later gate answer changes nothing (3.4).
	 */
	private readonly gatedCommands = new Map<
		SendToken,
		{ readonly commandId: string; readonly runner: string | undefined }
	>();
	/** Runs whose latest start try met the gate with no process current: pending, never transmitted (H4, L2). */
	private readonly gatedStarts = new Set<string>();
	/** Transmissions of a hold whose next try got not_sent: its start was unlaunched, so a relaunch is a new send (3.6, L2). */
	private readonly unlaunchedTries = new Set<SendToken>();
	/** Closes and end_sessions whose success was read: a duplicate success covers nothing (3.8, 3.2). */
	private readonly destroyed = new Set<SendToken>();
	/** The removal macro's runner, whose process_lost precedes the gate (H4, 6.3). */
	private removing:
		| { readonly runner: string; readonly gate: ProjectGate }
		| undefined;
	private removalInProgress = false;
	/** A runner left alive by a daemon killed mid-removal after a config save; silent while removed (4.4, Q28). */
	private survivor: string | undefined;
	/** Labels of a Registering restart's adoption; a turn of its own follows each (H4, 6.1). */
	private readonly restartLabels = new Set<string>();
	private turning = false;
	/** Actions left in a not-served retry storm: each one answers a queued gate answer or fires the alarm (4.8). */
	private gateStorm = 0;
	private stormAnswered = false;
	/** Admits left right after a gate change, so a launched Run's next input meets the gate as a steer (4.4, H4). */
	private gateAdmits = 0;
	private turnFinished = false;
	private goalState: ProviderGroundTruth["goal"] = "cleared";
	lastAssertions: readonly string[] = [];

	/** `totality` lets one explicit property start another runner while one serves (L1 totality); every other trace respects H1. */
	constructor(
		readonly provider: ProviderKind,
		readonly totality = false,
	) {}

	get label(): string {
		return this.hostLabel;
	}
	labelFor(send: Send): string {
		return this.sends.get(send.token)?.label ?? this.label;
	}

	/**
	 * A runner-held start or steer (3.4): a Main start or steer main did not send directly. A direct
	 * send is OpenCode main's, registered at its run.requested (D60).
	 */
	isHeld(issued: IssuedEffect): issued is MainIssue & {
		readonly effect: Extract<RunEffect, { kind: "start" | "steer" }>;
	} {
		return (
			issued.tag === "Main" &&
			(issued.effect.kind === "start" || issued.effect.kind === "steer") &&
			!this.mainSends.has(`${issued.commandId}\u0000${issued.effect.kind}`)
		);
	}
	/** 3.4: main claims a control's row; a claim shows only at its outcome, which names it. */
	private claim(issue: MainIssue): Send {
		const n = (this.claims.get(issue.commandId) ?? 0) + 1;
		this.claims.set(issue.commandId, n);
		const send: Send = {
			token: tokened(`fake-main:${issue.commandId}:${n}`),
			effect: issue.effect,
		};
		const key = `${issue.commandId}\u0000${issue.effect.kind}`;
		this.mainSends.set(key, [...(this.mainSends.get(key) ?? []), send]);
		this.mainTransmissions.set(send.token, {
			issue,
			name: { commandId: issue.commandId, transmission: n },
		});
		return send;
	}
	/** Repeated binding of one issue does not append another run.dispatched. */
	bound(issued: IssuedEffect): Send {
		if (issued.tag === "Tokened") return issued;
		if (!this.isHeld(issued)) {
			const latest = this.mainSends
				.get(`${issued.commandId}\u0000${issued.effect.kind}`)
				?.at(-1);
			return latest ?? this.claim(issued);
		}
		const gated = this.gatedHolds.get(issued);
		if (gated) return gated;
		const previous = this.bindings.get(issued);
		if (previous) return previous.send;
		// 4.4: the feeder reads the gate before holdRun, for a run steps 1 and 2 would pass.
		if (this.gated(issued)) {
			const wire = `fake-gated:${this.serial++}`;
			const send: Send =
				issued.effect.kind === "start"
					? { token: tokened(wire), effect: issued.effect }
					: { token: tokened(wire), effect: issued.effect };
			this.gateHold(issued, send);
			return send;
		}
		const held = this.holdRun(issued);
		assert.equal(held.tag, "Held", "fake holdRun: transmission cap exhausted");
		assert(held.tag === "Held");
		return held.send;
	}

	holdRun(issued: MainIssue):
		| {
				readonly tag: "Held";
				readonly send: Send;
				readonly transmission: number;
		  }
		| { readonly tag: "Exhausted" } {
		const previous = this.bindings.get(issued);
		if (previous) {
			return { tag: "Held", ...previous };
		}
		// 3.4, 4.3: the hold is the run.dispatched event. One the ledger has not read when it reissues the
		// commandId follows that issue, so holdRun under the old key returns Ended and the feeder holds the latest.
		for (const [token, binding] of [...this.holdBindings])
			if (
				binding.commandId === issued.commandId &&
				!this.dispatchRead.has(token) &&
				!this.spawnDispatched.has(token) &&
				this.dispatchFirst((n) => n.token === token)
			) {
				this.holdBindings.delete(token);
				this.sends.delete(token);
				this.pendingHeld.delete(token);
				this.unbound.delete(token);
				this.transmissions.set(issued.commandId, binding.transmission - 1);
			}
		const n = (this.transmissions.get(issued.commandId) ?? 0) + 1;
		if (n > 5) return { tag: "Exhausted" };
		this.transmissions.set(issued.commandId, n);
		const wire = `fake-send:${this.serial++}`;
		const send: Send =
			issued.effect.kind === "start"
				? { token: tokened(wire), effect: issued.effect }
				: { token: tokened(wire), effect: issued.effect };
		this.bindings.set(issued, { send, transmission: n });
		const { effect } = issued;
		assert(
			effect.kind === "start" || effect.kind === "steer",
			"Only a start or steer is held (3.4)",
		);
		// 3.4: run.dispatched names the Run by runId and the issue by commandId.
		this.holdBindings.set(send.token, {
			runId: effect.runId,
			commandId: issued.commandId,
			transmission: n,
		});
		return { tag: "Held", send, transmission: n };
	}
	/** A send that met the gate was never transmitted (H4). */
	isGated(token: SendToken): boolean {
		return this.gatedTokens.has(token);
	}
	isRestartLabel(label: string): boolean {
		return this.restartLabels.has(label);
	}
	get projectGate(): ProjectGate {
		return this.gate;
	}
	/** The removal macro's process_lost, before the fake observes it (H4). */
	isRemoval(runnerId: string): boolean {
		return this.removing?.runner === runnerId;
	}
	/** H4: the gate is a host fact, so a second host of the same trace answers from the same registry. */
	mirrorRegistry(source: FakeProvider): void {
		if (this.gate !== source.gate) this.setGate(source.gate);
		this.removalInProgress = source.removalInProgress;
		this.removing = source.removing;
		this.survivor = source.survivor;
		for (const label of source.restartLabels) this.restartLabels.add(label);
		// D60: main is one host process, so its direct sends are the same for every ledger (3.4).
		for (const [key, sends] of source.mainSends)
			if (
				!this.mainSends.has(key) &&
				sends.every(({ token }) => !source.mainTransmissions.has(token))
			)
				this.mainSends.set(key, sends);
	}
	/** H4: a gate change applies to every send not yet transmitted; a transmitted send is never refused. */
	setGate(gate: ProjectGate): void {
		this.gate = gate;
		if (gate !== "removed") this.survivor = undefined;
		if (gate === "served") {
			this.removalInProgress = false;
			this.gateStorm = 0;
			return;
		}
		for (const [token, held] of [...this.pendingHeld]) this.unhold(token, held);
		for (const [token, effect] of [...this.pendingNativeCommands]) {
			this.pendingNativeCommands.delete(token);
			this.gateSend(this.bound(effect));
		}
		for (const token of [...this.unbound]) {
			const native = this.sends.get(token);
			this.unbound.delete(token);
			this.sends.delete(token);
			if (native) this.gateSend(native.send);
		}
	}
	/** A pending try that met the gate or failed before holdRun: it never transmitted, so the cap does not count it (4.4, 4.8). */
	private unhold(
		token: SendToken,
		held: MainIssue,
		failure?: UnheldOutcome,
	): void {
		this.pendingHeld.delete(token);
		const binding = this.bindings.get(held);
		if (!binding) return;
		this.bindings.delete(held);
		this.holdBindings.delete(token);
		this.transmissions.set(held.commandId, binding.transmission - 1);
		this.gateHold(held, binding.send, failure);
		if (held.effect.kind === "start") this.gatedStarts.add(heldRunId(held));
	}
	private gated(held: MainIssue): boolean {
		if (
			this.gate === "served" ||
			this.retiredHolds.has(held.commandId) ||
			this.terminals.has(heldRunId(held))
		)
			return false;
		// A send addressed to a retired runner is Covered (H3), never gated.
		const owner = this.ownerLabel(held);
		const address =
			owner === null
				? undefined
				: (owner ?? (this.alive ? this.label : undefined));
		return address === undefined || !this.dead(runnerOf(address));
	}
	private gateHold(held: MainIssue, send: Send, failure?: UnheldOutcome): void {
		this.gatedHolds.set(held, send);
		this.gatedTokens.set(send.token, { send, label: undefined });
		const owner = this.ownerLabel(held);
		const answer = {
			target: {
				tag: "Held",
				held,
				runner: owner ? runnerOf(owner) : this.serving(),
			},
			removed: this.gate === "removed",
			...(failure ? { failure } : {}),
		} as const;
		// A start failure is answered at once; a gate answer waits in the host's queue (4.4).
		if (failure) this.gateAnswers.unshift(answer);
		else this.gateAnswers.push(answer);
	}
	private gateSend(send: Send, address?: string): void {
		this.gatedTokens.set(send.token, { send, label: address });
		if (send.effect.kind === "send_native_command")
			this.gatedCommands.set(send.token, {
				commandId: send.effect.commandId,
				runner: address === undefined ? undefined : runnerOf(address),
			});
		this.gateAnswers.push({
			target: { tag: "Tokened", token: send.token },
			removed: this.gate === "removed",
		});
	}
	private gateAnswer(now: number): LedgerCommand | undefined {
		const next = this.gateAnswers.shift();
		if (!next) return undefined;
		const outcome: GateOutcome = next.removed
			? { tag: "permanent", code: "project_inactive" }
			: { tag: "not_sent", retryAt: now };
		if (next.target.tag === "Held") {
			const { held, runner } = next.target;
			this.lastUnheld = {
				held,
				retired: runner !== undefined && this.dead(runner),
			};
			return {
				verb: "settle",
				settlement: {
					kind: "unheld_outcome",
					runId: heldRunId(held),
					commandId: held.commandId,
					outcome: next.failure ?? outcome,
				},
			};
		}
		const { token } = next.target;
		// 3.4: a gated control claim's outcome names its transmission.
		const claimed = this.mainTransmissions.get(token);
		return {
			verb: "observe",
			observation: {
				tag: "Answer",
				token,
				kind: "effect_outcome",
				outcome,
				...(claimed ? { transmission: claimed.name } : {}),
			},
		};
	}
	dispatch(send: Send): Extract<Evidence, { kind: "run_dispatched" }> {
		const binding = this.holdBindings.get(send.token);
		assert(binding, "Only a runner-held send has dispatch evidence");
		return {
			kind: "run_dispatched",
			runnerId: runnerOf(this.labelFor(send)),
			...binding,
		};
	}
	/** An issue's transmissions: a hold's by its run.dispatched, a control's by its claims (3.4). */
	bindingsFor(
		issue: MainIssue,
	): readonly { readonly send: Send; readonly transmission: number }[] {
		if (!this.isHeld(issue))
			return (
				this.mainSends.get(`${issue.commandId}\u0000${issue.effect.kind}`) ?? []
			).map((send, index) => ({
				send,
				transmission:
					this.mainTransmissions.get(send.token)?.name.transmission ??
					index + 1,
			}));
		return [...this.holdBindings].flatMap(([token, binding]) => {
			const send = this.sends.get(token)?.send;
			return binding.commandId === issue.commandId && send
				? [{ send, transmission: binding.transmission }]
				: [];
		});
	}
	/** Older label (3.4, L1): its runner retired, or a querySeq below the latest. A send's own label is never older, so an Answer never is. */
	private older(observation: Observation): boolean {
		if (observation.tag !== "Unsolicited") return false;
		const runner = runnerOf(observation.label);
		return (
			this.dead(runner) ||
			querySeqOf(observation.label) <
				(this.latestQuerySeq.get(runner) ?? -Infinity)
		);
	}
	private seenLabel(label: string): void {
		if (!this.labels.includes(label)) this.labels.push(label);
		const runner = runnerOf(label);
		this.latestQuerySeq.set(
			runner,
			Math.max(this.latestQuerySeq.get(runner) ?? -Infinity, querySeqOf(label)),
		);
	}
	/** An end_session acts on its runner's newest query (D15, D33). A null label binds per D23. */
	private targetOf(effect: Destruction): string | undefined {
		return effect.label === null ? undefined : this.newestLabel(effect.label);
	}
	/** The latest label seen for a label's runner (D15). */
	private newestLabel(label: string): string {
		const runner = runnerOf(label);
		return (
			this.labels.find(
				(seen) =>
					runnerOf(seen) === runner &&
					querySeqOf(seen) === this.latestQuerySeq.get(runner),
			) ?? label
		);
	}
	/**
	 * L2 case 2: a Run send of a runner-held provider goes to its execution's runner, under that
	 * runner's latest label, and is pending (null) while the execution's start is. A start, a
	 * destruction (its wire label) and every OpenCode send are case 3 (undefined).
	 */
	private ownerLabel(effect: IssuedEffect): string | null | undefined {
		const send = effect.effect;
		if (
			this.provider === "opencode" ||
			!("runId" in send) ||
			send.runId === null ||
			send.kind === "start" ||
			isDestruction(send)
		)
			return undefined;
		const runId = send.runId;
		const start = [...this.sends.values()].reverse().find(
			({ send }) =>
				send.effect.kind === "start" &&
				send.effect.runId === runId &&
				this.holdBindings.has(send.token) &&
				// An unlaunched try's execution was dropped (3.6): its relaunch owns the Run's steers.
				!this.unlaunchedTries.has(send.token),
		);
		if (start)
			return this.unbound.has(start.send.token)
				? null
				: this.newestLabel(start.label);
		if (this.startPending(runId)) return null;
		const wake = this.wakeExecutions.get(runId)?.[0];
		return wake === undefined ? undefined : this.newestLabel(wake);
	}
	/** A Run's latest start is pending: held for a process, or for its spawn's run_dispatched (L2). */
	private startPending(runId: string): boolean {
		return (
			this.gatedStarts.has(runId) ||
			[...this.pendingHeld.values(), ...this.spawnHeld.values()].some(
				(held) => held.effect.kind === "start" && heldRunId(held) === runId,
			)
		);
	}
	/** Runners a Run's bound start, steer or wake executions ran on; an unlaunched try's execution was dropped (8.5, D28, 3.6). */
	private executionRunners(runId: string): readonly string[] {
		return [
			...[...this.sends.values()]
				.filter(
					({ send }) =>
						(send.effect.kind === "start" || send.effect.kind === "steer") &&
						send.effect.runId === runId &&
						!this.unbound.has(send.token) &&
						!this.unlaunchedTries.has(send.token),
				)
				.map(({ label }) => label),
			...(this.wakeExecutions.get(runId) ?? []),
		].map(runnerOf);
	}
	/**
	 * D50 "reached", from what the ledger has read: a joined turn, or a transmission of the Run's
	 * current execution that is not NotConsumed and not Retrying or Failed with consumption None. A
	 * hold whose run.dispatched the ledger has not read is an undispatched issue, which has not reached.
	 */
	reached(runId: string): boolean {
		return (
			this.executions.some((x) => x.runId === runId) ||
			[...this.sends.values()].some(
				({ send, accepted, deliveryConfirmed, notConsumed, transportRank }) =>
					(send.effect.kind === "start" || send.effect.kind === "steer") &&
					send.effect.runId === runId &&
					!this.unlaunchedTries.has(send.token) &&
					// Any answer on a hold before its run.dispatched names a token the ledger has not bound (3.4).
					(!this.holdBindings.has(send.token) ||
						this.dispatchRead.has(send.token)) &&
					(accepted ||
						deliveryConfirmed ||
						(!notConsumed && transportRank !== 1 && transportRank !== 2)),
			) ||
			// A hold dispatched to a runner not yet started may have reached (3.6).
			[...this.spawnHeld].some(
				([token, held]) =>
					heldRunId(held) === runId && !this.unlaunchedTries.has(token),
			) ||
			// A gated Tokened try whose not_sent the ledger has not read yet may have reached (3.6).
			this.gateAnswers.some(({ target }) => {
				const effect =
					target.tag === "Tokened"
						? this.gatedTokens.get(target.token)?.send.effect
						: undefined;
				return (
					(effect?.kind === "start" || effect?.kind === "steer") &&
					effect.runId === runId
				);
			})
		);
	}
	/** D50: a not-yet-delivered Run unlaunches on a trigger; its execution is dropped and its hold lives on in the relaunch. */
	private unlaunch(runId: string): boolean {
		if (this.terminals.has(runId) || this.reached(runId)) return false;
		for (const { send } of this.sends.values())
			if (
				(send.effect.kind === "start" || send.effect.kind === "steer") &&
				send.effect.runId === runId
			)
				this.unlaunchedTries.add(send.token);
		// 4.4 H3: holdRun returns Ended for a pending try of the dropped execution, so the feeder drops it.
		for (const [token, held] of this.pendingHeld)
			if (heldRunId(held) === runId) {
				this.pendingHeld.delete(token);
				this.unlaunchedTries.add(token);
			}
		return true;
	}
	/** The event stream holds run.dispatched before any later fact of its transmission (4.5): a pending one is read first. */
	private dispatchFirst(
		matches: (
			dispatched: Extract<Observation, { kind: "run_dispatched" }>,
		) => boolean,
	): Observation | undefined {
		const index = this.notifications.findIndex(
			(n) => n.tag === "Answer" && n.kind === "run_dispatched" && matches(n),
		);
		return index < 0 ? undefined : this.notifications.splice(index, 1)[0];
	}
	/**
	 * A runner's stop commit: any pending run.dispatched of it first, then its run.released
	 * Answers, then process_lost{runnerId, retiredAt}, folded in that order (4.5, 3.13).
	 */
	private loss(runner: string, variant: number): LedgerCommand {
		const dispatched = this.dispatchFirst((n) => n.runnerId === runner);
		if (dispatched) return { verb: "observe", observation: dispatched };
		const [first, ...rest] = [
			...this.releases(runner, variant).map(
				({ token, reason }): LedgerCommand => ({
					verb: "observe",
					observation: { tag: "Answer", token, kind: "run_released", reason },
				}),
			),
			{
				verb: "settle",
				settlement: {
					kind: "process_lost",
					runnerId: runner,
					retiredAt: this.clock,
				},
			} satisfies LedgerCommand,
		];
		assert(first);
		this.commit.push(...rest);
		return first;
	}
	/**
	 * 4.5: a stop commit releases the transmissions its runner never took: Held, no consumption
	 * evidence, no command-accepted. Variants: none, all with one reason, mixed, the first only.
	 */
	private releases(
		runner: string,
		variant: number,
	): readonly { readonly token: SendToken; readonly reason: ReleaseReason }[] {
		const candidates = [...this.sends.values()].filter(
			(native) =>
				this.holdBindings.has(native.send.token) &&
				runnerOf(native.label) === runner &&
				!this.unbound.has(native.send.token) &&
				!native.covered &&
				!native.accepted &&
				!native.deliveryConfirmed &&
				!native.notConsumed &&
				native.transportRank === 0,
		);
		const reasons = ["Refused", "NotSent", "JournalAbsent"] as const;
		const chosen =
			variant % 4 === 0
				? []
				: variant % 4 === 3
					? candidates.slice(0, 1)
					: candidates;
		return chosen.map((native, i) => {
			const reason =
				reasons[(Math.floor(variant / 4) + (variant % 4 === 2 ? i : 0)) % 3] ??
				"NotSent";
			const runId = runIdOf(native.send.effect);
			// The runner refuses only while exiting, retiring or interrupted (4.5); an idle exit is `exiting`
			// and a self-retire (F40) is `retiring`, both host facts (4.6).
			const why = [...this.sends.values()].some(
				({ send }) =>
					send.effect.kind === "interrupt" &&
					(send.effect.runId === runId ||
						send.effect.runIds.some((id) => id === runId)),
			)
				? "interrupted"
				: Math.floor(variant / 12) % 2 === 0
					? "exiting"
					: "retiring";
			return {
				token: native.send.token,
				reason: reason === "Refused" ? { tag: "Refused", why } : reason,
			};
		});
	}
	/** The Runs with a bound try on a runner, each of which its retirement unlaunches unless it reached the agent (L1, 3.6 D50). */
	private runsOn(runner: string): readonly string[] {
		return [
			...new Set(
				[...this.sends.values()].flatMap(({ send, label }) =>
					(send.effect.kind === "start" || send.effect.kind === "steer") &&
					runnerOf(label) === runner &&
					!this.unbound.has(send.token) &&
					!this.unlaunchedTries.has(send.token) &&
					!this.terminals.has(send.effect.runId)
						? [send.effect.runId]
						: [],
				),
			),
		];
	}
	/** process_lost, or another runner's start (L1 totality). A repeated loss covers nothing new (3.2). */
	private loseRunner(runner: string): void {
		if (this.lostRunners.has(runner)) return;
		for (const runId of this.runsOn(runner)) this.unlaunch(runId);
		this.lostRunners.add(runner);
		for (const [token, gated] of this.gatedCommands)
			if (gated.runner === runner) this.gatedCommands.delete(token);
		// A runner lost before its process_started covers the sends resolved to it, and the case 2
		// sends of their Runs, which were pending with those starts (L1, L2, 6.1).
		if (this.spawning === runner) {
			this.spawning = undefined;
			const runIds = new Set([...this.spawnHeld.values()].map(heldRunId));
			for (const held of this.spawnHeld.values())
				this.retireHold(held.commandId);
			this.spawnHeld.clear();
			for (const held of [...this.pendingHeld.values()])
				if (runIds.has(heldRunId(held))) this.retireHold(held.commandId);
			for (const token of this.unbound) {
				const native = this.sends.get(token);
				const effect = native?.send.effect;
				if (
					native &&
					effect &&
					"runId" in effect &&
					effect.runId !== null &&
					runIds.has(effect.runId)
				) {
					native.covered = true;
					native.unfinished = false;
					this.unbound.delete(token);
				}
			}
		}
		for (const label of this.labels)
			if (runnerOf(label) === runner) this.retireLabel(label);
		if (runner === runnerOf(this.label)) {
			this.alive = false;
			this.turning = false;
			this.taskState = [];
		}
	}
	/** The started runner not yet lost, killed or not; H1 allows at most one. */
	private serving(): string | undefined {
		return [...this.processFacts]
			.map(runnerOf)
			.find((runner) => !this.lostRunners.has(runner));
	}
	private dead(runner: string): boolean {
		return this.lostRunners.has(runner);
	}
	/** The feeder reports `hold_exhausted` only for an unheld run, so never while a live runner still works one of its transmissions (4.3 steps 2-3). */
	private heldElsewhere(commandId: string): boolean {
		return [...this.holdBindings].some(([token, binding]) => {
			const native = this.sends.get(token);
			return (
				binding.commandId === commandId &&
				native?.unfinished === true &&
				!this.dead(runnerOf(this.labelFor(native.send)))
			);
		});
	}
	private retireHold(commandId: string): void {
		this.retiredHolds.add(commandId);
		for (const [token, held] of this.pendingHeld)
			if (held.commandId === commandId) this.pendingHeld.delete(token);
	}

	issued(
		effects: readonly IssuedEffect[],
		current = this.label,
		aliveAtIssue = this.alive,
	): readonly Send[] {
		const alive = aliveAtIssue;
		return effects.map((effect) => {
			const send = this.bound(effect);
			// L2: a later transmission keeps the address its send took at issue; it is never re-addressed.
			const first = this.isHeld(effect)
				? this.bindingsFor(effect).find(
						(earlier) =>
							earlier.send.token !== send.token &&
							!this.unlaunchedTries.has(earlier.send.token) &&
							runIdOf(earlier.send.effect) === runIdOf(effect.effect),
					)?.send
				: undefined;
			const case2 = this.ownerLabel(effect);
			const owner = case2 === undefined && first ? this.labelFor(first) : case2;
			// L2: pending when its execution's start is, or, for case 3, when no process is current.
			const pending = owner === null || (owner === undefined && !alive);
			const label = owner ?? current;
			// A start that met the gate with no address stays pending until a later try (H4, L2 case 2).
			if (send.effect.kind === "start") {
				if (this.gatedTokens.has(send.token) && pending)
					this.gatedStarts.add(send.effect.runId);
				else this.gatedStarts.delete(send.effect.runId);
			}
			if (this.gatedTokens.has(send.token)) return send;
			if (!this.sends.has(send.token)) {
				const heldRun = runIdOf(effect.effect);
				if (
					this.isHeld(effect) &&
					(this.retiredHolds.has(effect.commandId) ||
						(typeof heldRun === "string" && this.terminals.has(heldRun)))
				) {
					this.retireHold(effect.commandId);
					return send;
				}
				// H4: every send meets the gate before any adapter call (4.4).
				const gateAddress = isDestruction(send.effect)
					? this.targetOf(send.effect)
					: pending
						? undefined
						: label;
				if (
					!this.isHeld(effect) &&
					this.gate !== "served" &&
					(gateAddress === undefined || !this.dead(runnerOf(gateAddress)))
				) {
					this.gateSend(send, gateAddress);
					return send;
				}
				if (this.isHeld(effect) && pending) {
					this.pendingHeld.set(send.token, effect);
					return send;
				}
				if (send.effect.kind === "send_native_command" && pending) {
					this.pendingNativeCommands.set(send.token, effect);
					return send;
				}
				this.pendingHeld.delete(send.token);
				this.pendingNativeCommands.delete(send.token);
				const target = isDestruction(send.effect)
					? this.targetOf(send.effect)
					: undefined;
				// A send addressed to a retired runner is covered at issue (L1 item 1, L2, H3).
				const address = target ?? (pending ? undefined : label);
				const covered = address !== undefined && this.dead(runnerOf(address));
				if (pending && target === undefined && !covered)
					this.unbound.add(send.token);
				this.sends.set(send.token, {
					send,
					label: target ?? label,
					wakeFences: this.executions
						.filter((x) => x.fenced)
						.map((x) => ({ ...x })),
					accepted: false,
					deliveryConfirmed: false,
					lifecycleStarted: false,
					unfinished: !covered,
					covered,
					ended: false,
					notConsumed: false,
					transportRank: 0,
				});
				this.seenLabel(label);
				if (this.isHeld(effect) && covered) this.coveredHolds.add(send.token);
				// The feeder drops a covered owner send: holdRun returns Covered (H3). A spawn already
				// delivered this hold's run_dispatched.
				if (
					this.isHeld(effect) &&
					!covered &&
					!this.spawnDispatched.has(send.token)
				) {
					this.notifications.push(
						effect.effect.kind === "start"
							? {
									tag: "Answer",
									token: tokened(send.token),
									...this.dispatch(send),
								}
							: {
									tag: "Answer",
									token: tokened(send.token),
									...this.dispatch(send),
								},
					);
				}
				// Codex refuses a pause with no goal, so it never receives the command (8.5, D34).
				if (
					send.effect.kind === "send_native_command" &&
					this.provider === "codex" &&
					send.effect.text === "/goal pause" &&
					this.goalState === "cleared"
				)
					this.refusedCommands.set(send.token, "NoGoalExists");
				else if (
					send.effect.kind === "send_native_command" &&
					// A later claim of a received command is the same command (3.4, 8.5).
					!this.commands.has(send.effect.commandId)
				) {
					const queued = this.provider === "claude" && this.turning;
					this.commands.set(send.effect.commandId, {
						text: send.effect.text,
						state: queued ? "queued" : "started",
					});
					if (queued) {
						this.notifications.push({
							tag: "Unsolicited",
							label,
							eventId: this.eventId(),
							kind: "command_lifecycle",
							commandId: send.effect.commandId,
							state: "queued",
						});
					} else this.completeCommand(send.effect.commandId);
				}
			}
			return send;
		});
	}

	groundTruth(): ProviderGroundTruth {
		return {
			label: this.label,
			processAlive: this.alive,
			runningTurn: this.turning || this.executions.some((x) => x.live),
			acceptedUnended: [...this.sends.values()]
				.filter((send) => send.accepted && send.unfinished)
				.map(({ send }) => send.token),
			unfinished: [...this.sends.values()]
				.filter((send) => send.unfinished)
				.map(({ send }) => send.token),
			tasks: this.taskState,
			goal: this.goalState,
			queuedCommands: [...this.commands.entries()]
				.filter(([, command]) => command.state === "queued")
				.map(([id]) => id),
		};
	}

	setGoal(): void {
		this.goalState = "active";
	}
	pauseGoal(): void {
		if (this.provider === "codex") this.goalState = "paused";
	}
	resumeGoal(): void {
		this.goalState = "active";
		if (!this.turning && this.alive) this.queueWake();
	}
	limitGoal(): void {
		if (this.provider === "codex") this.goalState = "budgetLimited";
	}
	clearGoal(): void {
		this.goalState = "cleared";
	}

	/** Host messages generated by completed turns and queued slash commands. */
	pendingObservations(): readonly Observation[] {
		return this.notifications.splice(0);
	}
	/** Main's issues since the last read (D60, 3.4): the driver's record of every start and steer. */
	takeMainIssues(): readonly {
		readonly issue: IssuedEffect;
		readonly token: SendToken;
	}[] {
		return this.mainIssues.splice(0);
	}

	private eventId(): string {
		return `fake-event:${this.serial++}`;
	}
	// 8.3: Run-end evidence under an older wake execution label still clears that execution.
	private wakeEnd(observation: Observation): boolean {
		return (
			observation.tag === "Unsolicited" &&
			(observation.kind === "activity" ||
				observation.kind === "result" ||
				observation.kind === "turn_ended" ||
				observation.kind === "query_ended") &&
			this.executions.some(
				(x) => x.label === observation.label && (x.live || x.fenced),
			)
		);
	}
	private supportsTasks(): boolean {
		return this.provider === "claude" || this.provider === "codex";
	}
	private queueWake(wakeTask?: TaskKey): void {
		// 8.3: Cursor starts no unsolicited turn.
		if (this.provider === "cursor") return;
		if (
			this.notifications.some(
				(observation) =>
					observation.tag === "Unsolicited" &&
					observation.kind === "turn_started" &&
					observation.label === this.label,
			)
		)
			return;
		this.notifications.push({
			tag: "Unsolicited",
			label: this.label,
			eventId: this.eventId(),
			kind: "turn_started",
			...(wakeTask ? { wakeTask } : {}),
		});
	}
	private completeCommand(commandId: string): void {
		const command = this.commands.get(commandId);
		if (!command || command.state === "completed") return;
		command.state = "completed";
		const text = command.text.trim();
		if (text === "/goal clear") this.clearGoal();
		else if (text === "/goal pause") this.pauseGoal();
		else if (text === "/goal resume") this.resumeGoal();
		else if (text.startsWith("/goal ")) {
			this.setGoal();
			if (!this.turning) this.queueWake();
		}
		this.notifications.push({
			tag: "Unsolicited",
			label: this.label,
			eventId: this.eventId(),
			kind: "command_result",
			commandId,
		});
	}
	private finishTurn(): void {
		if (this.turnFinished) return;
		this.turnFinished = true;
		this.turning = false;
		for (const [id, command] of this.commands) {
			if (command.state === "queued") this.completeCommand(id);
		}
		if (this.goalState === "active") this.queueWake();
	}
	/**
	 * 8.3, D25, D47: the provider's Run-end evidence for a label clears the liveness, then the fence,
	 * of every execution under it, or of one Run's when it answers that Run's query. With no kind,
	 * the runner's retirement or a destruction clears both.
	 */
	private endExecutions(
		label: string,
		kind?: "result" | "query_ended",
		runId?: string,
	): void {
		for (const x of this.executions)
			if (x.label === label && (runId === undefined || x.runId === runId)) {
				if (
					kind === undefined ||
					kind === (this.provider === "opencode" ? "query_ended" : "result")
				)
					x.live = false;
				if (
					kind === undefined ||
					(this.provider === "claude" && kind === "query_ended") ||
					(this.provider !== "claude" &&
						this.provider !== "opencode" &&
						kind === "result")
				)
					x.fenced = false;
			}
	}
	private retireLabel(label: string): void {
		this.wakeLabels.delete(label);
		this.endExecutions(label);
		for (const send of this.sends.values()) {
			// A pending send is addressed to the next process, not to the label it was issued under (L2 case 3).
			if (send.label === label && !this.unbound.has(send.send.token)) {
				const binding = this.holdBindings.get(send.send.token);
				// An unlaunched try's hold lives on in its relaunch (3.6).
				if (binding && !this.unlaunchedTries.has(send.send.token))
					this.retireHold(binding.commandId);
				send.covered = true;
				send.unfinished = false;
			}
		}
	}
	/**
	 * 3.3: a query ending covers that label's interrupt sends: those addressed to it and, for a
	 * query_ended answering a Run's send, that Run's (its execution).
	 */
	private endQuery(label: string, runId?: string): void {
		// OpenCode input work still needs covering idle proof after query end (9).
		if (this.provider !== "opencode")
			for (const native of this.sends.values()) {
				const effect = native.send.effect;
				if (
					effect.kind === "interrupt" &&
					(native.label === label ||
						(runId !== undefined && effect.runId === runId))
				) {
					native.ended = true;
					native.unfinished = false;
				}
			}
		// OpenCode keeps the fence for a covering probe; Claude leaves at query_ended with or without
		// a result (9, D25). An answer ends only its own Run's execution (D47).
		this.endExecutions(label, "query_ended", runId);
		if (label === this.label) this.finishTurn();
	}
	private refreshQuery(send: NativeSend): void {
		send.unfinished =
			!send.covered &&
			!send.ended &&
			(send.accepted ||
				(!send.notConsumed &&
					(send.transportRank === 0 || send.transportRank >= 3)));
	}

	/** Impossible token frames and older labels never become native ground truth. */
	observe(
		command: LedgerCommand,
		before: LedgerView,
		after: LedgerView = before,
	): void {
		// Only this step's retirement is checked against this step's terminals.
		this.retirement = undefined;
		// 3.4: main writes one outcome per control claim and retries a retryable or not_sent outcome
		// on its latest claim, while the issue is live, as a new claim.
		if (
			command.verb === "observe" &&
			command.observation.tag === "Answer" &&
			command.observation.kind === "effect_outcome" &&
			command.observation.transmission !== undefined
		) {
			const { token, outcome } = command.observation;
			const claimed = this.mainTransmissions.get(token);
			if (claimed && !this.controlOutcomes.has(token)) {
				this.controlOutcomes.set(token, outcome);
				const { issue } = claimed;
				if (
					(outcome.tag === "retryable" || outcome.tag === "not_sent") &&
					this.bindingsFor(issue).at(-1)?.send.token === token &&
					after.live.some(
						(item) =>
							item.tag === "Main" &&
							item.commandId === issue.commandId &&
							item.effect.kind === issue.effect.kind,
					)
				) {
					this.claim(issue);
					this.issued([issue]);
				}
			}
		}
		// A gate answer names a send never transmitted: no host fact changes (H4), and a not_sent
		// send nothing received is no native work.
		if (isGateAnswer(command)) {
			const native =
				command.verb === "observe" && command.observation.tag === "Answer"
					? this.sends.get(command.observation.token)
					: undefined;
			if (
				native &&
				!native.accepted &&
				!native.deliveryConfirmed &&
				!native.lifecycleStarted
			)
				native.unfinished = false;
			return;
		}
		// D58: main's inbox holds the inputs the ledger accepted.
		if (command.verb === "admit")
			this.mainInbox.push({
				inputId: command.inputId,
				delivery: command.delivery,
			});
		// L6, D58: a Stop, End or Run now is the projection of main's stop commit, which interrupts main's open run.
		if (
			command.verb === "control" &&
			["stop", "end", "run_now"].includes(command.control.kind) &&
			this.mainRun
		)
			this.mainRun.stopped = true;
		if (command.verb === "settle") {
			const settlement = command.settlement;
			if (settlement.kind === "process_started") {
				const runner = runnerOf(settlement.label);
				// Retired is final and runnerIds are never reused (L1, H2): a later start changes nothing.
				// A start at or below the runner's latest querySeq is an older label (L1).
				if (
					this.processFacts.has(settlement.label) ||
					this.dead(runner) ||
					querySeqOf(settlement.label) <=
						(this.latestQuerySeq.get(runner) ?? -Infinity)
				)
					return;
				// Totality: another runner's start retires the current one as its loss (L1).
				const serving = this.serving();
				if (serving !== undefined && serving !== runner)
					this.loseRunner(serving);
				// A gated command waiting for a process is addressed to the process that starts next (4.4, 6.1).
				for (const [token, gated] of this.gatedCommands)
					if (gated.runner === undefined)
						this.gatedCommands.set(token, { ...gated, runner });
				// It is the loss of every other runner, started or not: a dispatched runner not yet
				// started retires with what run_dispatched resolved to it (L1, L2).
				if (this.spawning !== undefined && this.spawning !== runner)
					this.loseRunner(this.spawning);
				this.spawning = undefined;
				this.processFacts.add(settlement.label);
				this.seenLabel(settlement.label);
				this.hostLabel = settlement.label;
				if (!this.labels.includes(this.label)) this.labels.push(this.label);
				this.alive = true;
				for (const token of this.unbound) {
					const native = this.sends.get(token);
					if (native) native.label = settlement.label;
				}
				this.unbound.clear();
				this.turning = false;
				this.turnFinished = false;
				this.taskState =
					settlement.reattached && this.supportsTasks() ? "unknown" : [];
				this.taskVersion++;
				// H3: the feeder transmits a pending send only while it is still live.
				const live = (effect: IssuedEffect) =>
					before.live.some((item) =>
						item.tag === "Main"
							? effect.tag === "Main" &&
								item.commandId === effect.commandId &&
								item.effect.kind === effect.effect.kind
							: effect.tag === "Tokened" && item.token === effect.token,
					);
				const pending = [
					...this.pendingNativeCommands.values(),
					...this.pendingHeld.values(),
					...this.spawnHeld.values(),
				];
				this.pendingNativeCommands.clear();
				this.pendingHeld.clear();
				this.spawnHeld.clear();
				this.issued(pending.filter(live));
				if (this.restartLabels.has(settlement.label)) this.queueWake();
			} else if (settlement.kind === "process_lost") {
				const runner = settlement.runnerId;
				// D50: retirement unlaunches each not-yet-delivered Run with an execution on this runner.
				const runIds = this.lostRunners.has(runner) ? [] : this.runsOn(runner);
				const reached = runIds.filter((runId) => this.reached(runId));
				this.retirement = {
					unlaunched: runIds.filter((runId) => this.unlaunch(runId)),
					reached,
				};
				this.loseRunner(runner);
				if (this.removing?.runner === settlement.runnerId) {
					this.setGate(this.removing.gate);
					this.removing = undefined;
				}
			} else if (settlement.kind === "session_ended") {
				this.pendingNativeCommands.clear();
				// Session end covers every send (3.4), a gated native command's included.
				this.gatedCommands.clear();
				// Nothing acts in an ended native session (3.4), a wake's turn included.
				for (const x of this.executions) {
					x.fenced = false;
					x.live = false;
				}
				for (const { commandId } of this.holdBindings.values())
					this.retireHold(commandId);
				// The native session ends, not the process: only the watcher reports a death (3.11, D16).
				this.turning = false;
				this.taskState = [];
				for (const send of this.sends.values()) {
					send.covered = true;
					send.unfinished = false;
				}
			}
			if (settlement.kind === "hold_exhausted")
				this.retireHold(settlement.commandId);
			return;
		}
		if (command.verb !== "observe") return;
		const observation = command.observation;
		// D60: main's run events are this host's own acts, already applied when main wrote them.
		if (observation.tag === "Main") return;
		if (this.older(observation) && !this.wakeEnd(observation)) return;
		if (observation.tag === "Unsolicited") {
			// Evidence its provider cannot produce is Rejected and never raises the querySeq (L1, 3.4):
			// task evidence from Cursor or OpenCode, command_lifecycle (D46) or turn_ended (2.1 row 215,
			// 8.3) from any provider but Claude.
			if (
				(!this.supportsTasks() &&
					(observation.kind === "tasks_snapshot" ||
						observation.kind === "task_event")) ||
				(this.provider !== "claude" &&
					(observation.kind === "command_lifecycle" ||
						observation.kind === "turn_ended"))
			)
				return;
			const identity = `${observation.label}/${observation.eventId}`;
			if (this.seenEvents.has(identity)) return;
			this.seenEvents.add(identity);
			// 6.1: a newer querySeq of the serving runner, with no process_started, is a query replacement.
			const replaced =
				this.alive &&
				runnerOf(observation.label) === runnerOf(this.label) &&
				querySeqOf(observation.label) > querySeqOf(this.label);
			this.seenLabel(observation.label);
			if (replaced) {
				// The host drops its task cache: the newer query's tasks are unknown until its first
				// snapshot (8.4, D44). The old query's turn ends with it; its sends keep their own facts.
				this.hostLabel = observation.label;
				this.taskState = this.supportsTasks() ? "unknown" : [];
				this.taskVersion++;
				this.turning = false;
				this.turnFinished = false;
			}
			const own = observation.label === this.label;
			// Every wake execution label keeps its own Run-end evidence (D28).
			if (
				!own &&
				!(
					this.wakeLabels.has(observation.label) &&
					(observation.kind === "result" ||
						observation.kind === "activity" ||
						observation.kind === "query_ended")
				)
			)
				return;
			if (observation.kind === "tasks_snapshot" && this.supportsTasks()) {
				this.taskState = observation.tasks;
				this.taskVersion++;
			} else if (observation.kind === "turn_started") {
				// Every unsolicited turn is outstanding work of its own, a new wake Run's or one joined to
				// any active Run; a repeat re-arms it (8.3, D28, D47).
				if (
					before.active?.origin === "wake" &&
					!this.wakeLabels.has(observation.label)
				)
					this.wakeExecutions.get(before.active.runId)?.push(observation.label);
				this.wakeLabels.add(observation.label);
				const runId = after.active?.runId ?? "";
				const execution = this.executions.find(
					(x) => x.runId === runId && x.label === observation.label,
				);
				if (!execution)
					this.executions.push({
						runId,
						label: observation.label,
						live: true,
						fenced: true,
						fencedBy: observation.eventId,
					});
				else {
					if (!execution.fenced) execution.fencedBy = observation.eventId;
					execution.live = true;
					execution.fenced = true;
				}
				this.turning = true;
				this.turnFinished = false;
			} else if (observation.kind === "command_lifecycle") {
				const native = this.commands.get(observation.commandId);
				const state = observation.state;
				// A completed or cancelled command has ended its send's work (8.5).
				if (state === "completed" || state === "cancelled") {
					if (native) this.finishCommand(observation.commandId);
				} else if (native) native.state = state;
			} else if (observation.kind === "command_result") {
				this.finishCommand(observation.commandId);
			} else if (observation.kind === "result") {
				if (!this.wakeLabels.has(observation.label)) return;
				this.endExecutions(observation.label, "result");
				if (own) this.finishTurn();
			} else if (observation.kind === "turn_ended") {
				// 8.3: a Claude wake's turn_ended is its own end, live and fence alike.
				if (!this.wakeLabels.has(observation.label)) return;
				this.endExecutions(observation.label);
				if (own) this.finishTurn();
			} else if (observation.kind === "activity") {
				if (!this.wakeLabels.has(observation.label)) return;
				if (
					!own ||
					!this.executions.some((x) => x.label === observation.label && x.live)
				)
					return;
				this.turning = true;
				this.turnFinished = false;
			} else if (observation.kind === "query_ended") {
				if (!this.wakeLabels.has(observation.label)) return;
				this.endQuery(observation.label);
			}
			return;
		}
		if (observation.kind === "run_dispatched")
			this.dispatchRead.add(observation.token);
		// REDESIGN r3-1: a run_dispatched naming a fresh runner resolves a pending start to it before
		// its process_started (6.1, L2). Observed here so every host replaying the trace agrees.
		const spawned = this.pendingHeld.get(observation.token);
		if (
			spawned &&
			observation.kind === "run_dispatched" &&
			this.spawning === undefined &&
			this.serving() === undefined &&
			!this.dead(observation.runnerId)
		) {
			this.spawning = observation.runnerId;
			this.pendingHeld.delete(observation.token);
			this.spawnHeld.set(observation.token, spawned);
			this.spawnDispatched.add(observation.token);
			return;
		}
		const native = this.sends.get(observation.token);
		// The answered send's address owns the label (3.4, L2).
		if (!native) return;
		const answerLabel = native.label;
		const effect = native.send.effect;
		if (observation.kind === "effect_outcome") {
			if (effect.kind === "start" || effect.kind === "steer") {
				const ranks = {
					not_sent: 1,
					retryable: 1,
					permanent: 2,
					delivery_unknown: 3,
					succeeded: 4,
				};
				native.transportRank = Math.max(
					native.transportRank,
					ranks[observation.outcome.tag],
				);
				this.refreshQuery(native);
				// D50: a retryable or not_sent outcome unlaunches a not-yet-delivered Run; a dropped
				// execution's try no longer moves it.
				if (
					(observation.outcome.tag === "retryable" ||
						observation.outcome.tag === "not_sent") &&
					!this.unlaunchedTries.has(observation.token)
				)
					this.unlaunch(effect.runId);
				return;
			}
			// A permanent outcome means the provider never received the command (3.4, D34).
			if (
				effect.kind === "send_native_command" &&
				observation.outcome.tag === "permanent"
			) {
				native.unfinished = false;
				this.commands.delete(effect.commandId);
			} else if (
				observation.outcome.tag === "retryable" ||
				observation.outcome.tag === "permanent"
			) {
				if (!native.accepted) native.unfinished = false;
			} else if (
				observation.outcome.tag === "succeeded" &&
				effect.kind !== "probe" &&
				effect.kind !== "send_native_command"
			) {
				native.unfinished = false;
				if (
					effect.kind === "end_session" &&
					!this.destroyed.has(native.send.token)
				) {
					this.destroyed.add(native.send.token);
					// 3.4: a Run-less session end covers every send of the native session, so its runner's
					// older labels too (a reattach bumps querySeq without retiring, L1).
					for (const label of effect.runId === null
						? new Set(
								[...this.sends.values()]
									.map((send) => send.label)
									.filter(
										(label) => runnerOf(label) === runnerOf(native.label),
									),
							)
						: [native.label])
						this.retireLabel(label);
					// Tasks change only by task evidence, a start or a loss: L5 at a later scope end reads
					// the label's latest snapshot, and a destruction that went to pending recorded nothing.
					if (native.label === this.label) this.turning = false;
				}
			}
			return;
		}
		if (effect.kind === "probe" && observation.kind === "probe_result") {
			native.unfinished = false;
			if (effect.target.tag === "input") {
				for (const issued of this.sends.values()) {
					if (issued === native) break;
					const target = issued.send.effect;
					if (
						issued.label === this.label &&
						(target.kind === "start" || target.kind === "steer") &&
						target.inputId === effect.target.inputId
					) {
						if (observation.finding.tag === "input_present") {
							issued.accepted = true;
							this.refreshQuery(issued);
						} else if (
							observation.finding.tag === "input_absent" &&
							!issued.accepted
						) {
							issued.notConsumed = true;
							issued.unfinished = false;
						}
					}
				}
			}
			if (
				effect.target.tag === "native_session" &&
				observation.finding.tag === "native_idle"
			) {
				// A trusted covering idle probe alone ends OpenCode wake work (3.5, D26).
				if (this.provider === "opencode")
					for (const covered of native.wakeFences)
						for (const x of this.executions)
							if (
								x.label === answerLabel &&
								x.runId === covered.runId &&
								x.label === covered.label &&
								x.fenced &&
								x.fencedBy === covered.fencedBy
							) {
								x.live = false;
								x.fenced = false;
							}
				for (const issued of this.sends.values()) {
					if (issued === native) break;
					if (
						issued.label === this.label &&
						!(
							this.provider === "opencode" &&
							!issued.accepted &&
							!issued.deliveryConfirmed &&
							(issued.send.effect.kind === "start" ||
								issued.send.effect.kind === "steer")
						)
					) {
						issued.covered = true;
						issued.unfinished = false;
					}
				}
				this.turning = false;
			}
			return;
		}
		if (
			observation.kind === "interaction_resolved" &&
			(effect.kind === "deliver_answer" ||
				effect.kind === "start" ||
				effect.kind === "steer") &&
			(effect.kind !== "deliver_answer" ||
				observation.interactionId === effect.interactionId)
		) {
			for (const answer of this.sends.values())
				if (
					answer.send.effect.kind === "deliver_answer" &&
					answer.send.effect.interactionId === observation.interactionId
				) {
					answer.ended = true;
					answer.unfinished = false;
				}
			return;
		}
		if (effect.kind === "send_native_command") {
			// command_lifecycle from any provider but Claude is Rejected (D46, 3.4).
			if (
				(observation.kind !== "command_result" &&
					(observation.kind !== "command_lifecycle" ||
						this.provider !== "claude")) ||
				observation.commandId !== effect.commandId
			)
				return;
			const state =
				observation.kind === "command_result" ? "completed" : observation.state;
			if (state === "completed" || state === "cancelled")
				this.finishCommand(observation.commandId);
			else {
				const native = this.commands.get(observation.commandId);
				if (native) native.state = state;
			}
			return;
		}
		if (effect.kind !== "start" && effect.kind !== "steer") return;
		switch (observation.kind) {
			case "input_accepted":
				native.accepted = true;
				native.deliveryConfirmed = true;
				this.refreshQuery(native);
				break;
			case "started":
			case "activity":
			case "interaction_requested":
				if (!native.covered) {
					if (this.provider === "opencode") native.ended = false;
					native.accepted = true;
					this.refreshQuery(native);
					// The turn flag is the current query's; a replaced label's send keeps its own facts (3.3).
					if (native.label === this.label) {
						this.turning = true;
						this.turnFinished = false;
					}
				}
				break;
			case "input_declined":
				native.notConsumed = true;
				this.refreshQuery(native);
				break;
			case "run_released":
				if (observation.reason === "ResumeRejected") {
					native.transportRank = Math.max(native.transportRank, 2);
				} else native.notConsumed = true;
				this.refreshQuery(native);
				// D50: a release that leaves the Run never reached unlaunches it; a dropped execution's try no longer moves it.
				if (!this.unlaunchedTries.has(observation.token))
					this.unlaunch(effect.runId);
				break;
			case "delivery_indeterminate":
				native.transportRank = Math.max(native.transportRank, 3);
				this.refreshQuery(native);
				break;
			case "command_lifecycle":
				if (
					this.provider !== "claude" ||
					this.holdBindings.get(native.send.token)?.commandId !==
						observation.commandId
				)
					break;
				if (
					observation.state === "started" ||
					observation.state === "completed"
				) {
					native.lifecycleStarted = true;
					native.accepted = true;
				} else if (observation.state === "cancelled") {
					if (native.lifecycleStarted) native.accepted = true;
					else native.notConsumed = true;
				}
				this.refreshQuery(native);
				break;
			case "runner_reply":
				native.transportRank = Math.max(
					native.transportRank,
					observation.outcome.tag === "succeeded" ? 4 : 2,
				);
				// The command-reply carries the turn's TurnResult or failure
				// (runner-protocol.ts command-reply, 4.11): this send's turn is over.
				native.ended = true;
				native.unfinished = false;
				this.refreshQuery(native);
				// 4.11, 9: read as `result`, a Codex or Cursor reply ends its Run's execution, every
				// start and steer of it (a Cursor `wait()` settles every pending steer).
				if (
					(this.provider === "codex" || this.provider === "cursor") &&
					(effect.kind === "start" || effect.kind === "steer")
				)
					for (const send of this.sends.values()) {
						const other = send.send.effect;
						if (
							(other.kind === "start" || other.kind === "steer") &&
							other.runId === effect.runId &&
							send.label === answerLabel &&
							this.unlaunchedTries.has(send.send.token) ===
								this.unlaunchedTries.has(native.send.token)
						) {
							send.ended = true;
							send.unfinished = false;
						}
					}
				if (answerLabel === this.label) this.finishTurn();
				break;
			case "journal_answer":
				if (
					observation.answer === "running" ||
					observation.answer === "finished"
				) {
					native.accepted = true;
					this.refreshQuery(native);
					if (observation.answer === "running" && native.unfinished)
						this.turning = true;
				} else if (observation.answer === "absent" && !native.accepted) {
					// 4.9: no record, so no native work; only its run.released tells the ledger it never reached (D50).
					native.ended = true;
					this.refreshQuery(native);
				}
				break;
			case "result": {
				native.deliveryConfirmed = true;
				const answered =
					this.provider === "claude"
						? native
						: [...this.sends.values()]
								.reverse()
								.find(
									(send) =>
										send.label === answerLabel &&
										(send.accepted || send.deliveryConfirmed) &&
										(send.send.effect.kind === "start" ||
											send.send.effect.kind === "steer"),
								);
				if (answered && this.provider !== "opencode") {
					answered.ended = true;
					answered.unfinished = false;
				}
				// Cursor wait() ends the native turn and its pending steers (9).
				if (this.provider === "cursor")
					for (const send of this.sends.values())
						if (
							send.label === answerLabel &&
							send.accepted &&
							(send.send.effect.kind === "start" ||
								send.send.effect.kind === "steer")
						) {
							send.ended = true;
							send.unfinished = false;
						}
				if (
					this.provider !== "opencode" &&
					![...this.sends.values()].some(
						(send) =>
							(send.send.effect.kind === "start" ||
								send.send.effect.kind === "steer") &&
							send.send.effect.runId === effect.runId &&
							send.unfinished,
					)
				)
					for (const send of this.sends.values())
						if (
							send.send.effect.kind === "interrupt" &&
							send.send.effect.runId === effect.runId
						) {
							send.ended = true;
							send.unfinished = false;
						}
				// The start's own Run-end answer also ends its Run's turn joined under that label, by the
				// unsolicited result's policy (8.3, D47, oracle round 10).
				this.endExecutions(answerLabel, "result", effect.runId);
				// A turn result drains slash commands. Native query termination is
				// a separate host fact, even when the result ends the ledger Run.
				if (answerLabel === this.label) this.finishTurn();
				break;
			}
			case "query_ended":
				this.endQuery(answerLabel, effect.runId);
				break;
		}
	}

	private finishCommand(commandId: string): void {
		const command = this.commands.get(commandId);
		if (command) command.state = "completed";
		for (const native of this.sends.values()) {
			if (
				native.send.effect.kind === "send_native_command" &&
				native.send.effect.commandId === commandId
			)
				native.unfinished = false;
		}
	}

	/** 3.4: evidence its provider cannot produce (task evidence from Cursor or OpenCode, 8.1; command_lifecycle from any provider but Claude, D46) is Rejected. */
	assertVerdict(command: LedgerCommand, tag: "Accepted" | "Rejected"): void {
		if (
			command.verb === "observe" &&
			command.observation.tag === "Unsolicited" &&
			(command.observation.kind === "tasks_snapshot" ||
				command.observation.kind === "task_event") &&
			!this.supportsTasks()
		)
			assert.equal(
				tag,
				"Rejected",
				"3.4: task evidence from Cursor or OpenCode is not Rejected (8.1)",
			);
		// D46: producibility belongs to the kind, so it holds for any tag and any token.
		if (
			command.verb === "observe" &&
			command.observation.kind === "command_lifecycle" &&
			this.provider !== "claude"
		)
			assert.equal(
				tag,
				"Rejected",
				"D46: command_lifecycle from a provider but Claude is not Rejected (3.4)",
			);
		// 3.4: only Claude's payload has a wake turn_ended (2.1 row 215, 8.3).
		if (
			command.verb === "observe" &&
			command.observation.kind === "turn_ended" &&
			this.provider !== "claude"
		)
			assert.equal(
				tag,
				"Rejected",
				"3.4: turn_ended from a provider but Claude is not Rejected (8.3)",
			);
	}
	/** Assertions depend only on views, outputs and native facts observed above. */
	assertStep(
		command: LedgerCommand,
		before: LedgerView,
		after: LedgerView,
		effects: readonly IssuedEffect[],
		ended: readonly RunEnded[],
		replayed?: LedgerView,
	): void {
		// D50: a not_sent or retryable try unlaunches a not-yet-delivered Run; a reached one retries in its execution.
		if (
			command.verb === "settle" &&
			command.settlement.kind === "unheld_outcome" &&
			command.settlement.outcome.tag !== "permanent"
		)
			this.unlaunch(command.settlement.runId);
		// D50: Stop or Run now ends a not-yet-delivered Run at once, `interrupted`, with no effect (3.6, 5.1).
		const undelivered =
			command.verb === "control" &&
			(command.control.kind === "stop" ||
				(command.control.kind === "run_now" &&
					![...(before.active?.inputs ?? []), ...before.inbox].some(
						({ inputId }) =>
							command.control.kind === "run_now" &&
							inputId === command.control.inputId,
					))) &&
			before.active !== undefined &&
			before.active.tag !== "Interrupting" &&
			(before.active.tag === "Queued" || !this.reached(before.active.runId))
				? before.active.runId
				: undefined;
		const truth = this.groundTruth();
		const oldLabel = this.label;
		const oldTaskVersion = this.taskVersion;
		const older =
			!isGateAnswer(command) &&
			command.verb === "observe" &&
			this.older(command.observation);
		// Clearing an older wake execution may release the fence a queued Run waits on (8.3, D18).
		const olderWakeEnd =
			older &&
			!isGateAnswer(command) &&
			command.verb === "observe" &&
			this.wakeEnd(command.observation);
		const seenWake =
			command.verb === "observe" && command.observation.tag === "Unsolicited"
				? this.seenEvents.has(
						`${command.observation.label}/${command.observation.eventId}`,
					)
				: false;
		const lifecycleSend =
			command.verb === "observe" &&
			command.observation.tag === "Answer" &&
			(command.observation.kind === "started" ||
				command.observation.kind === "activity" ||
				command.observation.kind === "result" ||
				command.observation.kind === "interaction_requested")
				? this.sends.get(command.observation.token)?.send.effect
				: undefined;
		const answered =
			command.verb === "observe" && command.observation.tag === "Answer"
				? this.sends.get(command.observation.token)
				: undefined;
		// Lifecycle evidence on a retired or covered send changes no Run state (3.4, L1).
		const retiredLifecycle =
			answered !== undefined &&
			command.verb === "observe" &&
			(lifecycleSend !== undefined ||
				command.observation.kind === "query_ended") &&
			(answered.covered ||
				(!this.unbound.has(answered.send.token) &&
					this.dead(runnerOf(answered.label))));
		const lateEndedLifecycle =
			lifecycleSend &&
			(lifecycleSend.kind === "start" || lifecycleSend.kind === "steer") &&
			this.terminals.has(lifecycleSend.runId);
		if (
			command.verb === "observe" &&
			command.observation.tag === "Unsolicited" &&
			command.observation.kind === "turn_started" &&
			!before.active &&
			after.active?.origin === "wake"
		)
			this.wakeExecutions.set(after.active.runId, [command.observation.label]);
		const refusal =
			command.verb === "observe" &&
			command.observation.tag === "Answer" &&
			command.observation.kind === "effect_outcome" &&
			command.observation.outcome.tag === "permanent" &&
			!older
				? {
						native: this.sends.get(command.observation.token),
						code: command.observation.outcome.code,
					}
				: undefined;
		// A removed project's refusal of a gated native command fails it the same way (H4, D34).
		const gatedCommand =
			command.verb === "observe" && command.observation.tag === "Answer"
				? this.gatedCommands.get(command.observation.token)?.commandId
				: undefined;
		const refusedCommand =
			refusal?.native?.send.effect.kind === "send_native_command" &&
			refusal.native.unfinished
				? {
						commandId: refusal.native.send.effect.commandId,
						tag: "Failed",
						code: refusal.code,
					}
				: refusal && gatedCommand !== undefined
					? { commandId: gatedCommand, tag: "Failed", code: refusal.code }
					: undefined;
		this.observe(command, before, after);
		if (undelivered !== undefined) {
			assert(
				ended.some(
					(t) => t.runId === undelivered && t.reason.tag === "interrupted",
				),
				`D50: Stop or Run now left not-yet-delivered ${undelivered} unended (3.6)`,
			);
			assert(
				!effects.some(
					({ effect }) =>
						effect.kind === "interrupt" &&
						"runId" in effect &&
						effect.runId === undelivered,
				),
				`D50: Stop or Run now interrupted not-yet-delivered ${undelivered} (3.6, 5.1)`,
			);
		}
		if (this.retirement) {
			const { unlaunched, reached } = this.retirement;
			this.retirement = undefined;
			for (const runId of unlaunched)
				assert(
					!ended.some(
						(t) => t.runId === runId && t.reason.tag === "process_lost",
					),
					`D50: retirement ended not-yet-delivered ${runId} process_lost instead of unlaunching it (3.6)`,
				);
			for (const runId of reached)
				assert(
					ended.some((t) => t.runId === runId),
					`D50: retirement left reached ${runId} unended (3.6)`,
				);
		}
		if (
			this.label !== oldLabel ||
			this.taskVersion !== oldTaskVersion ||
			(command.verb === "settle" &&
				command.settlement.kind === "process_lost" &&
				command.settlement.runnerId === runnerOf(oldLabel))
		)
			this.confirmedSnapshot = undefined;
		const background = this.groundTruth().tasks;
		if (
			command.verb === "settle" &&
			command.settlement.kind === "process_started" &&
			before.pendingConfirm &&
			after.pendingConfirm
		)
			// Each step carries the runner's latest label (L3, 3.3).
			assert.deepEqual(
				after.pendingConfirm.labels,
				before.pendingConfirm.labels.map((label) => this.newestLabel(label)),
				"LI5: pending confirm labels are not a view of the runner's latest label after process_started (L3, D33)",
			);
		// A destruction issued with no live process records no lost work (8.4, D38).
		const aliveAtIssue = this.alive;
		const checked: string[] = [];
		for (const effect of effects) {
			if (effect.effect.kind === "start") {
				assert.equal(
					this.groundTruth().acceptedUnended.length,
					0,
					"LI1: start overlaps accepted, unended native work",
				);
				if (effect.effect.mode === "resume")
					assert.equal(
						this.executions.filter((x) => x.fenced).length,
						0,
						"LI1: resume start overlaps a running wake native-session fence",
					);
			}
		}
		checked.push("LI1");
		for (const terminal of ended) {
			assert.equal(
				this.terminals.has(terminal.runId),
				false,
				"LI3: Run ended more than once or its Tombstone changed",
			);
			this.terminals.set(terminal.runId, structuredClone(terminal));
			for (const held of this.pendingHeld.values())
				if (heldRunId(held) === terminal.runId) this.retireHold(held.commandId);
			// 4.3, H3: a hold whose run.dispatched the ledger has not read is not yet held, so holdRun
			// returns Ended (or Covered) and the feeder drops it: no transmission, nothing left to finish.
			for (const [token, binding] of [...this.holdBindings]) {
				const effect = this.sends.get(token)?.send.effect;
				if (
					(effect?.kind === "start" || effect?.kind === "steer") &&
					effect.runId === terminal.runId &&
					!this.dispatchRead.has(token) &&
					!this.spawnDispatched.has(token) &&
					this.dispatchFirst((n) => n.token === token)
				) {
					this.holdBindings.delete(token);
					this.sends.delete(token);
					this.unbound.delete(token);
					this.transmissions.set(binding.commandId, binding.transmission - 1);
					this.retireHold(binding.commandId);
				}
			}
		}
		if (after.active)
			assert.equal(
				this.terminals.has(after.active.runId),
				false,
				"LI3: an Ended Run became active again",
			);
		if (lateEndedLifecycle) {
			// 12A forbids changes to the Ended Run only: late evidence that releases the fence starts the
			// Queued Run in its own decision (3.2, 3.8, harness round 12).
			const queued =
				before.active?.tag === "Queued" ? before.active.runId : undefined;
			const fenceReleased =
				queued !== undefined &&
				after.active?.runId === queued &&
				after.active.tag === "Starting" &&
				effects.some(
					({ effect }) => effect.kind === "start" && effect.runId === queued,
				);
			if (!fenceReleased)
				assert.deepEqual(
					after.active,
					before.active,
					"LI3: late Ended lifecycle changed active Run authority or liveness",
				);
			assert.equal(
				ended.length,
				0,
				"LI3: late Ended lifecycle emitted a terminal",
			);
			// Only the released Queued Run gets effects, never the Ended Run (12A).
			assert.equal(
				effects.filter(
					({ effect }) =>
						!fenceReleased || !("runId" in effect) || effect.runId !== queued,
				).length,
				0,
				"LI3: late Ended lifecycle issued an effect",
			);
		}
		if (retiredLifecycle) {
			assert.deepEqual(
				after.active,
				before.active,
				"3.4: lifecycle evidence on a retired or covered send changed Run state",
			);
			assert.equal(
				ended.length,
				0,
				"3.4: lifecycle evidence on a retired or covered send ended a Run",
			);
		}
		checked.push("LI3");
		if (replayed) {
			assert.deepEqual(
				after,
				replayed,
				"LI4: replay view differs from live view",
			);
			checked.push("LI4");
		}
		const destructive = effects.some(({ effect }) => isDestruction(effect));
		if (
			command.verb === "control" &&
			command.control.kind === "confirm_escalation" &&
			command.control.snapshotEntry === before.pendingConfirm?.snapshotEntry &&
			this.confirmVersions.get(command.control.snapshotEntry) ===
				this.taskVersion
		)
			this.confirmedSnapshot = {
				label: this.label,
				version: this.taskVersion,
			};
		if (destructive && (background === "unknown" || background.length > 0)) {
			assert.equal(
				this.confirmedSnapshot?.label,
				this.label,
				"LI5: destructive effect without confirmation of background work",
			);
			assert.equal(
				this.confirmedSnapshot?.version,
				this.taskVersion,
				"LI5: stale background snapshot confirmation",
			);
		}
		for (const { effect } of effects) {
			if (!isDestruction(effect)) continue;
			if (effect.runId !== null && this.provider === "opencode")
				// Every OpenCode send is L2 case 3: the current process's latest label, null when pending.
				assert.equal(
					effect.label === null ? undefined : runnerOf(effect.label),
					aliveAtIssue ? runnerOf(this.label) : undefined,
					"LI5: OpenCode destruction label is not its current process's, or null when pending (L2 case 3, wire label)",
				);
			else if (effect.runId !== null) {
				const runners = this.executionRunners(effect.runId);
				// A send of a Run whose start is pending is pending too (L2 case 2).
				if (effect.label === null)
					assert(
						runners.length === 0 || this.startPending(effect.runId),
						"LI5: destruction label is null after its Run's process was seen (D33)",
					);
				else if (runners.length > 0)
					assert(
						runners.includes(runnerOf(effect.label)),
						`LI5: destruction label ${effect.label} is not an execution label of its Run (D33)`,
					);
			} else if (this.alive)
				assert.equal(
					effect.label === null ? undefined : runnerOf(effect.label),
					runnerOf(this.label),
					"LI5: Run-less end_session does not act on the current process (D33)",
				);
		}
		if (
			command.verb === "control" &&
			command.control.kind === "confirm_escalation" &&
			command.control.snapshotEntry === before.pendingConfirm?.snapshotEntry &&
			destructive
		)
			assert.deepEqual(
				new Set(
					effects.flatMap(({ effect }) =>
						isDestruction(effect) && effect.label !== null
							? [effect.label]
							: [],
					),
				),
				new Set(before.pendingConfirm.labels),
				"LI5: confirm acted on labels other than the ones its pending confirm view names (L3, D29)",
			);
		// L5: each label is decided once, in the decision that first ends its scope: the label
		// becoming older (a newer querySeq or its runner's retirement, D44), or session_ended. Only
		// the serving process's tasks are known here; a pending destruction records nothing.
		const servingRunner = truth.processAlive ? runnerOf(oldLabel) : undefined;
		const scopeEnds = [
			...(servingRunner !== undefined &&
			command.verb === "settle" &&
			// session_ended decides the current latest label even after an earlier session end on an
			// older label; a repeat on a decided label is skipped below (L5).
			(command.settlement.kind === "session_ended" ||
				(command.settlement.kind === "process_lost" &&
					command.settlement.runnerId === servingRunner) ||
				(command.settlement.kind === "process_started" &&
					this.lostRunners.has(servingRunner)))
				? [{ label: oldLabel, tasks: truth.tasks }]
				: []),
			// D44: the serving label becomes older by a newer querySeq of its runner (a reattach or
			// a query replacement, 6.1).
			...(servingRunner !== undefined &&
			runnerOf(this.label) === servingRunner &&
			querySeqOf(this.label) > querySeqOf(oldLabel)
				? [{ label: oldLabel, tasks: truth.tasks }]
				: []),
		];
		const recorded = after.lostWork
			.slice(before.lostWork.length)
			.map(({ label }) => label);
		assert.equal(
			new Set(recorded).size,
			recorded.length,
			"LI5: lost work recorded twice for one label in one decision (L5)",
		);
		for (const label of recorded)
			assert(
				!this.decidedLabels.has(label),
				`LI5: lost work recorded again for already decided label ${label} (L5)`,
			);
		const decidedHere = new Set<string>();
		for (const { label, tasks } of scopeEnds) {
			if (this.decidedLabels.has(label) || decidedHere.has(label)) continue;
			decidedHere.add(label);
			if (tasks === "unknown" || tasks.length > 0)
				assert(
					recorded.includes(label),
					`LI5: scope end did not record lost work for ${label} (L5)`,
				);
			else
				assert(
					!recorded.includes(label),
					`LI5: lost work recorded for ${label}, Known to have no live task (L5, 8.3)`,
				);
		}
		for (const label of [...recorded, ...scopeEnds.map(({ label }) => label)])
			this.decidedLabels.add(label);
		if (
			after.pendingConfirm &&
			!this.confirmVersions.has(after.pendingConfirm.snapshotEntry)
		)
			this.confirmVersions.set(
				after.pendingConfirm.snapshotEntry,
				this.taskVersion,
			);
		checked.push("LI5");
		if (
			command.verb === "control" &&
			command.control.kind === "native_command" &&
			!this.requestedCommands.has(command.control.commandId)
		) {
			const id = command.control.commandId;
			assert(
				effects.some(
					({ effect }) =>
						effect.kind === "send_native_command" && effect.commandId === id,
				),
				"LI6: native command was not issued in its requesting decision",
			);
			this.requestedCommands.add(id);
		}
		if (refusedCommand)
			assert.deepEqual(
				after.nativeCommands.find(
					({ commandId }) => commandId === refusedCommand.commandId,
				),
				refusedCommand,
				"LI6: refused native command is not Failed with the outcome's code (D34)",
			);
		// 8.5: a native command whose latest try got not_sent shows Queued (H4).
		if (
			gatedCommand !== undefined &&
			command.verb === "observe" &&
			command.observation.tag === "Answer" &&
			command.observation.kind === "effect_outcome" &&
			command.observation.outcome.tag === "not_sent"
		)
			assert.equal(
				after.nativeCommands.find(({ commandId }) => commandId === gatedCommand)
					?.tag,
				"Queued",
				"LI6: a native command whose latest try got not_sent is not Queued (8.5, H4)",
			);
		checked.push("LI6");
		if (older) {
			// The release issues the waiting Run's start; that Run stays active, Queued or Interrupting.
			const waiting = before.active?.runId;
			const fenceRelease =
				olderWakeEnd &&
				waiting !== undefined &&
				after.active?.runId === waiting &&
				effects.some(
					({ effect }) => effect.kind === "start" && effect.runId === waiting,
				);
			// 3.3: a query ending covers its execution's interrupt sends. That label is those sends'
			// own, never older for them (LI7), so a queued Run may lose a covered send's fence; with
			// that wake's cleanup covered, D18 shows the Tombstone in its place. Nothing else may change.
			const ownLabel =
				command.verb === "observe" &&
				command.observation.tag === "Unsolicited" &&
				command.observation.kind === "query_ended"
					? command.observation.label
					: undefined;
			const ownCover =
				ownLabel !== undefined &&
				before.active?.tag === "Queued" &&
				before.live.some((effect) => {
					if (effect.tag !== "Main" || effect.effect.kind !== "interrupt")
						return false;
					const kept = after.live.some(
						(item) =>
							item.tag === "Main" &&
							item.commandId === effect.commandId &&
							item.effect.kind === "interrupt",
					);
					return (
						!kept &&
						this.bindingsFor(effect).some(({ send }) => {
							const covered =
								this.sends.get(send.token) ?? this.gatedTokens.get(send.token);
							return covered?.label === ownLabel;
						})
					);
				});
			const unblocked = (view: LedgerView): unknown =>
				ownCover && view.active
					? { ...view.active, deadline: undefined }
					: view.active;
			if (!fenceRelease)
				assert.deepEqual(
					unblocked(after),
					unblocked(before),
					"LI7: older-label evidence changed Run authority or liveness",
				);
			assert.deepEqual(
				after.tasks,
				before.tasks,
				"LI7: older-label evidence changed task liveness",
			);
			// 8.3: an older wake execution's Run-end evidence clears its liveness; LI8 checks the result.
			if (!olderWakeEnd)
				assert.equal(
					after.anythingMayAct,
					before.anythingMayAct,
					"LI7: older-label evidence changed session liveness",
				);
		}
		checked.push("LI7");
		this.issued(effects, this.label, aliveAtIssue);
		const current = this.groundTruth();
		if (!after.anythingMayAct) {
			assert.equal(
				current.runningTurn,
				false,
				"LI8: running native turn hidden by anythingMayAct",
			);
			// A probe only reads, so it never may act (8.3, D31); a stop_task's work is its task, ended
			// once the task view holds it neither live nor unknown (3.4, 3.5).
			const { tasks } = current;
			assert.deepEqual(
				current.unfinished.filter((token) => {
					const effect = this.sends.get(token)?.send.effect;
					return (
						effect?.kind !== "probe" &&
						!(
							effect?.kind === "stop_task" &&
							tasks !== "unknown" &&
							!tasks.some(
								({ key }) =>
									key.taskId === effect.key.taskId &&
									key.runId === effect.key.runId,
							)
						)
					);
				}),
				[],
				"LI8: unfinished native send hidden by anythingMayAct",
			);
			assert.notEqual(
				current.tasks,
				"unknown",
				"LI8: unknown native tasks hidden by anythingMayAct",
			);
			assert.equal(
				current.tasks.length,
				0,
				"LI8: live native tasks hidden by anythingMayAct",
			);
		}
		checked.push("LI8");
		if (
			command.verb === "observe" &&
			command.observation.tag === "Unsolicited" &&
			command.observation.kind === "turn_started" &&
			!older &&
			!before.active
		) {
			if (!seenWake) {
				assert.equal(
					after.active?.origin,
					"wake",
					"LI9: self-started turn did not create a wake Run",
				);
				assert(after.active, "LI9: wake Run missing");
				assert.equal(
					[...this.wakes.values()].includes(after.active.runId),
					false,
					"LI9: distinct self-started turns reused a wake Run",
				);
				this.wakes.set(
					`${command.observation.label}/${command.observation.eventId}`,
					after.active.runId,
				);
			} else
				assert.equal(
					after.active?.runId,
					undefined,
					"LI9: duplicate turn start created another wake Run",
				);
			assert.equal(
				effects.some(({ effect }) => effect.kind === "start"),
				false,
				"LI9: wake Run sent a start effect",
			);
		}
		checked.push("LI9");
		if (
			command.verb === "observe" &&
			command.observation.kind === "command_result"
		) {
			assert.equal(
				after.active?.runId,
				before.active?.runId,
				"LI10: zero-turn result started or ended a Run",
			);
			assert.equal(
				ended.length,
				0,
				"LI10: zero-turn result emitted a terminal",
			);
			assert.equal(
				effects.some(({ effect }) => effect.kind === "start"),
				false,
				"LI10: zero-turn result issued start",
			);
		}
		checked.push("LI10");
		this.lastAssertions = checked;
	}

	private select(
		snapshot: ProviderSnapshot,
		action: TraceAction,
	): Send | undefined {
		const known = snapshot.issued.map((issued) => this.bound(issued));
		for (const issued of snapshot.issued)
			if (issued.tag === "Main")
				for (const binding of this.bindingsFor(issued))
					if (!known.some((send) => send.token === binding.send.token))
						known.push(binding.send);
		const live = new Set(
			snapshot.view.live.flatMap((issued) =>
				issued.tag === "Tokened"
					? [issued.token]
					: this.bindingsFor(issued).map(({ send }) => send.token),
			),
		);
		const held = new Set(
			snapshot.view.live.flatMap((issued) =>
				this.isHeld(issued) ? [issued.commandId] : [],
			),
		);
		for (const [index, issued] of snapshot.issued.entries()) {
			if (this.isHeld(issued) && held.has(issued.commandId)) {
				const send = known[index];
				if (send) live.add(send.token);
			}
		}
		switch (action.selection) {
			case 0:
				return at(
					known.filter(({ token }) => live.has(token)),
					action.index,
				);
			case 1:
				return at(
					known.filter(({ token }) => !live.has(token)),
					action.index,
				);
			case 2:
				return at(
					known.slice(0, Math.max(1, Math.ceil(known.length / 4))),
					action.index,
				);
			case 3:
				return undefined;
			default:
				return at([...known].reverse(), action.index);
		}
	}
	private interaction(snapshot: ProviderSnapshot, index: number): string {
		return (
			at(snapshot.view.interactions, index)?.interactionId ??
			`question:${index % 5}`
		);
	}
	private queryEvidence(
		action: TraceAction,
		snapshot: ProviderSnapshot,
		now: number,
		send?: Send,
	): QueryEvidence {
		switch (action.variant % 55) {
			case 51:
			case 52:
			case 53:
			case 54: {
				const states = ["queued", "started", "completed", "cancelled"] as const;
				return {
					kind: "command_lifecycle",
					// D21: a lifecycle naming another hold's commandId is mismatched evidence.
					commandId:
						(action.input % 3 === 2
							? [...this.transmissions.keys()].find(
									(id) =>
										id !==
										this.holdBindings.get(send?.token ?? tokened("never"))
											?.commandId,
								)
							: this.holdBindings.get(send?.token ?? tokened("never"))
									?.commandId) ?? `never-issued:${action.input}`,
					state: states[(action.variant - 51) % 4] ?? "queued",
				};
			}
			case 0:
				return { kind: "started" };
			case 1:
				return action.input % 3 === 0
					? { kind: "input_accepted" }
					: {
							kind: "input_accepted",
							nativeMessageId: `native:${action.input}`,
						};
			case 2:
				return { kind: "input_declined", reason: "TraceDeclined" };
			case 3:
				return { kind: "activity" };
			case 4:
			case 5:
				return {
					kind: "interaction_requested",
					interactionId: `question:${action.input % 5}`,
					interactionKind:
						(action.variant + action.input) % 2 === 0
							? "question"
							: "permission",
				};
			case 6:
				return {
					kind: "interaction_resolved",
					interactionId: this.interaction(snapshot, action.index),
				};
			case 7:
				return { kind: "result", outcome: "completed" };
			case 8:
				return {
					kind: "result",
					outcome: "error",
					error: { code: "ActualFailure", retryable: action.input % 2 === 0 },
				};
			case 9:
				return { kind: "result", outcome: "interrupted" };
			case 10:
				return { kind: "query_ended" };
			case 11:
				return { kind: "accounting" };
			case 34:
				return {
					kind: "run_dispatched",
					runnerId: runnerOf(send ? this.labelFor(send) : this.label),
					...(this.holdBindings.get(send?.token ?? tokened("never")) ?? {
						runId: `never-issued-run:${action.input}`,
						commandId: `never-issued:${action.input}`,
						transmission: 1 + (action.index % 5),
					}),
				};
			case 35:
				return {
					kind: "run_released",
					reason: {
						tag: "Refused",
						why:
							(["exiting", "retiring", "interrupted"] as const)[
								action.index % 3
							] ?? "exiting",
					},
				};
			case 36:
				return { kind: "run_released", reason: "NotSent" };
			case 37:
				return { kind: "run_released", reason: "JournalAbsent" };
			case 38:
				return { kind: "run_released", reason: "ResumeRejected" };
			case 39:
				return { kind: "delivery_indeterminate" };
			case 40:
				return { kind: "runner_reply", outcome: { tag: "succeeded" } };
			case 41:
				return {
					kind: "runner_reply",
					outcome: { tag: "failed", code: "TraceRunnerFailure" },
				};
			case 42:
				return { kind: "journal_answer", answer: "running" };
			case 43:
				return { kind: "journal_answer", answer: "finished" };
			case 44:
				return { kind: "journal_answer", answer: "uncertain" };
			case 45:
				return { kind: "journal_answer", answer: "absent" };
			default:
				return outcome(action.variant, now);
		}
	}
	private task(action: TraceAction): TaskDescription {
		return {
			key: {
				taskId: `task:${action.input % 5}`,
				...(action.variant % 2 === 0
					? { runId: `native-run:${action.index}` }
					: {}),
			},
			taskType:
				[
					"local_bash",
					"local_agent",
					"local_workflow",
					"monitor",
					"mcp_task",
					"future_kind",
				][action.variant % 6] ?? "local_bash",
			description: `task ${action.input}`,
			ambient: action.variant % 7 === 0,
		};
	}
	private unsolicited(action: TraceAction, label: string): Observation {
		const base = {
			tag: "Unsolicited",
			label,
			eventId: this.eventId(),
		} as const;
		switch (action.variant % 51) {
			case 48:
				return { ...base, kind: "activity" };
			case 49:
				return action.input % 3 === 0
					? { ...base, kind: "result", outcome: "completed" }
					: action.input % 3 === 1
						? {
								...base,
								kind: "result",
								outcome: "error",
								error: { code: "UnsolicitedFailure", retryable: false },
							}
						: { ...base, kind: "result", outcome: "interrupted" };
			case 50:
				// 8.3: a Claude wake's own end is its turn_ended; any other provider's is Rejected (3.4).
				return action.input % 2 === 1
					? { ...base, kind: "turn_ended" }
					: { ...base, kind: "query_ended" };
			case 23:
			case 24:
			case 25:
			case 26:
			case 27: {
				const events = [
					"started",
					"completed",
					"failed",
					"killed",
					"notification",
				] as const;
				// Cursor and OpenCode report no tasks (8.2, 9): their task evidence is a Rejected-path
				// input (3.4), otherwise activity.
				return this.supportsTasks() || action.input % 4 === 3
					? {
							...base,
							kind: "task_event",
							key: this.task(action).key,
							event: events[(action.variant - 23) % 5] ?? "started",
						}
					: { ...base, kind: "activity" };
			}
			case 28:
				// 8.3: Cursor starts no unsolicited turn.
				if (this.provider === "cursor") return { ...base, kind: "activity" };
				return {
					...base,
					kind: "turn_started",
					...(action.input % 2 === 0 && this.supportsTasks()
						? { wakeTask: this.task(action).key }
						: {}),
				};
			case 29:
			case 30:
			case 31:
			case 32: {
				const states = ["queued", "started", "completed", "cancelled"] as const;
				const commandId = `command:${action.input}`;
				return {
					...base,
					kind: "command_lifecycle",
					// A provider reports lifecycle only for a command it received (8.5).
					commandId: this.commands.has(commandId)
						? commandId
						: `never-issued:${action.input}`,
					state: states[(action.variant - 29) % 4] ?? "queued",
				};
			}
			case 33:
				return {
					...base,
					kind: "command_result",
					commandId: this.commands.has(`command:${action.input}`)
						? `command:${action.input}`
						: `never-issued:${action.input}`,
				};
			default:
				if (!this.supportsTasks() && action.input % 4 !== 3)
					return { ...base, kind: "activity" };
				return {
					...base,
					kind: "tasks_snapshot",
					tasks:
						action.variant === 46
							? []
							: action.input % 3 === 0
								? [
										this.task(action),
										this.task({
											...action,
											input: action.input + 1,
											variant: action.variant + 1,
										}),
									]
								: [this.task(action)],
				};
		}
	}
	private observation(
		send: Send | undefined,
		snapshot: ProviderSnapshot,
		action: TraceAction,
		now: number,
	): Observation {
		const label =
			action.selection === 1
				? (at(this.labels.slice(0, -1), action.index) ?? this.label)
				: (this.sends.get(send?.token ?? tokened("never"))?.label ??
					this.label);
		if (
			(action.variant >= 22 && action.variant <= 33) ||
			action.variant === 46 ||
			(action.variant >= 48 && action.variant <= 50)
		)
			return this.unsolicited(action, label);
		const wire =
			send?.token ?? `never-issued:${this.provider}:${this.serial++}`;
		// 3.4: a control claim shows only at its outcome, which names its transmission, so its other
		// evidence follows the outcome (main's receipt); a repeat names the same transmission.
		// GAP (CONTRACT.md 460-461): provider evidence on a claim before main writes its outcome names a
		// token decide cannot know yet; nearest reading: the fake delivers the outcome first.
		const claimed = send && this.mainTransmissions.get(send.token);
		const delivered = send && this.controlOutcomes.get(send.token);
		const commandReceived =
			send?.effect.kind === "send_native_command" &&
			!this.refusedCommands.has(send.token) &&
			this.commands.has(send.effect.commandId);
		if (
			send &&
			claimed &&
			(delivered === undefined ||
				!(
					(send.effect.kind === "deliver_answer" && action.variant % 3 === 0) ||
					(commandReceived && (action.variant >= 51 || action.variant === 47))
				))
		) {
			const refused = this.refusedCommands.get(send.token);
			// 3.4: completed is succeeded, retryable_failed retryable with its retryAt and code, failed or
			// cancelled permanent. A refused command is refused; a received one is never refused (D34).
			const drawn =
				refused !== undefined
					? ({ tag: "permanent", code: refused } as const)
					: action.variant % 3 === 1
						? ({
								tag: "retryable",
								retryAt: now + (action.variant % 8 === 5 ? 100_000 : 100),
								code:
									send.effect.kind === "deliver_answer"
										? "answer_refused"
										: "TraceRetryable",
							} as const)
						: action.variant % 3 === 2 && !commandReceived
							? ({ tag: "permanent", code: "TracePermanent" } as const)
							: ({ tag: "succeeded" } as const);
			return {
				tag: "Answer",
				token: send.token,
				kind: "effect_outcome",
				outcome: delivered ?? drawn,
				transmission: claimed.name,
			};
		}
		if (action.variant >= 16 && action.variant <= 21)
			return {
				tag: "Answer",
				token: tokened(wire),
				...probe(action.variant - 16, action.input),
			};
		if (send?.effect.kind === "probe")
			return {
				tag: "Answer",
				token: tokened(wire),
				...outcome(action.variant, now),
			};
		if (send?.effect.kind === "deliver_answer")
			return {
				tag: "Answer",
				token: tokened(wire),
				...(action.variant % 3 === 0
					? ({
							kind: "interaction_resolved",
							interactionId: send.effect.interactionId,
						} as const)
					: outcome(action.variant, now)),
			};
		if (send?.effect.kind === "send_native_command") {
			const refused = this.refusedCommands.get(send.token);
			const commandId = send.effect.commandId;
			// 8.5: a received command answers its lifecycle and result on its own token; D21: some name
			// another command.
			const named =
				action.input % 3 === 2
					? ([...this.commands.keys()].find((id) => id !== commandId) ??
						`never-issued:${action.input}`)
					: commandId;
			if (refused === undefined && this.commands.has(commandId)) {
				const states = ["queued", "started", "completed", "cancelled"] as const;
				if (action.variant >= 51)
					return {
						tag: "Answer",
						token: tokened(wire),
						kind: "command_lifecycle",
						commandId: named,
						state: states[(action.variant - 51) % 4] ?? "queued",
					};
				if (action.variant === 47)
					return {
						tag: "Answer",
						token: tokened(wire),
						kind: "command_result",
						commandId: named,
					};
			}
			const answer = outcome(action.variant, now);
			return {
				tag: "Answer",
				token: tokened(wire),
				// A refused command answers its refusal; a received one cannot then be refused (3.4, D34).
				...(refused !== undefined
					? ({
							kind: "effect_outcome",
							outcome: { tag: "permanent", code: refused },
						} as const)
					: answer.outcome.tag === "permanent" &&
							this.commands.has(send.effect.commandId)
						? outcome(0, now)
						: answer),
			};
		}
		if (send && send.effect.kind !== "start" && send.effect.kind !== "steer") {
			const result = outcome(action.variant, now);
			switch (send.effect.kind) {
				case "interrupt":
					return {
						tag: "Answer",
						token: tokened(wire),
						...result,
					};
				case "end_session":
					return {
						tag: "Answer",
						token: tokened(wire),
						...result,
					};
				case "cancel_request":
					return {
						tag: "Answer",
						token: tokened(wire),
						...result,
					};
				case "stop_task":
					return {
						tag: "Answer",
						token: tokened(wire),
						...result,
					};
			}
		}
		const query = this.queryEvidence(action, snapshot, now, send);
		// 4.5, 4.11: a runner-held resume the provider rejected is released ResumeRejected; the
		// effect_outcome form stays for odd inputs, as evidence the oracle must also read.
		const drawn: QueryEvidence =
			query.kind === "effect_outcome" &&
			query.outcome.tag === "permanent" &&
			query.outcome.code === "native_resume_rejected" &&
			send?.effect.kind === "start" &&
			send.effect.mode === "resume" &&
			this.holdBindings.has(send.token) &&
			action.input % 2 === 0
				? { kind: "run_released", reason: "ResumeRejected" }
				: query;
		// The ledger binds a hold's token only at its run_dispatched (3.4), so any answer reads it first.
		const dispatched = send
			? this.dispatchFirst((n) => n.token === send.token)
			: undefined;
		// 4.5, 4.11: the provider rejects a resume at query start, so its release follows run.dispatched
		// (unless operation 5 delays that run.dispatched, which no later fact may overtake).
		if (
			dispatched &&
			action.operation !== 5 &&
			action.input % 4 === 1 &&
			send?.effect.kind === "start" &&
			send.effect.mode === "resume"
		)
			this.notifications.unshift({
				tag: "Answer",
				token: tokened(send.token),
				kind: "run_released",
				reason: "ResumeRejected",
			});
		if (dispatched) return dispatched;
		const native = send && this.sends.get(send.token);
		// G4 option B (11.2 LI2, 3.6, D52): a fact that unlaunched this try says it was never handed
		// over, so the host never answers it as received.
		const received = [
			"started",
			"input_accepted",
			"activity",
			"result",
			"accounting",
		].includes(drawn.kind);
		// A release is evidence the transmission was never received, so an accepted one is never released (1, 4.5).
		const evidence: QueryEvidence =
			send !== undefined && received && this.unlaunchedTries.has(send.token)
				? {
						kind: "effect_outcome",
						outcome: { tag: "not_sent", retryAt: now + 100 },
					}
				: drawn.kind === "run_released" &&
						(native?.accepted === true || native?.deliveryConfirmed === true)
					? { kind: "accounting" }
					: drawn;
		return send?.effect.kind === "steer"
			? { tag: "Answer", token: tokened(wire), ...evidence }
			: { tag: "Answer", token: tokened(wire), ...evidence };
	}

	/**
	 * Main's run seam (D60): this host plays main, which claims its inbox, dispatches each start and
	 * steer, starts and ends its runs. Runner-held: run_requested names the input's Run and the
	 * transmission is the hold's run.dispatched (3.4, 4.11); direct (OpenCode, `runsOpenCodeServer`):
	 * run_requested is the transmission, its token the runId. Each event has main's event id.
	 */
	private main(action: TraceAction): LedgerCommand {
		const alarm = {
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		} as const;
		const direct = this.provider === "opencode";
		const emit = (
			event: Extract<Observation, { tag: "Main" }>,
		): LedgerCommand => {
			this.mainEvents.push(event);
			return { verb: "observe", observation: event };
		};
		const dispatch = (
			runId: string,
			effect: Extract<RunEffect, { kind: "start" | "steer" }>,
			commandId = `main-command:${this.serial++}`,
		): IssuedEffect => {
			// 3.13: a direct start or steer is Main under its input's id; its token is the runId (3.4).
			const issue: IssuedEffect = {
				tag: "Main",
				commandId: direct ? effect.inputId : commandId,
				effect,
			};
			if (direct)
				this.mainSends.set(`${effect.inputId}\u0000${effect.kind}`, [
					{ token: tokened(runId), effect },
				]);
			const [send] = this.issued([issue]);
			assert(send);
			this.mainIssues.push({ issue, token: send.token });
			return issue;
		};
		const open = this.mainRun;
		// Main makes the first move it can, starting at the chosen one; with none, time passes.
		for (const offset of [0, 1, 2, 3, 4])
			switch ((action.variant + offset) % 5) {
				case 0: {
					// Main claims its inbox head: a start with no open run, else a steer into it; a queued
					// input waits for the open run's terminal (3.9). Its run.requested is appended in the
					// write that sends the input, after input.sent, never at admit (3.4).
					const head = this.mainInbox[0];
					if (!head || (open && head.delivery === "queue")) continue;
					this.mainInbox.shift();
					const runId = `main-run:${this.serial++}`;
					if (open) {
						dispatch(runId, {
							kind: "steer",
							runId: open.runId,
							inputId: head.inputId,
						});
						this.mainSteers.push({
							inputId: head.inputId,
							runId,
							parent: open.runId,
						});
					} else
						this.mainRun = {
							runId,
							inputId: head.inputId,
							started: false,
							stopped: false,
							issue: dispatch(runId, {
								kind: "start",
								runId,
								inputId: head.inputId,
								mode: this.processFacts.size > 0 ? "resume" : "fresh",
							}),
						};
					return emit({
						tag: "Main",
						eventId: `main:${this.serial++}`,
						kind: "run_requested",
						runId,
						inputId: head.inputId,
						direct,
					});
				}
				case 1: {
					// run.started joins a steer to its open parent, starts one that outlived it as its own
					// Run, or starts main's open run (3.9).
					const steer = this.mainSteers.shift();
					if (steer)
						return emit({
							tag: "Main",
							eventId: `main:${this.serial++}`,
							kind: "run_started",
							inputId: steer.inputId,
							requestedRunId:
								open?.runId === steer.parent ? steer.parent : steer.runId,
						});
					if (!open || open.started) continue;
					open.started = true;
					return emit({
						tag: "Main",
						eventId: `main:${this.serial++}`,
						kind: "run_started",
						inputId: open.inputId,
						requestedRunId: open.runId,
					});
				}
				case 2: {
					// Main's terminal follows native truth: a clean end completes, a permanent failure
					// errors, and OpenCode's stop with no confirming evidence is interrupted (L6, 3.9).
					if (!open) continue;
					const native = [...this.sends.values()]
						.reverse()
						.find(
							({ send }) =>
								send.effect.kind === "start" &&
								send.effect.runId === open.runId,
						);
					const stopped =
						open.stopped ||
						[...this.sends.values()].some(
							({ send }) =>
								send.effect.kind === "interrupt" &&
								(send.effect.runId === open.runId ||
									send.effect.runIds.includes(open.runId)),
						);
					// OpenCode's turn.error ends the turn and its query in one write: main's error terminal and the
					// start's query_ended fold back to back, in either order, and the Run ends once (3.4, 3.8 GAP 5).
					if (
						direct &&
						native &&
						!native.ended &&
						!this.unlaunchedTries.has(native.send.token) &&
						Math.floor(action.variant / 5) % 3 === 1
					) {
						this.mainRun = undefined;
						const ended: LedgerCommand = {
							verb: "observe",
							observation: {
								tag: "Answer",
								token: native.send.token,
								kind: "query_ended",
							},
						};
						const terminal = emit({
							tag: "Main",
							eventId: `main:${this.serial++}`,
							kind: "run_terminal",
							runId: open.runId,
							outcome: "error",
							code: "TraceTurnError",
						});
						const [first, second] =
							action.input % 2 === 0 ? [ended, terminal] : [terminal, ended];
						this.commit.push(second);
						return first;
					}
					// Nearest reading: main's interrupt ends its run interrupted; the fake does not wait for the runner's confirmation.
					// A failed reply also ends the send, so failure is read first; an unlaunched try never ran (D50).
					const terminal =
						native?.transportRank === 2
							? ({ outcome: "error", code: "TracePermanent" } as const)
							: native?.ended === true &&
									!this.unlaunchedTries.has(native.send.token)
								? ({ outcome: "completed" } as const)
								: !stopped
									? undefined
									: direct
										? ({
												outcome: "interrupted",
												code: "stop_unconfirmed",
											} as const)
										: ({ outcome: "interrupted" } as const);
					if (!terminal) continue;
					this.mainRun = undefined;
					return emit({
						tag: "Main",
						eventId: `main:${this.serial++}`,
						kind: "run_terminal",
						runId: open.runId,
						...terminal,
					});
				}
				case 3: {
					// Main relaunches its open run's unlaunched start (3.6, D50): runner-held, a new issue of the
					// same commandId whose transmission is its run.dispatched (4.8); direct, a fresh claim.
					const token = open && this.bound(open.issue).token;
					if (
						!open ||
						token === undefined ||
						!this.unlaunchedTries.has(token) ||
						open.issue.effect.kind !== "start"
					)
						continue;
					if (direct) {
						const runId = `main-run:${this.serial++}`;
						open.issue = dispatch(runId, { ...open.issue.effect, runId });
						return emit({
							tag: "Main",
							eventId: `main:${this.serial++}`,
							kind: "run_requested",
							runId,
							inputId: open.inputId,
							direct,
						});
					}
					open.issue = dispatch(
						open.runId,
						open.issue.effect,
						this.isHeld(open.issue) ? open.issue.commandId : undefined,
					);
					const held = this.bound(open.issue).token;
					const dispatched = this.dispatchFirst((n) => n.token === held);
					return dispatched
						? { verb: "observe", observation: dispatched }
						: alarm;
				}
				default: {
					// D60: a repeated main event id is Accepted with no events.
					const repeat = at(this.mainEvents, action.index);
					// A repeat is drawn, never a fallback for a move main could not make.
					if (!repeat || offset > 0) continue;
					return { verb: "observe", observation: repeat };
				}
			}
		return alarm;
	}
	/**
	 * A process event the host can produce (6.9 H1, H2; 6.1). While a runner serves: its loss (always
	 * next once it is killed), a duplicate, or its reattach on a newer query. Once none serves: the
	 * spawning runner's start, a spawn naming a fresh runner by run_dispatched, or a fresh runner,
	 * never a retired runnerId. Only `totality` starts another runner while one serves (L1).
	 */
	private processEvent(
		action: TraceAction,
		snapshot: ProviderSnapshot,
	): LedgerCommand {
		const serving = this.serving();
		const reattached = action.variant % 2 === 0;
		if (serving !== undefined && !(this.totality && action.variant % 3 === 0)) {
			if (
				action.variant % 4 === 3 ||
				(this.provider === "opencode" && action.variant % 4 !== 2)
			)
				return this.loss(serving, action.variant);
			const latest = this.latestQuerySeq.get(serving);
			if (
				this.provider !== "opencode" &&
				action.variant % 4 === 1 &&
				latest !== undefined &&
				latest >= 0
			)
				return this.replaceQuery(action, `${serving}:${latest + 1}`);
			const label =
				latest === undefined || latest < 0 || action.variant % 4 === 2
					? this.label
					: `${serving}:${latest + 1}`;
			return {
				verb: "settle",
				settlement: { kind: "process_started", label, reattached: true },
			};
		}
		// H4: a project not served spawns nothing; a spawn already under way finishes (3.11).
		if (this.gate !== "served" && this.spawning === undefined)
			return { verb: "settle", settlement: { kind: "alarm_fired" } };
		if (this.processFacts.size === 0)
			return {
				verb: "settle",
				settlement: { kind: "process_started", label: this.label, reattached },
			};
		if (this.spawning !== undefined)
			return {
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: `${this.spawning}:1`,
					reattached: false,
				},
			};
		const id = this.runnerSerial++;
		// The feeder parks while a runner still serves (4.4 Unserved{Some}); only a process_started
		// starts another runner then (L1 totality), never a spawn report (H3).
		const spawn =
			serving === undefined &&
			this.provider !== "opencode" &&
			action.variant % 5 === 4
				? [...this.pendingHeld].find(
						([, held]) =>
							held.effect.kind === "start" &&
							snapshot.view.live.some(
								(item) =>
									this.isHeld(item) && item.commandId === held.commandId,
							),
					)
				: undefined;
		const binding = spawn && this.holdBindings.get(spawn[0]);
		// 4.4, D49: a third of spawns fail before holdRun; the start is settled by its queue key.
		if (spawn && binding && Math.floor(action.variant / 5) % 3 === 2) {
			this.unhold(
				spawn[0],
				spawn[1],
				action.input % 3 === 0
					? { tag: "retryable", retryAt: snapshot.now + 1 + action.advance }
					: {
							tag: "permanent",
							code:
								action.input % 3 === 1 ? "StartLost" : "runner_start_failed",
						},
			);
			return (
				this.gateAnswer(snapshot.now) ?? {
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				}
			);
		}
		// REDESIGN r3-1: the host registers a fresh runner and dispatches a pending start to it
		// before its process_started (6.1, L2).
		if (spawn && binding) {
			const [token] = spawn;
			const runnerId = `host-${id}`;
			return {
				verb: "observe",
				observation: {
					tag: "Answer",
					token: tokened(token),
					kind: "run_dispatched",
					runnerId,
					...binding,
				},
			};
		}
		// OpenCode runnerIds contain ':' (9); an older host's label has no querySeq (3.3, L1).
		const label =
			this.provider === "opencode"
				? `opencode:${(0x5eed00 + id * 0x1f3).toString(16)}:0`
				: action.variant % 3 === 0
					? `legacy-${id}`
					: `host-${id}:1`;
		return {
			verb: "settle",
			settlement: { kind: "process_started", label, reattached },
		};
	}
	/**
	 * 6.1: the host replaces the serving query: it bumps querySeq with no process_started and
	 * stamps the newer label on its first frame. The replaced query's query_ended still arrives
	 * under its own label, answering its latest Run send, and covers that label's interrupt and
	 * close sends (3.3).
	 */
	private replaceQuery(action: TraceAction, label: string): LedgerCommand {
		const replaced = this.label;
		const send = [...this.sends.values()]
			.reverse()
			.find(
				(native) =>
					native.label === replaced &&
					!native.covered &&
					(native.send.effect.kind === "start" ||
						native.send.effect.kind === "steer"),
			);
		this.notifications.push(
			send === undefined
				? {
						tag: "Unsolicited",
						label: replaced,
						eventId: this.eventId(),
						kind: "query_ended",
					}
				: send.send.effect.kind === "start"
					? {
							tag: "Answer",
							token: tokened(send.send.token),
							kind: "query_ended",
						}
					: {
							tag: "Answer",
							token: tokened(send.send.token),
							kind: "query_ended",
						},
		);
		return {
			verb: "observe",
			observation: this.unsolicited(
				{
					...action,
					variant: this.supportsTasks()
						? ([0, 46, 48][action.index % 3] ?? 0)
						: 48,
				},
				label,
			),
		};
	}
	/** A send issued while pending and not yet resolved was never transmitted, so nothing answers it (L2, H3). */
	private untransmitted(send: Send | undefined): boolean {
		return (
			send !== undefined &&
			(this.unbound.has(send.token) ||
				this.gatedTokens.has(send.token) ||
				this.coveredHolds.has(send.token) ||
				this.pendingHeld.has(send.token) ||
				this.pendingNativeCommands.has(send.token) ||
				this.spawnHeld.has(send.token))
		);
	}

	next(action: TraceAction, snapshot: ProviderSnapshot): TracePacket {
		this.q28 = undefined;
		this.clock = snapshot.now;
		// A stop commit's facts fold in one transaction: nothing interleaves them (4.5).
		const committed = this.commit.shift();
		if (committed) return { command: committed, now: snapshot.now };
		if (
			snapshot.view.pendingConfirm &&
			!this.copiedConfirms.includes(snapshot.view.pendingConfirm.snapshotEntry)
		)
			this.copiedConfirms.push(snapshot.view.pendingConfirm.snapshotEntry);
		let now = snapshot.now + action.advance;
		const inputId = `input:${action.input}`;
		let command: LedgerCommand;
		// The removal's process_lost was not observed (a rejected step): the removal still finishes.
		if (this.removing) {
			this.setGate(this.removing.gate);
			this.removing = undefined;
		}
		// No frame precedes the first process_started (6.1, H1).
		const frame = [3, 4, 5, 13, 14, 15, 20, 21, 22, 26, 27].includes(
			action.operation,
		);
		const gateAdmit = this.gateAdmits > 0 && this.gate !== "served";
		this.gateAdmits = gateAdmit ? this.gateAdmits - 1 : 0;
		// An armed storm answers each queued gate answer and then fires the alarm that retries it, so one
		// send meets the gate many times; with nothing queued the trace goes on as drawn (4.8).
		const storming =
			!gateAdmit && this.gateStorm > 0 && this.gate === "not_served";
		const stormAnswer = storming ? this.gateAnswer(now) : undefined;
		const stormAlarm =
			storming && stormAnswer === undefined && this.stormAnswered;
		if (stormAnswer !== undefined || stormAlarm) this.gateStorm--;
		if (!gateAdmit) this.stormAnswered = stormAnswer !== undefined;
		switch (
			gateAdmit
				? 0
				: stormAnswer !== undefined || stormAlarm
					? -1
					: frame && this.processFacts.size === 0
						? 12
						: action.operation
		) {
			case -1:
				// The storm's alarm fires at the earliest deadline: the retry backs off (3.7).
				if (!stormAnswer && snapshot.alarmAt !== undefined)
					now = Math.max(now, snapshot.alarmAt);
				command = stormAnswer ?? {
					verb: "settle",
					settlement: { kind: "alarm_fired" },
				};
				break;
			case 0:
			case 1:
				// D58: main's handoff; a steer delivery is main's send into an open run (3.9).
				command = {
					verb: "admit",
					inputId,
					delivery: action.operation === 1 ? "steer" : "queue",
					request: { text: `text:${action.input}` },
				};
				break;
			case 2: {
				// L6: deadlineAt is the commit's stop.deadlineAt, null for a commit L6 does not fold.
				const deadlineAt = action.input % 3 === 0 ? null : now + 1_000;
				// 3.4: a Control's commandId names main's outbox row, unique per Control.
				const commandId = `control:${this.serial++}`;
				const controls = [
					{ kind: "stop", commandId, deadlineAt },
					{ kind: "end", commandId, deadlineAt },
					{ kind: "run_now", commandId, inputId, deadlineAt },
					{
						kind: "answer",
						commandId,
						interactionId: this.interaction(snapshot, action.index),
						answer: { allow: action.input % 2 === 0 },
					},
					{ kind: "stop_tasks", tasks: "all" },
					{
						kind: "confirm_escalation",
						snapshotEntry:
							snapshot.view.pendingConfirm?.snapshotEntry ?? action.index,
					},
					{
						kind: "native_command",
						commandId: `command:${action.input}`,
						text: "/goal clear",
					},
				] as const;
				command = {
					verb: "control",
					control: controls[action.variant % controls.length] ?? controls[0],
				};
				break;
			}
			case 3:
			case 4:
			case 5:
			case 20:
			case 27: {
				// Weighted toward D47 (round 12): operation 27 answers the start of an input Run a turn
				// joined, else of main's open run (D60), with Run-end evidence (declined, a result or a
				// query end); with neither it is operation 20.
				const active = snapshot.view.active;
				const target =
					action.operation !== 27
						? undefined
						: active?.origin === "input" &&
								this.executions.some((x) => x.runId === active.runId)
							? active.runId
							: this.mainRun?.runId;
				const joinedStart =
					target === undefined
						? undefined
						: [...this.sends.values()]
								.reverse()
								.find(
									({ send }) =>
										send.effect.kind === "start" &&
										send.effect.runId === target,
								)?.send;
				const drawn =
					joinedStart === undefined
						? action
						: {
								...action,
								selection: 0,
								variant: [2, 7, 8, 9, 10][action.variant % 5] ?? 7,
							};
				const selected = joinedStart ?? this.select(snapshot, drawn);
				const send = this.untransmitted(selected) ? undefined : selected;
				// G2: run_dispatched on a transmitted no-hold send is produced; bound-only metadata never is.
				if (
					drawn.variant === 34 &&
					(!send ||
						!this.sends.has(send.token) ||
						(!this.holdBindings.has(send.token) &&
							(drawn.input % 2 === 1 ||
								(send.effect.kind !== "start" &&
									send.effect.kind !== "steer"))))
				) {
					command = { verb: "settle", settlement: { kind: "alarm_fired" } };
					break;
				}
				command = {
					verb: "observe",
					observation: this.observation(send, snapshot, drawn, now),
				};
				// 4.5, 3.4: run.dispatched is a stream event read in order, never a delayed answer.
				if (
					action.operation === 5 &&
					command.observation.kind !== "run_dispatched"
				) {
					this.delayed.push(command);
					command = {
						verb: "observe",
						observation: {
							tag: "Answer",
							token: tokened(`never-issued:${this.serial++}`),
							kind: "activity",
						},
					};
				}
				break;
			}
			case 6:
				if (snapshot.alarmAt !== undefined) {
					if (action.variant % 4 === 0)
						now = Math.max(snapshot.now, snapshot.alarmAt);
					else if (action.variant % 4 === 1)
						now = Math.max(snapshot.now, snapshot.alarmAt - 1);
					else if (action.variant % 4 === 2)
						now = Math.max(now, snapshot.alarmAt + 100_000);
				}
				// 3.7: a clock going backwards never fires an alarm early or twice.
				if (action.variant % 8 === 7)
					now = Math.max(0, snapshot.now - 1 - action.advance);
				command = { verb: "settle", settlement: { kind: "alarm_fired" } };
				break;
			case 7:
			case 23:
				// The serving runner, a known non-current runner, the spawning runner, or none issued (L1).
				command = this.loss(
					action.selection === 3
						? "never-issued-host"
						: action.selection === 1
							? (at(
									[...this.processFacts]
										.map(runnerOf)
										.filter((runner) => runner !== this.serving()),
									action.index,
								) ?? runnerOf(this.label))
							: action.selection === 2 && this.spawning !== undefined
								? this.spawning
								: (this.serving() ?? this.spawning ?? runnerOf(this.label)),
					action.variant,
				);
				break;
			case 8:
				command = this.projectMacro(action);
				break;
			case 9: {
				// Even variants deliver host messages: 0 mod 4 a gate answer first, 2 mod 4 a notification first.
				const first =
					action.variant % 4 === 0 ? this.gateAnswer(now) : undefined;
				const notification =
					action.variant % 2 === 0 && !first
						? this.notifications.shift()
						: undefined;
				const gate =
					first ??
					(action.variant % 2 === 0 && !notification
						? this.gateAnswer(now)
						: undefined);
				command = gate ??
					(notification
						? { verb: "observe", observation: notification }
						: undefined) ??
					this.delayed.splice(
						action.index % Math.max(1, this.delayed.length),
						1,
					)[0] ?? { verb: "settle", settlement: { kind: "alarm_fired" } };
				break;
			}
			case 10:
				command = at(this.delivered, action.index) ?? {
					verb: "control",
					control: {
						kind: "stop",
						commandId: `control:${this.serial++}`,
						deadlineAt: now + 1_000,
					},
				};
				break;
			case 11:
				command = {
					verb: "control",
					control: {
						kind: "answer",
						commandId: `control:${this.serial++}`,
						interactionId: this.interaction(snapshot, action.index),
						answer: `answer:${action.input}`,
					},
				};
				break;
			case 12:
			case 19:
				command = this.processEvent(action, snapshot);
				break;
			case 13:
			case 14:
			case 15:
			case 21:
			case 22: {
				const variant =
					action.operation === 13
						? action.variant % 2 === 0
							? 22
							: 46
						: action.operation === 14
							? 23 + (action.variant % 5)
							: action.operation === 15
								? 28
								: action.operation === 21
									? 29 + (action.variant % 4)
									: 33;
				command = {
					verb: "observe",
					observation: this.unsolicited(
						{ ...action, variant },
						action.selection === 1
							? (at(this.labels.slice(0, -1), action.index) ?? this.label)
							: this.label,
					),
				};
				break;
			}
			case 16: {
				const texts = [
					"/goal clear",
					"/goal trace condition",
					"/goal pause",
					"/goal resume",
					"/opaque-native-command",
				];
				command = {
					verb: "control",
					control: {
						kind: "native_command",
						commandId: `command:${action.input}`,
						text: texts[action.variant % texts.length] ?? "/goal clear",
					},
				};
				break;
			}
			case 17:
				command = {
					verb: "control",
					control: {
						kind: "confirm_escalation",
						snapshotEntry:
							action.selection === 2 && this.copiedConfirms.length > 0
								? (at(this.copiedConfirms, action.index) ?? 0)
								: Math.max(
										0,
										(snapshot.view.pendingConfirm?.snapshotEntry ??
											action.index) -
											(action.variant % 2),
									),
					},
				};
				break;
			case 24: {
				const issue = at(
					snapshot.issued.filter((item) => this.isHeld(item)),
					action.index,
				);
				if (!issue) {
					command = {
						verb: "settle",
						settlement: {
							kind: "hold_exhausted",
							commandId: `never-issued:${action.input}`,
						},
					};
					break;
				}
				const held = { ...issue };
				const original = this.bindings.get(issue)?.send;
				// L2 case 2: the send follows its execution's start; pending with it, covered at issue
				// when that runner is retired, so the feeder transmits nothing (H3).
				const owner = this.ownerLabel(issue);
				const issueLabel =
					owner ?? (original ? this.labelFor(original) : this.label);
				// A run still held by a live runner is Busy, so holdRun binds no new transmission (4.3 step 2).
				const dropped =
					!snapshot.view.live.some(
						(item) => this.isHeld(item) && item.commandId === issue.commandId,
					) ||
					owner === null ||
					this.dead(runnerOf(issueLabel)) ||
					this.heldElsewhere(issue.commandId) ||
					this.retiredHolds.has(issue.commandId) ||
					this.terminals.has(heldRunId(issue));
				// 4.4: the re-step reads the gate before holdRun; a gated try transmits nothing.
				if (!dropped && this.gate !== "served") {
					this.gateAnswers.unshift({
						target: {
							tag: "Held",
							held: issue,
							runner: runnerOf(issueLabel),
						},
						removed: this.gate === "removed",
					});
					command = this.gateAnswer(now) ?? {
						verb: "settle",
						settlement: { kind: "alarm_fired" },
					};
					break;
				}
				if (dropped || !this.alive) {
					command = { verb: "settle", settlement: { kind: "alarm_fired" } };
					break;
				}
				// 4.4, D49: a try that fails before holdRun transmits nothing and is settled by its queue key.
				if (Math.floor(action.variant / 11) % 5 === 4) {
					this.gateAnswers.unshift({
						target: {
							tag: "Held",
							held: issue,
							runner: runnerOf(issueLabel),
						},
						removed: false,
						failure:
							action.input % 3 === 0
								? { tag: "retryable", retryAt: now + 1 + action.advance }
								: {
										tag: "permanent",
										code:
											action.input % 3 === 1
												? "StartLost"
												: "runner_start_failed",
									},
					});
					command = this.gateAnswer(now) ?? {
						verb: "settle",
						settlement: { kind: "alarm_fired" },
					};
					break;
				}
				const bound = this.holdRun(held);
				if (bound.tag === "Exhausted") {
					command = {
						verb: "settle",
						settlement: {
							kind: "hold_exhausted",
							commandId: this.heldElsewhere(issue.commandId)
								? `never-issued:${action.input}`
								: issue.commandId,
						},
					};
					break;
				}
				this.issued([held]);
				// 4.5, 4.11: the provider rejects a resume at query start, so its release follows run.dispatched.
				if (
					action.variant % 11 === 6 &&
					bound.send.effect.kind === "start" &&
					bound.send.effect.mode === "resume"
				)
					this.notifications.unshift({
						tag: "Answer",
						token: tokened(bound.send.token),
						kind: "run_released",
						reason: "ResumeRejected",
					});
				const base = {
					tag: "Answer",
					...this.dispatch(bound.send),
				} as const;
				command = {
					verb: "observe",
					observation:
						issue.effect.kind === "start"
							? { ...base, token: tokened(bound.send.token) }
							: { ...base, token: tokened(bound.send.token) },
				};
				break;
			}
			case 25: {
				const commandId = at(
					snapshot.issued.filter((item) => this.isHeld(item)),
					action.index,
				)?.commandId;
				// D49: an unheld outcome naming a Run that never issued that queue key.
				if (action.selection === 4) {
					command = {
						verb: "settle",
						settlement: {
							kind: "unheld_outcome",
							runId: `never-issued-run:${action.input}`,
							commandId: commandId ?? `never-issued:${action.input}`,
							outcome:
								action.variant % 3 === 0
									? { tag: "not_sent", retryAt: now }
									: action.variant % 3 === 1
										? { tag: "retryable", retryAt: now + 1 }
										: { tag: "permanent", code: "StartLost" },
						},
					};
					break;
				}
				command = {
					verb: "settle",
					settlement: {
						kind: "hold_exhausted",
						commandId:
							commandId === undefined || this.heldElsewhere(commandId)
								? `never-issued:${action.input}`
								: commandId,
					},
				};
				break;
			}
			case 28:
				command = this.main(action);
				break;
			case 26: {
				const previous = at(
					this.delivered.filter(
						(item) =>
							item.verb === "observe" && item.observation.tag === "Unsolicited",
					),
					action.index,
				);
				command =
					previous?.verb === "observe" &&
					previous.observation.tag === "Unsolicited"
						? {
								verb: "observe",
								observation: {
									...previous.observation,
									label: this.label,
								},
							}
						: {
								verb: "observe",
								observation: this.unsolicited(
									{ ...action, variant: 28 },
									this.label,
								),
							};
				break;
			}
			default:
				command = {
					verb: "control",
					control: {
						kind: "stop_tasks",
						tasks:
							action.variant % 3 === 0
								? "all"
								: action.variant % 3 === 1
									? [this.task(action).key]
									: [
											this.task(action).key,
											this.task({ ...action, input: action.input + 1 }).key,
										],
					},
				};
		}
		// H4: OpenCode, or a runner a mid-removal daemon death left alive (Q28), reports nothing for a
		// removed project but the refusals of its sends.
		if (
			(this.provider === "opencode" || this.survivor !== undefined) &&
			this.gate === "removed" &&
			((command.verb === "observe" &&
				!(
					command.observation.tag === "Answer" &&
					command.observation.kind === "effect_outcome" &&
					this.gatedTokens.has(command.observation.token)
				)) ||
				(command.verb === "settle" &&
					((command.settlement.kind === "process_lost" &&
						command.settlement.runnerId === this.survivor) ||
						(command.settlement.kind === "process_started" &&
							runnerOf(command.settlement.label) === this.survivor))))
		)
			command = { verb: "settle", settlement: { kind: "alarm_fired" } };
		// A gate answer is not replayed: a gated hold's settlement is keyed by commandId, so a replay
		// could name a later try (4.4).
		if (
			!isGateAnswer(command) &&
			(command.verb === "observe" || command.verb === "settle")
		)
			this.delivered.push(command);
		return { command, now };
	}
	/**
	 * H4 host macros (3.11): removal (its runner's process_lost first, then refusals), the gate's
	 * advance (removal finishing, a re-add's import window, served again), a not-served window, a
	 * Registering restart whose adopted runner starts a turn of its own, and session ends.
	 */
	private projectMacro(action: TraceAction): LedgerCommand {
		const alarm = {
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		} as const;
		switch (action.variant % 7) {
			case 0: {
				// The registry answers removed only once the removal finished (6.3); before that, not served.
				const gate: ProjectGate =
					Math.floor(action.variant / 7) % 2 === 0 ? "removed" : "not_served";
				const runner =
					this.provider === "opencode"
						? undefined
						: (this.serving() ?? this.spawning);
				// 4.4, Q28: the daemon died mid-removal after a config save, so it restarts removed and the
				// runner whose Stop never committed stays alive, unseen by the ledger.
				if (
					action.variant === 42 &&
					runner !== undefined &&
					!this.lostRunners.has(runner)
				) {
					this.setGate("removed");
					this.removalInProgress = false;
					this.survivor = runner;
					this.q28 = "survivor";
					return alarm;
				}
				const loss =
					runner === undefined || this.lostRunners.has(runner)
						? undefined
						: this.loss(runner, action.variant);
				// A pending run.dispatched is read first; the removal starts at a later step.
				if (loss?.verb === "observe") return loss;
				this.removalInProgress = gate === "not_served";
				if (Math.floor(action.variant / 14) % 2 === 1) this.gateAdmits = 2;
				if (runner === undefined || !loss) {
					this.setGate(gate);
					return alarm;
				}
				this.removing = { runner, gate };
				return loss;
			}
			case 1:
			case 2:
				this.setGate(
					this.removalInProgress
						? "removed"
						: this.gate === "removed"
							? "not_served"
							: "served",
				);
				return alarm;
			case 3:
				if (this.gate === "served") this.setGate("not_served");
				// 4.8 has no cap for not_sent: half the windows retry one send against the gate many times.
				if (Math.floor(action.variant / 7) % 2 === 1) {
					this.gateStorm = 20;
					this.stormAnswered = false;
				}
				if (Math.floor(action.variant / 14) % 2 === 1) this.gateAdmits = 2;
				return alarm;
			case 4: {
				if (this.gate === "served") this.setGate("not_served");
				const runner = this.serving();
				const latest =
					runner === undefined ? undefined : this.latestQuerySeq.get(runner);
				if (
					this.provider === "opencode" ||
					runner === undefined ||
					!this.alive ||
					this.dead(runner) ||
					latest === undefined ||
					latest < 0
				)
					return alarm;
				const label = `${runner}:${latest + 1}`;
				this.restartLabels.add(label);
				return {
					verb: "settle",
					settlement: { kind: "process_started", label, reattached: true },
				};
			}
			case 6: {
				// Q28: the daemon died while a runner kept the session alive. The new daemon adopts it,
				// releasing NotSent what its hello reports not_received (7.2), or, the runner having exited,
				// Settle reads its journal: Absent is released JournalAbsent, Present answers late (7.3).
				const runner = this.serving();
				const held = [...this.sends.values()].filter(
					(native) =>
						this.holdBindings.has(native.send.token) &&
						runnerOf(native.label) === runner &&
						!this.unbound.has(native.send.token) &&
						!native.covered,
				);
				// Only held sends give 7.3 a journal to read, so with some held the vanish third settles from it.
				const mode =
					Math.floor(action.variant / 7) % 3 === 0 && held.length > 0
						? 2
						: Math.floor(action.variant / 7) % 3;
				if (
					mode === 0 ||
					this.provider === "opencode" ||
					runner === undefined ||
					!this.alive ||
					this.dead(runner)
				)
					return {
						verb: "settle",
						settlement: {
							kind: "session_ended",
							cause: "native_session_vanished",
						},
					};
				if (mode === 1) {
					const notReceived = held.filter(
						(native) =>
							!native.accepted &&
							!native.deliveryConfirmed &&
							!native.notConsumed &&
							native.transportRank === 0,
					);
					if (notReceived.length > 0) this.q28 = "adopt";
					for (const { send } of notReceived)
						this.notifications.push(
							send.effect.kind === "start"
								? {
										tag: "Answer",
										token: tokened(send.token),
										kind: "run_released",
										reason: "NotSent",
									}
								: {
										tag: "Answer",
										token: tokened(send.token),
										kind: "run_released",
										reason: "NotSent",
									},
						);
					return {
						verb: "settle",
						settlement: {
							kind: "process_started",
							label: this.label,
							reattached: true,
						},
					};
				}
				// Variant 9 of a stop commit's releases: every candidate, JournalAbsent.
				const loss = this.loss(runner, 9);
				const releasing =
					loss.verb === "observe" && loss.observation.kind === "run_released";
				if (loss.verb !== "settle" && !releasing) return loss;
				const present = held.filter((native) => native.accepted);
				if (present.length > 0 || releasing) this.q28 = "journal";
				for (const { send } of present)
					this.notifications.push(
						send.effect.kind === "start"
							? {
									tag: "Answer",
									token: tokened(send.token),
									kind: "journal_answer",
									answer: action.input % 2 === 0 ? "running" : "finished",
								}
							: {
									tag: "Answer",
									token: tokened(send.token),
									kind: "journal_answer",
									answer: action.input % 2 === 0 ? "running" : "finished",
								},
					);
				return loss;
			}
			default:
				return {
					verb: "settle",
					settlement: {
						kind: "session_ended",
						cause: "native_session_vanished",
					},
				};
		}
	}
}
