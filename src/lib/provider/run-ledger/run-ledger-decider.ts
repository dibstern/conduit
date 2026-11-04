import type {
	ActiveRunView,
	Consumption,
	DecideContext,
	Decision,
	EndReason,
	Evidence,
	InputPlacement,
	InputState,
	InteractionView,
	InterruptBy,
	IssuedEffect,
	Label,
	LedgerCommand,
	LedgerView,
	LostWork,
	NativeCommandView,
	ProviderDecisionRules,
	ProviderKind,
	RunEffect,
	RunEnded,
	RunOutcome,
	SendToken,
	Server,
	Task,
	TaskKey,
	TasksView,
	Transport,
} from "./run-ledger-model.js";
import { nativePolicies } from "./run-ledger-policy-adapters.js";

declare const stateBrand: unique symbol;
declare const eventBrand: unique symbol;
export type SessionLedgerState = { readonly [stateBrand]: true };
export type LedgerEvent = { readonly [eventBrand]: true };

// ---------------------------------------------------------------------------------------------
// Book (3.3): evidence and conduit's decisions, each once. Only `record` writes it, on a draft
// copy, so every public function stays pure.

/** 3.6 reached test. */
type Value = "never" | "possibly" | "reached";

interface Tx {
	/** A control's claim is bound at its first outcome naming its transmission (3.4). */
	token?: SendToken | undefined;
	readonly seq: number;
	/** A control's claim number, per row from 1 (3.4, CONTRACT.md 449-455). */
	readonly n?: number | undefined;
	/** Its send's address, or the runner its run.dispatched names; null while pending (L2). */
	label: Label | null;
	runnerId: string | null;
	transport: Transport;
	consumption: Consumption;
	/** A runner-held try that ended before any hold (3.4): never handed over. */
	readonly unheld: boolean;
	notSent: boolean;
	/** run.released: the runner returned the hold unconsumed (4.11). */
	released: boolean;
	/** D48: a rejected resume's start never reached the agent and starts the next one fresh. */
	resumeRejected: boolean;
	/** Stop's own outcome (4.8, 9): never retried, never fails an input. */
	stopOwn: boolean;
	retryable: boolean;
	permanent?: string | undefined;
	retryAt?: number | undefined;
	/** 3.10 lastRefusal: a retryable outcome's code. */
	refusal?: string | undefined;
	declined: boolean;
	/** 9: an input_absent finding; a later acceptance beats it. */
	absent: boolean;
	/** A result answered it (3.8 5C: proof after an unknown delivery). */
	resulted: boolean;
	/** L1 item 1, 3.4: its coverage, recorded whatever its tries got, so after its work ended too (3.8 reason 2.3). */
	covered?: "process_lost" | "session_ended" | undefined;
	/** The first delivery-recovery probe's deadline (3.7, D20). */
	recovery?: { readonly at: number; readonly opened: number } | undefined;
	/** Its answers, the evidence section 9's work-ended column reads. */
	readonly answers: Evidence[];
	/** D52: sealed at its first closing fact, reading its value then. */
	sealed?: { readonly value: Value; readonly unconsumed: boolean } | undefined;
	/**
	 * Why its work ended (3.5): its evidence, main's terminal (D59), coverage, an unlaunch or the
	 * ledger stop deadline's alarm (L6).
	 */
	ended?:
		| "evidence"
		| "main"
		| "process_lost"
		| "session_ended"
		| "dropped"
		| "forced"
		| undefined;
	/** D59: main's terminal ended its Run, but this OpenCode abort or cancel_request stays a fence member (3101-3106). */
	mainEnded?: boolean | undefined;
	nativeMessageId?: string | undefined;
	accounted: boolean;
}

type StartEffect = Extract<RunEffect, { kind: "start" }>;
type SteerEffect = Extract<RunEffect, { kind: "steer" }>;
type ProbeEffect = Extract<RunEffect, { kind: "probe" }>;
type ControlEffect = Extract<
	RunEffect,
	{
		kind:
			| "interrupt"
			| "end_session"
			| "cancel_request"
			| "deliver_answer"
			| "stop_task"
			| "send_native_command";
	}
>;
type SendEffect = StartEffect | SteerEffect | ProbeEffect | ControlEffect;

/** A probe's target and what it covers, stored at issue (3.7, 3.12). */
interface Probe {
	readonly target: ProbeEffect["target"];
	/** The transmission an input probe recovers. */
	readonly subject?: { readonly send: number; readonly tx: number } | undefined;
	deadline?: { readonly at: number; readonly opened: number } | undefined;
	done: boolean;
}

/**
 * Send (issue decision, 3.3): a start or steer main issues (D60), a Stop's interrupt, an
 * end_session or an answer's deliver_answer main issues under its Control, or a probe or
 * cancel_request decide issues (3.12).
 */
interface Send<Effect extends SendEffect = SendEffect> {
	readonly seq: number;
	readonly effect: Effect;
	readonly held: boolean;
	commandId?: string | undefined;
	/** Its Run, null for a send no Run reads (an idle Stop's, a Run-less end_session). */
	readonly runId: string | null;
	/** Its execution (3.3). */
	readonly exec: number;
	/** L2 case 3: the current process at issue, null while pending, then resolved once. */
	runnerId: string | null;
	label: Label | null;
	/** L2 case 2: the seq of the pending start it follows, resolving with it. */
	readonly follows?: number | undefined;
	/** L2, 3.6: a send of an execution an unlaunch dropped resolves no further. */
	dropped: boolean;
	readonly txs: Tx[];
	/** 4.3: hold_exhausted settled it failed at the cap. */
	exhausted: boolean;
	probe?: Probe | undefined;
}

/** 3.10: an interaction is its label's, Pending until resolved; the first answer wins. */
interface Interaction {
	readonly interactionId: string;
	readonly kind: "permission" | "question";
	readonly label: Label;
	answer?: unknown;
	/** Its deliver_answer sends, by index. */
	readonly deliveries: number[];
	resolved: boolean;
}

/** D53, 3.9: an admitted input; its reservation is main's first run.requested runId for it. */
interface Input {
	readonly delivery: "queue" | "steer";
	runId?: string | undefined;
	failed?: string | undefined;
	reservation?: string | undefined;
}

interface FoldItem {
	readonly seq: number;
	readonly outcome: RunOutcome;
	readonly code?: string | undefined;
	readonly retryable: boolean;
}

/** Execution (launch decision, 3.3) and its evidence. */
interface Exec {
	readonly n: number;
	evidence: boolean;
	activity: boolean;
	result: boolean;
	afterResult: boolean;
	endEvidence: boolean;
	endedBy?: "process_lost" | "session_ended" | undefined;
	/** 3.7: Settling, fixed at the result; `opened` is the entry that opened it. */
	settle?: { readonly at: number; readonly opened: number } | undefined;
	readonly fold: FoldItem[];
}

/** Run (decisions only, 3.3); a wake Run's id is decide's (8.3). */
interface Run {
	readonly runId: string;
	readonly origin: "input" | "wake";
	readonly wakeTask?: TaskKey | undefined;
	/** 8.3: the labels whose wake executions are this wake Run's, oldest first. */
	readonly wakeLabels: Label[];
	readonly inputs: string[];
	phase: "Queued" | "Launched" | "Interrupting" | "Ended";
	/** 3.6: a Stop, Run now or end commit asked it to stop; its retries are withdrawn. */
	asked: boolean;
	/** The commit that made it Interrupting. */
	by?: InterruptBy | undefined;
	exec: Exec;
	/** 3.6: after an unlaunch, the unlaunching outcome's retryAt (a field, not a deadline). */
	retryAt?: number | undefined;
	/** The Tombstone (3.8). */
	ended?: Pick<RunEnded, "outcome" | "reason"> | undefined;
}

/** 8.3: a label's wake execution, from its turn_started to its own end or coverage. */
interface Wake {
	readonly label: Label;
	/** A repeat turn_started with no active Run re-arms it under the wake Run (CONTRACT.md 2837-2840). */
	runId?: string | undefined;
	/** Its turn_started's issue order; an end_session success covers only work before it (3.4). */
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

/** 8.5: a native command, a projection of its send. */
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
	/** Time left while the provider reports it queued; the deadline resumes with it (8.5). */
	remaining: number;
	deadline?: { readonly at: number; readonly opened: number } | undefined;
}

/** 8.4, D44: a runner's latest snapshot and its label; a raised label's tasks are unknown. */
type TaskState =
	| { readonly tag: "Unknown"; readonly label: Label }
	| { readonly tag: "Known"; readonly label: Label; readonly tasks: Task[] };

/** L6: a stop item is a transmission, or a wake execution by index. */
type StopItem =
	| { readonly send: number; readonly tx: number }
	| { readonly wake: number };

interface Book {
	readonly sessionId: string;
	readonly provider: ProviderKind;
	/** Fact entries recorded; a deadline is due only at a later entry (3.7). */
	entry: number;
	/** Issue order of sends and transmissions (3.4 freshness, 10A). */
	seq: number;
	readonly runs: Run[];
	readonly inputs: Map<string, Input>;
	readonly sends: Send[];
	/** Cache written only by record (3.2). */
	readonly tokens: Map<string, { readonly send: number; readonly tx: number }>;
	/** `steer`: a joined steer's own run, not yet started; its end is the steer's, not its Run's (4.8). */
	readonly mainRuns: Map<
		string,
		{ readonly runId: string; open: boolean; readonly steer?: true }
	>;
	readonly seen: Set<string>;
	/** The seq of the last session end or rejected resume (3.4). */
	freshSince: number;
	/** L1: a runner retired before it started has no label. */
	readonly runners: Map<
		string,
		| { readonly retired: false; latest: Label; tasks: TaskState }
		| { readonly retired: true; readonly latest: Label | null }
	>;
	current: string | null;
	readonly retirements: Set<string>;
	readonly interactions: Interaction[];
	readonly wakes: Wake[];
	readonly nativeCommands: NativeCommandRec[];
	/** 8.3: the latest notification's task, a wake Run's wakeTask when its turn_started names none. */
	lastNotified?: TaskKey | undefined;
	/** L6: the one ledger stop deadline, over transmissions and wake executions. */
	stop?:
		| {
				readonly at: number;
				readonly opened: number;
				readonly items: StopItem[];
		  }
		| undefined;
	/** L5: lost work in record order, and each label decided once. */
	readonly lostWork: LostWork[];
	readonly lostDecided: Set<Label>;
	/** 8.4 (L3): the confirm gate holds only its step; D43 drops it with its Run. */
	confirm?:
		| {
				readonly step: "retire" | "end_session";
				readonly runId?: string | undefined;
				readonly commandId?: string | undefined;
		  }
		| undefined;
	/** 8.4, D45: raised by every non-older snapshot, process_started and raised label. */
	snapshotEntry: number;
	/** 8.7: by port; only server_gone removes one (8.2). */
	readonly servers: Map<number, Server>;
}

/**
 * LedgerEvent is one entry (3.2): a fact (the command with the time and policy it was decided
 * under, and the ids it minted) or a decision `reconcile` made from the views.
 */
type Entry =
	| {
			readonly kind: "fact";
			readonly command: LedgerCommand;
			readonly now: number;
			readonly policy: DecideContext["policy"];
			readonly ids: readonly string[];
	  }
	| ({ readonly kind: "end"; readonly runId: string } & Pick<
			RunEnded,
			"outcome" | "reason"
	  >)
	| { readonly kind: "unlaunch"; readonly runId: string }
	| { readonly kind: "release" };
type Fact = Extract<Entry, { kind: "fact" }>;
/** A fact's minting: decide draws ids from ctx.newId, evolve replays the entry's (3.2, 3.12). */
interface Step {
	readonly newId: () => string;
	readonly effects: IssuedEffect[];
}

type Outcome =
	| { readonly tag: "Changed" }
	| { readonly tag: "Noop"; readonly diagnostic?: string | undefined }
	| { readonly tag: "Rejected"; readonly diagnostic: string };
const changed: Outcome = { tag: "Changed" };
const sameServer = (a: Server["key"], b: Server["key"]) =>
	a.pid === b.pid && a.startedAt === b.startedAt && a.port === b.port;
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

/** L1: split at the last `:` when a decimal querySeq follows. */
function splitLabel(label: Label): { runnerId: string; querySeq: number } {
	const at = label.lastIndexOf(":");
	const suffix = label.slice(at + 1);
	return at >= 0 && /^\d+$/.test(suffix)
		? { runnerId: label.slice(0, at), querySeq: Number(suffix) }
		: { runnerId: label, querySeq: 0 };
}

function value(tx: Tx): Value {
	if (tx.consumption.tag === "Observed" || tx.consumption.tag === "Accepted")
		return "reached";
	return tx.unheld || tx.notSent || tx.released || tx.resumeRejected
		? "never"
		: "possibly";
}
function unconsumed(tx: Tx): boolean {
	if (value(tx) !== "possibly") return false;
	return tx.consumption.tag === "NotConsumed"
		? tx.consumption.why !== "released"
		: tx.retryable || tx.permanent !== undefined;
}
function seal(tx: Tx): void {
	tx.sealed ??= { value: value(tx), unconsumed: unconsumed(tx) };
}
const sealedValue = (tx: Tx): Value => tx.sealed?.value ?? value(tx);

/** 3.5 mayStillAct; a probe only reads, so its work has always ended (8.3, D31). */
function mayStillAct(book: Book, send: Send, tx: Tx): boolean {
	const effect = send.effect;
	if (tx.ended !== undefined || effect.kind === "probe") return false;
	// 3.10: an answer's work ends when its interaction resolves.
	if (
		effect.kind === "deliver_answer" &&
		interactionOf(book, effect.interactionId)?.resolved !== false
	)
		return false;
	// 3.5, 8.4: a stop_task's work is its task, ended once the task is neither live nor unknown.
	if (effect.kind === "stop_task") {
		const tasks = taskView(book);
		if (
			tasks.tag === "none" ||
			(tasks.tag === "live" &&
				!tasks.tasks.some((task) => sameKey(task.key, effect.key)))
		)
			return false;
	}
	// 8.5: a native command's work ends at its completion, cancellation or failure. Gap (CONTRACT.md
	// 2930-2934): Codex sends no receipts, so only coverage or a permanent outcome finishes its send.
	if (effect.kind === "send_native_command") {
		const state = book.nativeCommands.find(
			(item) => item.commandId === effect.commandId,
		)?.state;
		if (
			state === undefined ||
			state === "Completed" ||
			state === "Cancelled" ||
			state === "Failed"
		)
			return false;
	}
	// D59: a runner provider's interrupt is no fence member; its work ends with the Run it names.
	if (
		effect.kind === "interrupt" &&
		!rules(book).fences(effect) &&
		findRun(book, effect.runId)?.phase !== "Interrupting"
	)
		return false;
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

const findRun = (book: Book, runId: string | null | undefined) =>
	runId === null || runId === undefined
		? undefined
		: book.runs.find((run) => run.runId === runId);
/** The sends of the Run's current execution (3.6). */
const runSends = (book: Book, run: Run) =>
	book.sends.filter(
		(send) => send.runId === run.runId && send.exec === run.exec.n,
	);
const isStart = (send: Send): send is Send<StartEffect> =>
	send.effect.kind === "start";
/** A start or steer: a send that delivers an input (3.6, 3.9). */
const delivers = (send: Send): send is Send<StartEffect | SteerEffect> =>
	send.effect.kind === "start" || send.effect.kind === "steer";
/** Its starts and steers (3.6); a Run's end waits for no probe (3.8 condition 2). */
const deliverySends = (book: Book, run: Run) =>
	runSends(book, run).filter(delivers);
const interactionOf = (book: Book, interactionId: string) =>
	book.interactions.find((item) => item.interactionId === interactionId);
/** 3.10: one of the interaction's answer deliveries may still act. */
const delivering = (book: Book, interaction: Interaction) =>
	interaction.deliveries.some((index) => {
		const send = book.sends[index];
		return send?.txs.some((tx) => mayStillAct(book, send, tx)) === true;
	});
const activeInputRun = (book: Book) =>
	book.runs.find((run) => run.phase !== "Ended" && run.origin === "input");
const activeWakeRun = (book: Book) =>
	book.runs.find((run) => run.phase !== "Ended" && run.origin === "wake");
/** The Run the view and a commit read: the input Run, else the wake Run (8.3). */
const activeRun = (book: Book) => activeInputRun(book) ?? activeWakeRun(book);
const sameKey = (a: TaskKey, b: TaskKey) =>
	a.taskId === b.taskId && a.runId === b.runId;
/** 8.4: the current runner's tasks; a pending address has none. */
function taskView(book: Book): TasksView {
	const runner =
		book.current === null ? undefined : book.runners.get(book.current);
	if (
		runner === undefined ||
		runner.retired ||
		!nativePolicies[book.provider].capabilities.backgroundTasks
	)
		return { tag: "none" };
	if (runner.tasks.tag === "Unknown" || runner.tasks.label !== runner.latest)
		return { tag: "unknown", label: runner.latest };
	if (runner.tasks.tasks.length === 0) return { tag: "none" };
	// 8.2 (CONTRACT.md 2780-2782): a work task with a live linked server and no declared awaited
	// covering it is serving; derived here so it falls back the moment server_gone lands.
	const linked = [...book.servers.values()];
	const serving = (task: Task) => {
		const own = linked.filter(
			(server) => server.taskKey && sameKey(server.taskKey, task.key),
		);
		return own.length > 0 && own.every((server) => server.role !== "awaited");
	};
	return {
		tag: "live",
		label: runner.latest,
		tasks: runner.tasks.tasks.map((task) =>
			task.class === "work" && serving(task)
				? { ...task, class: "serving" }
				: task,
		),
	};
}
/**
 * L5: a label's lost work is decided once, when its scope first ends: its live tasks, unknown
 * tasks for a provider that reports them, and none for a label known to be empty.
 */
function decideLostWork(book: Book, label: Label): void {
	if (book.lostDecided.has(label)) return;
	book.lostDecided.add(label);
	const runner = book.runners.get(splitLabel(label).runnerId);
	const tasks = runner?.retired === false ? runner.tasks : undefined;
	if (tasks === undefined || tasks.tag === "Unknown" || tasks.label !== label) {
		if (nativePolicies[book.provider].capabilities.backgroundTasks)
			book.lostWork.push({ label, tag: "unknown" });
	} else if (tasks.tasks.length > 0)
		book.lostWork.push({ label, tag: "known", tasks: tasks.tasks });
}
const currentLabel = (book: Book): Label | null =>
	book.current === null
		? null
		: (book.runners.get(book.current)?.latest ?? null);
/** 3.8 condition 2's work: no probe, answer or end_session, nor a runner provider's interrupt (D59, 3.10). */
const runWork = (book: Book, run: Run) =>
	runSends(book, run).filter(
		(send) =>
			send.effect.kind !== "probe" &&
			send.effect.kind !== "deliver_answer" &&
			send.effect.kind !== "end_session" &&
			(send.effect.kind !== "interrupt" || rules(book).fences(send.effect)),
	);
/** A claim's own transmission, minted at its run.requested and not yet sent (2.1 rows 202, 212). */
const claimOf = (tx: Tx, claim: string | undefined) =>
	claim !== undefined &&
	tx.token === claim &&
	tx.transport.tag === "Issued" &&
	tx.consumption.tag === "None";
/** L6: label work, the fence members that may still act; a claim's own transmission aside. */
const labelWorkOutstanding = (book: Book, claim?: string) =>
	book.wakes.some((wake) => wake.ended === undefined) ||
	book.sends.some(
		(send) =>
			rules(book).fences(send.effect) &&
			send.txs.some((tx) => !claimOf(tx, claim) && mayStillAct(book, send, tx)),
	);

// ---------------------------------------------------------------------------------------------
// read (3.2): every summary reconcile and the view act on.

const sendValue = (send: Send): Value => {
	const values = send.txs.map(sealedValue);
	return values.includes("reached")
		? "reached"
		: values.includes("possibly")
			? "possibly"
			: "never";
};
const sendUnconsumed = (send: Send): boolean =>
	sendValue(send) === "possibly" &&
	send.txs
		.filter((tx) => sealedValue(tx) === "possibly")
		.every((tx) => tx.sealed?.unconsumed ?? unconsumed(tx));

/** 3.6 D50: Launched with every start and steer never handed over, and no execution evidence. */
function notYetDelivered(book: Book, run: Run): boolean {
	return (
		run.phase === "Queued" ||
		(!run.exec.evidence &&
			deliverySends(book, run).every((send) => sendValue(send) === "never"))
	);
}

/**
 * 3.6 retry pending: from a retrying outcome until its next transmission, an acceptance, Stop or
 * the end. A Stop, Run now or end commit asks the Run, which withdraws every retry of its sends.
 */
function retryPending(book: Book, run: Run, send: Send): boolean {
	const latest = send.txs.at(-1);
	if (
		run.asked ||
		send.exhausted ||
		latest?.sealed === undefined ||
		(latest.ended !== undefined && latest.ended !== "evidence") ||
		latest.mainEnded ||
		latest.resumeRejected ||
		latest.stopOwn ||
		send.txs.some((tx) => tx.consumption.tag === "Accepted") ||
		notYetDelivered(book, run)
	)
		return false;
	return (
		latest.notSent ||
		latest.unheld ||
		latest.released ||
		(latest.declined && isStart(send)) ||
		latest.absent ||
		(latest.retryable && latest.consumption.tag === "None")
	);
}

/** 3.8 outcome fold (5C, 10A): failure beats success, specific beats generic, completion beats an interrupt. */
function fold(
	items: readonly FoldItem[],
	asked: boolean,
): Pick<RunEnded, "outcome" | "reason"> {
	const failure = items
		.filter((item) => item.outcome === "error")
		.sort(
			(a, b) =>
				Number(a.code === undefined) - Number(b.code === undefined) ||
				a.seq - b.seq ||
				(a.code ?? "").localeCompare(b.code ?? ""),
		)[0];
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
	// 3.8 condition 1: an asked Run keeps the interrupt fallback.
	return asked || items.some((item) => item.outcome === "interrupted")
		? { outcome: "interrupted", reason: { tag: "interrupted", forced: false } }
		: { outcome: "completed", reason: { tag: "completed" } };
}

/** 3.8 condition 2: a send with no transmission is sealed once its Run was asked (3.6). */
function nothingMayAct(book: Book, run: Run): boolean {
	const exec = run.exec;
	return (
		deliverySends(book, run).every((send) => {
			const latest = send.txs.at(-1);
			return latest === undefined ? run.asked : latest.sealed !== undefined;
		}) &&
		runWork(book, run).every(
			(send) =>
				!send.txs.some((tx) => !tx.mainEnded && mayStillAct(book, send, tx)) &&
				!retryPending(book, run, send),
		) &&
		!(exec.evidence && !exec.endEvidence && exec.endedBy === undefined)
	);
}

/** What 3.6 and 3.8 read of one Run not Ended. */
interface RunSummary {
	readonly runId: string;
	readonly queued: boolean;
	/** A Stop, Run now or end commit asked it (3.6). */
	readonly asked: boolean;
	/** Reason 2.1: asked, or a start cancelled before it started (9). */
	readonly interrupted: boolean;
	/** L6: its work's end was forced by the ledger stop deadline's alarm. */
	readonly forced: boolean;
	/** Condition 1: Run-end evidence recorded with authority. */
	readonly endEvidence: boolean;
	/** GAP 5: no result and main's run still open. */
	readonly awaiting: boolean;
	/** Condition 2. */
	readonly nothingMayAct: boolean;
	readonly notYetDelivered: boolean;
	/** Reason 2.2's first specific permanent code (10A). */
	readonly refusal?: string | undefined;
	/** Reason 2.2: each send is never handed over or unconsumed. */
	readonly refused: boolean;
	/** Reason 2.3: the covering cause, session ended before process lost. */
	readonly covered?: "process_lost" | "session_ended" | undefined;
	readonly fold: Pick<RunEnded, "outcome" | "reason">;
	/** 8.3: a wake Run ends only with its latest label's wake execution, by that end. */
	readonly wake?:
		| { readonly ended?: Pick<RunEnded, "outcome" | "reason"> | undefined }
		| undefined;
}

/** 8.3: a wake Run's end, read from its latest label's wake execution. */
function wakeEnd(
	book: Book,
	run: Run,
): Pick<RunEnded, "outcome" | "reason"> | undefined {
	const latest = run.wakeLabels.at(-1);
	const wake = book.wakes
		.filter((item) => item.label === latest && item.runId === run.runId)
		.at(-1);
	if (wake?.older) return undefined;
	switch (wake?.ended) {
		case undefined:
			return undefined;
		case "process_lost":
		case "session_ended":
			return { outcome: "error", reason: { tag: wake.ended } };
		case "forced":
			return {
				outcome: "interrupted",
				reason: { tag: "interrupted", forced: true },
			};
		default:
			// D59, 3.8 reason 2.1: a wake ended with no result after a Stop reads interrupted.
			return fold(wake?.outcome === undefined ? [] : [wake.outcome], run.asked);
	}
}

function summarize(book: Book, run: Run): RunSummary {
	const sends = deliverySends(book, run);
	const exec = run.exec;
	const mains = [...book.mainRuns.values()].filter(
		(main) => main.runId === run.runId,
	);
	const awaiting =
		!exec.result && mains.length > 0 && mains.every((main) => main.open);
	const txs = sends.flatMap((send) => send.txs);
	const covers = txs
		.filter((tx) => sealedValue(tx) !== "never")
		.map((tx) => tx.covered);
	const covered =
		covers.includes("session_ended") || exec.endedBy === "session_ended"
			? "session_ended"
			: covers.includes("process_lost") || exec.endedBy === "process_lost"
				? "process_lost"
				: undefined;
	return {
		runId: run.runId,
		queued: run.phase === "Queued",
		asked: run.asked,
		interrupted:
			run.asked ||
			txs.some(
				(tx) =>
					tx.consumption.tag === "NotConsumed" &&
					tx.consumption.why === "cancelled",
			),
		forced: runWork(book, run).some((send) =>
			send.txs.some((tx) => tx.ended === "forced"),
		),
		endEvidence: exec.endEvidence,
		awaiting,
		nothingMayAct: nothingMayAct(book, run),
		notYetDelivered: notYetDelivered(book, run),
		// 4.3: the cap's refusal, else the first specific permanent code.
		refusal: sends.some((send) => send.exhausted)
			? "provider_send_attempts_exhausted"
			: txs
					.filter((tx) => tx.permanent !== undefined && !tx.resumeRejected)
					.sort((a, b) => a.seq - b.seq)[0]?.permanent,
		refused: sends.every(
			(send) => sendValue(send) === "never" || sendUnconsumed(send),
		),
		covered,
		// 3.8 5C: delivery_unknown with no later proof is a failure coded delivery_indeterminate.
		fold: fold(
			[
				...exec.fold,
				...txs
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
			],
			run.asked,
		),
		...(run.origin === "wake" ? { wake: { ended: wakeEnd(book, run) } } : {}),
	};
}

interface Due {
	readonly at: number;
	readonly opened: number;
	readonly fire: (fact: Fact, step: Step) => void;
}

/** L6: a stop item is open while its transmission may still act. */
function stopItemOpen(book: Book, item: StopItem): boolean {
	if ("wake" in item) return book.wakes[item.wake]?.ended === undefined;
	const send = book.sends[item.send];
	const tx = send?.txs[item.tx];
	return send !== undefined && tx !== undefined && mayStillAct(book, send, tx);
}
/** 8.5: what covers a native command, its send's session_ended or process_lost, if anything. */
function coveringCause(book: Book, command: NativeCommandRec) {
	const covers = (book.sends[command.send]?.txs ?? []).map((tx) => tx.ended);
	return covers.includes("session_ended")
		? "session_ended"
		: covers.includes("process_lost")
			? "process_lost"
			: undefined;
}

const stopOpen = (book: Book) =>
	book.stop?.items.some((item) => stopItemOpen(book, item)) ?? false;

/** 3.7: every open deadline with its firing, in deadline then opening order. */
function deadlines(book: Book): Due[] {
	const due: Due[] = [];
	const stop = book.stop;
	if (stop !== undefined && stopOpen(book))
		due.push({
			at: stop.at,
			opened: stop.opened,
			fire: () => {
				// L6: the alarm forces only work no observer ended, and kills nothing.
				for (const item of stop.items) {
					if (!stopItemOpen(book, item)) continue;
					const forced =
						"wake" in item
							? book.wakes[item.wake]
							: book.sends[item.send]?.txs[item.tx];
					if (forced !== undefined) forced.ended = "forced";
				}
				book.stop = undefined;
			},
		});
	for (const run of book.runs) {
		const settle = run.exec.settle;
		if (run.phase !== "Ended" && settle !== undefined)
			due.push({
				...settle,
				fire: (fact, step) => {
					// 3.7: Settling's expiry probes native_session; the view then reads Running (3.6).
					run.exec.settle = undefined;
					probe(book, fact, step, run.runId, { tag: "native_session" });
				},
			});
	}
	for (const send of book.sends) {
		const pending = send.probe;
		// Gap (CONTRACT.md 1876, "probes follow 3.7"): a probe's retries do not stop when its Run
		// ends; it goes on to its cap or its answer, as the oracle does.
		if (pending?.deadline !== undefined && !pending.done)
			due.push({
				...pending.deadline,
				fire: (fact, step) => reprobe(book, fact, step, send, pending),
			});
		if (!delivers(send)) continue;
		for (const tx of send.txs) {
			const recovery = tx.recovery;
			if (recovery !== undefined)
				due.push({
					...recovery,
					fire: (fact, step) => {
						tx.recovery = undefined;
						const run = findRun(book, send.runId);
						// 3.7, D20: it probes only an input nothing answered since and whose work goes on.
						if (
							consumptionRank[tx.consumption.tag] >= 1 ||
							tx.ended !== undefined ||
							run === undefined
						)
							return;
						probe(
							book,
							fact,
							step,
							run.runId,
							{ tag: "input", inputId: send.effect.inputId },
							{ send: book.sends.indexOf(send), tx: send.txs.indexOf(tx) },
						);
					},
				});
		}
	}
	// 8.5 (CONTRACT.md 2795-2796): only a waiting command carries a deadline, never a covered one;
	// it drives only its view.
	for (const command of book.nativeCommands)
		if (
			command.deadline !== undefined &&
			coveringCause(book, command) === undefined
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

function read(book: Book) {
	return {
		runs: book.runs.flatMap((run) =>
			run.phase === "Ended" ? [] : [summarize(book, run)],
		),
		alarmAt: deadlines(book)[0]?.at,
		// 8.4: a gate whose tasks are neither live nor unknown releases.
		release: book.confirm !== undefined && taskView(book).tag === "none",
	};
}

// ---------------------------------------------------------------------------------------------
// reconcile (3.2): reads only `read`'s output and returns the next decision, or none.

function reconcile(situation: ReturnType<typeof read>): Entry | undefined {
	const end = (
		runId: string,
		ended: Pick<RunEnded, "outcome" | "reason">,
	): Entry => ({ kind: "end", runId, ...ended });
	const interrupted = (
		forced: boolean,
	): Pick<RunEnded, "outcome" | "reason"> => ({
		outcome: "interrupted",
		reason: { tag: "interrupted", forced },
	});
	for (const run of situation.runs) {
		// 3.6: a Run not yet launched ends interrupted at its commit.
		if (run.queued) {
			if (run.asked) return end(run.runId, interrupted(false));
			continue;
		}
		if (run.wake !== undefined) {
			if (run.wake.ended !== undefined) return end(run.runId, run.wake.ended);
			continue;
		}
		if (run.endEvidence && !run.awaiting) return end(run.runId, run.fold);
		if (!run.nothingMayAct) continue;
		// D48: a permanent outcome on an undelivered start ends it refused; else D50 unlaunches.
		if (run.notYetDelivered && !run.asked)
			return run.refusal === undefined
				? { kind: "unlaunch", runId: run.runId }
				: end(run.runId, {
						outcome: "error",
						reason: { tag: "refused", code: run.refusal },
					});
		if (run.interrupted) return end(run.runId, interrupted(run.forced));
		if (run.refusal !== undefined && run.refused)
			return end(run.runId, {
				outcome: "error",
				reason: { tag: "refused", code: run.refusal },
			});
		if (run.covered !== undefined) {
			const reason: EndReason =
				run.fold.reason.tag === "provider_error"
					? { tag: run.covered, code: run.fold.reason.code }
					: { tag: run.covered };
			return end(run.runId, { outcome: "error", reason });
		}
		if (!run.awaiting) return end(run.runId, run.fold);
	}
	// 8.4: after the Run decisions, as an ended Run drops its gate first (D43).
	return situation.release ? { kind: "release" } : undefined;
}

// ---------------------------------------------------------------------------------------------
// record (3.2): the only writer.

const newExec = (n: number): Exec => ({
	n,
	evidence: false,
	activity: false,
	result: false,
	afterResult: false,
	endEvidence: false,
	fold: [],
});

function transmit(
	book: Book,
	send: Send,
	token: SendToken | undefined,
	runnerId: string | null = send.runnerId,
	label: Label | null = send.label,
): Tx {
	const tx: Tx = {
		token,
		seq: book.seq++,
		label,
		runnerId,
		transport: { tag: "Issued" },
		consumption: { tag: "None" },
		unheld: token === undefined && send.held,
		// 3.4 (CONTRACT.md 449-455): a control's claims count per row, n from 1.
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
		answers: [],
		accounted: false,
	};
	send.txs.push(tx);
	// L1 item 1, L2: a transmission to a retired address is covered at once.
	if (runnerId !== null && book.runners.get(runnerId)?.retired) {
		seal(tx);
		tx.covered ??= "process_lost";
		tx.ended ??= "process_lost";
	}
	if (token !== undefined)
		book.tokens.set(token, {
			send: book.sends.indexOf(send),
			tx: send.txs.length - 1,
		});
	return tx;
}

/** 3.4: fresh until a start since the last session end or rejected resume may have reached. */
const nextMode = (book: Book): "fresh" | "resume" =>
	book.sends.some(
		(send) =>
			isStart(send) &&
			send.seq > book.freshSince &&
			send.txs.some((tx) => value(tx) !== "never"),
	)
		? "resume"
		: "fresh";

/**
 * L2: a send's address at issue. Case 2: a send for a Run with an execution, on a runner-host
 * provider, goes to that execution's runner, pending while its start is; a wake Run's runner is
 * its latest turn_started label's. Case 3: every other send (every OpenCode send) goes to the
 * current process, or pending with none.
 */
function addressAt(
	book: Book,
	run: Run | undefined,
): Pick<Send, "runnerId" | "label" | "follows"> {
	if (
		run !== undefined &&
		run.phase !== "Queued" &&
		nativePolicies[book.provider].capabilities.runnerHost
	) {
		const wake = run.wakeLabels.at(-1);
		const start = runSends(book, run).find(
			(send) => isStart(send) && !send.dropped,
		);
		const runnerId =
			wake === undefined ? start?.runnerId : splitLabel(wake).runnerId;
		if (start !== undefined && runnerId === null)
			return { runnerId: null, label: null, follows: start.seq };
		if (runnerId !== undefined && runnerId !== null)
			return {
				runnerId,
				label: book.runners.get(runnerId)?.latest ?? null,
			};
	}
	return { runnerId: book.current, label: currentLabel(book) };
}

function issue<Effect extends SendEffect>(
	book: Book,
	effect: Effect,
	held: boolean,
): Send<Effect> {
	const run = findRun(book, "runId" in effect ? effect.runId : null);
	const send: Send<Effect> = {
		seq: book.seq++,
		effect,
		held,
		runId: run?.runId ?? null,
		exec: run?.exec.n ?? 0,
		...addressAt(book, run),
		dropped: false,
		txs: [],
		exhausted: false,
	};
	book.sends.push(send);
	// L1 item 1, L2: a held send addressed to a retired runner is covered at issue, never handed over.
	if (
		held &&
		send.runnerId !== null &&
		book.runners.get(send.runnerId)?.retired
	)
		transmit(book, send, undefined).sealed = {
			value: "never",
			unconsumed: false,
		};
	return send;
}

/**
 * 3.4: an effect main issues with no hold, under its Control's commandId; its first claim is open,
 * named only at its outcome, and may act until then (3.5).
 */
function issueControl(
	book: Book,
	effect: ControlEffect,
	commandId: string,
): Send {
	const send = issue(book, effect, false);
	send.commandId = commandId;
	transmit(book, send, undefined);
	return send;
}

/** A cancel_request or stop_task decide issues, Tokened from ctx.newId (3.12, 3.13). */
function issueTokened(
	book: Book,
	step: Step,
	effect: Extract<ControlEffect, { kind: "cancel_request" | "stop_task" }>,
): void {
	const send = issue(book, effect, false);
	const token = step.newId() as SendToken;
	transmit(book, send, token);
	step.effects.push({ tag: "Tokened", token, effect });
}

/** 3.7: probe transmission n's retry deadline is its issue plus max(probeMs, backoff(n)). */
const backoff = (n: number) => [1_000, 2_000, 4_000, 8_000][n - 1] ?? 30_000;

/** A probe transmission, Tokened from ctx.newId (3.12); past the cap of 5 it ends with no finding. */
function reprobe(
	book: Book,
	fact: Fact,
	step: Step,
	send: Send,
	pending: Probe,
): void {
	// 4.8 (CONTRACT.md 1873-1875): the cap counts every issued token but a not_sent one.
	const n = send.txs.filter((tx) => !tx.notSent).length + 1;
	if (n > 5) {
		pending.done = true;
		pending.deadline = undefined;
		return;
	}
	const token = step.newId() as SendToken;
	transmit(book, send, token);
	step.effects.push({ tag: "Tokened", token, effect: send.effect });
	pending.deadline = {
		at: fact.now + Math.max(fact.policy.probeMs, backoff(n)),
		opened: book.entry,
	};
}

/** 3.7, 3.12: a probe stores at issue what it covers and owns a deadline from its issue. */
function probe(
	book: Book,
	fact: Fact,
	step: Step,
	runId: string | null,
	target: Probe["target"],
	subject?: Probe["subject"],
): void {
	const send = issue(book, { kind: "probe", runId, target }, false);
	send.probe = { target, subject, done: false };
	reprobe(book, fact, step, send, send.probe);
}

function launch(run: Run): void {
	run.phase = "Launched";
	run.retryAt = undefined;
	run.exec = newExec(run.exec.n + 1);
}

/** D53: a start or steer fails its input once, at a permanent outcome other than a rejected resume or Stop's own. */
function failInput(book: Book, send: Send, tx: Tx): void {
	if (!delivers(send) || tx.resumeRejected || tx.stopOwn) return;
	const input = book.inputs.get(send.effect.inputId);
	if (input?.runId === send.runId)
		// Gap (CONTRACT.md 1521-1523): only hold_exhausted names a code; any other uncoded failure
		// reuses provider_send_attempts_exhausted.
		input.failed ??= tx.permanent ?? "provider_send_attempts_exhausted";
}

/**
 * The first delivery-recovery probe: a start's or steer's deadline at the outcome plus probeMs
 * (3.7, D20). An answer has no probe (3.10).
 */
function openRecovery(book: Book, fact: Fact, send: Send, tx: Tx): void {
	if (delivers(send))
		tx.recovery ??= { at: fact.now + fact.policy.probeMs, opened: book.entry };
}

function effectOutcome(
	book: Book,
	fact: Fact,
	send: Send,
	tx: Tx,
	outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
): Outcome {
	// 3101-3106: the returned call of an abort its Run's terminal left open ends it.
	if (tx.mainEnded) tx.ended ??= "main";
	switch (outcome.tag) {
		case "succeeded":
			tx.transport = joinTransport(tx.transport, { tag: "Sent" });
			if (send.effect.kind === "end_session") {
				seal(tx);
				tx.ended ??= "evidence";
				sessionEnd(book, send.seq);
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
			if (tx.n !== undefined) tx.ended ??= "evidence";
			tx.transport = joinTransport(tx.transport, {
				tag: "Failed",
				code: outcome.code,
			});
			failInput(book, send, tx);
			// 8.5: a permanent outcome, a refusal included, fails the native command with its code.
			if (send.effect.kind === "send_native_command") {
				const index = book.sends.indexOf(send);
				const command = book.nativeCommands.find((item) => item.send === index);
				if (command !== undefined) {
					command.state = "Failed";
					command.code = outcome.code;
					command.deadline = undefined;
				}
			}
			// 3.10: a permanent refusal ends the answer's delivery, which resolves its interaction.
			if (send.effect.kind === "deliver_answer") {
				const interaction = interactionOf(book, send.effect.interactionId);
				if (interaction !== undefined) interaction.resolved = true;
			}
			break;
		}
		case "delivery_unknown":
			// 3.7, D20: an unknown delivery is never re-sent; a probe recovers it.
			tx.transport = joinTransport(tx.transport, { tag: "Unknown" });
			seal(tx);
			openRecovery(book, fact, send, tx);
			return changed;
	}
	// 3.4: main claims a control's row again after a retryable outcome on its latest claim, unless
	// a sweep's or a raced outcome already ended the row: Failed and Sent beat Retrying in the join
	// (CONTRACT.md 465, 476, 560-561), so a late retryable revives nothing.
	if (
		tx.n !== undefined &&
		tx === send.txs.at(-1) &&
		outcome.tag === "retryable" &&
		tx.transport.tag === "Retrying"
	)
		transmit(book, send, undefined);
	seal(tx);
	return changed;
}

/**
 * 3.4 session end: covers every transmission issued before `before` and the next start is fresh.
 * An end_session success covers only what issued before it (CONTRACT.md 535-537).
 */
function sessionEnd(book: Book, before: number): boolean {
	let moved = book.freshSince !== book.seq;
	book.freshSince = book.seq;
	for (const send of book.sends)
		for (const tx of send.txs)
			if (
				tx.seq < before &&
				(tx.sealed === undefined ||
					tx.ended === undefined ||
					tx.covered === undefined)
			) {
				seal(tx);
				tx.covered ??= "session_ended";
				tx.ended ??= "session_ended";
				moved = true;
			}
	for (const run of book.runs)
		if (
			run.phase !== "Ended" &&
			run.exec.evidence &&
			run.exec.endedBy === undefined &&
			(runSends(book, run).some((send) =>
				send.txs.some((tx) => tx.seq < before),
			) ||
				book.wakes.some(
					(wake) => wake.runId === run.runId && wake.seq < before,
				))
		) {
			run.exec.endedBy = "session_ended";
			moved = true;
		}
	// 8.3: it covers the wake executions opened before it.
	for (const wake of book.wakes)
		if (wake.seq < before && wake.ended === undefined) {
			wake.ended = "session_ended";
			moved = true;
		}
	// 3.10: session end resolves every interaction.
	for (const interaction of book.interactions)
		if (!interaction.resolved) {
			interaction.resolved = true;
			moved = true;
		}
	return moved;
}

/** An answer resolved to its send and transmission (3.4). */
interface Answered {
	readonly send: Send;
	readonly tx: Tx;
	readonly run: Run | undefined;
	/** The send is its Run's current execution's and its work has not ended (hasAuthority). */
	readonly live: boolean;
}

type EvidenceClass =
	| "lifecycle"
	| "receipt"
	| "hold"
	| "outcome"
	| "probe"
	| "background"
	| "interaction"
	| "command";
interface EvidenceRule<K extends Evidence["kind"]> {
	readonly class: EvidenceClass;
	/** 3.4: whether the send can produce it as an Answer; a kind it cannot is Rejected. */
	readonly produces: (send: Send) => boolean;
	readonly merge: (
		book: Book,
		fact: Fact,
		at: Answered,
		evidence: Extract<Evidence, { readonly kind: K }>,
	) => Outcome;
}
/** 3.2: keyed by every Evidence kind, so a missing kind is a compile error. */
export type EvidenceTable = {
	readonly [K in Evidence["kind"]]: EvidenceRule<K>;
};

const runEnd = (book: Book) => nativePolicies[book.provider].runEnd;
/** Section 9's fence membership, idle proof and work-ended column (CONTRACT.md 3076-3093). */
const rules = (book: Book): ProviderDecisionRules =>
	nativePolicies[book.provider].rules;
const never = () => false;
/** 3.4, 8.3, D61: background evidence and a native command's receipts are never an answer. */
const unsolicitedOnly = () =>
	rejected("unsolicited evidence is never an answer (3.4, 8.3, D61)");
const held = (send: Send) => send.held;

function liveness(
	book: Book,
	_fact: Fact,
	{ tx, run, live }: Answered,
	evidence: Extract<Evidence, { kind: "started" | "activity" }>,
): Outcome {
	const before = tx.consumption.tag;
	tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
	seal(tx);
	const moved = before !== tx.consumption.tag;
	if (!live || run === undefined) return moved ? changed : noop();
	const exec = run.exec;
	const first =
		!exec.evidence || (evidence.kind === "activity" && !exec.activity);
	// 11A: activity after a result is a new phase where the owned execution ends the Run.
	const phase =
		evidence.kind === "activity" &&
		exec.result &&
		!exec.afterResult &&
		runEnd(book) === "query_ended";
	exec.evidence = true;
	if (evidence.kind === "activity") exec.activity = true;
	if (phase) {
		exec.afterResult = true;
		exec.settle = undefined;
	}
	// 3.8 activity throttling: only repeats within one phase are dropped.
	return first || phase || moved ? changed : noop();
}

const evidenceTable: EvidenceTable = {
	started: { class: "lifecycle", produces: delivers, merge: liveness },
	activity: { class: "lifecycle", produces: delivers, merge: liveness },
	result: {
		class: "lifecycle",
		produces: delivers,
		merge(book, fact, { send, tx, run }, evidence) {
			tx.resulted = true;
			tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			const authority =
				run !== undefined &&
				run.phase !== "Ended" &&
				send.exec === run.exec.n &&
				(tx.ended === undefined || tx.ended === "evidence") &&
				// 3.4: a covered transmission's evidence changes nothing, its work ended by evidence first too.
				tx.covered === undefined;
			const byResult = runEnd(book) === "result";
			if (!authority) return changed;
			run.exec.evidence = true;
			run.exec.result = true;
			run.exec.afterResult = false;
			run.exec.fold.push({
				seq: send.seq,
				outcome: evidence.outcome,
				code: evidence.error?.code,
				retryable: evidence.error?.retryable ?? false,
			});
			if (byResult) run.exec.endEvidence = true;
			// 11A, 3.7: Settling holds the result until the owned execution ends, fixed at the result.
			else
				run.exec.settle ??= {
					at: fact.now + fact.policy.settleMs,
					opened: book.entry,
				};
			return changed;
		},
	},
	query_ended: {
		class: "lifecycle",
		produces: delivers,
		merge(book, _fact, { tx, run, live }) {
			// 9: query_ended ends only an owned execution's work, and its own by the work-ended column.
			if (runEnd(book) !== "query_ended") return noop();
			// 9: it ends its label's starts and steers; an abort or cancel_request acts on the native
			// session, not the query, so a query end never covers them (CONTRACT.md 334-338, 3101-3106).
			for (const send of book.sends)
				if (delivers(send))
					for (const other of send.txs)
						if (tx.label !== null && other.label === tx.label)
							other.ended ??= "evidence";
			if (live && run !== undefined) run.exec.endEvidence = true;
			return changed;
		},
	},
	input_accepted: {
		class: "receipt",
		produces: delivers,
		merge(_book, _fact, { tx }, evidence) {
			const nativeId = evidence.nativeMessageId;
			if (
				nativeId !== undefined &&
				tx.nativeMessageId !== undefined &&
				tx.nativeMessageId !== nativeId
			)
				return rejected("a contradicting native id (3.4, 6C)");
			const moved =
				tx.consumption.tag !== "Accepted" ||
				(tx.nativeMessageId === undefined && nativeId !== undefined);
			tx.nativeMessageId ??= nativeId;
			tx.consumption = joinConsumption(tx.consumption, { tag: "Accepted" });
			seal(tx);
			return moved ? changed : noop("a duplicate acceptance (12A)");
		},
	},
	input_declined: {
		class: "receipt",
		produces: delivers,
		merge(_book, _fact, { tx }) {
			const before = JSON.stringify(tx.consumption);
			const moved = !tx.declined;
			tx.declined = true;
			tx.consumption = joinConsumption(tx.consumption, {
				tag: "NotConsumed",
				why: "declined",
			});
			seal(tx);
			return moved || before !== JSON.stringify(tx.consumption)
				? changed
				: noop("a duplicate decline (12A)");
		},
	},
	accounting: {
		class: "receipt",
		produces: delivers,
		merge(_book, _fact, { tx }) {
			if (tx.accounted) return noop("a duplicate accounting receipt (12A)");
			tx.accounted = true;
			return changed;
		},
	},
	effect_outcome: {
		class: "outcome",
		produces: (send) => !send.held,
		merge: (book, fact, { send, tx }, evidence) =>
			// 3.4 (CONTRACT.md 465-471, D48): not_sent is only a probe's, stop_task's or
			// cancel_request's; a native command never gets one (8.5).
			evidence.outcome.tag === "not_sent" &&
			send.effect.kind !== "probe" &&
			send.effect.kind !== "stop_task" &&
			send.effect.kind !== "cancel_request"
				? rejected(`${send.effect.kind} cannot produce not_sent evidence (3.4)`)
				: effectOutcome(book, fact, send, tx, evidence.outcome),
	},
	runner_reply: {
		class: "hold",
		produces: held,
		merge: (book, fact, { send, tx }, evidence) =>
			effectOutcome(
				book,
				fact,
				send,
				tx,
				evidence.outcome.tag === "succeeded"
					? { tag: "succeeded" }
					: { tag: "permanent", code: evidence.outcome.code },
			),
	},
	// A known token's run.dispatched is a repeat; a fresh one binds before the table (3.4).
	run_dispatched: {
		class: "hold",
		produces: held,
		merge: () => noop("repeated run.dispatched"),
	},
	run_released: {
		class: "hold",
		produces: held,
		merge(_book, _fact, { tx }, { reason }) {
			// 4.11: the runner returned the hold; a rejected resume never reached the agent (D48).
			tx.released = true;
			if (reason === "ResumeRejected") {
				tx.resumeRejected = true;
				tx.transport = joinTransport(tx.transport, {
					tag: "Failed",
					code: "native_resume_rejected",
				});
			} else {
				// 4.8, 9: a hold released by Stop is Stop's own, never retried.
				tx.stopOwn = typeof reason === "object" && reason.why === "interrupted";
				tx.consumption = joinConsumption(tx.consumption, {
					tag: "NotConsumed",
					why: "released",
				});
			}
			seal(tx);
			return changed;
		},
	},
	delivery_indeterminate: {
		class: "hold",
		produces: held,
		merge(book, fact, { send, tx }) {
			tx.transport = joinTransport(tx.transport, { tag: "Unknown" });
			seal(tx);
			openRecovery(book, fact, send, tx);
			return changed;
		},
	},
	journal_answer: {
		class: "hold",
		produces: held,
		merge(_book, _fact, { tx }, { answer }) {
			if (answer === "uncertain") return noop();
			// 9: absent closes the hold; the work-ended column reads it after the merge.
			if (answer !== "absent")
				tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			return changed;
		},
	},
	probe_result: {
		class: "probe",
		produces: (send) => send.effect.kind === "probe",
		merge(book, _fact, { send, tx }, { finding }) {
			const pending = send.probe;
			if (pending === undefined)
				return rejected("probe_result for a non-probe (3.4)");
			const target = pending.target.tag;
			if (
				finding.tag !== "native_busy" &&
				(target === "input"
					? finding.tag === "native_idle"
					: finding.tag !== "native_idle")
			)
				return rejected(`${finding.tag} cannot answer a ${target} probe (3.4)`);
			const subjectSend =
				pending.subject === undefined
					? undefined
					: book.sends[pending.subject.send];
			const subject =
				pending.subject === undefined
					? undefined
					: subjectSend?.txs[pending.subject.tx];
			if (
				finding.tag === "input_present" &&
				finding.nativeMessageId !== undefined &&
				subjectSend?.txs.some(
					(item) =>
						item.nativeMessageId !== undefined &&
						item.nativeMessageId !== finding.nativeMessageId,
				)
			)
				return rejected("a contradicting native id (3.4, 6C)");
			tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			if (pending.done) return noop("late probe answer");
			// 3.7: busy is no finding; the probe re-probes at its deadline.
			if (finding.tag === "native_busy") return changed;
			pending.done = true;
			pending.deadline = undefined;
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
						// 9: input_absent ends probing; a later acceptance beats it.
						subject.absent = true;
						subject.consumption = joinConsumption(subject.consumption, {
							tag: "NotConsumed",
							why: "absent",
						});
						seal(subject);
					}
					break;
				case "native_idle": {
					// 9: an idle probe covers the fence members issued before it its idle proof names.
					const policy = rules(book);
					for (const other of book.sends)
						if (policy.fences(other.effect))
							for (const item of other.txs)
								if (
									item.seq < tx.seq &&
									item.ended === undefined &&
									policy.idleCovers(
										other.effect,
										item.resulted || consumptionRank[item.consumption.tag] >= 2,
									)
								)
									item.ended = "evidence";
					// 8.3, D26: and every wake execution.
					for (const wake of book.wakes) wake.ended ??= "own";
					break;
				}
			}
			return changed;
		},
	},
	interaction_requested: {
		class: "interaction",
		produces: delivers,
		merge: (book, _fact, { tx }, evidence) =>
			tx.label === null
				? noop("an interaction needs a label (3.10)")
				: requestInteraction(book, tx.label, evidence),
	},
	interaction_resolved: {
		class: "interaction",
		produces: never,
		merge: () => rejected("interaction_resolved is never an answer (3.4, D61)"),
	},
	command_lifecycle: {
		class: "command",
		produces: delivers,
		merge: (_book, _fact, { send, tx }, evidence) => {
			// D21: a held start's or steer's receipt names its hold's commandId.
			if (evidence.commandId !== send.commandId)
				return rejected("a command receipt naming another commandId (D21)");
			if (evidence.state === "cancelled" && tx.consumption.tag === "None") {
				// 9: cancelled before started is NotConsumed{cancelled}, Stop's own.
				tx.stopOwn = true;
				tx.consumption = { tag: "NotConsumed", why: "cancelled" };
			} else if (evidence.state === "started")
				tx.consumption = joinConsumption(tx.consumption, {
					tag: "Observed",
				});
			seal(tx);
			return changed;
		},
	},
	command_result: { class: "command", produces: never, merge: unsolicitedOnly },
	tasks_snapshot: {
		class: "background",
		produces: never,
		merge: unsolicitedOnly,
	},
	task_event: { class: "background", produces: never, merge: unsolicitedOnly },
	turn_started: {
		class: "background",
		produces: never,
		merge: unsolicitedOnly,
	},
	turn_ended: { class: "background", produces: never, merge: unsolicitedOnly },
};

/** 3.10: an interaction belongs to the label its evidence names; it is requested once. */
function requestInteraction(
	book: Book,
	label: Label,
	evidence: Extract<Evidence, { kind: "interaction_requested" }>,
): Outcome {
	if (interactionOf(book, evidence.interactionId) !== undefined)
		return noop("interaction already requested");
	book.interactions.push({
		interactionId: evidence.interactionId,
		kind: evidence.interactionKind,
		label,
		deliveries: [],
		resolved: false,
	});
	return changed;
}

/** Correlates `kind` with its evidence for the table lookup. */
function merge<K extends Evidence["kind"]>(
	book: Book,
	fact: Fact,
	at: Answered,
	kind: K,
	evidence: Extract<Evidence, { readonly kind: K }>,
): Outcome {
	const rule: EvidenceRule<K> = evidenceTable[kind];
	return rule.produces(at.send)
		? rule.merge(book, fact, at, evidence)
		: rejected(`${at.send.effect.kind} cannot produce ${kind} evidence (3.4)`);
}

/** 3.4: run.dispatched binds a fresh token to the issue its commandId names in its Run. */
function dispatched(
	book: Book,
	token: SendToken,
	evidence: Extract<Evidence, { kind: "run_dispatched" }>,
): Outcome {
	const runner = book.runners.get(evidence.runnerId);
	if (runner?.retired === true)
		return noop("no hold is written on a retired runner (4.3)");
	const run = findRun(book, book.mainRuns.get(evidence.runId)?.runId);
	if (run === undefined) return noop("unknown or never-issued token (3.4)");
	// H3, 4.3 step 2 (CONTRACT.md 1514-1518, 1560-1563), 12A (891-894): a hold for an Ended Run,
	// a dropped issue's included, finds no running send and the feeder drops it, so it binds nothing.
	if (run.phase === "Ended")
		return noop("an Ended Run's hold finds no running send (H3)");
	const heldSends = book.sends
		.filter(delivers)
		.filter((send) => send.held && send.runId === run.runId);
	let send = heldSends
		.filter((item) => item.commandId === evidence.commandId)
		.at(-1);
	if (send !== undefined) {
		// 3.6 D50: a relaunch is a new transmission of the same issue, in a new execution. Main's
		// fresh-run run.requested (3.4, 4.8) may have launched it already, its issue pending there.
		if (run.phase === "Queued" || send.exec !== run.exec.n) {
			const { effect } = send;
			if (run.phase === "Queued") launch(run);
			send =
				deliverySends(book, run).find(
					(item) =>
						item.held &&
						item.commandId === undefined &&
						item.effect.inputId === effect.inputId,
				) ??
				issue(
					book,
					effect.kind === "start"
						? { ...effect, mode: nextMode(book) }
						: effect,
					true,
				);
			send.commandId = evidence.commandId;
		}
	} else {
		send = heldSends.find((item) => item.commandId === undefined);
		if (send === undefined) return noop("unknown or never-issued token (3.4)");
		send.commandId = evidence.commandId;
	}
	// holdRun counts n per commandId across a relaunch (4.3); an unheld try took no hold.
	const holds = book.sends
		.filter((item) => item.held && item.commandId === evidence.commandId)
		.flatMap((item) => item.txs)
		.filter((tx) => !tx.unheld).length;
	if (evidence.transmission !== holds + 1)
		return rejected("run.dispatched transmission out of order (4.3)");
	// L2: a pending held send resolves at its own run_dispatched to the runner it names, and a
	// case 2 send following its start resolves with it.
	if (send.runnerId === null) {
		const startSeq = send.seq;
		for (const item of book.sends)
			if (
				item === send ||
				(item.follows === startSeq && item.runnerId === null)
			) {
				item.runnerId = evidence.runnerId;
				item.label = runner?.latest ?? null;
				for (const tx of item.txs)
					if (tx.runnerId === null) {
						tx.runnerId = evidence.runnerId;
						tx.label = item.label;
					}
			}
	}
	transmit(book, send, token, evidence.runnerId, runner?.latest ?? send.label);
	return changed;
}

/** 3.4, 3.10, 8.3: evidence no send produced, under the label it names. */
function unsolicited(
	book: Book,
	fact: Fact,
	step: Step,
	observation: Extract<
		Extract<LedgerCommand, { verb: "observe" }>["observation"],
		{ tag: "Unsolicited" }
	>,
): Outcome {
	const { label, kind } = observation;
	const key = `${label}\u0000${observation.eventId}`;
	if (book.seen.has(key)) return noop("repeated unsolicited observation");
	const { capabilities } = nativePolicies[book.provider];
	if (
		(kind === "tasks_snapshot" || kind === "task_event") &&
		!capabilities.backgroundTasks
	)
		return rejected(`${book.provider} reports no background tasks (8.1)`);
	if (
		(kind === "command_lifecycle" ||
			kind === "command_result" ||
			kind === "turn_ended") &&
		!capabilities.commandReceipts
	)
		return rejected(`${kind} is Claude's (3.4, 9, D46)`);
	if (kind === "turn_started" && !capabilities.wakeTurns)
		return rejected(`${book.provider} starts no unsolicited turn (8.3)`);
	// L1 (CONTRACT.md 353-355): a runner not started has no authority and changes nothing.
	const { runnerId, querySeq } = splitLabel(label);
	const runner = book.runners.get(runnerId);
	if (runner === undefined || runner.latest === null)
		return noop("a runner not started has no authority (L1)");
	book.seen.add(key);
	// L1 item 4: a retired runner's labels are older, as is one below its latest querySeq.
	const older = runner.retired || querySeq < splitLabel(runner.latest).querySeq;
	// 8.4, L5, D44: a label newer than its live runner's latest raises it, ending the old label's
	// scope; its tasks are unknown until its first snapshot.
	let raised = false;
	if (!runner.retired && querySeq > splitLabel(runner.latest).querySeq) {
		decideLostWork(book, runner.latest);
		runner.latest = label;
		runner.tasks = capabilities.backgroundTasks
			? { tag: "Unknown", label }
			: { tag: "Known", label, tasks: [] };
		book.snapshotEntry++;
		raised = true;
	}
	const unchanged = (diagnostic?: string) =>
		raised ? changed : noop(diagnostic);
	const wake = book.wakes.find(
		(item) => item.label === label && item.ended === undefined,
	);
	switch (kind) {
		case "tasks_snapshot":
			// runner.retired narrows; older already includes it.
			if (runner.retired || older)
				return unchanged("older-label snapshot (L1.4)");
			// 8.3: a snapshot replaces the set. 8.2 (CONTRACT.md 2778-2781) names the kind and class;
			// serving is derived from linked servers at view time (taskView).
			runner.tasks = {
				tag: "Known",
				label,
				tasks: observation.tasks.map((task) => ({
					...task,
					kind:
						{
							local_bash: "shell",
							local_agent: "subagent",
							local_workflow: "workflow",
						}[task.taskType] ?? task.taskType,
					class:
						task.ambient || task.taskType === "monitor" ? "monitoring" : "work",
				})),
			};
			book.snapshotEntry++;
			return changed;
		case "task_event":
			// 8.3: a notification names the waking task.
			if (observation.event === "notification")
				book.lastNotified = observation.key;
			return changed;
		case "turn_started": {
			if (older) return unchanged("older label gives no wake Run (L1.4)");
			const inputRun = activeInputRun(book);
			const wakeRun = activeWakeRun(book);
			// 8.3 (CONTRACT.md 2837-2840, D28): with no active Run a turn_started records a wake Run,
			// opening its label's wake execution or re-arming one still outstanding as that Run's.
			if (
				wake !== undefined &&
				(inputRun !== undefined ||
					(wakeRun !== undefined && wake.runId === wakeRun.runId))
			)
				return unchanged(
					"wake execution already outstanding under the active Run",
				);
			let runId: string | undefined;
			if (inputRun === undefined) {
				if (wakeRun === undefined) {
					runId = step.newId();
					book.runs.push({
						runId,
						origin: "wake",
						wakeTask: observation.wakeTask ?? book.lastNotified,
						wakeLabels: [label],
						inputs: [],
						phase: "Launched",
						asked: false,
						exec: { ...newExec(1), evidence: true },
					});
				} else {
					wakeRun.wakeLabels.push(label);
					runId = wakeRun.runId;
				}
			}
			if (wake === undefined) book.wakes.push({ label, runId, seq: book.seq });
			else wake.runId = runId;
			return changed;
		}
		case "turn_ended":
			// 8.3, D59: a Claude wake's own end.
			if (wake === undefined)
				return unchanged("no wake execution on its label (8.3)");
			if (older) wake.older = true;
			wake.ended = "own";
			return changed;
		case "activity":
			return unchanged(
				wake === undefined ? "no wake execution on its label (8.3)" : undefined,
			);
		case "result": {
			if (wake === undefined) {
				// 3.4: a Claude result naming none, with no wake, answers each started send with no result.
				const started = book.sends.filter(delivers).filter((send) =>
					send.txs.some(
						(tx) =>
							tx.label === label &&
							// started: consumption Observed or Accepted; a release or decline is no start
							// (CONTRACT.md 501-505).
							(tx.consumption.tag === "Observed" ||
								tx.consumption.tag === "Accepted") &&
							!tx.resulted,
					),
				);
				if (
					!nativePolicies[book.provider].capabilities.commandReceipts ||
					started.length === 0
				)
					return unchanged("no wake execution on its label (8.3)");
				for (const send of started)
					for (const tx of send.txs) {
						if (tx.label !== label || tx.resulted) continue;
						const run = findRun(book, send.runId);
						const live =
							run !== undefined &&
							run.phase !== "Ended" &&
							send.exec === run.exec.n &&
							tx.ended === undefined;
						tx.answers.push(observation);
						evidenceTable.result.merge(
							book,
							fact,
							{ send, tx, run, live },
							observation,
						);
						if (rules(book).workEnded(tx.answers)) tx.ended ??= "evidence";
					}
				return changed;
			}
			// 9: OpenCode's wake ends at its query_ended or a covering idle probe.
			if (runEnd(book) === "query_ended") return unchanged();
			if (older) wake.older = true;
			wake.ended = "result";
			wake.outcome = {
				seq: book.seq,
				outcome: observation.outcome,
				code: observation.error?.code,
				retryable: observation.error?.retryable ?? false,
			};
			return changed;
		}
		case "query_ended": {
			if (wake === undefined && runEnd(book) !== "query_ended")
				return unchanged("no wake execution on its label (8.3)");
			if (wake !== undefined) {
				if (older) wake.older = true;
				wake.ended = "own";
			}
			// 9: OpenCode's query end ends its label's starts and steers, never an abort or
			// cancel_request (CONTRACT.md 334-338, 3101-3106).
			let moved = wake !== undefined;
			if (runEnd(book) === "query_ended")
				for (const send of book.sends)
					if (delivers(send))
						for (const tx of send.txs)
							if (tx.label === label && tx.ended === undefined) {
								tx.ended = "evidence";
								moved = true;
							}
			return moved ? changed : unchanged();
		}
		case "interaction_requested": {
			// Gap (CONTRACT.md 1041-1044, L1 349-350): an interaction raised on a retired runner's
			// label after its retirement stays Pending; the contract resolves only those Pending at the
			// retirement, so this follows the oracle.
			const outcome = requestInteraction(book, label, observation);
			return raised ? changed : outcome;
		}
		case "interaction_resolved": {
			// D61: native or confirming an answer, by its interaction.
			const interaction = interactionOf(book, observation.interactionId);
			if (interaction === undefined || interaction.resolved) return unchanged();
			interaction.resolved = true;
			return changed;
		}
		case "command_lifecycle":
		case "command_result": {
			// D61 (CONTRACT.md 486-494): a native command's receipts are unsolicited, by its commandId.
			const command = book.nativeCommands.find(
				(item) => item.commandId === observation.commandId,
			);
			if (command === undefined)
				return unchanged("a command receipt naming no native command (D61)");
			// LI7 (CONTRACT.md 3430): older-label evidence changes nothing, its send's own label aside.
			if (
				older &&
				!book.sends[command.send]?.txs.some((tx) => tx.label === label)
			)
				return unchanged("older-label command receipt (LI7)");
			// 8.5: the deadline pauses while queued and resumes with the time it had left.
			switch (
				observation.kind === "command_result" ? "completed" : observation.state
			) {
				case "queued":
					if (command.deadline !== undefined)
						command.remaining = Math.max(0, command.deadline.at - fact.now);
					command.deadline = undefined;
					command.state = "Queued";
					break;
				case "started":
					command.deadline ??= {
						at: fact.now + command.remaining,
						opened: book.entry,
					};
					command.state = "Started";
					break;
				case "completed":
					command.deadline = undefined;
					command.state = "Completed";
					break;
				case "cancelled":
					command.deadline = undefined;
					command.state = "Cancelled";
			}
			return changed;
		}
	}
}

function observe(
	book: Book,
	fact: Fact,
	step: Step,
	observation: Extract<LedgerCommand, { verb: "observe" }>["observation"],
): Outcome {
	switch (observation.tag) {
		case "Unsolicited": {
			// 3.1, 3.4 (CONTRACT.md 290-291, 496-497): the (label, event id) pair is the identity, so its
			// first arrival records even when it changes nothing else; a later repeat is then a repeat.
			const known = book.seen.size;
			const outcome = unsolicited(book, fact, step, observation);
			return outcome.tag === "Noop" && book.seen.size !== known
				? changed
				: outcome;
		}
		case "Main": {
			const key = `main\u0000${observation.eventId}`;
			if (book.seen.has(key)) return noop("repeated main observation (D60)");
			book.seen.add(key);
			switch (observation.kind) {
				case "run_requested": {
					const input = book.inputs.get(observation.inputId);
					if (input === undefined)
						return noop("run.requested for an input never admitted");
					input.reservation ??= observation.runId;
					if (input.runId === undefined) {
						if (activeInputRun(book) !== undefined)
							return noop("run.requested while another Run is active");
						// 3.4: the Run is reserved at main's run.requested, under main's runId.
						book.runs.push({
							runId: observation.runId,
							origin: "input",
							wakeLabels: [],
							inputs: [observation.inputId],
							phase: "Queued",
							asked: false,
							exec: newExec(0),
						});
						input.runId = observation.runId;
					}
					const run = findRun(book, input.runId);
					if (run === undefined || run.phase === "Ended")
						return noop("run.requested for an ended Run (3.8)");
					// 3.9: a steer is delivered into its Run's live query unless it opens the Run.
					const steer =
						input.delivery === "steer" && run.inputs[0] !== observation.inputId;
					book.mainRuns.set(observation.runId, {
						runId: run.runId,
						open: true,
						...(steer ? { steer } : {}),
					});
					if (run.phase === "Queued") launch(run);
					const send =
						deliverySends(book, run).find(
							(item) => item.effect.inputId === observation.inputId,
						) ??
						issue(
							book,
							steer
								? {
										kind: "steer",
										runId: run.runId,
										inputId: observation.inputId,
									}
								: {
										kind: "start",
										runId: run.runId,
										inputId: observation.inputId,
										mode: nextMode(book),
									},
							!observation.direct,
						);
					if (observation.direct) {
						// 3.13: a direct start is Main under its input's id, its token the runId (3.4).
						send.commandId ??= observation.inputId;
						transmit(book, send, observation.runId as SendToken);
					}
					return changed;
				}
				case "run_started": {
					const input = book.inputs.get(observation.inputId);
					const run = findRun(
						book,
						(
							book.mainRuns.get(observation.runId) ??
							book.mainRuns.get(observation.requestedRunId)
						)?.runId,
					);
					if (input === undefined || run === undefined)
						return noop("run.started for an unknown run");
					// 3.9 (CONTRACT.md 148, 956): a run main observed for a native message, the requested Run
					// joined into it, names that Run; main's terminal comes under it.
					const observed = !book.mainRuns.has(observation.runId);
					if (run.phase === "Ended") {
						// 3.9 (CONTRACT.md 978-981): a steer its Run's end left unconsumed, the Run's own joined
						// steer included, is a Run of its own, its reservation's, Launched with its send.
						const runId = input.reservation ?? observation.requestedRunId;
						if (findRun(book, runId) !== undefined)
							return noop(
								"run.started for a steer whose reservation names an existing Run (3.9)",
							);
						book.runs.push({
							runId,
							origin: "input",
							wakeLabels: [],
							inputs: [observation.inputId],
							phase: "Launched",
							asked: false,
							exec: { ...newExec(1), evidence: true },
						});
						input.runId = runId;
						for (const id of [observation.requestedRunId, runId])
							book.mainRuns.set(id, { runId, open: true });
						if (observed)
							book.mainRuns.set(observation.runId, { runId, open: true });
						return changed;
					}
					if (observed)
						book.mainRuns.set(observation.runId, {
							runId: run.runId,
							open: true,
						});
					if (input.runId === run.runId) return observed ? changed : noop();
					// 3.9: the input joins the Run main started it in.
					const from = findRun(book, input.runId);
					const at = from?.inputs.indexOf(observation.inputId) ?? -1;
					if (at >= 0) from?.inputs.splice(at, 1);
					if (!run.inputs.includes(observation.inputId))
						run.inputs.push(observation.inputId);
					input.runId = run.runId;
					return changed;
				}
				case "run_terminal": {
					const target = book.mainRuns.get(observation.runId);
					if (target === undefined)
						return noop("run_terminal for an unknown run");
					// 4.8 (CONTRACT.md 1864-1869), 4.3 (1521-1524): from 32.5 a joined steer has its own
					// transmissions and cap, so its unstarted run's end, a fresh-run retry's failed try or the
					// cap's error, is the steer's alone: its Run neither ends nor names that run again.
					if (target.steer) {
						book.mainRuns.delete(observation.runId);
						return changed;
					}
					target.open = false;
					const run = findRun(book, target.runId);
					if (run === undefined || run.phase === "Ended") return changed;
					// D59: main's terminal ends its Run's work as main, except an OpenCode abort or cancel_request
					// whose call has not returned: session-wide, its delivery unknown, it stays a fence member until
					// the call returns, a probe issued after it returns native_idle, or the stop's deadline step,
					// main's stop_unconfirmed terminal. The Run's end waits for none (CONTRACT.md 788-789, 797-799,
					// 3101-3106; a reading, reported as a gap).
					for (const send of runSends(book, run))
						for (const tx of send.txs)
							if (
								(send.effect.kind === "interrupt" ||
									send.effect.kind === "cancel_request") &&
								rules(book).fences(send.effect) &&
								observation.code !== "stop_unconfirmed" &&
								tx.transport.tag === "Issued"
							)
								tx.mainEnded = true;
							else tx.ended ??= "main";
					run.exec.fold.push({
						seq: book.seq,
						outcome: observation.outcome,
						code: observation.code,
						retryable: false,
					});
					run.exec.endEvidence = true;
					return changed;
				}
			}
			break;
		}
		case "Answer": {
			// D46 (CONTRACT.md 519-520): producibility is the kind's, so it precedes the token.
			if (
				(observation.kind === "command_lifecycle" ||
					observation.kind === "command_result" ||
					observation.kind === "turn_ended") &&
				!nativePolicies[book.provider].capabilities.commandReceipts
			)
				return rejected(`${observation.kind} is Claude's (3.4, 9, D46)`);
			if (
				observation.kind === "run_dispatched" &&
				!book.tokens.has(observation.token)
			)
				return dispatched(book, observation.token, observation);
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
					// 3.4 (CONTRACT.md 465-471, D48): main's gate precedes its claim.
					return rejected(
						`main writes no ${observation.outcome.tag} for a transmission (3.4)`,
					);
				const rows = book.sends.filter(
					(item) => !item.held && item.commandId === named.commandId,
				);
				if (named.transmission === 0) {
					// 3.4 (CONTRACT.md 474-477): n 0 ends the issue never transmitted, adding no chain.
					const issued = rows
						.filter((item) => item.txs.every((tx) => tx.token === undefined))
						.at(-1);
					if (issued === undefined) return noop("n 0 names no issue (3.4)");
					issued.txs.length = 0;
					return changed;
				}
				const row = rows.find((item) =>
					item.txs.some((tx) => tx.n === named.transmission),
				);
				const claim = row?.txs.find((tx) => tx.n === named.transmission);
				if (row === undefined || claim === undefined)
					return noop("unknown transmission (3.4)");
				if (claim.token === undefined && !book.tokens.has(observation.token)) {
					claim.token = observation.token;
					book.tokens.set(observation.token, {
						send: book.sends.indexOf(row),
						tx: row.txs.indexOf(claim),
					});
				} else if (claim.token !== observation.token)
					return rejected("a transmission names one token (3.4)");
			}
			const at = book.tokens.get(observation.token);
			const send = at === undefined ? undefined : book.sends[at.send];
			const tx = at === undefined ? undefined : send?.txs[at.tx];
			if (send === undefined || tx === undefined)
				return noop("unknown or never-issued token (3.4)");
			if (tx.n !== undefined && observation.kind !== "effect_outcome")
				// D61 (CONTRACT.md 489-494, 517-518): a control main issues is answered only by its outcome.
				return rejected(
					`${observation.kind} on a control main issues (3.4, D61)`,
				);
			if (
				observation.kind === "effect_outcome" &&
				(observation.transmission !== undefined) !== (tx.n !== undefined)
			)
				return rejected(
					"an effect_outcome names a transmission exactly for a control (3.4)",
				);
			const run = findRun(book, send.runId);
			const live =
				run !== undefined &&
				run.phase !== "Ended" &&
				send.exec === run.exec.n &&
				tx.ended === undefined;
			// The draft is discarded unless the merge changed it, so only folded answers stay.
			tx.answers.push(observation);
			const outcome = merge(
				book,
				fact,
				{ send, tx, run, live },
				observation.kind,
				observation,
			);
			// 3.5, 9: a start's or steer's own work ends by its provider's work-ended column.
			if (delivers(send) && rules(book).workEnded(tx.answers))
				tx.ended ??= "evidence";
			return outcome;
		}
	}
}

/** L1: a runner retires (its process_lost, or another runner's process_started). */
function retire(book: Book, runnerId: string): void {
	const runner = book.runners.get(runnerId);
	// L1 item 3, L5: retiring records its latest label's lost work.
	if (runner?.retired === false) decideLostWork(book, runner.latest);
	// L1 (CONTRACT.md 349-350): retirement is final, a runner not yet started included.
	book.runners.set(runnerId, {
		latest: book.runners.get(runnerId)?.latest ?? null,
		retired: true,
	});
	if (book.current === runnerId) book.current = null;
	const addressed = (send: Send, tx: Tx) =>
		send.runnerId === runnerId || tx.runnerId === runnerId;
	// L1 item 1: retiring covers every send addressed to it and seals its transmissions.
	for (const send of book.sends) {
		for (const tx of send.txs)
			if (addressed(send, tx)) {
				seal(tx);
				tx.covered ??= "process_lost";
				tx.ended ??= "process_lost";
			}
		if (
			send.held &&
			send.txs.length === 0 &&
			send.runnerId === runnerId &&
			findRun(book, send.runId)?.phase !== "Ended"
		)
			// 3.6: retirement before any hold of its start leaves it never handed over.
			transmit(book, send, undefined).sealed = {
				value: "never",
				unconsumed: false,
			};
	}
	for (const run of book.runs)
		if (
			run.phase !== "Ended" &&
			run.exec.evidence &&
			runSends(book, run).some((send) =>
				send.txs.some((tx) => addressed(send, tx)),
			)
		)
			run.exec.endedBy ??= "process_lost";
	// L1 item 2: it ends its wake executions.
	for (const wake of book.wakes)
		if (splitLabel(wake.label).runnerId === runnerId)
			wake.ended ??= "process_lost";
	// 3.10: retirement resolves its labels' interactions.
	for (const interaction of book.interactions)
		if (splitLabel(interaction.label).runnerId === runnerId)
			interaction.resolved = true;
}

function settle(
	book: Book,
	fact: Fact,
	step: Step,
	settlement: Extract<LedgerCommand, { verb: "settle" }>["settlement"],
): Outcome {
	switch (settlement.kind) {
		case "server_gone": {
			const entry = book.servers.get(settlement.server.port);
			if (entry === undefined || !sameServer(entry.key, settlement.server))
				return noop("server_gone names another ServerKey (8.2)");
			book.servers.delete(settlement.server.port);
			return changed;
		}
		case "server_seen": {
			const { server, source } = settlement;
			const entry = book.servers.get(server.port);
			// 8.2: a declared entry keeps its source and role against later detection of its own
			// ServerKey; a new ServerKey on the port starts as its observation says.
			const kept =
				entry !== undefined &&
				sameServer(entry.key, server) &&
				entry.source === "declared" &&
				source === "detected"
					? entry
					: undefined;
			const next: Server = {
				key: server,
				command: settlement.command,
				cwd: settlement.cwd,
				...(settlement.taskKey === undefined
					? {}
					: { taskKey: settlement.taskKey }),
				source: kept?.source ?? source,
				role: kept?.role ?? settlement.role ?? "serving",
			};
			if (JSON.stringify(entry) === JSON.stringify(next))
				return noop("server unchanged");
			book.servers.set(server.port, next);
			return changed;
		}
		case "alarm_fired": {
			// 3.7: every deadline an alarm recorded after it opened reaches fires once, in order.
			const due = deadlines(book).filter(
				(item) => item.at <= fact.now && item.opened < book.entry,
			);
			for (const item of due) item.fire(fact, step);
			return due.length > 0 ? changed : noop("nothing due");
		}
		case "hold_exhausted": {
			const send = book.sends
				.filter((item) => item.held && item.commandId === settlement.commandId)
				.at(-1);
			if (send === undefined) return noop("unknown commandId (3.4)");
			// 4.3: the hold's budget is spent; it fails its input with provider_send_attempts_exhausted.
			send.exhausted = true;
			for (const tx of send.txs) seal(tx);
			const latest = send.txs.at(-1);
			if (latest !== undefined) failInput(book, send, latest);
			return changed;
		}
		case "unheld_outcome": {
			const run = findRun(book, book.mainRuns.get(settlement.runId)?.runId);
			if (run === undefined) return noop("unknown token (3.4)");
			if (run.phase === "Ended")
				return noop("late evidence for an Ended Run (3.8)");
			const sends = deliverySends(book, run).filter((item) => item.held);
			let send =
				sends
					.filter((item) => item.commandId === settlement.commandId)
					.at(-1) ?? sends.find((item) => item.commandId === undefined);
			if (send === undefined) return noop("unknown token (3.4)");
			// D50 (CONTRACT.md 674-676, F58 3322-3329): an unlaunched Run's next unheld try is main's
			// relaunch under the same commandId, a new execution's transmission, not the dropped one's.
			if (run.phase === "Queued") {
				const { effect } = send;
				launch(run);
				send = issue(
					book,
					effect.kind === "start"
						? { ...effect, mode: nextMode(book) }
						: effect,
					true,
				);
			}
			send.commandId ??= settlement.commandId;
			const tx = transmit(book, send, undefined);
			effectOutcome(book, fact, send, tx, settlement.outcome);
			tx.notSent ||= settlement.outcome.tag === "not_sent";
			return changed;
		}
		case "process_started": {
			const { runnerId, querySeq } = splitLabel(settlement.label);
			const prior = book.runners.get(runnerId);
			// L1 (CONTRACT.md 349-350, 6.1): retirement is final and runnerIds are never reused.
			if (prior?.retired === true)
				return noop("a retired runner's process_started changes nothing (L1)");
			// L1: a live runner's start at or below its latest querySeq is an older label.
			if (
				prior !== undefined &&
				book.current === runnerId &&
				querySeq <= splitLabel(prior.latest).querySeq
			)
				return noop("an older label's process_started changes nothing (L1)");
			// L5, D44: the runner's previous label becomes older, so its scope ends.
			if (prior !== undefined && prior.latest !== settlement.label)
				decideLostWork(book, prior.latest);
			// L1 totality (CONTRACT.md 346-349): another runner's process_started is the process_lost
			// of every other runner, started or only named by a run.dispatched.
			for (const other of new Set([
				...book.runners.keys(),
				...book.sends.flatMap((send) => [
					send.runnerId,
					...send.txs.map((tx) => tx.runnerId),
				]),
			]))
				if (
					other !== null &&
					other !== runnerId &&
					book.runners.get(other)?.retired !== true
				)
					retire(book, other);
			// 8.3: a fresh launch has no tasks; a reattach's are unknown until its snapshot.
			book.runners.set(runnerId, {
				latest: settlement.label,
				retired: false,
				tasks:
					settlement.reattached &&
					nativePolicies[book.provider].capabilities.backgroundTasks
						? { tag: "Unknown", label: settlement.label }
						: { tag: "Known", label: settlement.label, tasks: [] },
			});
			book.current = runnerId;
			book.snapshotEntry++;
			// L2: a pending send resolves, once, to the next process_started's runner; a
			// run_dispatched naming a runner not yet started fixes its label here.
			for (const send of book.sends)
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
			if (book.retirements.has(key))
				return noop("process_lost already folded (6.5)");
			book.retirements.add(key);
			retire(book, settlement.runnerId);
			return changed;
		}
		case "session_ended": {
			// L5, 8.4 (CONTRACT.md 2884-2885): session_ended ends the latest label's scope.
			// 3.4: the native session ends at this fact and covers every send issued before it.
			const moved = sessionEnd(book, book.seq);
			const label = currentLabel(book);
			const decided = book.lostDecided.size;
			if (label !== null) decideLostWork(book, label);
			return moved || book.lostDecided.size !== decided
				? changed
				: noop("the native session already ended");
		}
	}
}

/** 8.4: an end_session row under its own Control, addressed as L2 says (case 2 or 3). */
const endSession = (book: Book, run: Run | undefined, commandId: string) =>
	issueControl(
		book,
		{
			kind: "end_session",
			runId: run?.runId ?? null,
			label: addressAt(book, run).label,
		},
		commandId,
	);
/** 8.4 (L3): the end_session step waits on the confirm gate with tasks live or unknown. */
function gateEndSession(book: Book, run: Run | undefined, commandId: string) {
	if (taskView(book).tag === "none") endSession(book, run, commandId);
	else book.confirm = { step: "end_session", runId: run?.runId, commandId };
}

/** 3.6, 5.1, L6: a Stop, Run now or end commit asks the active Run and opens or joins the stop deadline. */
function commit(
	book: Book,
	fact: Fact,
	step: Step,
	by: InterruptBy,
	deadlineAt: number | null,
	commandId: string,
): Outcome {
	const run = activeRun(book);
	// 3.10: a Pending interaction on a label with work is resolved at the commit, unless its answer may act.
	const labels = new Set([
		...book.wakes.flatMap((wake) =>
			wake.ended === undefined ? [wake.label] : [],
		),
		...book.sends.flatMap((send) =>
			rules(book).fences(send.effect)
				? send.txs.flatMap((tx) =>
						tx.label !== null && mayStillAct(book, send, tx) ? [tx.label] : [],
					)
				: [],
		),
	]);
	for (const interaction of book.interactions)
		if (
			!interaction.resolved &&
			labels.has(interaction.label) &&
			!delivering(book, interaction)
		)
			interaction.resolved = true;
	if (run !== undefined) {
		run.asked = true;
		if (run.phase !== "Queued") {
			run.phase = "Interrupting";
			run.by = by;
		}
	}
	// 5.1: a Run nothing of which may act ends at once with no effect; with neither it nor label
	// work, Stop issues nothing.
	const acting =
		run !== undefined && run.phase !== "Queued" && !nothingMayAct(book, run);
	// 8.4: an end's Stop row is its end_session, not an interrupt.
	if (by === "end") gateEndSession(book, run, commandId);
	else if (acting || labelWorkOutstanding(book)) {
		const runId = acting ? (run?.runId ?? null) : null;
		issueControl(
			book,
			{
				kind: "interrupt",
				runId,
				runIds: [...book.mainRuns.entries()]
					.filter(([, main]) => main.open && main.runId === run?.runId)
					.map(([id]) => id),
			},
			commandId,
		);
		if (!nativePolicies[book.provider].capabilities.runnerHost) {
			// 5.1 OpenCode Stop: the Stop issues cancel_request and a native_session probe together,
			// the probe's deadline running from that issue (3.7).
			issueTokened(book, step, { kind: "cancel_request", runId });
			probe(book, fact, step, runId, { tag: "native_session" });
		}
	}
	// 8.4 (L3): an interrupted Run's retire step waits on the gate with tasks live or unknown.
	// Gap (CONTRACT.md 2870): the contract gates the step past the stop's deadline, which for a
	// runner host is main's (U2), not the ledger's; the gate opens at the commit as the oracle's
	// does, and a Run-less Stop of label work alone opens none, as the oracle.
	if (
		by !== "end" &&
		run?.phase === "Interrupting" &&
		taskView(book).tag !== "none"
	)
		book.confirm ??= { step: "retire", runId: run.runId };
	if (deadlineAt === null) return changed;
	// L6: add the label work with no open main run to the one ledger stop deadline.
	const hasOpenMain = (runId: string | null) =>
		[...book.mainRuns.values()].some(
			(main) => main.open && main.runId === runId,
		);
	const items: StopItem[] = [
		...book.wakes.flatMap((wake, index): StopItem[] =>
			wake.ended === undefined ? [{ wake: index }] : [],
		),
		...book.sends.flatMap((send, index) =>
			rules(book).fences(send.effect) && !hasOpenMain(send.runId)
				? send.txs.flatMap((tx, txIndex): StopItem[] =>
						mayStillAct(book, send, tx) ? [{ send: index, tx: txIndex }] : [],
					)
				: [],
		),
	];
	if (items.length === 0) return changed;
	const stop = book.stop;
	book.stop =
		stop === undefined || !stopOpen(book)
			? { at: deadlineAt, opened: book.entry, items }
			: {
					...stop,
					items: [
						...stop.items,
						...items.filter(
							(item) =>
								!stop.items.some(
									(old) => JSON.stringify(old) === JSON.stringify(item),
								),
						),
					],
				};
	return changed;
}

function control(
	book: Book,
	fact: Fact,
	step: Step,
	command: Extract<LedgerCommand, { verb: "control" }>["control"],
): Outcome {
	switch (command.kind) {
		case "stop":
		case "run_now":
			// D58: a Run now's input is main's inbox's until its handoff; the ledger reads the commit.
			return commit(
				book,
				fact,
				step,
				command.kind,
				command.deadlineAt,
				command.commandId,
			);
		case "end": {
			// 8.4 (CONTRACT.md 2889-2898): with deadlineAt, main commits the Stop as this end_session;
			// a later one (deadlineAt null) or one with no Run joins no deadline.
			const run = activeRun(book);
			if (run !== undefined && command.deadlineAt !== null)
				return commit(
					book,
					fact,
					step,
					"end",
					command.deadlineAt,
					command.commandId,
				);
			gateEndSession(book, run, command.commandId);
			return changed;
		}
		case "answer": {
			const interaction = interactionOf(book, command.interactionId);
			if (interaction === undefined)
				return rejected("no such interaction (3.10)");
			if (interaction.resolved)
				return noop("interaction already resolved (3.10)");
			if (delivering(book, interaction))
				return noop("answered once: the first answer wins (3.10)");
			// 3.10: the first answer decision wins; a retry redelivers it under the new commandId.
			interaction.answer ??= command.answer;
			const run = book.runs.find(
				(item) =>
					item.phase !== "Ended" &&
					(item.wakeLabels.includes(interaction.label) ||
						book.sends.some(
							(send) =>
								send.runId === item.runId &&
								send.txs.some((tx) => tx.label === interaction.label),
						)),
			);
			const send = issueControl(
				book,
				{
					kind: "deliver_answer",
					runId: run?.runId ?? null,
					label: interaction.label,
					interactionId: interaction.interactionId,
					answer: interaction.answer,
				},
				command.commandId,
			);
			interaction.deliveries.push(book.sends.indexOf(send));
			return changed;
		}
		case "stop_tasks": {
			// 8.4: "all" means the live tasks; unknown or none issues nothing.
			const tasks = taskView(book);
			if (tasks.tag !== "live")
				return rejected(`stop_tasks with tasks ${tasks.tag} (8.4)`);
			const keys =
				command.tasks === "all"
					? tasks.tasks.map((task) => task.key)
					: command.tasks.filter((key) =>
							tasks.tasks.some((task) => sameKey(task.key, key)),
						);
			if (keys.length === 0) return rejected("no live task named (8.4)");
			for (const key of keys)
				issueTokened(book, step, { kind: "stop_task", key });
			return changed;
		}
		case "confirm_escalation": {
			// 8.4, D45: a confirm answers only the gate's current snapshot; its end_session step
			// issues at the confirm, addressed then (L2).
			const gate = book.confirm;
			if (gate === undefined) return rejected("no pending confirm (8.4)");
			if (command.snapshotEntry !== book.snapshotEntry)
				return rejected("stale confirm (8.4)");
			book.confirm = undefined;
			if (gate.step === "end_session" && gate.commandId !== undefined)
				endSession(book, findRun(book, gate.runId), gate.commandId);
			return changed;
		}
		case "native_command": {
			if (
				book.nativeCommands.some((item) => item.commandId === command.commandId)
			)
				return rejected("native command already issued (8.5)");
			// 8.5 (L4, D60): a session send main issues, live and shown in the decision that folds it;
			// its deadline starts at issue.
			const send = issueControl(
				book,
				{
					kind: "send_native_command",
					commandId: command.commandId,
					text: command.text,
				},
				command.commandId,
			);
			book.nativeCommands.push({
				commandId: command.commandId,
				send: book.sends.indexOf(send),
				state: "Sent",
				remaining: fact.policy.nativeCommandMs,
				deadline: {
					at: fact.now + fact.policy.nativeCommandMs,
					opened: book.entry,
				},
			});
			return changed;
		}
	}
}

/** Applies one entry to a draft; the caller discards the draft unless it changed. */
function apply(book: Book, entry: Entry, step: Step): Outcome {
	switch (entry.kind) {
		case "end": {
			const run = findRun(book, entry.runId);
			if (run === undefined || run.phase === "Ended")
				return rejected(`a second terminal for Run ${entry.runId} (3.2)`);
			run.phase = "Ended";
			run.retryAt = undefined;
			run.exec.settle = undefined;
			run.ended = { outcome: entry.outcome, reason: entry.reason };
			// D43: the gate drops with its Run.
			if (book.confirm?.runId === entry.runId) book.confirm = undefined;
			return changed;
		}
		case "release": {
			const gate = book.confirm;
			if (gate === undefined || taskView(book).tag !== "none")
				return rejected("a release with no gate to release (8.4)");
			book.confirm = undefined;
			// 8.4: the end_session step issues at its release, addressed then (L2).
			if (gate.step === "end_session" && gate.commandId !== undefined)
				endSession(book, findRun(book, gate.runId), gate.commandId);
			return changed;
		}
		case "unlaunch": {
			const run = findRun(book, entry.runId);
			if (run?.phase !== "Launched" || !notYetDelivered(book, run))
				return rejected(`an unlaunch of a delivered Run ${entry.runId} (3.6)`);
			// 3.6 D50: back to Queued; the execution's sends are dropped and resolve no further (L2).
			const txs = deliverySends(book, run).flatMap((send) => send.txs);
			for (const tx of txs) tx.ended ??= "dropped";
			for (const send of runSends(book, run)) send.dropped = true;
			run.retryAt = txs.at(-1)?.retryAt;
			run.phase = "Queued";
			if (txs.some((tx) => tx.resumeRejected)) book.freshSince = book.seq;
			return changed;
		}
		case "fact": {
			book.entry++;
			const command = entry.command;
			switch (command.verb) {
				case "admit": {
					const prior = book.inputs.get(command.inputId);
					if (
						prior?.runId !== undefined &&
						findRun(book, prior.runId)?.phase !== "Ended"
					)
						return rejected("input already admitted to an active Run");
					// D58, 3.4: main's handoff; main's run.requested reserves the Run.
					const input: Input = { delivery: command.delivery };
					book.inputs.set(command.inputId, input);
					// 3.9 GAP (CONTRACT.md 984 leaves when a steer joins open): following the oracle, a
					// steer joins the active Run at admission once it is Launched.
					const run = activeInputRun(book);
					if (command.delivery === "steer" && run?.phase === "Launched") {
						run.inputs.push(command.inputId);
						input.runId = run.runId;
					}
					return changed;
				}
				case "observe":
					return observe(book, entry, step, command.observation);
				case "control":
					return control(book, entry, step, command.control);
				case "settle":
					return settle(book, entry, step, command.settlement);
			}
		}
	}
}

type Recorded =
	| { readonly tag: "Recorded"; readonly book: Book }
	| { readonly tag: "Unchanged"; readonly diagnostic?: string | undefined }
	| { readonly tag: "Rejected"; readonly diagnostic: string };

function record(book: Book, entry: Entry, step: Step): Recorded {
	const draft = structuredClone(book);
	const outcome = apply(draft, entry, step);
	switch (outcome.tag) {
		case "Changed":
			return { tag: "Recorded", book: draft };
		case "Noop":
			return { tag: "Unchanged", diagnostic: outcome.diagnostic };
		case "Rejected":
			return outcome;
	}
}

// ---------------------------------------------------------------------------------------------
// The public seam (3.1).

const bookOf = (state: SessionLedgerState) => state as unknown as Book;
const stateOf = (book: Book) => book as unknown as SessionLedgerState;

export function initialSessionLedgerState(
	sessionId: string,
	provider: ProviderKind,
): SessionLedgerState {
	return stateOf({
		sessionId,
		provider,
		entry: 0,
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
		interactions: [],
		wakes: [],
		nativeCommands: [],
		lostWork: [],
		lostDecided: new Set(),
		snapshotEntry: 0,
		servers: new Map(),
	});
}

/** Fixpoint bound for reconcile (3.2). */
const reconcileBound = 64;

export function decide(
	state: SessionLedgerState,
	command: LedgerCommand,
	ctx: DecideContext,
): Decision<LedgerEvent> {
	const book = bookOf(state);
	// 3.12: the fact keeps the ids it mints, so evolve replays them.
	const ids: string[] = [];
	const step: Step = {
		newId: () => {
			const id = ctx.newId();
			ids.push(id);
			return id;
		},
		effects: [],
	};
	const fact: Entry = {
		kind: "fact",
		command,
		now: ctx.now,
		policy: ctx.policy,
		ids,
	};
	const recorded = record(book, fact, step);
	if (recorded.tag === "Rejected") return recorded;
	const alarm = (at: number | undefined) =>
		at === undefined ? {} : { alarmAt: at };
	if (recorded.tag === "Unchanged")
		return {
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			...alarm(read(book).alarmAt),
			...(recorded.diagnostic === undefined
				? {}
				: { diagnostic: recorded.diagnostic }),
		};
	const entries: Entry[] = [fact];
	let current = recorded.book;
	for (
		let next = reconcile(read(current));
		next !== undefined;
		next = reconcile(read(current))
	) {
		if (entries.length > reconcileBound)
			return {
				tag: "Rejected",
				diagnostic: `reconcile found no fixpoint within ${reconcileBound} steps (3.2)`,
			};
		const decided = record(current, next, step);
		if (decided.tag !== "Recorded")
			return {
				tag: "Rejected",
				diagnostic: `reconcile made an illegal decision: ${decided.diagnostic ?? next.kind}`,
			};
		entries.push(next);
		current = decided.book;
	}
	return {
		tag: "Accepted",
		events: entries as readonly Entry[] as unknown as readonly LedgerEvent[],
		effects: step.effects,
		ended: entries.flatMap((entry): RunEnded[] =>
			entry.kind === "end"
				? [{ runId: entry.runId, outcome: entry.outcome, reason: entry.reason }]
				: [],
		),
		...alarm(read(current).alarmAt),
	};
}

/** evolve is record (3.2): it replays the entry and never reconciles. */
export function evolve(
	state: SessionLedgerState,
	event: LedgerEvent,
): SessionLedgerState {
	const entry = event as unknown as Entry;
	const ids = entry.kind === "fact" ? [...entry.ids] : [];
	const recorded = record(bookOf(state), entry, {
		newId: () => ids.shift() ?? "",
		effects: [],
	});
	return recorded.tag === "Recorded" ? stateOf(recorded.book) : state;
}

function inputState(book: Book, run: Run, inputId: string): InputState {
	const failed = book.inputs.get(inputId)?.failed;
	if (failed !== undefined) return { tag: "Failed", reason: failed };
	const txs = deliverySends(book, run)
		.filter((send) => send.effect.inputId === inputId)
		.flatMap((send) => send.txs);
	const accepted = txs.find((tx) => tx.consumption.tag === "Accepted");
	if (accepted !== undefined)
		return accepted.nativeMessageId === undefined
			? { tag: "Accepted" }
			: { tag: "Accepted", nativeMessageId: accepted.nativeMessageId };
	// 3.7: an unknown delivery nothing answered stays unknown until a probe or receipt settles it.
	if (
		txs.some(
			(tx) => tx.transport.tag === "Unknown" && tx.consumption.tag === "None",
		)
	)
		return { tag: "Delivered", certainty: "unknown" };
	const latest = txs.at(-1);
	// A latest try not consumed waits as Queued (3.9).
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

function activeView(book: Book, run: Run): ActiveRunView {
	const head = {
		runId: run.runId,
		inputs: run.inputs.map((inputId) => ({
			inputId,
			state: inputState(book, run, inputId),
		})),
		...(run.origin === "input"
			? { origin: "input" as const }
			: run.wakeTask === undefined
				? { origin: "wake" as const }
				: { origin: "wake" as const, wakeTask: run.wakeTask }),
	};
	// L6: the stop deadline shows on a Queued Run with label work, else on the Run its items name.
	// Gap (CONTRACT.md 787-794, 2837-2850): following the oracle, a Claude wake Run shows none.
	const stop = book.stop;
	const deadline =
		stop !== undefined &&
		stopOpen(book) &&
		!(
			run.origin === "wake" &&
			nativePolicies[book.provider].capabilities.commandReceipts
		) &&
		(run.phase === "Queued"
			? labelWorkOutstanding(book)
			: stop.items.some((item) =>
					"wake" in item
						? book.wakes[item.wake]?.runId === run.runId
						: book.sends[item.send]?.runId === run.runId,
				))
			? { deadline: { owner: "Stop" as const, at: stop.at } }
			: {};
	if (run.phase === "Queued")
		return {
			...head,
			tag: "Queued",
			...deadline,
			...(run.retryAt === undefined ? {} : { retryAt: run.retryAt }),
		};
	if (run.phase === "Interrupting")
		return { ...head, tag: "Interrupting", by: run.by ?? "stop", ...deadline };
	return run.exec.settle === undefined
		? { ...head, tag: run.exec.evidence ? "Running" : "Starting", ...deadline }
		: {
				...head,
				tag: "Settling",
				deadline: { owner: "Run", runId: run.runId, at: run.exec.settle.at },
			};
}

export function viewLedger(state: SessionLedgerState): LedgerView {
	const book = bookOf(state);
	const run = activeRun(book);
	const live = book.sends.flatMap((send): IssuedEffect[] => {
		const effect = send.effect;
		if (effect.kind === "probe") return [];
		const acting = send.txs.filter((tx) => mayStillAct(book, send, tx));
		// 3.13: decide's own effects are Tokened per transmission; every effect main issues is Main.
		if (effect.kind === "cancel_request" || effect.kind === "stop_task")
			return acting.flatMap((tx): IssuedEffect[] =>
				tx.token === undefined
					? []
					: [{ tag: "Tokened", token: tx.token, effect }],
			);
		return acting.length > 0 && send.commandId !== undefined
			? [{ tag: "Main", commandId: send.commandId, effect }]
			: [];
	});
	const tasks = taskView(book);
	return {
		paused: false,
		...(run === undefined ? {} : { active: activeView(book, run) }),
		// D58: main's module computes the inbox (T2).
		inbox: [],
		live,
		tasks,
		...(book.servers.size === 0 ? {} : { servers: new Map(book.servers) }),
		// 8.3: a non-ended Run, a send that may still act, tasks live or unknown, a wake execution, or
		// a server live (8.7).
		anythingMayAct:
			run !== undefined ||
			live.length > 0 ||
			tasks.tag !== "none" ||
			book.wakes.some((wake) => wake.ended === undefined) ||
			book.servers.size > 0,
		// 8.4: a gate shows while its tasks are live or unknown; its labels are the current one.
		...(book.confirm === undefined || tasks.tag === "none"
			? {}
			: {
					pendingConfirm: {
						step: book.confirm.step,
						labels: [currentLabel(book)].filter((label) => label !== null),
						snapshotEntry: book.snapshotEntry,
						tasks,
					},
				}),
		lostWork: book.lostWork,
		// 8.5: a projection of its send; Failed with the covering cause when covered.
		nativeCommands: book.nativeCommands.map((command): NativeCommandView => {
			const { commandId, state } = command;
			const covered = coveringCause(book, command);
			if (
				covered !== undefined &&
				state !== "Completed" &&
				state !== "Cancelled" &&
				state !== "Failed"
			)
				return { commandId, tag: "Failed", code: covered };
			switch (state) {
				case "Sent":
				case "Started":
					return command.deadline === undefined
						? { commandId, tag: "Queued" }
						: {
								commandId,
								tag: state,
								deadline: {
									owner: "NativeCommand",
									commandId,
									at: command.deadline.at,
								},
							};
				case "Failed":
					return { commandId, tag: "Failed", code: command.code ?? "failed" };
				default:
					return { commandId, tag: state };
			}
		}),
		interactions: book.interactions.flatMap((item): InteractionView[] => {
			const send = item.deliveries.map((index) => book.sends[index]).at(-1);
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
		}),
	};
}

/** 3.5 `fenceHolds`, read by `markRunning` before a start's claim `claim` (2.1 row 202). */
export const fenceHolds = (state: SessionLedgerState, claim?: string) =>
	labelWorkOutstanding(bookOf(state), claim);

/**
 * One input as main's units read it (2.1 rows 206, 207, 210-212): its Run's delivery sends (D53),
 * every execution's, so a relaunch keeps its tries (4.8); undefined for an input never admitted.
 */
export function inputPlacement(
	state: SessionLedgerState,
	inputId: string,
	claim?: string,
): InputPlacement | undefined {
	const book = bookOf(state);
	const input = book.inputs.get(inputId);
	if (input === undefined) return undefined;
	const run = findRun(book, input.runId);
	const sends = book.sends.filter(
		(send): send is Send<StartEffect | SteerEffect> =>
			delivers(send) &&
			send.runId === input.runId &&
			send.effect.inputId === inputId,
	);
	return {
		start: !(
			input.delivery === "steer" &&
			run !== undefined &&
			run.inputs[0] !== inputId
		),
		steer: input.delivery === "steer",
		place:
			input.failed !== undefined
				? "failed"
				: sends.some(
							(send) =>
								sendValue(send) === "reached" ||
								(sendValue(send) === "possibly" && !sendUnconsumed(send)),
						)
					? "sent"
					: "unplaced",
		transmissions: sends
			.flatMap((send) => send.txs)
			.filter((tx) => !tx.notSent && !claimOf(tx, claim)).length,
	};
}
