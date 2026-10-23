import { answer, request } from "./run-ledger-answers.js";
import {
	type Correlated,
	confirmDelivery,
	retireSession,
} from "./run-ledger-correlation.js";
import { fireAlarm } from "./run-ledger-deadlines.js";
import { cancel } from "./run-ledger-input-records.js";
import { type ActiveRun, activeRun, type Work } from "./run-ledger-internal.js";
import {
	activity,
	endQuery,
	finish,
	interrupt,
	recordResult,
} from "./run-ledger-lifecycle.js";
import type { Control, LedgerCommand } from "./run-ledger-model.js";
import { admitInput, queuedCancelled } from "./run-ledger-queue.js";
import { effectOutcome, nativeProbe } from "./run-ledger-transmissions.js";

export function localCommand(work: Work, command: LedgerCommand): void {
	const run = activeRun(work.state);
	if (command.verb === "admit") {
		admitInput(work, command.inputId, command.runNow);
		return;
	}
	if (command.verb === "control") {
		control(work, command.control);
		return;
	}
	if (command.verb !== "settle" || "token" in command.settlement) return;
	const reason = command.settlement;
	if (reason.kind === "alarm_fired") {
		fireAlarm(work);
		return;
	}
	work.state = {
		...work.state,
		paused: true,
		inactive: work.state.inactive || reason.kind === "project_inactive",
	};
	if (run) finish(work, run, "error", reason);
	retireSession(work);
}

function control(work: Work, command: Control): void {
	const run = activeRun(work.state);
	switch (command.kind) {
		case "resume":
			work.state = { ...work.state, paused: false, inactive: false };
			return;
		case "run_now":
			admitInput(work, command.inputId, true);
			return;
		case "cancel_input":
			cancel(work, command.inputId);
			queuedCancelled(work);
			return;
		case "answer":
			answer(work, run, command.interactionId, command.answer);
			return;
		case "stop":
		case "end":
			work.state = { ...work.state, paused: true };
			if (run) interrupt(work, run, command.kind);
			return;
	}
}

export function correlatedCommand(work: Work, input: Correlated): void {
	const evidence = input.evidence;
	if (evidence.kind === "effect_outcome") {
		effectOutcome(work, input, evidence.outcome);
		return;
	}
	if (evidence.kind === "probe_result") {
		nativeProbe(work, input, evidence.finding.tag === "native_idle");
		return;
	}
	const owner = work.state.runs.get(input.send.runId);
	if (!owner || owner.tag === "Ended") return;
	if (
		evidence.kind === "started" ||
		evidence.kind === "activity" ||
		evidence.kind === "result" ||
		evidence.kind === "interaction_requested"
	)
		confirmDelivery(work, input.send, evidence.kind === "result");
	if (evidence.kind === "process_lost") {
		finish(work, owner, "error", { kind: "process_lost" });
		return;
	}
	if (evidence.kind === "interaction_requested") {
		const known = owner.interactions.some(
			(item) => item.interactionId === evidence.interactionId,
		);
		request(work, owner, evidence);
		const updated = work.state.runs.get(owner.runId);
		// New native work discharges a liveness probe's fence, not other bounds.
		if (
			!known &&
			updated?.tag === "Running" &&
			updated.deadline.kind === "fence"
		)
			activity(work, updated, input.send.order);
		return;
	}
	dispatchState(owner, input, work);
}

type ByTag = { [K in ActiveRun["tag"]]: Extract<ActiveRun, { tag: K }> };
type StateRun<K extends ActiveRun["tag"]> = {
	[T in K]: ByTag[T] & { tag: T };
}[K];
type StateHandlers = {
	[K in ActiveRun["tag"]]: (
		run: ByTag[K],
		input: Correlated,
		work: Work,
	) => void;
};
const handlers: StateHandlers = {
	Queued: queued,
	Starting: working,
	Running: working,
	Interrupting: interrupting,
	Settling: working,
};

function dispatchState<K extends ActiveRun["tag"]>(
	run: StateRun<K>,
	input: Correlated,
	work: Work,
): void {
	handlers[run.tag](run, input, work);
}

function queued(run: ByTag["Queued"], input: Correlated, work: Work): void {
	work.diagnostic = `${run.tag} cannot handle ${input.evidence.kind}`;
}

function working(
	run: ByTag["Starting"] | ByTag["Running"] | ByTag["Settling"],
	input: Correlated,
	work: Work,
): void {
	switch (input.evidence.kind) {
		case "started":
		case "activity":
			activity(work, run, input.send.order);
			return;
		case "result":
			recordResult(work, run, input.evidence, input.send.order);
			return;
		case "query_ended":
			endQuery(work, run);
			return;
		default:
			work.diagnostic = `${run.tag} cannot handle ${input.evidence.kind}`;
	}
}

function interrupting(
	run: ByTag["Interrupting"],
	input: Correlated,
	work: Work,
): void {
	switch (input.evidence.kind) {
		case "started":
		case "activity":
			return;
		case "result":
			recordResult(work, run, input.evidence, input.send.order);
			return;
		case "query_ended":
			endQuery(work, run);
			return;
		default:
			work.diagnostic = `Interrupting cannot handle ${input.evidence.kind}`;
	}
}
