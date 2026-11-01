/**
 * Reference oracle for the Run Ledger (82tn.32.2.3), built to CONTRACT.md 3.13 and the 32d model.
 * It is a plain interpreter: its entries are the decisions it accepted, and its state is the world
 * those entries fold to. Comments cite CONTRACT.md sections; `GAP:` marks a nearest reading.
 */
import type {
	ActiveRunView,
	Consumption,
	DecideContext,
	Decision,
	Evidence,
	InputState,
	InteractionView,
	InterruptBy,
	IssuedEffect,
	Label,
	LedgerCommand,
	LedgerView,
	LostWork,
	NativeCommandView,
	ProviderKind,
	RunEffect,
	RunEnded,
	RunOutcome,
	SendToken,
	Task,
	TaskKey,
	TasksView,
	Transport,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";

/** A deliberate contract break, so a scenario can prove it notices one. */
export type Mutation = "probe_at_outcome" | "extend_settle" | "unforced_alarm";

/** One accepted decision, replayed with the ids it minted (LI4). */
export interface ReferenceEntry {
	readonly command: LedgerCommand;
	readonly now: number;
	readonly policy: DecideContext["policy"];
	readonly ids: readonly string[];
}
export interface ReferenceState {
	readonly sessionId: string;
	readonly provider: ProviderKind;
	readonly mutation?: Mutation | undefined;
	readonly entries: readonly ReferenceEntry[];
}

type Value = "never" | "possibly" | "reached";
/** Why a transmission's work ended (3.5): its evidence, main's terminal (D59), coverage, a drop or the alarm. */
type WorkEnd =
	| "evidence"
	| "main"
	| "process_lost"
	| "session_ended"
	| "dropped"
	| "forced";

interface Tx {
	/** A control claim's token binds at its outcome, which names its transmission (3.4). */
	token?: SendToken | undefined;
	/** A control claim's transmission: its outbox row's attempt_count (3.4). */
	readonly n?: number | undefined;
	readonly seq: number;
	/** Its send's address, or the runner its run.dispatched names; null while pending (L2). */
	label: Label | null;
	runnerId: string | null;
	transport: Transport;
	consumption: Consumption;
	/** A runner-held try that ended before any hold (3.4): never handed over. */
	readonly unheld: boolean;
	notSent: boolean;
	released: boolean;
	resumeRejected: boolean;
	/** Stop's own outcome (4.8, 9): never retried, never fails an input. */
	stopOwn: boolean;
	retryable: boolean;
	/** A retryable outcome's code: an answer's lastRefusal (10B, 3.10). */
	refusal?: string | undefined;
	permanent?: string | undefined;
	retryAt?: number | undefined;
	declined: boolean;
	absent: boolean;
	sealed?: { readonly value: Value; readonly unconsumed: boolean } | undefined;
	ended?: WorkEnd | undefined;
	/** D59: main's terminal ended its Run, but this OpenCode abort or cancel_request stays a fence member (3101-3106). */
	mainEnded?: boolean | undefined;
	/** L1 item 1, 3.4: its coverage, recorded whatever its tries got, so after its work ended too (3.8 reason 2.3). */
	covered?: "process_lost" | "session_ended" | undefined;
	nativeMessageId?: string | undefined;
	resulted: boolean;
	/** The first delivery-recovery probe's deadline (3.7, D20). */
	recovery?: { readonly at: number; readonly opened: number } | undefined;
	/** An accounting receipt is recorded once; a duplicate produces no events (12A, LI2). */
	accounted?: true | undefined;
}

interface Probe {
	readonly target: Extract<RunEffect, { kind: "probe" }>["target"];
	readonly subject?: { readonly send: number; readonly tx: number } | undefined;
	deadline?: { at: number; readonly opened: number } | undefined;
	answered: boolean;
	busy: boolean;
	done: boolean;
}

interface Send {
	readonly seq: number;
	readonly effect: RunEffect;
	readonly held: boolean;
	commandId?: string | undefined;
	readonly runId: string | null;
	readonly exec: number;
	/** L2: addressed once, at issue; null while pending, then resolved once, never re-addressed. */
	runnerId: string | null;
	/** L2: the runner's latest label when the address is fixed; null while it has none. */
	label: Label | null;
	/** L2 case 2: a send of an execution whose start is pending resolves with that start. */
	readonly follows?: Send | undefined;
	/** L2, 3.6: a send of an execution an unlaunch dropped resolves no further. */
	dropped: boolean;
	readonly txs: Tx[];
	withdrawn: boolean;
	exhausted: boolean;
	probe?: Probe | undefined;
}

interface FoldItem {
	readonly seq: number;
	readonly outcome: RunOutcome;
	readonly code?: string | undefined;
	readonly retryable: boolean;
}

interface Exec {
	readonly n: number;
	evidence: boolean;
	activity: boolean;
	result: boolean;
	afterResult: boolean;
	endEvidence: boolean;
	endedBy?: "process_lost" | "session_ended" | "forced" | undefined;
	settle?: { at: number; readonly opened: number } | undefined;
	settleExpired: boolean;
	readonly fold: FoldItem[];
}

interface Run {
	readonly runId: string;
	readonly origin: "input" | "wake";
	readonly wakeTask?: TaskKey | undefined;
	readonly inputs: string[];
	phase: "Queued" | "Launched" | "Interrupting" | "Ended";
	by?: InterruptBy | undefined;
	asked: boolean;
	exec: Exec;
	retryAt?: number | undefined;
	readonly wakeLabels: Label[];
}

interface Input {
	readonly inputId: string;
	readonly delivery: "queue" | "steer";
	runId?: string | undefined;
	failed?: string | undefined;
	/** 3.9 (CONTRACT.md 975-980): its send's run, main's run.requested runId; a steer that outlives its Run becomes that Run. */
	reservation?: string | undefined;
}

interface Wake {
	readonly label: Label;
	/** 8.3 Wake Runs (CONTRACT.md 2837-2840): a repeat turn_started with no active Run re-arms it. */
	runId?: string | undefined;
	/** Its turn_started's decision; an end_session success covers only work before its issue (3.4). */
	readonly seq: number;
	ended?:
		| "result"
		| "own"
		| "process_lost"
		| "session_ended"
		| "forced"
		| undefined;
	outcome?: FoldItem | undefined;
	/** 8.3 (CONTRACT.md 2821-2824): older-label evidence cleared it without authority, so its Run stays. */
	older?: true | undefined;
}

interface Interaction {
	readonly interactionId: string;
	readonly kind: "permission" | "question";
	readonly label: Label;
	readonly opened: number;
	answer?: unknown | undefined;
	deliveries: number[];
	resolved: boolean;
}

interface NativeCommandRec {
	readonly commandId: string;
	readonly send: number;
	state:
		| "Sent"
		| "Started"
		| "Queued"
		| "Unconfirmed"
		| "Completed"
		| "Cancelled"
		| "Failed";
	code?: string | undefined;
	/** Time left while paused (8.5): the deadline resumes with it. */
	remaining: number;
	deadline?: { at: number; readonly opened: number } | undefined;
}

type TaskState =
	| { readonly tag: "Unknown"; readonly label: Label }
	| { readonly tag: "Known"; readonly label: Label; readonly tasks: Task[] };

interface Runner {
	latest: Label;
	retired: boolean;
	tasks: TaskState;
}

type StopItem =
	| { readonly tag: "tx"; readonly send: number; readonly tx: number }
	| { readonly tag: "wake"; readonly wake: number };

interface World {
	readonly sessionId: string;
	readonly provider: ProviderKind;
	readonly mutation?: Mutation | undefined;
	step: number;
	seq: number;
	readonly runs: Run[];
	readonly inputs: Map<string, Input>;
	readonly sends: Send[];
	readonly tokens: Map<string, { send: number; tx: number }>;
	/** `steer`: a joined steer's own run, not yet started; its end is the steer's, not its Run's (4.8). */
	readonly mainRuns: Map<
		string,
		{ runId: string; open: boolean; readonly steer?: true }
	>;
	readonly seen: Set<string>;
	/** The seq of the last session end or rejected resume (3.4). */
	freshSince: number;
	readonly runners: Map<string, Runner>;
	current: string | null;
	readonly retirements: Set<string>;
	/** Oracle edit (32.2.8), L1 (CONTRACT.md 349-350): runners retired before their process_started. */
	readonly retiredUnstarted: Set<string>;
	readonly wakes: Wake[];
	readonly interactions: Interaction[];
	readonly nativeCommands: NativeCommandRec[];
	readonly lostWork: LostWork[];
	readonly lostDecided: Set<Label>;
	stop?:
		| { readonly at: number; readonly opened: number; items: StopItem[] }
		| undefined;
	confirm?:
		| {
				readonly step: "retire" | "end_session";
				readonly runId?: string | undefined;
				readonly commandId?: string | undefined;
		  }
		| undefined;
	snapshotEntry: number;
	lastNotified?: TaskKey | undefined;
}

interface Step {
	readonly now: number;
	readonly policy: DecideContext["policy"];
	readonly newId: () => string;
	readonly effects: IssuedEffect[];
	readonly ended: RunEnded[];
}

type Outcome =
	| { readonly tag: "Rejected"; readonly diagnostic: string }
	| { readonly tag: "Noop"; readonly diagnostic?: string | undefined }
	| { readonly tag: "Changed"; readonly diagnostic?: string | undefined };

const changed: Outcome = { tag: "Changed" };
const noop = (diagnostic?: string): Outcome => ({ tag: "Noop", diagnostic });
const rejected = (diagnostic: string): Outcome => ({
	tag: "Rejected",
	diagnostic,
});

const transportRank = {
	Issued: 0,
	Retrying: 1,
	Failed: 2,
	Unknown: 3,
	Sent: 4,
} as const;
const consumptionRank = {
	None: 0,
	NotConsumed: 1,
	Observed: 2,
	Accepted: 3,
} as const;

/** 3.5: each chain merges by join (maximum). */
function joinTransport(a: Transport, b: Transport): Transport {
	if (a.tag === "Retrying" && b.tag === "Retrying")
		return { tag: "Retrying", at: Math.min(a.at, b.at) };
	if (a.tag === "Failed" && b.tag === "Failed")
		return { tag: "Failed", code: a.code < b.code ? a.code : b.code };
	return transportRank[b.tag] > transportRank[a.tag] ? b : a;
}
function joinConsumption(a: Consumption, b: Consumption): Consumption {
	if (a.tag === "NotConsumed" && b.tag === "NotConsumed")
		return a.why < b.why ? a : b;
	return consumptionRank[b.tag] > consumptionRank[a.tag] ? b : a;
}

/** L1 (CONTRACT 344-345): the split is at the last `:` when a decimal querySeq follows; otherwise the whole label is the runnerId. */
function splitLabel(label: Label): { runnerId: string; querySeq: number } {
	const match = /^(.*):(\d+)$/.exec(label);
	return match
		? { runnerId: match[1] ?? label, querySeq: Number(match[2]) }
		: { runnerId: label, querySeq: 0 };
}

const reportsTasks = (provider: ProviderKind) =>
	provider === "claude" || provider === "codex";

/** Section 9 fence members: start and steer; OpenCode adds cancel_request and its abort. */
const fenceMember = (provider: ProviderKind, kind: RunEffect["kind"]) =>
	kind === "start" ||
	kind === "steer" ||
	(provider === "opencode" &&
		(kind === "interrupt" || kind === "cancel_request"));

/** 3.6: the reached test. */
function value(tx: Tx): Value {
	if (tx.consumption.tag === "Observed" || tx.consumption.tag === "Accepted")
		return "reached";
	if (tx.unheld || tx.notSent || tx.released || tx.resumeRejected)
		return "never";
	return "possibly";
}
function unconsumed(tx: Tx): boolean {
	if (value(tx) !== "possibly") return false;
	if (tx.consumption.tag === "NotConsumed")
		return tx.consumption.why !== "released";
	return tx.retryable || tx.permanent !== undefined;
}
/** D52: a transmission is sealed at its first closing fact, reading its value then (A.18 T4: the Seal row's one writer). */
function seal(
	tx: Tx,
	sealed: NonNullable<Tx["sealed"]> = {
		value: value(tx),
		unconsumed: unconsumed(tx),
	},
): void {
	tx.sealed ??= sealed;
}
/** 3.5, 8.3: a transmission's or wake execution's work ends at its first ending fact (A.18 T4: the Label work and Wake execution rows' one writer). */
function endWork<End extends string>(
	work: { ended?: End | undefined },
	why: NoInfer<End>,
): void {
	work.ended ??= why;
}
/** 3.10: an interaction resolves once (A.18 T4: the Interaction row's one writer). */
function resolveInteraction(interaction: Interaction): void {
	interaction.resolved = true;
}
const sealedValue = (tx: Tx): Value => tx.sealed?.value ?? value(tx);

function findRun(world: World, runId: string | null | undefined) {
	return runId === null || runId === undefined
		? undefined
		: world.runs.find((run) => run.runId === runId);
}

function workEnded(world: World, send: Send, tx: Tx): boolean {
	if (tx.ended !== undefined) return true;
	const effect = send.effect;
	switch (effect.kind) {
		case "interrupt":
			// D59: a runner provider's interrupt is no member; it ends with the Runs it names, at once with none.
			if (world.provider !== "opencode")
				return findRun(world, effect.runId)?.phase !== "Interrupting";
			return false;
		case "deliver_answer":
			return (
				world.interactions.find(
					(item) => item.interactionId === effect.interactionId,
				)?.resolved ?? true
			);
		case "stop_task": {
			// 3.5, 8.4: a stop_task's work is its task.
			const tasks = taskView(world);
			return !(
				tasks.tag === "unknown" ||
				(tasks.tag === "live" &&
					tasks.tasks.some((task) => sameKey(task.key, effect.key)))
			);
		}
		case "send_native_command": {
			const command = world.nativeCommands.find(
				(item) => item.commandId === effect.commandId,
			);
			return (
				command === undefined ||
				["Completed", "Cancelled", "Failed"].includes(command.state)
			);
		}
		case "probe":
			return true;
		default:
			return false;
	}
}

/** 3.5 mayStillAct; a probe only reads, so it never may act (8.3, D31). */
function mayStillAct(world: World, send: Send, tx: Tx): boolean {
	if (workEnded(world, send, tx)) return false;
	switch (tx.consumption.tag) {
		case "Accepted":
		case "Observed":
			return true;
		case "NotConsumed":
			return false;
		case "None":
			return tx.transport.tag !== "Retrying" && tx.transport.tag !== "Failed";
	}
}

const sameKey = (a: TaskKey, b: TaskKey) =>
	a.taskId === b.taskId && a.runId === b.runId;

function taskView(world: World): TasksView {
	const runner =
		world.current === null ? undefined : world.runners.get(world.current);
	if (runner === undefined || !reportsTasks(world.provider))
		return { tag: "none" };
	if (runner.tasks.tag === "Unknown" || runner.tasks.label !== runner.latest)
		return { tag: "unknown", label: runner.latest };
	return runner.tasks.tasks.length === 0
		? { tag: "none" }
		: { tag: "live", label: runner.latest, tasks: runner.tasks.tasks };
}

function labelWorkOutstanding(world: World): boolean {
	return (
		world.wakes.some((wake) => wake.ended === undefined) ||
		world.sends.some(
			(send) =>
				fenceMember(world.provider, send.effect.kind) &&
				send.txs.some((tx) => mayStillAct(world, send, tx)),
		)
	);
}

/** 3.6: a send with no transmission is sealed once a try ended before transmitting or its Run was asked. */
function sendSealed(run: Run, send: Send): boolean {
	const latest = send.txs.at(-1);
	return latest === undefined ? run.asked : latest.sealed !== undefined;
}
function sendValue(send: Send): Value {
	const values = send.txs.map(sealedValue);
	return values.includes("reached")
		? "reached"
		: values.includes("possibly")
			? "possibly"
			: "never";
}
function sendUnconsumed(send: Send): boolean {
	return (
		sendValue(send) === "possibly" &&
		send.txs
			.filter((tx) => sealedValue(tx) === "possibly")
			.every((tx) => tx.sealed?.unconsumed ?? unconsumed(tx))
	);
}

const runSends = (world: World, run: Run) =>
	world.sends.filter(
		(send) => send.runId === run.runId && send.exec === run.exec.n,
	);
const deliverySends = (world: World, run: Run) =>
	runSends(world, run).filter(
		(send) => send.effect.kind === "start" || send.effect.kind === "steer",
	);

/** 3.6 D50: Launched with every start and steer never handed over, and no execution evidence. */
function notYetDelivered(world: World, run: Run): boolean {
	return (
		run.phase === "Queued" ||
		(!run.exec.evidence &&
			deliverySends(world, run).every((send) => sendValue(send) === "never"))
	);
}

/** 3.6 retry pending: from a retrying outcome until its next transmission, an acceptance, Stop or the Run's end. */
function retryPending(world: World, run: Run, send: Send): boolean {
	const latest = send.txs.at(-1);
	if (
		latest === undefined ||
		run.asked ||
		send.withdrawn ||
		send.exhausted ||
		latest.sealed === undefined ||
		(latest.ended !== undefined && latest.ended !== "evidence") ||
		latest.mainEnded ||
		latest.resumeRejected ||
		latest.stopOwn ||
		send.txs.some((tx) => tx.consumption.tag === "Accepted") ||
		notYetDelivered(world, run)
	)
		return false;
	return (
		latest.notSent ||
		latest.unheld ||
		latest.released ||
		(latest.declined && send.effect.kind === "start") ||
		latest.absent ||
		(latest.retryable && latest.consumption.tag === "None")
	);
}

/** Sends a Run's end waits for (3.8 condition 2); a runner provider's interrupt ends with its Run (D59). */
const runWork = (world: World, run: Run) =>
	runSends(world, run).filter(
		(send) =>
			send.effect.kind !== "probe" &&
			send.effect.kind !== "deliver_answer" &&
			send.effect.kind !== "end_session" &&
			(world.provider === "opencode" || send.effect.kind !== "interrupt"),
	);

/** 3.8 condition 2. */
function nothingMayAct(world: World, run: Run): boolean {
	const work = runWork(world, run);
	return (
		deliverySends(world, run).every((send) => sendSealed(run, send)) &&
		work.every(
			(send) =>
				!send.txs.some((tx) => !tx.mainEnded && mayStillAct(world, send, tx)) &&
				!retryPending(world, run, send),
		) &&
		!(
			run.exec.evidence &&
			!run.exec.endEvidence &&
			run.exec.endedBy === undefined
		)
	);
}

/** 3.8 outcome fold (5C, 10A): failure beats success, specific beats generic, completion beats an interrupt. */
function fold(
	items: readonly FoldItem[],
	asked: boolean,
): Pick<RunEnded, "outcome" | "reason"> {
	const failures = items
		.filter((item) => item.outcome === "error")
		.sort(
			(a, b) =>
				Number(a.code === undefined) - Number(b.code === undefined) ||
				a.seq - b.seq ||
				(a.code ?? "").localeCompare(b.code ?? ""),
		);
	const failure = failures[0];
	if (failure !== undefined)
		return {
			outcome: "error",
			reason: {
				tag: "provider_error",
				code: failure.code ?? "provider_error",
				retryable: failure.retryable,
			},
		};
	if (items.some((item) => item.outcome === "completed"))
		return { outcome: "completed", reason: { tag: "completed" } };
	// 3.8 condition 2.4: main's terminal is in the fold (run_terminal, `error` as provider_error, not
	// retryable); with neither it nor a result (a wake Run, 8.3) the end reads completed. Asked keeps
	// condition 1's interrupt fallback.
	return asked || items.some((item) => item.outcome === "interrupted")
		? { outcome: "interrupted", reason: { tag: "interrupted", forced: false } }
		: { outcome: "completed", reason: { tag: "completed" } };
}

/** 3.8 5C: delivery_unknown with no later proof is a failure coded delivery_indeterminate. */
function foldItems(world: World, run: Run): FoldItem[] {
	return [
		...run.exec.fold,
		...deliverySends(world, run).flatMap((send) =>
			send.txs
				.filter(
					(tx) =>
						tx.transport.tag === "Unknown" &&
						consumptionRank[tx.consumption.tag] < 2 &&
						!tx.resulted,
				)
				.map(
					(tx): FoldItem => ({
						seq: tx.seq,
						outcome: "error",
						code: "delivery_indeterminate",
						retryable: false,
					}),
				),
		),
	];
}

function endRun(
	world: World,
	step: Step,
	run: Run,
	ended: Pick<RunEnded, "outcome" | "reason">,
): void {
	run.phase = "Ended";
	run.retryAt = undefined;
	run.exec.settle = undefined;
	step.ended.push({ runId: run.runId, ...ended });
	if (world.confirm?.runId === run.runId) world.confirm = undefined;
}

/** The first specific permanent code, or the cap (3.8 reason 2.2, 4.3). */
function refusal(world: World, run: Run): string | undefined {
	const sends = deliverySends(world, run);
	if (sends.some((send) => send.exhausted))
		return "provider_send_attempts_exhausted";
	return sends
		.flatMap((send) => send.txs)
		.filter((tx) => tx.permanent !== undefined && !tx.resumeRejected)
		.sort((a, b) => a.seq - b.seq)[0]?.permanent;
}

function wakeEnd(
	world: World,
	run: Run,
): Pick<RunEnded, "outcome" | "reason"> | undefined {
	const latest = run.wakeLabels.at(-1);
	const wake = [...world.wakes]
		.reverse()
		.find((item) => item.label === latest && item.runId === run.runId);
	if (wake?.ended === undefined || wake.older) return undefined;
	switch (wake.ended) {
		case "process_lost":
		case "session_ended":
			return { outcome: "error", reason: { tag: wake.ended } };
		case "forced":
			return {
				outcome: "interrupted",
				reason: {
					tag: "interrupted",
					forced: world.mutation !== "unforced_alarm",
				},
			};
		default:
			return fold(wake.outcome === undefined ? [] : [wake.outcome], run.asked);
	}
}

/** 3.8: the one Run-end rule, with 3.6's unlaunch, to a fixpoint, then advance. */
function reconcile(world: World, step: Step): void {
	for (let moved = true; moved; ) {
		const phases = world.runs.map((run) => run.phase).join();
		for (const run of world.runs) {
			if (run.phase === "Ended") continue;
			if (run.phase === "Queued") {
				if (run.asked) {
					endRun(world, step, run, {
						outcome: "interrupted",
						reason: { tag: "interrupted", forced: false },
					});
				}
				continue;
			}
			if (run.origin === "wake") {
				const ended = wakeEnd(world, run);
				if (ended !== undefined) endRun(world, step, run, ended);
				continue;
			}
			// 3.8 GAP 5: a Run with a main run and no result ends only once main's terminal folded,
			// unless 2.1 to 2.3 applies, so OpenCode's query_ended and turn.error fold either order.
			const mains = [...world.mainRuns.values()].filter(
				(main) => main.runId === run.runId,
			);
			const awaiting =
				!run.exec.result &&
				mains.length > 0 &&
				mains.every((main) => main.open);
			if (run.exec.endEvidence && !awaiting) {
				endRun(world, step, run, fold(foldItems(world, run), run.asked));
				continue;
			}
			if (!nothingMayAct(world, run)) continue;
			const sends = deliverySends(world, run);
			const code = refusal(world, run);
			if (notYetDelivered(world, run) && !run.asked) {
				if (code !== undefined) {
					endRun(world, step, run, {
						outcome: "error",
						reason: { tag: "refused", code },
					});
					continue;
				}
				// 3.6 D50: unlaunch back to Queued; the execution's sends are dropped.
				for (const send of sends)
					for (const tx of send.txs) endWork(tx, "dropped");
				for (const send of runSends(world, run)) send.dropped = true;
				run.retryAt = sends.flatMap((send) => send.txs).at(-1)?.retryAt;
				run.phase = "Queued";
				if (sends.some((send) => send.txs.some((tx) => tx.resumeRejected)))
					world.freshSince = world.seq;
				continue;
			}
			const covered = sends
				.flatMap((send) => send.txs)
				.filter(
					(tx) => sealedValue(tx) !== "never" && tx.covered !== undefined,
				);
			const firstCode = fold(foldItems(world, run), false);
			if (
				run.asked ||
				sends.some((send) =>
					send.txs.some(
						(tx) =>
							tx.consumption.tag === "NotConsumed" &&
							tx.consumption.why === "cancelled",
					),
				)
			) {
				const forced = runWork(world, run).some((send) =>
					send.txs.some((tx) => tx.ended === "forced"),
				);
				endRun(world, step, run, {
					outcome: "interrupted",
					reason: {
						tag: "interrupted",
						forced: forced && world.mutation !== "unforced_alarm",
					},
				});
			} else if (
				code !== undefined &&
				sends.every(
					(send) => sendValue(send) === "never" || sendUnconsumed(send),
				)
			)
				endRun(world, step, run, {
					outcome: "error",
					reason: { tag: "refused", code },
				});
			else if (covered.length > 0 || run.exec.endedBy !== undefined) {
				const cause =
					covered.some((tx) => tx.covered === "session_ended") ||
					run.exec.endedBy === "session_ended"
						? "session_ended"
						: "process_lost";
				endRun(world, step, run, {
					outcome: "error",
					reason:
						firstCode.reason.tag === "provider_error"
							? { tag: cause, code: firstCode.reason.code }
							: { tag: cause },
				});
			} else if (!awaiting)
				endRun(world, step, run, fold(foldItems(world, run), run.asked));
		}
		moved = world.runs.map((run) => run.phase).join() !== phases;
	}
	// 8.4: a gate releases once the tasks it reads are neither live nor unknown.
	if (world.confirm !== undefined && taskView(world).tag === "none") {
		const gate = world.confirm;
		world.confirm = undefined;
		if (gate.step === "end_session" && gate.commandId !== undefined)
			foldEndSession(world, gate.runId ?? null, gate.commandId);
	}
}

/** 3.4: a user Run's id is main's, the runId of the run.requested that reserves it. */
function reserve(world: World, runId: string, inputId: string): Run {
	const run: Run = {
		runId,
		origin: "input",
		inputs: [inputId],
		phase: "Queued",
		asked: false,
		exec: newExec(0),
		wakeLabels: [],
	};
	world.runs.push(run);
	const input = world.inputs.get(inputId);
	if (input !== undefined) input.runId = run.runId;
	return run;
}

const newExec = (n: number): Exec => ({
	n,
	evidence: false,
	activity: false,
	result: false,
	afterResult: false,
	endEvidence: false,
	settleExpired: false,
	fold: [],
});

function launch(run: Run): void {
	run.phase = "Launched";
	run.retryAt = undefined;
	run.exec = newExec(run.exec.n + 1);
}

function currentLabel(world: World): Label | null {
	return world.current === null
		? null
		: (world.runners.get(world.current)?.latest ?? null);
}

/**
 * L2: a send's address at issue. Case 2: a send for a Run or wake Run with an execution, on a
 * runner-host provider, goes to that execution's runner, pending while its start is. Case 3:
 * every other send (every OpenCode send) goes to the current process, or pending with none.
 */
function addressAt(
	world: World,
	runId: string | null,
): Pick<Send, "runnerId" | "label" | "follows"> {
	const run = findRun(world, runId);
	if (
		run !== undefined &&
		run.phase !== "Queued" &&
		world.provider !== "opencode"
	) {
		const wake = run.wakeLabels.at(-1);
		const start = runSends(world, run).find(
			(send) => send.effect.kind === "start" && !send.dropped,
		);
		const runnerId =
			wake === undefined ? start?.runnerId : splitLabel(wake).runnerId;
		if (start !== undefined && runnerId === null)
			return { runnerId: null, label: null, follows: start };
		if (runnerId !== undefined && runnerId !== null)
			return {
				runnerId,
				label: world.runners.get(runnerId)?.latest ?? null,
			};
	}
	return { runnerId: world.current, label: currentLabel(world) };
}

function issue(world: World, effect: RunEffect, held: boolean): Send {
	const runId = "runId" in effect ? effect.runId : null;
	const run = findRun(world, runId);
	const send: Send = {
		seq: world.seq++,
		effect,
		held,
		runId: run?.runId ?? null,
		exec: run?.exec.n ?? 0,
		...addressAt(world, runId),
		dropped: false,
		txs: [],
		withdrawn: false,
		exhausted: false,
	};
	world.sends.push(send);
	// L1 item 1, L2: a held send addressed to a retired runner is covered at issue, never handed over.
	if (held && send.runnerId !== null && isRetired(world, send.runnerId))
		seal(transmit(world, send, undefined), {
			value: "never",
			unconsumed: false,
		});
	return send;
}

function transmit(
	world: World,
	send: Send,
	token: SendToken | undefined,
	runnerId: string | null = send.runnerId,
	label: Label | null = send.label,
): Tx {
	const tx: Tx = {
		token,
		seq: world.seq++,
		label,
		runnerId,
		transport: { tag: "Issued" },
		consumption: { tag: "None" },
		unheld: token === undefined && send.held,
		// 3.4 (CONTRACT.md 449-455): a control's claims count per row, n from 1; each row is its own
		// issue under its own commandId.
		n:
			token === undefined && !send.held
				? 1 + Math.max(0, ...send.txs.map((claim) => claim.n ?? 0))
				: undefined,
		notSent: false,
		released: false,
		resumeRejected: false,
		stopOwn: false,
		retryable: false,
		declined: false,
		absent: false,
		resulted: false,
	};
	send.txs.push(tx);
	// L1 item 1, L2: a transmission to a retired address is covered at once, a reclaim's included.
	if (runnerId !== null && isRetired(world, runnerId)) {
		seal(tx);
		tx.covered ??= "process_lost";
		endWork(tx, "process_lost");
	}
	if (token !== undefined)
		world.tokens.set(token, {
			send: world.sends.indexOf(send),
			tx: send.txs.length - 1,
		});
	return tx;
}

/** probe, stop_task or cancel_request: decide's, Tokened, its token from ctx.newId (3.12, 3.13). */
function fold1(
	world: World,
	step: Step,
	effect: Extract<
		RunEffect,
		{ kind: "probe" | "stop_task" | "cancel_request" }
	>,
): Send {
	const send = issue(world, effect, false);
	const token = step.newId() as SendToken;
	transmit(world, send, token);
	step.effects.push({ tag: "Tokened", token, effect });
	return send;
}

/**
 * 3.4: an effect main issues with no hold, under its Control's commandId; its first claim is open,
 * named only at its outcome, and may act until then (3.5).
 */
function issueControl(
	world: World,
	effect: RunEffect,
	commandId: string,
): Send {
	const send = issue(world, effect, false);
	send.commandId = commandId;
	transmit(world, send, undefined);
	return send;
}

/** 3.7: probe transmission n's retry deadline is its issue plus max(probeMs, backoff(n)). */
const backoff = (n: number) => [1_000, 2_000, 4_000, 8_000][n - 1] ?? 30_000;

function probe(
	world: World,
	step: Step,
	runId: string | null,
	target: Probe["target"],
	subject?: Probe["subject"],
): void {
	const send = fold1(world, step, { kind: "probe", runId, target });
	send.probe = {
		target,
		subject,
		deadline: {
			at: step.now + Math.max(step.policy.probeMs, backoff(1)),
			opened: world.step,
		},
		answered: false,
		busy: false,
		done: false,
	};
}

function reprobe(world: World, step: Step, send: Send, probe: Probe): void {
	// 4.8 (CONTRACT.md 1873-1875): the cap counts every issued token but a not_sent one.
	const n = send.txs.filter((tx) => !tx.notSent).length + 1;
	if (n > 5) {
		// 3.7: past the cap the probe ends with no finding.
		probe.done = true;
		probe.deadline = undefined;
		return;
	}
	const token = step.newId() as SendToken;
	transmit(world, send, token);
	step.effects.push({ tag: "Tokened", token, effect: send.effect });
	probe.answered = false;
	probe.busy = false;
	probe.deadline = {
		at: step.now + Math.max(step.policy.probeMs, backoff(n)),
		opened: world.step,
	};
}

function foldEndSession(
	world: World,
	runId: string | null,
	commandId: string,
): void {
	// Wire label (L2): end_session carries its address's label, null while it has none.
	issueControl(
		world,
		{ kind: "end_session", runId, label: addressAt(world, runId).label },
		commandId,
	);
}

/** 8.4: the end_session step is confirm-gated with tasks live or unknown. */
function gateEndSession(
	world: World,
	runId: string | null,
	commandId: string,
): void {
	if (taskView(world).tag === "none") foldEndSession(world, runId, commandId);
	else
		world.confirm = {
			step: "end_session",
			runId: runId ?? undefined,
			commandId,
		};
}

/** 3.4 session end: covers earlier sends; the next start is fresh. */
function sessionEnd(
	world: World,
	before: number,
	cause: "session_ended",
): void {
	world.freshSince = world.seq;
	for (const send of world.sends)
		for (const tx of send.txs)
			if (tx.seq < before) {
				seal(tx);
				tx.covered ??= cause;
				endWork(tx, cause);
			}
	// 3.4 (CONTRACT.md 535-537): an end_session success covers only what was issued before it.
	for (const run of world.runs)
		if (
			run.phase !== "Ended" &&
			run.exec.evidence &&
			(runSends(world, run).some((send) =>
				send.txs.some((tx) => tx.seq < before),
			) ||
				world.wakes.some(
					(wake) => wake.runId === run.runId && wake.seq < before,
				))
		)
			run.exec.endedBy ??= cause;
	for (const wake of world.wakes) if (wake.seq < before) endWork(wake, cause);
	for (const interaction of world.interactions) resolveInteraction(interaction);
}

/** L5: each label's lost work is decided once, when its scope first ends. */
function decideLostWork(world: World, label: Label): void {
	if (world.lostDecided.has(label)) return;
	world.lostDecided.add(label);
	const runner = world.runners.get(splitLabel(label).runnerId);
	const tasks = runner?.tasks;
	if (tasks === undefined || tasks.tag === "Unknown" || tasks.label !== label) {
		if (reportsTasks(world.provider))
			world.lostWork.push({ label, tag: "unknown" });
		return;
	}
	if (tasks.tasks.length > 0)
		world.lostWork.push({ label, tag: "known", tasks: tasks.tasks });
}

/** A label newer than its runner's latest raises it (8.4 snapshotEntry, L5). */
function noteLabel(world: World, label: Label): "older" | "current" {
	const { runnerId, querySeq } = splitLabel(label);
	const runner = world.runners.get(runnerId);
	// unsolicited() drops a runner not started before this (L1).
	if (runner === undefined || runner.retired) return "older";
	const latest = splitLabel(runner.latest).querySeq;
	if (querySeq < latest) return "older";
	if (querySeq > latest) {
		decideLostWork(world, runner.latest);
		runner.latest = label;
		// D44: the newer label's tasks are unknown until its first snapshot (8.4).
		runner.tasks = reportsTasks(world.provider)
			? { tag: "Unknown", label }
			: { tag: "Known", label, tasks: [] };
		world.snapshotEntry++;
	}
	return "current";
}

/** Evidence kinds each effect can produce as an Answer (3.4). */
function producible(world: World, send: Send, evidence: Evidence): boolean {
	const kind = send.effect.kind;
	switch (evidence.kind) {
		case "run_dispatched":
		case "run_released":
		case "delivery_indeterminate":
		case "runner_reply":
		case "journal_answer":
			return send.held;
		case "effect_outcome":
			// 3.4 (CONTRACT.md 465-471, build round 2e D48) and 3.13: not_sent is an effect decide
			// issues' only, a direct start's named by its runId included.
			return (
				!send.held &&
				(evidence.outcome.tag !== "not_sent" ||
					kind === "probe" ||
					kind === "stop_task" ||
					kind === "cancel_request")
			);
		case "started":
		case "input_accepted":
		case "input_declined":
		case "activity":
		case "result":
		case "query_ended":
		case "accounting":
		case "interaction_requested":
			return kind === "start" || kind === "steer";
		case "command_lifecycle":
			// D61: a native command's receipts and every interaction_resolved are unsolicited.
			return (
				world.provider === "claude" && (kind === "start" || kind === "steer")
			);
		case "probe_result":
			return kind === "probe";
		default:
			return false;
	}
}

function interactionOf(world: World, interactionId: string) {
	return world.interactions.find(
		(item) => item.interactionId === interactionId,
	);
}

function requestInteraction(
	world: World,
	label: Label,
	evidence: Extract<Evidence, { kind: "interaction_requested" }>,
): Outcome {
	if (interactionOf(world, evidence.interactionId) !== undefined)
		return noop("interaction already requested");
	world.interactions.push({
		interactionId: evidence.interactionId,
		kind: evidence.interactionKind,
		label,
		opened: world.step,
		deliveries: [],
		resolved: false,
	});
	return changed;
}

/** 3.10: the first answer decision wins (user or timeout). */
function answerInteraction(
	world: World,
	interaction: Interaction,
	answer: unknown,
	commandId: string,
): void {
	interaction.answer ??= answer;
	const run = world.runs.find(
		(item) =>
			item.phase !== "Ended" &&
			(item.wakeLabels.includes(interaction.label) ||
				world.sends.some(
					(send) =>
						send.runId === item.runId &&
						send.txs.some((tx) => tx.label === interaction.label),
				)),
	);
	const send = issueControl(
		world,
		{
			kind: "deliver_answer",
			runId: run?.runId ?? null,
			label: interaction.label,
			interactionId: interaction.interactionId,
			answer: interaction.answer,
		},
		commandId,
	);
	interaction.deliveries.push(world.sends.indexOf(send));
}

function wakeOn(world: World, label: Label) {
	return world.wakes.find(
		(wake) => wake.label === label && wake.ended === undefined,
	);
}

function activeInputRun(world: World) {
	return world.runs.find(
		(run) => run.phase !== "Ended" && run.origin === "input",
	);
}
function activeRun(world: World) {
	return (
		activeInputRun(world) ??
		world.runs.find((run) => run.phase !== "Ended" && run.origin === "wake")
	);
}

/** Unsolicited observations (3.4, 8.3): named by (label, event id). */
function unsolicited(
	world: World,
	step: Step,
	observation: Extract<
		Extract<LedgerCommand, { verb: "observe" }>["observation"],
		{ tag: "Unsolicited" }
	>,
): Outcome {
	const key = `${observation.label}\u0000${observation.eventId}`;
	if (world.seen.has(key)) return noop("repeated unsolicited observation");
	if (
		(observation.kind === "tasks_snapshot" ||
			observation.kind === "task_event") &&
		!reportsTasks(world.provider)
	)
		return rejected(`${world.provider} reports no background tasks (8.1)`);
	if (
		(observation.kind === "command_lifecycle" ||
			observation.kind === "command_result") &&
		world.provider !== "claude"
	)
		return rejected("command receipts are Claude's (9, D46)");
	if (observation.kind === "turn_ended" && world.provider !== "claude")
		return rejected(
			"only a Claude wake has a turn_ended (3.4, 2.1 row 215, 8.3)",
		);
	// 8.3 (CONTRACT.md 2808): Cursor starts no unsolicited turn, so it has no wake turn_started.
	if (observation.kind === "turn_started" && world.provider === "cursor")
		return rejected("Cursor starts no unsolicited turn (8.3)");
	// L1 (CONTRACT.md 353-355): evidence under the label of a runner not started has no authority
	// and changes nothing.
	if (!world.runners.has(splitLabel(observation.label).runnerId))
		return noop("a runner not started has no authority (L1)");
	world.seen.add(key);
	const label = observation.label;
	const place = noteLabel(world, label);
	const wake = wakeOn(world, label);
	switch (observation.kind) {
		case "tasks_snapshot": {
			if (place === "older") return noop("older-label snapshot (L1.4)");
			const runner = world.runners.get(splitLabel(label).runnerId);
			if (runner === undefined) return noop();
			runner.tasks = {
				tag: "Known",
				label,
				tasks: observation.tasks.map((task) => ({
					...task,
					// 8.2 (CONTRACT.md 2778-2781): kind from task_type; serving needs 8.7's servers (GAP, 32.33).
					kind:
						(
							{
								local_bash: "shell",
								local_agent: "subagent",
								local_workflow: "workflow",
							} as Record<string, string>
						)[task.taskType] ?? task.taskType,
					class:
						task.ambient || task.taskType === "monitor" ? "monitoring" : "work",
				})),
			};
			world.snapshotEntry++;
			return changed;
		}
		case "task_event":
			if (observation.event === "notification")
				world.lastNotified = observation.key;
			return changed;
		case "turn_started": {
			if (place === "older")
				return noop("older label gives no wake Run (L1.4)");
			const userRun = activeInputRun(world);
			const wakeRun = world.runs.find(
				(run) => run.phase !== "Ended" && run.origin === "wake",
			);
			// 8.3 Wake Runs (CONTRACT.md 2837-2840, build round 2e D47/D28): with no active Run a
			// turn_started records a wake Run, opening its label's wake execution or re-arming one still
			// outstanding, which a joined Run's end leaves, as that Run's.
			if (
				wake !== undefined &&
				(userRun !== undefined ||
					(wakeRun !== undefined && wake.runId === wakeRun.runId))
			)
				return noop("wake execution already outstanding under the active Run");
			let runId: string | undefined;
			if (userRun === undefined) {
				if (wakeRun !== undefined) {
					wakeRun.wakeLabels.push(label);
					runId = wakeRun.runId;
				} else {
					const run: Run = {
						runId: step.newId(),
						origin: "wake",
						wakeTask: observation.wakeTask ?? world.lastNotified,
						inputs: [],
						phase: "Launched",
						asked: false,
						exec: { ...newExec(1), evidence: true },
						wakeLabels: [label],
					};
					world.runs.push(run);
					runId = run.runId;
				}
			}
			if (wake === undefined)
				world.wakes.push({ label, runId, seq: world.seq });
			else wake.runId = runId;
			return changed;
		}
		case "turn_ended":
			if (wake === undefined)
				return noop("no wake execution on its label (8.3)");
			if (place === "older") wake.older = true;
			endWork(wake, "own");
			return changed;
		case "activity":
			if (wake === undefined)
				return noop("no wake execution on its label (8.3)");
			return noop();
		case "result":
			if (wake === undefined) {
				// 3.4: a Claude result naming none, with no wake, names each started send with no result.
				const started = world.sends.filter(
					(send) =>
						(send.effect.kind === "start" || send.effect.kind === "steer") &&
						send.txs.some(
							(tx) =>
								tx.label === label &&
								tx.consumption.tag !== "None" &&
								!tx.resulted,
						),
				);
				if (world.provider !== "claude" || started.length === 0)
					return noop("no wake execution on its label (8.3)");
				for (const send of started)
					for (const tx of send.txs)
						if (tx.label === label && !tx.resulted)
							answerResult(world, step, send, tx, observation);
				return changed;
			}
			if (world.provider === "opencode") return noop();
			if (place === "older") wake.older = true;
			endWork(wake, "result");
			wake.outcome = {
				seq: world.seq,
				outcome: observation.outcome,
				code: observation.error?.code,
				retryable: observation.error?.retryable ?? false,
			};
			return changed;
		case "query_ended":
			if (wake === undefined) {
				if (world.provider !== "opencode")
					return noop("no wake execution on its label (8.3)");
				return queryEnded(world, label) ? changed : noop();
			}
			if (place === "older") wake.older = true;
			endWork(wake, "own");
			if (world.provider === "opencode") queryEnded(world, label);
			return changed;
		case "interaction_requested":
			return requestInteraction(world, label, observation);
		case "command_lifecycle":
		case "command_result": {
			// D61 (CONTRACT.md 486-494): a native command's receipts are unsolicited, by its commandId.
			const command = world.nativeCommands.find(
				(item) => item.commandId === observation.commandId,
			);
			// 3.4 (CONTRACT.md 517-523, build round 2e D61): a receipt naming no native command is an
			// unknown token, its commandId its key.
			if (command === undefined)
				return noop("a command receipt naming no native command (D61)");
			// LI7 (CONTRACT.md 3430): older-label evidence changes nothing, its send's own label aside.
			if (
				place === "older" &&
				!world.sends[command.send]?.txs.some((tx) => tx.label === label)
			)
				return noop("older-label command receipt (LI7)");
			commandReceipt(world, step, command, observation);
			return changed;
		}
		case "interaction_resolved": {
			// D61: native or confirming an answer, by its interaction.
			const interaction = interactionOf(world, observation.interactionId);
			if (interaction === undefined || interaction.resolved) return noop();
			resolveInteraction(interaction);
			return changed;
		}
	}
}

/**
 * OpenCode's query end ends its label's starts and steers (9). An abort or cancel_request acts on
 * the native session, not the query, so a query end never covers them (CONTRACT.md 334-338, 3101-3106).
 */
function queryEnded(world: World, label: Label): boolean {
	let moved = false;
	for (const send of world.sends)
		if (send.effect.kind === "start" || send.effect.kind === "steer")
			for (const tx of send.txs)
				if (tx.label === label && tx.ended === undefined) {
					endWork(tx, "evidence");
					moved = true;
				}
	return moved;
}

function commandReceipt(
	world: World,
	step: Step,
	command: NativeCommandRec,
	evidence: Extract<
		Evidence,
		{ kind: "command_lifecycle" } | { kind: "command_result" }
	>,
): void {
	const state =
		evidence.kind === "command_result" ? "completed" : evidence.state;
	const pause = () => {
		if (command.deadline !== undefined)
			command.remaining = Math.max(0, command.deadline.at - step.now);
		command.deadline = undefined;
	};
	switch (state) {
		case "queued":
			pause();
			command.state = "Queued";
			return;
		case "started":
			command.deadline ??= {
				at: step.now + command.remaining,
				opened: world.step,
			};
			command.state = "Started";
			return;
		case "completed":
			command.deadline = undefined;
			command.state = "Completed";
			return;
		case "cancelled":
			command.deadline = undefined;
			command.state = "Cancelled";
	}
}

function answerResult(
	world: World,
	step: Step,
	send: Send,
	tx: Tx,
	evidence: Extract<Evidence, { kind: "result" }>,
): void {
	tx.resulted = true;
	tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
	seal(tx);
	const run = findRun(world, send.runId);
	const authority =
		run !== undefined &&
		run.phase !== "Ended" &&
		send.exec === run.exec.n &&
		(tx.ended === undefined || tx.ended === "evidence") &&
		// 3.4: a covered transmission's evidence changes nothing, its work ended by evidence first too.
		tx.covered === undefined;
	if (world.provider !== "opencode") endWork(tx, "evidence");
	if (!authority || run === undefined) return;
	run.exec.evidence = true;
	run.exec.result = true;
	run.exec.afterResult = false;
	run.exec.fold.push({
		seq: send.seq,
		outcome: evidence.outcome,
		code: evidence.error?.code,
		retryable: evidence.error?.retryable ?? false,
	});
	if (world.provider === "opencode")
		// 11A: Settling holds the result until the owned execution ends.
		// 3.7: Settling is fixed at the result; a later result neither moves nor extends it.
		run.exec.settle ??= {
			at: step.now + step.policy.settleMs,
			opened: world.step,
		};
	else run.exec.endEvidence = true;
}

function answer(
	world: World,
	step: Step,
	observation: Extract<
		Extract<LedgerCommand, { verb: "observe" }>["observation"],
		{ tag: "Answer" }
	>,
): Outcome {
	const evidence: Evidence = observation;
	if (observation.kind === "run_dispatched")
		return dispatched(world, observation);
	// D46 (oracle round 10; build round 2e, CONTRACT.md 519-520): producibility is the kind's, so it
	// comes before the unknown-token rule. Either command receipt off Claude is Rejected.
	if (
		(observation.kind === "command_lifecycle" ||
			observation.kind === "command_result" ||
			observation.kind === "turn_ended") &&
		world.provider !== "claude"
	)
		return rejected(`${observation.kind} is Claude's (3.4, 9, D46)`);
	// 3.4: a control's outcome names its transmission, which binds the token the host composed.
	if (
		observation.kind === "effect_outcome" &&
		observation.transmission !== undefined
	) {
		const named = observation.transmission;
		if (
			observation.outcome.tag === "delivery_unknown" ||
			observation.outcome.tag === "not_sent"
		)
			// 3.4 (CONTRACT.md 465-471, build round 2e D48): main's gate precedes its claim, so no row
			// it runs gets either.
			return rejected(
				`main writes no ${observation.outcome.tag} for a transmission (3.4)`,
			);
		if (named.transmission === 0) {
			// 3.4 (CONTRACT.md 474-477): n 0 names no transmission and needs no claim. The issue is
			// found by commandId alone and ends never transmitted (never handed over, 3.6), adding no
			// chain; it is unknown only when its commandId names no issue.
			const issued = [...world.sends]
				.reverse()
				.find(
					(send) =>
						!send.held &&
						send.commandId === named.commandId &&
						send.txs.every((tx) => tx.token === undefined),
				);
			if (issued === undefined) return noop("n 0 names no issue (3.4)");
			issued.txs.length = 0;
			return changed;
		}
		const claim = world.sends
			.filter((send) => !send.held && send.commandId === named.commandId)
			.flatMap((send) => send.txs)
			.find((tx) => tx.n === named.transmission);
		if (claim === undefined) return noop("unknown transmission (3.4)");
		const bound = world.tokens.get(observation.token);
		if (claim.token === undefined && bound === undefined) {
			claim.token = observation.token;
			const send = world.sends.find((item) => item.txs.includes(claim));
			if (send !== undefined)
				world.tokens.set(observation.token, {
					send: world.sends.indexOf(send),
					tx: send.txs.indexOf(claim),
				});
		} else if (claim.token !== observation.token)
			return rejected("a transmission names one token (3.4)");
	}
	const at = world.tokens.get(observation.token);
	if (at === undefined) return noop("unknown or never-issued token (3.4)");
	const send = world.sends[at.send];
	const tx = send?.txs[at.tx];
	if (send === undefined || tx === undefined)
		return noop("unknown or never-issued token (3.4)");
	if (tx.n !== undefined && evidence.kind !== "effect_outcome")
		// D61 (CONTRACT.md 489-494, 517-518): a control main issues is answered only by its outcome.
		return rejected(`${evidence.kind} on a control main issues (3.4, D61)`);
	if (!producible(world, send, evidence))
		return rejected(
			`${send.effect.kind} cannot produce ${evidence.kind} evidence (3.4)`,
		);
	if (
		evidence.kind === "effect_outcome" &&
		(evidence.transmission !== undefined) !== (tx.n !== undefined)
	)
		return rejected(
			"an effect_outcome names a transmission exactly for a control (3.4)",
		);
	const run = findRun(world, send.runId);
	const live =
		run !== undefined &&
		run.phase !== "Ended" &&
		send.exec === run.exec.n &&
		tx.ended === undefined;
	switch (evidence.kind) {
		case "started":
		case "activity": {
			const before = tx.consumption.tag;
			tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			if (!live || run === undefined)
				return before === tx.consumption.tag ? noop() : changed;
			const exec = run.exec;
			const first =
				!exec.evidence || (evidence.kind === "activity" && !exec.activity);
			const phase =
				exec.result && !exec.afterResult && world.provider === "opencode";
			exec.evidence = true;
			if (evidence.kind === "activity") exec.activity = true;
			if (phase && evidence.kind === "activity") {
				if (world.mutation === "extend_settle")
					exec.settle = {
						at: step.now + step.policy.settleMs,
						opened: world.step,
					};
				else {
					exec.afterResult = true;
					exec.settle = undefined;
				}
			}
			// 3.8 activity throttling: only repeats within one phase are dropped.
			return first || phase || before !== tx.consumption.tag ? changed : noop();
		}
		case "input_accepted":
		case "input_declined": {
			const nativeId =
				evidence.kind === "input_accepted"
					? evidence.nativeMessageId
					: undefined;
			if (
				nativeId !== undefined &&
				tx.nativeMessageId !== undefined &&
				tx.nativeMessageId !== nativeId
			)
				return rejected("a contradicting native id (3.4, 6C)");
			if (evidence.kind === "input_accepted") {
				tx.nativeMessageId ??= nativeId;
				tx.consumption = joinConsumption(tx.consumption, { tag: "Accepted" });
			} else {
				tx.declined = true;
				tx.consumption = joinConsumption(tx.consumption, {
					tag: "NotConsumed",
					why: "declined",
				});
			}
			seal(tx);
			return changed;
		}
		case "accounting":
			if (tx.accounted)
				return noop("a duplicate accounting receipt (12A, LI2)");
			tx.accounted = true;
			return changed;
		case "interaction_requested":
			return tx.label === null
				? noop("an interaction needs a label (3.10)")
				: requestInteraction(world, tx.label, evidence);
		case "result":
			answerResult(world, step, send, tx, evidence);
			return changed;
		case "query_ended":
			if (world.provider !== "opencode")
				// 9: query_ended ends no Claude send's work, only a wake's.
				return noop();
			endWork(tx, "evidence");
			if (tx.label !== null) queryEnded(world, tx.label);
			if (live && run !== undefined) run.exec.endEvidence = true;
			return changed;
		case "effect_outcome":
			return effectOutcome(world, step, send, tx, evidence.outcome);
		case "run_released": {
			const reason = evidence.reason;
			if (reason === "ResumeRejected") {
				tx.resumeRejected = true;
				tx.released = true;
				tx.transport = joinTransport(tx.transport, {
					tag: "Failed",
					code: "native_resume_rejected",
				});
			} else {
				tx.released = true;
				tx.stopOwn = typeof reason === "object" && reason.why === "interrupted";
				tx.consumption = joinConsumption(tx.consumption, {
					tag: "NotConsumed",
					why: "released",
				});
			}
			seal(tx);
			return changed;
		}
		case "delivery_indeterminate":
			tx.transport = joinTransport(tx.transport, { tag: "Unknown" });
			seal(tx);
			openRecovery(world, step, send, tx);
			return changed;
		case "runner_reply":
			return effectOutcome(
				world,
				step,
				send,
				tx,
				evidence.outcome.tag === "succeeded"
					? { tag: "succeeded" }
					: { tag: "permanent", code: evidence.outcome.code },
			);
		case "journal_answer":
			if (evidence.answer === "uncertain") return noop();
			if (evidence.answer === "absent") {
				seal(tx);
				// 9: a Claude send's work ends at journal absent with no acceptance.
				if (world.provider === "claude" && tx.consumption.tag !== "Accepted")
					endWork(tx, "evidence");
				return changed;
			}
			tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			return changed;
		case "command_lifecycle": {
			// D21: a held start's or steer's receipt names its hold's commandId.
			if (evidence.commandId !== send.commandId)
				return rejected("a command receipt naming another commandId (D21)");
			if (evidence.state === "cancelled" && tx.consumption.tag === "None") {
				// 9: cancelled before started is NotConsumed{cancelled}, Stop's own.
				tx.stopOwn = true;
				tx.consumption = { tag: "NotConsumed", why: "cancelled" };
			} else if (evidence.state === "started")
				tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			return changed;
		}
		case "probe_result":
			return probeResult(world, send, tx, evidence.finding);
		default:
			return rejected(`${evidence.kind} is never an answer (3.4)`);
	}
}

/** The first delivery-recovery probe: a Send deadline at the outcome plus probeMs (3.7, D20). */
function openRecovery(world: World, step: Step, send: Send, tx: Tx): void {
	const target = recoveryTarget(send);
	if (target === undefined) return;
	if (world.mutation === "probe_at_outcome") {
		probe(world, step, send.runId, target, {
			send: world.sends.indexOf(send),
			tx: send.txs.indexOf(tx),
		});
		return;
	}
	tx.recovery ??= { at: step.now + step.policy.probeMs, opened: world.step };
}
function recoveryTarget(send: Send): Probe["target"] | undefined {
	const effect = send.effect;
	// 3.10: no answer probe; main retries an answer only at a retryable outcome.
	return effect.kind === "start" || effect.kind === "steer"
		? { tag: "input", inputId: effect.inputId }
		: undefined;
}

function effectOutcome(
	world: World,
	step: Step,
	send: Send,
	tx: Tx,
	outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
): Outcome {
	// 3101-3106: the returned call of an abort its Run's terminal left open ends it.
	if (tx.mainEnded) endWork(tx, "main");
	switch (outcome.tag) {
		case "succeeded":
			tx.transport = joinTransport(tx.transport, { tag: "Sent" });
			if (send.effect.kind === "end_session") {
				seal(tx);
				endWork(tx, "evidence");
				sessionEnd(world, send.seq, "session_ended");
				return changed;
			}
			break;
		case "retryable":
			tx.retryable = true;
			tx.retryAt = outcome.retryAt;
			tx.refusal = outcome.code;
			tx.transport = joinTransport(tx.transport, {
				tag: "Retrying",
				at: outcome.retryAt,
			});
			if (send.probe?.deadline !== undefined && tx === send.txs.at(-1))
				// 3.7, D20: a probe's deadline is raised to a later retryAt.
				send.probe.deadline = {
					at: Math.max(send.probe.deadline.at, outcome.retryAt),
					opened: send.probe.deadline.opened,
				};
			break;
		case "not_sent":
			tx.notSent = true;
			tx.retryAt = outcome.retryAt;
			tx.transport = joinTransport(tx.transport, {
				tag: "Retrying",
				at: outcome.retryAt,
			});
			break;
		case "permanent": {
			// 3.4: an outcome with no live claim (the budget's exhaustion) names the latest claimed
			// transmission, so the claim opened for the retry never happened.
			const open = send.txs.at(-1);
			if (tx.n !== undefined && open !== tx && open?.token === undefined)
				send.txs.pop();
			tx.permanent = outcome.code;
			tx.resumeRejected = outcome.code === "native_resume_rejected";
			// 3.4 (CONTRACT.md 465, 476): a permanent outcome ends its control row, so no issue stays in
			// live after it; a raced outcome on the transmission joins its chains but revives nothing.
			if (tx.n !== undefined) endWork(tx, "evidence");
			tx.transport = joinTransport(tx.transport, {
				tag: "Failed",
				code: outcome.code,
			});
			failInput(world, send, tx);
			if (send.effect.kind === "send_native_command") {
				const command = world.nativeCommands.find(
					(item) => item.send === world.sends.indexOf(send),
				);
				if (command !== undefined) {
					command.state = "Failed";
					command.code = outcome.code;
					command.deadline = undefined;
				}
			}
			if (send.effect.kind === "deliver_answer") {
				// 3.10 (amends 10B): a permanent refusal ends the delivery, which resolves the interaction.
				const interaction = interactionOf(world, send.effect.interactionId);
				if (interaction !== undefined) resolveInteraction(interaction);
			}
			break;
		}
		case "delivery_unknown":
			tx.transport = joinTransport(tx.transport, { tag: "Unknown" });
			seal(tx);
			openRecovery(world, step, send, tx);
			return changed;
	}
	// 3.4: main claims a control's row again after a retryable outcome on its latest claim.
	if (
		tx.n !== undefined &&
		tx === send.txs.at(-1) &&
		outcome.tag === "retryable"
	)
		transmit(world, send, undefined);
	seal(tx);
	return changed;
}

/** D53: a send fails once, at a permanent outcome other than a rejected resume or Stop's own. */
function failInput(world: World, send: Send, tx: Tx): void {
	const effect = send.effect;
	if (
		(effect.kind !== "start" && effect.kind !== "steer") ||
		tx.resumeRejected ||
		tx.stopOwn
	)
		return;
	const input = world.inputs.get(effect.inputId);
	if (input !== undefined && input.runId === send.runId)
		input.failed ??= tx.permanent ?? "provider_send_attempts_exhausted";
}

function probeResult(
	world: World,
	send: Send,
	tx: Tx,
	finding: Extract<Evidence, { kind: "probe_result" }>["finding"],
): Outcome {
	const probe = send.probe;
	if (probe === undefined)
		return rejected("probe_result for a non-probe (3.4)");
	const target = probe.target.tag;
	const fits =
		finding.tag === "native_busy" ||
		(target === "input" &&
			(finding.tag === "input_present" || finding.tag === "input_absent")) ||
		(target === "native_session" && finding.tag === "native_idle");
	if (!fits)
		return rejected(`${finding.tag} cannot answer a ${target} probe (3.4)`);
	const subjectSend =
		probe.subject === undefined ? undefined : world.sends[probe.subject.send];
	const subject =
		probe.subject === undefined
			? undefined
			: subjectSend?.txs[probe.subject.tx];
	if (
		finding.tag === "input_present" &&
		finding.nativeMessageId !== undefined &&
		subjectSend !== undefined &&
		subjectSend.txs.some(
			(item) =>
				item.nativeMessageId !== undefined &&
				item.nativeMessageId !== finding.nativeMessageId,
		)
	)
		return rejected("a contradicting native id (3.4, 6C)");
	tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
	seal(tx);
	if (probe.done) return noop("late probe answer");
	if (finding.tag === "native_busy") {
		probe.busy = true;
		return changed;
	}
	probe.answered = true;
	probe.done = true;
	probe.deadline = undefined;
	switch (finding.tag) {
		case "input_present":
			if (subject !== undefined) {
				subject.nativeMessageId ??= finding.nativeMessageId;
				subject.consumption = joinConsumption(subject.consumption, {
					tag: "Observed",
				});
				seal(subject);
			}
			break;
		case "input_absent":
			if (subject !== undefined) {
				// 9 (decided 2026-10-28): input_absent ends probing; a later acceptance beats it.
				subject.absent = true;
				subject.consumption = joinConsumption(subject.consumption, {
					tag: "NotConsumed",
					why: "absent",
				});
				seal(subject);
			}
			break;
		case "native_idle":
			// 9: an idle probe covers sends issued before it whose delivery is confirmed, aborts and
			// cancel_request session-wide, and OpenCode wake executions (D26).
			for (const other of world.sends) {
				if (!fenceMember(world.provider, other.effect.kind)) continue;
				const sessionWide =
					other.effect.kind === "interrupt" ||
					other.effect.kind === "cancel_request";
				for (const item of other.txs)
					if (
						item.seq < tx.seq &&
						item.ended === undefined &&
						(sessionWide ||
							item.resulted ||
							consumptionRank[item.consumption.tag] >= 2)
					)
						endWork(item, "evidence");
			}
			for (const wake of world.wakes) endWork(wake, "own");
			break;
	}
	return changed;
}

/** run.dispatched binds a held issue's transmission by commandId (3.4, 4.11). */
function dispatched(
	world: World,
	observation: Extract<Evidence, { kind: "run_dispatched" }> & {
		readonly token: SendToken;
	},
): Outcome {
	const bound = world.tokens.get(observation.token);
	if (bound !== undefined)
		// CONTRACT.md 527-528: a hold fact on a send with no hold is evidence it cannot produce.
		return world.sends[bound.send]?.held
			? noop("repeated run.dispatched")
			: rejected("a send with no hold cannot produce run_dispatched (3.4)");
	const runner = world.runners.get(observation.runnerId);
	if (isRetired(world, observation.runnerId))
		return noop("no hold is written on a retired runner (4.3)");
	// 3.4: run.dispatched names its Run by main's runId and the issue in that Run by commandId.
	const run = findRun(world, world.mainRuns.get(observation.runId)?.runId);
	if (run === undefined) return noop("unknown or never-issued token (3.4)");
	// H3, 4.3 step 2 (CONTRACT.md 1514-1518, 1560-1563), 12A (891-894): a hold for an Ended Run,
	// a dropped issue's included, finds no running send and the feeder drops it, so it binds nothing.
	if (run.phase === "Ended")
		return noop("an Ended Run's hold finds no running send (H3)");
	const held = world.sends.filter(
		(item) => item.held && item.runId === run.runId,
	);
	let send = [...held]
		.reverse()
		.find((item) => item.commandId === observation.commandId);
	if (send !== undefined) {
		// 3.6: a relaunch is a new transmission of the same Run, in a new execution. Main's fresh-run
		// run.requested (3.4, 4.8) may have launched it already, its issue pending there.
		if (run.phase === "Queued" || send.exec !== run.exec.n) {
			const { effect } = send;
			if (run.phase === "Queued") launch(run);
			send =
				deliverySends(world, run).find(
					(item) =>
						item.held &&
						item.commandId === undefined &&
						"inputId" in item.effect &&
						"inputId" in effect &&
						item.effect.inputId === effect.inputId,
				) ??
				issue(
					world,
					effect.kind === "start"
						? { ...effect, mode: nextMode(world) }
						: effect,
					true,
				);
			send.commandId = observation.commandId;
		}
	} else {
		send = held.find((item) => item.commandId === undefined);
		if (send === undefined) return noop("unknown or never-issued token (3.4)");
		send.commandId = observation.commandId;
	}
	// holdRun counts n per commandId across a relaunch (4.3); an unheld try took no hold.
	const holds = world.sends
		.filter((item) => item.held && item.commandId === observation.commandId)
		.flatMap((item) => item.txs)
		.filter((tx) => !tx.unheld).length;
	if (observation.transmission !== holds + 1)
		return rejected("run.dispatched transmission out of order (4.3)");
	// L2: a pending held send resolves at its own run_dispatched to the runner it names, and a
	// case 2 send following its start resolves with it.
	if (send.runnerId === null) {
		const start = send;
		for (const item of world.sends)
			if (
				item === start ||
				(item.follows === start && item.runnerId === null)
			) {
				for (const tx of item.txs)
					if (tx.runnerId === null) {
						tx.runnerId = observation.runnerId;
						tx.label = runner?.latest ?? null;
					}
				item.runnerId = observation.runnerId;
				item.label = runner?.latest ?? null;
			}
	}
	transmit(
		world,
		send,
		observation.token,
		observation.runnerId,
		runner?.latest ?? send.label,
	);
	return changed;
}

/** 3.4: fresh until a start since the last session end or rejected resume may have reached. */
function nextMode(world: World): "fresh" | "resume" {
	return world.sends.some(
		(send) =>
			send.effect.kind === "start" &&
			send.seq > world.freshSince &&
			send.txs.some((tx) => value(tx) !== "never"),
	)
		? "resume"
		: "fresh";
}

/** Main's run events (3.4, D60): decide issues no start or steer from one. */
function mainEvent(
	world: World,
	observation: Extract<
		Extract<LedgerCommand, { verb: "observe" }>["observation"],
		{ tag: "Main" }
	>,
): Outcome {
	if (world.seen.has(`main\u0000${observation.eventId}`))
		return noop("repeated main observation (D60)");
	world.seen.add(`main\u0000${observation.eventId}`);
	switch (observation.kind) {
		case "run_requested": {
			const input = world.inputs.get(observation.inputId);
			if (input === undefined)
				return noop("run.requested for an input never admitted");
			input.reservation ??= observation.runId;
			if (input.runId === undefined) {
				if (activeInputRun(world) !== undefined)
					return noop("run.requested while another Run is active");
				// 3.4: the Run is reserved at main's run.requested, under main's runId.
				reserve(world, observation.runId, input.inputId);
			}
			const run = findRun(world, input.runId);
			if (run === undefined || run.phase === "Ended")
				return noop("run.requested for an ended Run (3.8)");
			const steer =
				input.delivery === "steer" && run.inputs[0] !== input.inputId;
			world.mainRuns.set(observation.runId, {
				runId: run.runId,
				open: true,
				...(steer ? { steer } : {}),
			});
			if (run.phase === "Queued") launch(run);
			const prior = deliverySends(world, run).find(
				(send) =>
					"inputId" in send.effect && send.effect.inputId === input.inputId,
			);
			const effect: RunEffect = steer
				? { kind: "steer", runId: run.runId, inputId: input.inputId }
				: {
						kind: "start",
						runId: run.runId,
						inputId: input.inputId,
						mode: nextMode(world),
					};
			// 3.4: a direct send's run.requested is its transmission, its token the runId; a runner-held
			// send's names its Run, and run.dispatched is its transmission.
			const send = prior ?? issue(world, effect, !observation.direct);
			if (observation.direct) {
				// 3.13: a direct start is Main under its input's id.
				send.commandId ??= input.inputId;
				transmit(world, send, observation.runId as SendToken);
			}
			return changed;
		}
		case "run_started": {
			const input = world.inputs.get(observation.inputId);
			// CONTRACT.md 148, 956: the arm folds run.started with its join: the input joins the run main
			// started it in; a run the ledger never saw, main's for a native message, names the requested Run.
			const target =
				world.mainRuns.get(observation.runId) ??
				world.mainRuns.get(observation.requestedRunId);
			const run = findRun(world, target?.runId);
			if (input === undefined || run === undefined)
				return noop("run.started for an unknown run");
			const unseen = !world.mainRuns.has(observation.runId);
			if (run.phase === "Ended") {
				// 3.9 (CONTRACT.md 975-980): a steer its Run's end left unconsumed is a Run of its own, its
				// reservation's, Launched with its send. Oracle edit (32.2.8): this holds for a steer that
				// joined that Run too (CONTRACT.md 978-981, "its host's run.started starts it"), which the
				// same-Run noop below used to swallow.
				const runId = input.reservation ?? observation.requestedRunId;
				if (findRun(world, runId) !== undefined)
					return noop(
						"run.started for a steer whose reservation names an existing Run (3.9)",
					);
				const own: Run = {
					runId,
					origin: "input",
					inputs: [input.inputId],
					phase: "Launched",
					asked: false,
					exec: { ...newExec(1), evidence: true },
					wakeLabels: [],
				};
				world.runs.push(own);
				input.runId = own.runId;
				for (const runId of [observation.requestedRunId, own.runId])
					world.mainRuns.set(runId, { runId: own.runId, open: true });
				if (unseen)
					world.mainRuns.set(observation.runId, {
						runId: own.runId,
						open: true,
					});
				return changed;
			}
			if (unseen)
				world.mainRuns.set(observation.runId, { runId: run.runId, open: true });
			if (input.runId === run.runId) return unseen ? changed : noop();
			const from = findRun(world, input.runId);
			if (from !== undefined) {
				const at = from.inputs.indexOf(input.inputId);
				if (at >= 0) from.inputs.splice(at, 1);
			}
			if (!run.inputs.includes(input.inputId)) run.inputs.push(input.inputId);
			input.runId = run.runId;
			return changed;
		}
		case "run_terminal": {
			const target = world.mainRuns.get(observation.runId);
			if (target === undefined) return noop("run_terminal for an unknown run");
			// 4.8 (CONTRACT.md 1864-1869), 4.3 (1521-1524): from 32.5 a joined steer has its own
			// transmissions and cap, so its unstarted run's end, a fresh-run retry's failed try or the
			// cap's error, is the steer's alone: its Run neither ends nor names that run again.
			if (target.steer) {
				world.mainRuns.delete(observation.runId);
				return changed;
			}
			target.open = false;
			const run = findRun(world, target.runId);
			if (run === undefined || run.phase === "Ended") return changed;
			// D59: main's terminal ends its Run's work as main, except an OpenCode abort or cancel_request
			// whose call has not returned: session-wide, its delivery unknown, it stays a fence member until
			// the call returns, a probe issued after it returns native_idle, or the stop's deadline step,
			// main's stop_unconfirmed terminal. The Run's end waits for none (CONTRACT.md 788-789, 797-799,
			// 3101-3106; a reading, reported as a gap).
			for (const send of runSends(world, run))
				for (const tx of send.txs)
					if (
						world.provider === "opencode" &&
						(send.effect.kind === "interrupt" ||
							send.effect.kind === "cancel_request") &&
						observation.code !== "stop_unconfirmed" &&
						tx.transport.tag === "Issued"
					)
						tx.mainEnded = true;
					else endWork(tx, "main");
			run.exec.fold.push({
				seq: world.seq,
				outcome: observation.outcome,
				code: observation.code,
				retryable: false,
			});
			run.exec.endEvidence = true;
			return changed;
		}
	}
}

/** Stop, Run now and end commits (5.1, L6, 3.10, 8.4). */
function commit(
	world: World,
	step: Step,
	by: InterruptBy,
	deadlineAt: number | null,
	commandId: string,
): void {
	const run = activeRun(world);
	// 3.10: a Pending interaction on a label with work is resolved at the commit, unless its answer may act.
	const labels = new Set<Label>([
		...world.wakes
			.filter((wake) => wake.ended === undefined)
			.map((wake) => wake.label),
		...world.sends.flatMap((send) =>
			fenceMember(world.provider, send.effect.kind)
				? send.txs
						.filter((tx) => tx.label !== null && mayStillAct(world, send, tx))
						.map((tx) => tx.label ?? "")
				: [],
		),
	]);
	for (const interaction of world.interactions)
		if (
			!interaction.resolved &&
			labels.has(interaction.label) &&
			!interaction.deliveries.some((index) => {
				const send = world.sends[index];
				return send?.txs.some((tx) => mayStillAct(world, send, tx)) ?? false;
			})
		)
			resolveInteraction(interaction);
	if (run !== undefined) {
		run.asked = true;
		if (run.phase !== "Queued") {
			run.phase = "Interrupting";
			run.by = by;
		}
		for (const send of runSends(world, run)) send.withdrawn = true;
	}
	// 5.1: a Run nothing of which may act ends at once with no effect; with neither it nor label
	// work, Stop issues nothing (REDESIGN-6 r2).
	const acting =
		run !== undefined && run.phase !== "Queued" && !nothingMayAct(world, run);
	// 8.4: an end's Stop row is its end_session, not an interrupt.
	if (by !== "end" && (acting || labelWorkOutstanding(world))) {
		const runIds = [...world.mainRuns.entries()]
			.filter(([, main]) => main.open && main.runId === run?.runId)
			.map(([id]) => id);
		const runId = acting ? (run?.runId ?? null) : null;
		issueControl(world, { kind: "interrupt", runId, runIds }, commandId);
		if (world.provider === "opencode") {
			// 5.1 OpenCode Stop: main issues the native abort; the Stop issues cancel_request and a
			// native_session probe together, the probe's deadline running from that issue (3.7).
			fold1(world, step, { kind: "cancel_request", runId });
			probe(world, step, runId, { tag: "native_session" });
		}
	}
	// 8.4 (CONTRACT.md 2893-2895): an end commits its Stop as the end_session row itself.
	if (by === "end") gateEndSession(world, run?.runId ?? null, commandId);
	else if (
		run !== undefined &&
		run.phase === "Interrupting" &&
		taskView(world).tag !== "none"
	)
		world.confirm ??= { step: "retire", runId: run.runId };
	if (deadlineAt === null) return;
	// L6: add the label work with no open main run to the one ledger stop deadline.
	const hasOpenMain = (runId: string | null) =>
		runId !== null &&
		[...world.mainRuns.values()].some(
			(main) => main.open && main.runId === runId,
		);
	const items: StopItem[] = [
		...world.wakes.flatMap((wake, index): StopItem[] =>
			wake.ended === undefined ? [{ tag: "wake", wake: index }] : [],
		),
		...world.sends.flatMap((send, index) =>
			fenceMember(world.provider, send.effect.kind) && !hasOpenMain(send.runId)
				? send.txs.flatMap((tx, txIndex): StopItem[] =>
						mayStillAct(world, send, tx)
							? [{ tag: "tx", send: index, tx: txIndex }]
							: [],
					)
				: [],
		),
	];
	if (items.length === 0) return;
	if (world.stop === undefined || !stopOpen(world))
		world.stop = { at: deadlineAt, opened: world.step, items };
	else
		world.stop.items = [
			...world.stop.items,
			...items.filter(
				(item) =>
					!world.stop?.items.some(
						(old) => JSON.stringify(old) === JSON.stringify(item),
					),
			),
		];
}

function stopItemOpen(world: World, item: StopItem): boolean {
	if (item.tag === "wake") return world.wakes[item.wake]?.ended === undefined;
	const send = world.sends[item.send];
	const tx = send?.txs[item.tx];
	return send !== undefined && tx !== undefined && mayStillAct(world, send, tx);
}
/** 8.5: what covers a native command, its send's session_ended or process_lost, if anything. */
function coveringCause(world: World, command: NativeCommandRec) {
	const covers = (world.sends[command.send]?.txs ?? []).map((tx) => tx.ended);
	return covers.includes("session_ended")
		? "session_ended"
		: covers.includes("process_lost")
			? "process_lost"
			: undefined;
}

const stopOpen = (world: World) =>
	world.stop?.items.some((item) => stopItemOpen(world, item)) ?? false;

interface Due {
	readonly at: number;
	readonly opened: number;
	readonly fire: () => void;
}

/** 3.7: every open deadline, each with its firing. */
function deadlines(world: World, step: Step): Due[] {
	const due: Due[] = [];
	const stop = world.stop;
	if (stop !== undefined && stopOpen(world))
		due.push({
			at: stop.at,
			opened: stop.opened,
			fire: () => {
				// L6: the alarm forces only work no observer ended, and kills nothing.
				for (const item of stop.items) {
					if (!stopItemOpen(world, item)) continue;
					if (item.tag === "wake") {
						const wake = world.wakes[item.wake];
						if (wake !== undefined) endWork(wake, "forced");
					} else {
						const tx = world.sends[item.send]?.txs[item.tx];
						if (tx !== undefined) endWork(tx, "forced");
					}
				}
				// Every item is now ended, so the stop is closed; commit stays its one writer (A.18 T4).
			},
		});
	for (const run of world.runs) {
		const settle = run.exec.settle;
		if (run.phase !== "Ended" && settle !== undefined)
			due.push({
				...settle,
				fire: () => {
					// 3.7: Settling's expiry probes native_session; the view then reads Running (3.6).
					run.exec.settle = undefined;
					run.exec.settleExpired = true;
					probe(world, step, run.runId, { tag: "native_session" });
				},
			});
	}
	for (const send of world.sends) {
		const probeRec = send.probe;
		if (probeRec?.deadline !== undefined && !probeRec.done)
			due.push({
				...probeRec.deadline,
				fire: () => reprobe(world, step, send, probeRec),
			});
		for (const tx of send.txs) {
			const recovery = tx.recovery;
			const target = recoveryTarget(send);
			if (recovery === undefined || target === undefined) continue;
			due.push({
				...recovery,
				fire: () => {
					tx.recovery = undefined;
					if (
						consumptionRank[tx.consumption.tag] >= 1 ||
						tx.ended !== undefined
					)
						return;
					probe(world, step, send.runId, target, {
						send: world.sends.indexOf(send),
						tx: send.txs.indexOf(tx),
					});
				},
			});
		}
	}
	// 8.5 (CONTRACT.md 2795-2796): only a waiting command carries a deadline, never a covered one.
	for (const command of world.nativeCommands)
		if (
			command.deadline !== undefined &&
			coveringCause(world, command) === undefined
		)
			due.push({
				...command.deadline,
				fire: () => {
					command.deadline = undefined;
					command.state = "Unconfirmed";
				},
			});
	return due.sort((a, b) => a.at - b.at || a.opened - b.opened);
}

function control(
	world: World,
	step: Step,
	command: Extract<LedgerCommand, { verb: "control" }>["control"],
): Outcome {
	switch (command.kind) {
		case "stop":
			commit(world, step, "stop", command.deadlineAt, command.commandId);
			return changed;
		case "run_now": {
			// D58: the input is main's inbox's until its handoff; the ledger reads only the commit.
			commit(world, step, "run_now", command.deadlineAt, command.commandId);
			return changed;
		}
		case "end": {
			// 8.4 (CONTRACT.md 2889-2898): each row is its own Control under its own commandId. With
			// deadlineAt, main commits the Stop as this end_session; a later end_session (deadlineAt
			// null) or one with no Run joins no deadline, and no Run issues end_session{runId: null}.
			const run = activeRun(world);
			if (run === undefined || command.deadlineAt === null)
				gateEndSession(world, run?.runId ?? null, command.commandId);
			else commit(world, step, "end", command.deadlineAt, command.commandId);
			return changed;
		}
		case "answer": {
			const interaction = interactionOf(world, command.interactionId);
			if (interaction === undefined)
				return rejected("no such interaction (3.10)");
			if (interaction.resolved)
				return noop("interaction already resolved (3.10)");
			const delivering = interaction.deliveries.some((index) => {
				const send = world.sends[index];
				return send?.txs.some((tx) => mayStillAct(world, send, tx)) ?? false;
			});
			if (delivering)
				return noop("answered once: the first answer wins (3.10)");
			answerInteraction(world, interaction, command.answer, command.commandId);
			return changed;
		}
		case "stop_tasks": {
			const tasks = taskView(world);
			if (tasks.tag !== "live")
				return rejected(`stop_tasks with tasks ${tasks.tag} (8.4)`);
			const keys =
				command.tasks === "all"
					? tasks.tasks.map((task) => task.key)
					: command.tasks.filter((key) =>
							tasks.tasks.some((task) => sameKey(task.key, key)),
						);
			if (keys.length === 0) return rejected("no live task named (8.4)");
			for (const key of keys) fold1(world, step, { kind: "stop_task", key });
			return changed;
		}
		case "confirm_escalation": {
			const gate = world.confirm;
			if (gate === undefined) return rejected("no pending confirm (8.4)");
			if (command.snapshotEntry !== world.snapshotEntry)
				return rejected("stale confirm (8.4)");
			world.confirm = undefined;
			if (gate.step === "end_session" && gate.commandId !== undefined)
				foldEndSession(world, gate.runId ?? null, gate.commandId);
			return changed;
		}
		case "native_command": {
			if (
				world.nativeCommands.some(
					(item) => item.commandId === command.commandId,
				)
			)
				return rejected("native command already issued (8.5)");
			const send = issueControl(
				world,
				{
					kind: "send_native_command",
					commandId: command.commandId,
					text: command.text,
				},
				command.commandId,
			);
			world.nativeCommands.push({
				commandId: command.commandId,
				send: world.sends.indexOf(send),
				state: "Sent",
				remaining: step.policy.nativeCommandMs,
				deadline: {
					at: step.now + step.policy.nativeCommandMs,
					opened: world.step,
				},
			});
			return changed;
		}
	}
}

/** Oracle edit (32.2.8), L1 (CONTRACT.md 349-350, 6.1): retirement is final, a runner not yet started included. */
const isRetired = (world: World, runnerId: string) =>
	world.runners.get(runnerId)?.retired === true ||
	world.retiredUnstarted.has(runnerId);

/** L1: a runner retires at its process_lost or, for totality, another runner's process_started. */
function retire(world: World, runnerId: string): void {
	const runner = world.runners.get(runnerId);
	if (runner !== undefined) {
		runner.retired = true;
		decideLostWork(world, runner.latest);
	} else world.retiredUnstarted.add(runnerId);
	if (world.current === runnerId) world.current = null;
	const onRunner = (label: Label | null) =>
		label !== null && splitLabel(label).runnerId === runnerId;
	const addressed = (send: Send, tx: Tx) =>
		send.runnerId === runnerId || tx.runnerId === runnerId;
	// L1 item 1: retiring covers every send addressed to it, whatever its tries got, and
	// seals its transmissions.
	for (const send of world.sends) {
		for (const tx of send.txs)
			if (addressed(send, tx)) {
				seal(tx);
				tx.covered ??= "process_lost";
				endWork(tx, "process_lost");
			}
		const run = findRun(world, send.runId);
		if (
			send.held &&
			send.txs.length === 0 &&
			send.runnerId === runnerId &&
			run !== undefined &&
			run.phase !== "Ended"
		)
			// 3.6: retirement before any hold of its start leaves it never handed over.
			seal(transmit(world, send, undefined), {
				value: "never",
				unconsumed: false,
			});
	}
	for (const run of world.runs)
		if (
			run.phase !== "Ended" &&
			run.exec.evidence &&
			runSends(world, run).some((send) =>
				send.txs.some((tx) => addressed(send, tx)),
			)
		)
			run.exec.endedBy ??= "process_lost";
	for (const wake of world.wakes)
		if (onRunner(wake.label)) endWork(wake, "process_lost");
	for (const interaction of world.interactions)
		if (onRunner(interaction.label)) resolveInteraction(interaction);
}

function settle(
	world: World,
	step: Step,
	settlement: Extract<LedgerCommand, { verb: "settle" }>["settlement"],
): Outcome {
	switch (settlement.kind) {
		// 8.7: servers are the PortWatcher's session facts; the reference compares none (32.33.1).
		case "server_seen":
		case "server_gone":
			return noop("servers are not modelled by the reference");
		case "alarm_fired": {
			// 3.7: fire every deadline with at <= now, in deadline order, once.
			const due = deadlines(world, step).filter(
				(item) => item.at <= step.now && item.opened < world.step,
			);
			if (due.length === 0) return noop("nothing due");
			for (const item of due) item.fire();
			return changed;
		}
		case "hold_exhausted": {
			const send = [...world.sends]
				.reverse()
				.find((item) => item.held && item.commandId === settlement.commandId);
			if (send === undefined) return noop("unknown commandId (3.4)");
			// 4.3: settles the run failed with provider_send_attempts_exhausted.
			send.exhausted = true;
			for (const tx of send.txs) seal(tx);
			const latest = send.txs.at(-1);
			if (latest !== undefined) failInput(world, send, latest);
			return changed;
		}
		case "unheld_outcome": {
			const target = world.mainRuns.get(settlement.runId);
			const run = findRun(world, target?.runId);
			if (run === undefined) return noop("unknown token (3.4)");
			if (run.phase === "Ended")
				return noop("late evidence for an Ended Run (3.8)");
			let send =
				[...runSends(world, run)]
					.reverse()
					.find(
						(item) => item.held && item.commandId === settlement.commandId,
					) ??
				runSends(world, run).find(
					(item) => item.held && item.commandId === undefined,
				);
			if (send === undefined) return noop("unknown token (3.4)");
			// D50, F58: an unlaunched Run's next unheld try is main's relaunch, a new execution's transmission.
			if (run.phase === "Queued") {
				const { effect } = send;
				launch(run);
				send = issue(
					world,
					effect.kind === "start"
						? { ...effect, mode: nextMode(world) }
						: effect,
					true,
				);
			}
			send.commandId ??= settlement.commandId;
			const tx = transmit(world, send, undefined);
			effectOutcome(world, step, send, tx, settlement.outcome);
			tx.notSent ||= settlement.outcome.tag === "not_sent";
			return changed;
		}
		case "process_started": {
			const { runnerId, querySeq } = splitLabel(settlement.label);
			const prior = world.runners.get(runnerId);
			// L1: retired is final, and a live runner's start at or below its latest querySeq is an older label.
			if (
				isRetired(world, runnerId) ||
				(prior !== undefined &&
					world.current === runnerId &&
					querySeq <= splitLabel(prior.latest).querySeq)
			)
				return noop("an older label's process_started changes nothing (L1)");
			// L5, D44: the runner's previous label becomes older, so its scope ends.
			if (prior !== undefined && prior.latest !== settlement.label)
				decideLostWork(world, prior.latest);
			// Oracle edit (32.2.7), L1 totality (CONTRACT.md 346-349): another runner's
			// process_started is the process_lost of every other runner, started or not.
			for (const other of new Set([
				...world.runners.keys(),
				...world.sends.flatMap((send) => [
					send.runnerId,
					...send.txs.map((tx) => tx.runnerId),
				]),
			]))
				if (other !== null && other !== runnerId && !isRetired(world, other))
					retire(world, other);
			world.runners.set(runnerId, {
				latest: settlement.label,
				retired: false,
				tasks:
					settlement.reattached && reportsTasks(world.provider)
						? { tag: "Unknown", label: settlement.label }
						: { tag: "Known", label: settlement.label, tasks: [] },
			});
			world.current = runnerId;
			world.snapshotEntry++;
			// L2: a pending send resolves, once, to the next process_started's runner; a run_dispatched
			// naming a runner not yet started fixes the label of that runner's process_started.
			for (const send of world.sends)
				if (
					(send.runnerId === null && !send.dropped) ||
					(send.runnerId === runnerId && send.label === null)
				) {
					for (const tx of send.txs)
						if (tx.runnerId === send.runnerId && tx.label === null) {
							tx.runnerId = runnerId;
							tx.label = settlement.label;
						}
					send.runnerId = runnerId;
					send.label = settlement.label;
				}
			return changed;
		}
		case "process_lost": {
			const key = `${settlement.runnerId}\u0000${settlement.retiredAt}`;
			if (world.retirements.has(key))
				return noop("process_lost already folded (6.5)");
			world.retirements.add(key);
			retire(world, settlement.runnerId);
			return changed;
		}
		case "session_ended": {
			sessionEnd(world, world.seq, "session_ended");
			// L5, 8.4 (CONTRACT.md 2884-2885): session_ended ends the latest label's scope; an
			// end_session success ends no label's scope.
			const label = currentLabel(world);
			if (label !== null) decideLostWork(world, label);
			return changed;
		}
	}
}

function apply(world: World, command: LedgerCommand, step: Step): Outcome {
	switch (command.verb) {
		case "admit": {
			const prior = world.inputs.get(command.inputId);
			if (
				prior !== undefined &&
				findRun(world, prior.runId)?.phase !== "Ended" &&
				prior.runId !== undefined
			)
				return rejected("input already admitted to an active Run");
			const input: Input = {
				inputId: command.inputId,
				delivery: command.delivery,
			};
			world.inputs.set(command.inputId, input);
			const active = activeInputRun(world);
			if (command.delivery === "steer") {
				if (active !== undefined && active.phase === "Launched") {
					active.inputs.push(command.inputId);
					input.runId = active.runId;
				}
				return changed;
			}
			// D58, 3.4: main's handoff; main mints the Run id, so its run.requested reserves the Run.
			return changed;
		}
		case "observe": {
			const observation = command.observation;
			switch (observation.tag) {
				case "Answer":
					return answer(world, step, observation);
				case "Main":
					return mainEvent(world, observation);
				case "Unsolicited": {
					const raisedAt = world.snapshotEntry;
					const outcome = unsolicited(world, step, observation);
					// L1, D44: accepted evidence on a newer querySeq raises its runner's label, so it records.
					return outcome.tag === "Noop" && world.snapshotEntry !== raisedAt
						? { tag: "Changed", diagnostic: outcome.diagnostic }
						: outcome;
				}
			}
			break;
		}
		case "control":
			return control(world, step, command.control);
		case "settle":
			return settle(world, step, command.settlement);
	}
}

function emptyWorld(
	sessionId: string,
	provider: ProviderKind,
	mutation?: Mutation,
): World {
	return {
		sessionId,
		provider,
		mutation,
		step: 0,
		seq: 0,
		runs: [],
		inputs: new Map(),
		sends: [],
		tokens: new Map(),
		mainRuns: new Map(),
		seen: new Set(),
		freshSince: -1,
		runners: new Map(),
		current: null,
		retirements: new Set(),
		retiredUnstarted: new Set(),
		wakes: [],
		interactions: [],
		nativeCommands: [],
		lostWork: [],
		lostDecided: new Set(),
		snapshotEntry: 0,
	};
}

function run(
	world: World,
	entry: ReferenceEntry,
	newId: () => string,
): { outcome: Outcome; step: Step } {
	world.step++;
	const step: Step = {
		now: entry.now,
		policy: entry.policy,
		newId,
		effects: [],
		ended: [],
	};
	const outcome = apply(world, entry.command, step);
	if (outcome.tag === "Changed") reconcile(world, step);
	return { outcome, step };
}

/** Worlds are derived from entries; the cache only saves replay time. */
const worlds = new WeakMap<ReferenceState, World>();
function worldOf(state: ReferenceState): World {
	const cached = worlds.get(state);
	if (cached !== undefined) return cached;
	const world = emptyWorld(state.sessionId, state.provider, state.mutation);
	for (const entry of state.entries) {
		const ids = [...entry.ids];
		run(world, entry, () => ids.shift() ?? "");
	}
	worlds.set(state, world);
	return world;
}

export function initialSessionLedgerState(
	sessionId: string,
	provider: ProviderKind,
	mutation?: Mutation,
): ReferenceState {
	return { sessionId, provider, mutation, entries: [] };
}

export function decide(
	state: ReferenceState,
	command: LedgerCommand,
	ctx: DecideContext,
): Decision<ReferenceEntry> {
	const world = structuredClone(worldOf(state));
	const ids: string[] = [];
	const entry = { command, now: ctx.now, policy: ctx.policy, ids };
	const { outcome, step } = run(world, entry, () => {
		const id = ctx.newId();
		ids.push(id);
		return id;
	});
	if (outcome.tag === "Rejected") return outcome;
	const alarmAt = deadlines(world, step)[0]?.at;
	return {
		tag: "Accepted",
		events: outcome.tag === "Changed" ? [entry] : [],
		effects: step.effects,
		ended: step.ended,
		...(alarmAt === undefined ? {} : { alarmAt }),
		...(outcome.diagnostic === undefined
			? {}
			: { diagnostic: outcome.diagnostic }),
	};
}

export function evolve(
	state: ReferenceState,
	entry: ReferenceEntry,
): ReferenceState {
	const world = structuredClone(worldOf(state));
	const ids = [...entry.ids];
	run(world, entry, () => ids.shift() ?? "");
	const next = { ...state, entries: [...state.entries, entry] };
	worlds.set(next, world);
	return next;
}

function inputState(world: World, run: Run, inputId: string): InputState {
	const input = world.inputs.get(inputId);
	if (input?.failed !== undefined)
		return { tag: "Failed", reason: input.failed };
	const txs = deliverySends(world, run)
		.filter(
			(send) => "inputId" in send.effect && send.effect.inputId === inputId,
		)
		.flatMap((send) => send.txs);
	const accepted = txs.find((tx) => tx.consumption.tag === "Accepted");
	if (accepted !== undefined)
		return accepted.nativeMessageId === undefined
			? { tag: "Accepted" }
			: { tag: "Accepted", nativeMessageId: accepted.nativeMessageId };
	if (
		txs.some(
			(tx) => tx.transport.tag === "Unknown" && tx.consumption.tag === "None",
		)
	)
		return { tag: "Delivered", certainty: "unknown" };
	const latest = txs.at(-1);
	// A latest try not consumed (declined, absent, released, cancelled) waits as Queued (3.9).
	if (
		latest === undefined ||
		latest.notSent ||
		latest.unheld ||
		latest.consumption.tag === "NotConsumed"
	)
		return { tag: "Queued" };
	if (latest.consumption.tag === "Observed" || latest.transport.tag === "Sent")
		return { tag: "Delivered", certainty: "sent" };
	if (latest.transport.tag === "Unknown")
		return { tag: "Delivered", certainty: "unknown" };
	return latest.transport.tag === "Issued"
		? { tag: "Dispatching" }
		: { tag: "Queued" };
}

function activeView(world: World, run: Run): ActiveRunView {
	const head = {
		runId: run.runId,
		inputs: run.inputs.map((inputId) => ({
			inputId,
			state: inputState(world, run, inputId),
		})),
	};
	const origin =
		run.origin === "wake"
			? run.wakeTask === undefined
				? { origin: "wake" as const }
				: { origin: "wake" as const, wakeTask: run.wakeTask }
			: { origin: "input" as const };
	const stop = world.stop;
	const inStop =
		stop !== undefined &&
		stopOpen(world) &&
		!(run.origin === "wake" && world.provider === "claude") &&
		(run.phase === "Queued"
			? labelWorkOutstanding(world)
			: stop.items.some((item) =>
					item.tag === "wake"
						? world.wakes[item.wake]?.runId === run.runId
						: world.sends[item.send]?.runId === run.runId,
				));
	const deadline = inStop
		? { deadline: { owner: "Stop" as const, at: stop.at } }
		: {};
	if (run.phase === "Queued")
		return {
			...head,
			...origin,
			tag: "Queued",
			...deadline,
			...(run.retryAt === undefined ? {} : { retryAt: run.retryAt }),
		};
	if (run.phase === "Interrupting")
		return {
			...head,
			...origin,
			tag: "Interrupting",
			by: run.by ?? "stop",
			...deadline,
		};
	if (run.exec.settle !== undefined)
		return {
			...head,
			...origin,
			tag: "Settling",
			deadline: { owner: "Run", runId: run.runId, at: run.exec.settle.at },
		};
	return {
		...head,
		...origin,
		tag: run.exec.evidence ? "Running" : "Starting",
		...deadline,
	};
}

export function viewLedger(state: ReferenceState): LedgerView {
	const world = worldOf(state);
	const run = activeRun(world);
	const live: IssuedEffect[] = world.sends.flatMap((send): IssuedEffect[] => {
		const effect = send.effect;
		if (effect.kind === "probe") return [];
		const acting = send.txs.filter((tx) => mayStillAct(world, send, tx));
		// 3.13: decide's own effects are Tokened per transmission; every effect main issues is Main.
		if (effect.kind === "stop_task" || effect.kind === "cancel_request")
			return acting.flatMap((tx): IssuedEffect[] =>
				tx.token === undefined
					? []
					: [{ tag: "Tokened", token: tx.token, effect }],
			);
		return acting.length > 0 && send.commandId !== undefined
			? [{ tag: "Main", commandId: send.commandId, effect }]
			: [];
	});
	const tasks = taskView(world);
	const interactions = world.interactions.flatMap((item): InteractionView[] => {
		const send = item.deliveries.map((index) => world.sends[index]).at(-1);
		const delivery = send?.txs.at(-1);
		if (item.resolved && delivery === undefined) return [];
		// 3.10 (10B): a refused answer stays Pending, naming the transmission its retryable outcome
		// refused and that outcome's code, while its delivery retries.
		const named = send?.txs.filter((tx) => tx.token !== undefined).at(-1);
		const refused =
			!item.resolved &&
			send?.commandId !== undefined &&
			named?.n !== undefined &&
			named.consumption.tag !== "Accepted" &&
			named.retryable &&
			named.refusal !== undefined
				? {
						attempt: { commandId: send.commandId, transmission: named.n },
						code: named.refusal,
					}
				: undefined;
		if (delivery === undefined || refused !== undefined)
			return [
				{
					tag: "Pending",
					interactionId: item.interactionId,
					kind: item.kind,
					...(refused === undefined ? {} : { lastRefusal: refused }),
				},
			];
		return [
			{
				tag: "Answered",
				interactionId: item.interactionId,
				kind: item.kind,
				delivery:
					item.resolved || delivery.consumption.tag === "Accepted"
						? "settled"
						: delivery.transport.tag === "Sent"
							? "sent"
							: delivery.transport.tag === "Unknown"
								? "unknown"
								: "queued",
			},
		];
	});
	const nativeCommands = world.nativeCommands.map(
		(command): NativeCommandView => {
			// 8.5 (CONTRACT.md 2933-2934): Failed with the covering cause when covered.
			const covered = coveringCause(world, command);
			if (
				covered !== undefined &&
				command.state !== "Completed" &&
				command.state !== "Cancelled" &&
				command.state !== "Failed"
			)
				return { commandId: command.commandId, tag: "Failed", code: covered };
			switch (command.state) {
				case "Sent":
				case "Started":
					return command.deadline === undefined
						? { commandId: command.commandId, tag: "Queued" }
						: {
								commandId: command.commandId,
								tag: command.state,
								deadline: {
									owner: "NativeCommand",
									commandId: command.commandId,
									at: command.deadline.at,
								},
							};
				case "Failed":
					return {
						commandId: command.commandId,
						tag: "Failed",
						code: command.code ?? "failed",
					};
				default:
					return { commandId: command.commandId, tag: command.state };
			}
		},
	);
	const confirm = world.confirm;
	return {
		paused: false,
		...(run === undefined ? {} : { active: activeView(world, run) }),
		// D58: the oracle models no inbox; main's module computes it in T2.
		inbox: [],
		live,
		tasks,
		anythingMayAct:
			world.runs.some((item) => item.phase !== "Ended") ||
			live.length > 0 ||
			tasks.tag !== "none" ||
			world.wakes.some((wake) => wake.ended === undefined),
		...(confirm === undefined || tasks.tag === "none"
			? {}
			: {
					pendingConfirm: {
						step: confirm.step,
						labels:
							currentLabel(world) === null ? [] : [currentLabel(world) ?? ""],
						snapshotEntry: world.snapshotEntry,
						tasks,
					},
				}),
		lostWork: world.lostWork,
		nativeCommands,
		interactions,
	};
}
