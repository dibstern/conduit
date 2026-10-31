import type {
	ActiveRunView,
	Consumption,
	DecideContext,
	Decision,
	EndReason,
	Evidence,
	InputState,
	IssuedEffect,
	Label,
	LedgerCommand,
	LedgerView,
	ProviderDecisionRules,
	ProviderKind,
	RunEffect,
	RunEnded,
	RunOutcome,
	SendToken,
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
	readonly token?: SendToken | undefined;
	readonly seq: number;
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
	declined: boolean;
	/** 9: an input_absent finding; a later acceptance beats it. */
	absent: boolean;
	/** A result answered it (3.8 5C: proof after an unknown delivery). */
	resulted: boolean;
	/** The first delivery-recovery probe's deadline (3.7, D20). */
	recovery?: { readonly at: number; readonly opened: number } | undefined;
	/** Its answers, the evidence section 9's work-ended column reads. */
	readonly answers: Evidence[];
	/** D52: sealed at its first closing fact, reading its value then. */
	sealed?: { readonly value: Value; readonly unconsumed: boolean } | undefined;
	/** Why its work ended (3.5): its evidence, main's terminal (D59), coverage or an unlaunch. */
	ended?:
		| "evidence"
		| "main"
		| "process_lost"
		| "session_ended"
		| "dropped"
		| undefined;
	nativeMessageId?: string | undefined;
	accounted: boolean;
}

type StartEffect = Extract<RunEffect, { kind: "start" }>;
type ProbeEffect = Extract<RunEffect, { kind: "probe" }>;

/** A probe's target and what it covers, stored at issue (3.7, 3.12). */
interface Probe {
	readonly target: ProbeEffect["target"];
	/** The transmission an input probe recovers. */
	readonly subject?: { readonly send: number; readonly tx: number } | undefined;
	deadline?: { readonly at: number; readonly opened: number } | undefined;
	done: boolean;
}

/** Send (issue decision, 3.3): a start main issues (D60) or a probe decide issues (3.12). */
interface Send<
	Effect extends StartEffect | ProbeEffect = StartEffect | ProbeEffect,
> {
	readonly seq: number;
	readonly effect: Effect;
	readonly held: boolean;
	commandId?: string | undefined;
	readonly runId: string;
	/** Its execution (3.3). */
	readonly exec: number;
	/** L2 case 3: the current process at issue, null while pending, then resolved once. */
	runnerId: string | null;
	label: Label | null;
	/** L2, 3.6: a send of an execution an unlaunch dropped resolves no further. */
	dropped: boolean;
	readonly txs: Tx[];
	/** 4.3: hold_exhausted settled it failed at the cap. */
	exhausted: boolean;
	probe?: Probe | undefined;
}
type StartSend = Send<StartEffect>;

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

/** Run (decisions only, 3.3). Interrupting lands with stopping (32.2.7). */
interface Run {
	readonly runId: string;
	readonly inputs: string[];
	phase: "Queued" | "Launched" | "Ended";
	exec: Exec;
	/** 3.6: after an unlaunch, the unlaunching outcome's retryAt (a field, not a deadline). */
	retryAt?: number | undefined;
	/** The Tombstone (3.8). */
	ended?: Pick<RunEnded, "outcome" | "reason"> | undefined;
}

interface Book {
	readonly sessionId: string;
	readonly provider: ProviderKind;
	/** Fact entries recorded; a deadline is due only at a later entry (3.7). */
	entry: number;
	/** Issue order of sends and transmissions (3.4 freshness, 10A). */
	seq: number;
	readonly runs: Run[];
	readonly inputs: Map<string, { runId?: string; failed?: string }>;
	readonly sends: Send[];
	/** Cache written only by record (3.2). */
	readonly tokens: Map<string, { readonly send: number; readonly tx: number }>;
	readonly mainRuns: Map<string, { readonly runId: string; open: boolean }>;
	readonly seen: Set<string>;
	/** The seq of the last session end or rejected resume (3.4). */
	freshSince: number;
	readonly runners: Map<string, { latest: Label; retired: boolean }>;
	current: string | null;
	readonly retirements: Set<string>;
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
	| { readonly kind: "unlaunch"; readonly runId: string };
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
const noop = (diagnostic?: string): Outcome => ({ tag: "Noop", diagnostic });
const rejected = (diagnostic: string): Outcome => ({
	tag: "Rejected",
	diagnostic,
});
/** An input a later lane builds: a typed rejection the differential test excludes by name. */
const notBuilt = (ticket: string, what: string): Outcome =>
	rejected(`not yet built (${ticket}): ${what}`);

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
	return at < 0
		? { runnerId: label, querySeq: 0 }
		: {
				runnerId: label.slice(0, at),
				querySeq: Number(label.slice(at + 1)) || 0,
			};
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
function mayStillAct(send: Send, tx: Tx): boolean {
	if (tx.ended !== undefined || send.effect.kind === "probe") return false;
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

const findRun = (book: Book, runId: string | undefined) =>
	runId === undefined
		? undefined
		: book.runs.find((run) => run.runId === runId);
/** The sends of the Run's current execution (3.6). */
const runSends = (book: Book, run: Run) =>
	book.sends.filter(
		(send) => send.runId === run.runId && send.exec === run.exec.n,
	);
const isStart = (send: Send): send is StartSend => send.effect.kind === "start";
/** Its starts: the sends that deliver (3.6); a Run's end waits for no probe (3.8 condition 2). */
const deliverySends = (book: Book, run: Run) =>
	runSends(book, run).filter(isStart);
const activeRun = (book: Book) =>
	book.runs.find((run) => run.phase !== "Ended");
const currentLabel = (book: Book): Label | null =>
	book.current === null
		? null
		: (book.runners.get(book.current)?.latest ?? null);

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

/** 3.6 retry pending: from a retrying outcome until its next transmission, an acceptance or the end. */
function retryPending(book: Book, run: Run, send: StartSend): boolean {
	const latest = send.txs.at(-1);
	if (
		send.exhausted ||
		latest?.sealed === undefined ||
		(latest.ended !== undefined && latest.ended !== "evidence") ||
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
		latest.declined ||
		latest.absent ||
		(latest.retryable && latest.consumption.tag === "None")
	);
}

/** 3.8 outcome fold (5C, 10A): failure beats success, specific beats generic. */
function fold(
	items: readonly FoldItem[],
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
	return items.some((item) => item.outcome === "interrupted")
		? { outcome: "interrupted", reason: { tag: "interrupted", forced: false } }
		: { outcome: "completed", reason: { tag: "completed" } };
}

/** What 3.6 and 3.8 read of one Launched Run. */
interface RunSummary {
	readonly runId: string;
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
		.map((tx) => tx.ended);
	const covered =
		covers.includes("session_ended") || exec.endedBy === "session_ended"
			? "session_ended"
			: covers.includes("process_lost") || exec.endedBy === "process_lost"
				? "process_lost"
				: undefined;
	return {
		runId: run.runId,
		endEvidence: exec.endEvidence,
		awaiting,
		nothingMayAct:
			sends.every((send) => send.txs.at(-1)?.sealed !== undefined) &&
			sends.every(
				(send) =>
					!send.txs.some((tx) => mayStillAct(send, tx)) &&
					!retryPending(book, run, send),
			) &&
			!(exec.evidence && !exec.endEvidence && exec.endedBy === undefined),
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
		fold: fold([
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
		]),
	};
}

interface Due {
	readonly at: number;
	readonly opened: number;
	readonly fire: (fact: Fact, step: Step) => void;
}

/** 3.7: every open deadline with its firing, in deadline then opening order. */
function deadlines(book: Book): Due[] {
	const due: Due[] = [];
	for (const run of book.runs) {
		const settle = run.exec.settle;
		if (run.phase !== "Ended" && settle !== undefined)
			due.push({
				...settle,
				fire: (fact, step) => {
					// 3.7: Settling's expiry probes native_session; the view then reads Running (3.6).
					run.exec.settle = undefined;
					probe(book, fact, step, run, { tag: "native_session" });
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
		if (!isStart(send)) continue;
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
							run,
							{ tag: "input", inputId: send.effect.inputId },
							{ send: book.sends.indexOf(send), tx: send.txs.indexOf(tx) },
						);
					},
				});
		}
	}
	return due.sort((a, b) => a.at - b.at || a.opened - b.opened);
}

function read(book: Book) {
	return {
		runs: book.runs.flatMap((run) =>
			run.phase === "Launched" ? [summarize(book, run)] : [],
		),
		alarmAt: deadlines(book)[0]?.at,
	};
}

// ---------------------------------------------------------------------------------------------
// reconcile (3.2): reads only `read`'s output and returns the next decision, or none.

function reconcile(situation: ReturnType<typeof read>): Entry | undefined {
	const end = (
		runId: string,
		ended: Pick<RunEnded, "outcome" | "reason">,
	): Entry => ({ kind: "end", runId, ...ended });
	for (const run of situation.runs) {
		if (run.endEvidence && !run.awaiting) return end(run.runId, run.fold);
		if (!run.nothingMayAct) continue;
		// D48: a permanent outcome on an undelivered start ends it refused; else D50 unlaunches.
		if (run.notYetDelivered)
			return run.refusal === undefined
				? { kind: "unlaunch", runId: run.runId }
				: end(run.runId, {
						outcome: "error",
						reason: { tag: "refused", code: run.refusal },
					});
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
	return undefined;
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

function issue<Effect extends StartEffect | ProbeEffect>(
	book: Book,
	run: Run,
	effect: Effect,
	held: boolean,
): Send<Effect> {
	const send: Send<Effect> = {
		seq: book.seq++,
		effect,
		held,
		runId: run.runId,
		exec: run.exec.n,
		runnerId: book.current,
		label: currentLabel(book),
		dropped: false,
		txs: [],
		exhausted: false,
	};
	book.sends.push(send);
	return send;
}
const start = (book: Book, run: Run, inputId: string, held: boolean) =>
	issue(
		book,
		run,
		{ kind: "start", runId: run.runId, inputId, mode: nextMode(book) },
		held,
	);

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
	run: Run,
	target: Probe["target"],
	subject?: Probe["subject"],
): void {
	const send = issue(
		book,
		run,
		{ kind: "probe", runId: run.runId, target },
		false,
	);
	send.probe = { target, subject, done: false };
	reprobe(book, fact, step, send, send.probe);
}

function launch(run: Run): void {
	run.phase = "Launched";
	run.retryAt = undefined;
	run.exec = newExec(run.exec.n + 1);
}

/** D53: a start fails its input once, at a permanent outcome other than a rejected resume or Stop's own. */
function failInput(book: Book, send: Send, tx: Tx): void {
	if (!isStart(send) || tx.resumeRejected || tx.stopOwn) return;
	const input = book.inputs.get(send.effect.inputId);
	if (input?.runId === send.runId)
		// Gap (CONTRACT.md 1521-1523): only hold_exhausted names a code; any other uncoded failure
		// reuses provider_send_attempts_exhausted.
		input.failed ??= tx.permanent ?? "provider_send_attempts_exhausted";
}

/** The first delivery-recovery probe: a start's deadline at the outcome plus probeMs (3.7, D20). */
function openRecovery(book: Book, fact: Fact, send: Send, tx: Tx): void {
	if (isStart(send))
		tx.recovery ??= { at: fact.now + fact.policy.probeMs, opened: book.entry };
}

function effectOutcome(
	book: Book,
	fact: Fact,
	send: Send,
	tx: Tx,
	outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
): Outcome {
	switch (outcome.tag) {
		case "succeeded":
			tx.transport = joinTransport(tx.transport, { tag: "Sent" });
			break;
		case "retryable":
			tx.retryable = true;
			tx.retryAt = outcome.retryAt;
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
		case "permanent":
			tx.permanent = outcome.code;
			tx.resumeRejected = outcome.code === "native_resume_rejected";
			tx.transport = joinTransport(tx.transport, {
				tag: "Failed",
				code: outcome.code,
			});
			failInput(book, send, tx);
			break;
		case "delivery_unknown":
			// 3.7, D20: an unknown delivery is never re-sent; a probe recovers it.
			tx.transport = joinTransport(tx.transport, { tag: "Unknown" });
			seal(tx);
			openRecovery(book, fact, send, tx);
			return changed;
	}
	seal(tx);
	return changed;
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
function rules(book: Book): ProviderDecisionRules {
	const policy = nativePolicies[book.provider];
	// Gap (CONTRACT.md 3087, 32.2.13): a Pending row's start fences, has no idle proof, and its
	// work ends at its runEnd evidence, the nearest reading until its row is decided.
	return policy.tag === "Ready"
		? policy.rules
		: {
				fences: (effect) => effect.kind === "start",
				idleCovers: () => false,
				workEnded: (evidence) =>
					evidence.some((item) => item.kind === policy.runEnd),
			};
}
const never = () => false;
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
	started: { class: "lifecycle", produces: isStart, merge: liveness },
	activity: { class: "lifecycle", produces: isStart, merge: liveness },
	result: {
		class: "lifecycle",
		produces: isStart,
		merge(book, fact, { send, tx, run }, evidence) {
			tx.resulted = true;
			tx.consumption = joinConsumption(tx.consumption, { tag: "Observed" });
			seal(tx);
			const authority =
				run !== undefined &&
				run.phase !== "Ended" &&
				send.exec === run.exec.n &&
				(tx.ended === undefined || tx.ended === "evidence");
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
		produces: isStart,
		merge(book, _fact, { tx, run, live }) {
			// 9: query_ended ends only an owned execution's work, and its own by the work-ended column.
			if (runEnd(book) !== "query_ended") return noop();
			// 9: it ends its label's fence members.
			for (const send of book.sends)
				if (rules(book).fences(send.effect))
					for (const other of send.txs)
						if (tx.label !== null && other.label === tx.label)
							other.ended ??= "evidence";
			if (live && run !== undefined) run.exec.endEvidence = true;
			return changed;
		},
	},
	input_accepted: {
		class: "receipt",
		produces: isStart,
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
		produces: isStart,
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
		produces: isStart,
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
			// cancel_request's, never a start's.
			evidence.outcome.tag === "not_sent" && isStart(send)
				? rejected("start cannot produce not_sent evidence (3.4)")
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
					break;
				}
			}
			return changed;
		},
	},
	interaction_requested: {
		class: "interaction",
		produces: isStart,
		merge: () => notBuilt("32.2.8", "interaction_requested"),
	},
	interaction_resolved: {
		class: "interaction",
		produces: never,
		merge: () => notBuilt("32.2.8", "interaction_resolved"),
	},
	command_lifecycle: {
		class: "command",
		produces: isStart,
		merge: () => notBuilt("32.2.8", "command_lifecycle"),
	},
	command_result: {
		class: "command",
		produces: never,
		merge: () => notBuilt("32.2.11", "command_result"),
	},
	tasks_snapshot: {
		class: "background",
		produces: never,
		merge: () => notBuilt("32.2.11", "tasks_snapshot"),
	},
	task_event: {
		class: "background",
		produces: never,
		merge: () => notBuilt("32.2.11", "task_event"),
	},
	turn_started: {
		class: "background",
		produces: never,
		merge: () => notBuilt("32.2.11", "turn_started"),
	},
	turn_ended: {
		class: "background",
		produces: never,
		merge: () => notBuilt("32.2.11", "turn_ended"),
	},
};

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
	const heldSends = book.sends
		.filter(isStart)
		.filter((send) => send.held && send.runId === run.runId);
	let send = heldSends
		.filter((item) => item.commandId === evidence.commandId)
		.at(-1);
	if (send !== undefined) {
		// 3.6 D50: a relaunch is a new transmission of the same issue, in a new execution.
		if (run.phase === "Queued") {
			launch(run);
			send = start(book, run, send.effect.inputId, true);
			send.commandId = evidence.commandId;
		} else if (
			run.phase === "Ended" &&
			send.txs.some((tx) => tx.ended === "dropped")
		)
			return noop("the dropped issue's hold finds no running send (H3)");
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
	// L2: a pending held send resolves at its own run_dispatched to the runner it names.
	if (send.runnerId === null) {
		send.runnerId = evidence.runnerId;
		send.label = runner?.latest ?? null;
		for (const tx of send.txs)
			if (tx.runnerId === null) {
				tx.runnerId = evidence.runnerId;
				tx.label = send.label;
			}
	}
	transmit(book, send, token, evidence.runnerId, runner?.latest ?? send.label);
	return changed;
}

function observe(
	book: Book,
	fact: Fact,
	observation: Extract<LedgerCommand, { verb: "observe" }>["observation"],
): Outcome {
	switch (observation.tag) {
		case "Unsolicited":
			return notBuilt("32.2.11", `unsolicited ${observation.kind}`);
		case "Main": {
			const key = `main\u0000${observation.eventId}`;
			if (book.seen.has(key)) return noop("repeated main observation (D60)");
			book.seen.add(key);
			switch (observation.kind) {
				case "run_requested": {
					const input = book.inputs.get(observation.inputId);
					if (input === undefined)
						return noop("run.requested for an input never admitted");
					if (input.runId === undefined) {
						if (activeRun(book) !== undefined)
							return noop("run.requested while another Run is active");
						// 3.4: the Run is reserved at main's run.requested, under main's runId.
						book.runs.push({
							runId: observation.runId,
							inputs: [observation.inputId],
							phase: "Queued",
							exec: newExec(0),
						});
						input.runId = observation.runId;
					}
					const run = findRun(book, input.runId);
					if (run === undefined || run.phase === "Ended")
						return noop("run.requested for an ended Run (3.8)");
					book.mainRuns.set(observation.runId, {
						runId: run.runId,
						open: true,
					});
					if (run.phase === "Queued") launch(run);
					const send =
						deliverySends(book, run).find(
							(item) => item.effect.inputId === observation.inputId,
						) ?? start(book, run, observation.inputId, !observation.direct);
					if (observation.direct) {
						// 3.13: a direct start is Main under its input's id, its token the runId (3.4).
						send.commandId ??= observation.inputId;
						transmit(book, send, observation.runId as SendToken);
					}
					return changed;
				}
				case "run_started":
					return notBuilt("32.2.8", "run.started");
				case "run_terminal": {
					const target = book.mainRuns.get(observation.runId);
					if (target === undefined)
						return noop("run_terminal for an unknown run");
					target.open = false;
					const run = findRun(book, target.runId);
					if (run === undefined || run.phase === "Ended") return changed;
					// D59: main's terminal ends its Run's work as main.
					for (const send of runSends(book, run))
						for (const tx of send.txs) tx.ended ??= "main";
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
			if (
				observation.kind === "run_dispatched" &&
				!book.tokens.has(observation.token)
			)
				return dispatched(book, observation.token, observation);
			if (
				observation.kind === "effect_outcome" &&
				observation.transmission !== undefined
			)
				return notBuilt("32.2.7", "a control's effect_outcome");
			const at = book.tokens.get(observation.token);
			const send = at === undefined ? undefined : book.sends[at.send];
			const tx = at === undefined ? undefined : send?.txs[at.tx];
			if (send === undefined || tx === undefined)
				return noop("unknown or never-issued token (3.4)");
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
			// 3.5, 9: a start's own work ends by its provider's work-ended column.
			if (isStart(send) && rules(book).workEnded(tx.answers))
				tx.ended ??= "evidence";
			return outcome;
		}
	}
}

function settle(
	book: Book,
	fact: Fact,
	step: Step,
	settlement: Extract<LedgerCommand, { verb: "settle" }>["settlement"],
): Outcome {
	switch (settlement.kind) {
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
			const send =
				sends
					.filter((item) => item.commandId === settlement.commandId)
					.at(-1) ?? sends.find((item) => item.commandId === undefined);
			if (send === undefined) return noop("unknown token (3.4)");
			send.commandId ??= settlement.commandId;
			const tx = transmit(book, send, undefined);
			effectOutcome(book, fact, send, tx, settlement.outcome);
			tx.notSent ||= settlement.outcome.tag === "not_sent";
			return changed;
		}
		case "process_started": {
			const { runnerId, querySeq } = splitLabel(settlement.label);
			const prior = book.runners.get(runnerId);
			// L1: retired is final, and a live runner's start at or below its latest querySeq is older.
			if (
				prior?.retired === true ||
				(prior !== undefined &&
					book.current === runnerId &&
					querySeq <= splitLabel(prior.latest).querySeq)
			)
				return noop("an older label's process_started changes nothing (L1)");
			if (
				settlement.reattached &&
				nativePolicies[book.provider].capabilities.backgroundTasks
			)
				return notBuilt("32.2.11", "a reattached runner's tasks");
			// Gap (CONTRACT.md 346-348): L1 retires every other runner here; this slice follows the
			// oracle and leaves that retirement to the host's process_lost (H1, 6.9).
			book.runners.set(runnerId, { latest: settlement.label, retired: false });
			book.current = runnerId;
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
			const runner = book.runners.get(settlement.runnerId);
			if (runner !== undefined) runner.retired = true;
			if (book.current === settlement.runnerId) book.current = null;
			const addressed = (send: Send, tx: Tx) =>
				send.runnerId === settlement.runnerId ||
				tx.runnerId === settlement.runnerId;
			// L1 item 1: retiring covers every send addressed to it and seals its transmissions.
			for (const send of book.sends) {
				for (const tx of send.txs)
					if (addressed(send, tx)) {
						seal(tx);
						tx.ended ??= "process_lost";
					}
				if (
					send.held &&
					send.txs.length === 0 &&
					send.runnerId === settlement.runnerId &&
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
			return changed;
		}
		case "session_ended": {
			// 3.4: the native session ends at this fact and covers every send issued before it.
			let moved = book.freshSince !== book.seq;
			book.freshSince = book.seq;
			for (const send of book.sends)
				for (const tx of send.txs)
					if (tx.sealed === undefined || tx.ended === undefined) {
						seal(tx);
						tx.ended ??= "session_ended";
						moved = true;
					}
			for (const run of book.runs)
				if (
					run.phase !== "Ended" &&
					run.exec.evidence &&
					run.exec.endedBy === undefined
				) {
					run.exec.endedBy = "session_ended";
					moved = true;
				}
			return moved ? changed : noop("the native session already ended");
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
					if (command.delivery === "steer")
						return notBuilt("32.2.8", "a steer's admission");
					const prior = book.inputs.get(command.inputId);
					if (
						prior?.runId !== undefined &&
						findRun(book, prior.runId)?.phase !== "Ended"
					)
						return rejected("input already admitted to an active Run");
					// D58, 3.4: main's handoff; main's run.requested reserves the Run.
					book.inputs.set(command.inputId, {});
					return changed;
				}
				case "observe":
					return observe(book, entry, command.observation);
				case "control":
					return notBuilt("32.2.7", `the ${command.control.kind} control`);
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
		origin: "input" as const,
	};
	if (run.phase === "Queued")
		return {
			...head,
			tag: "Queued",
			...(run.retryAt === undefined ? {} : { retryAt: run.retryAt }),
		};
	return run.exec.settle === undefined
		? { ...head, tag: run.exec.evidence ? "Running" : "Starting" }
		: {
				...head,
				tag: "Settling",
				deadline: { owner: "Run", runId: run.runId, at: run.exec.settle.at },
			};
}

export function viewLedger(state: SessionLedgerState): LedgerView {
	const book = bookOf(state);
	const run = activeRun(book);
	const live = book.sends.flatMap((send): IssuedEffect[] =>
		send.commandId !== undefined && send.txs.some((tx) => mayStillAct(send, tx))
			? [{ tag: "Main", commandId: send.commandId, effect: send.effect }]
			: [],
	);
	return {
		paused: false,
		...(run === undefined ? {} : { active: activeView(book, run) }),
		// D58: main's module computes the inbox (T2).
		inbox: [],
		live,
		tasks: { tag: "none" },
		anythingMayAct: run !== undefined || live.length > 0,
		lostWork: [],
		nativeCommands: [],
		interactions: [],
	};
}
