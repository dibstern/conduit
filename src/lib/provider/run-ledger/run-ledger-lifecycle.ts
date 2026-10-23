import { closeInteractions } from "./run-ledger-answers.js";
import { issue, liveSends, retireRun } from "./run-ledger-correlation.js";
import { returnInputs } from "./run-ledger-input-records.js";
import {
	type ActiveRun,
	putRun,
	type RunState,
	type Work,
} from "./run-ledger-internal.js";
import type {
	Deadline,
	EndReason,
	Evidence,
	RunOutcome,
} from "./run-ledger-model.js";
import { nativePolicy } from "./run-ledger-policy.js";
import { sendProof } from "./run-ledger-send-proof.js";
import {
	accumulateTerminalEvidence,
	classifyTerminalEvidence,
} from "./run-ledger-terminal.js";

export function deadline(
	work: Work,
	kind: Deadline["kind"],
	delay: number,
): Deadline {
	return { kind, at: work.ctx.now + delay };
}

export function finish(
	work: Work,
	run: ActiveRun,
	outcome: RunOutcome,
	reason: EndReason,
	nativeEnded = false,
): void {
	const policy = nativePolicy(work.state.provider);
	const terminal = classifyTerminalEvidence(
		run.terminal,
		{ outcome, reason },
		run.tag === "Interrupting" ? run.by : undefined,
	);
	// An owned execution ending cannot discharge a different HTTP request that
	// the provider may still execute. Native policy decides how idle proves it safe.
	const pendingQueries = new Set(
		nativeEnded && policy.postTombstoneProbe
			? liveSends(work.state)
					.filter(
						(send) =>
							send.runId === run.runId &&
							(send.effect.kind === "start" || send.effect.kind === "steer") &&
							sendProof(send).retainAtNativeEnd,
					)
					.map((send) => send.token)
			: [],
	);
	if (pendingQueries.size > 0)
		work.state = {
			...work.state,
			nativeFence: {
				runId: run.runId,
				tokens: [...pendingQueries],
				deadline: deadline(work, "fence", work.ctx.policy.fenceMs),
			},
		};
	const needsProbe =
		run.tag !== "Queued" &&
		policy.postTombstoneProbe &&
		liveSends(work.state).some(
			(send) =>
				send.runId === run.runId &&
				policy.fences(send.effect) &&
				(!nativeEnded ||
					(send.effect.kind !== "start" && send.effect.kind !== "steer") ||
					pendingQueries.has(send.token)),
		);
	closeInteractions(work, run);
	const closed = work.state.runs.get(run.runId) ?? run;
	if (closed.tag === "Ended") return;
	const { deadline: _deadline, ...ended } = closed;
	putRun(work, { ...ended, tag: "Ended", ...terminal });
	work.state = { ...work.state, current: undefined };
	returnInputs(
		work,
		run.runId,
		run.tag === "Queued" && reason.kind === "interrupted",
	);
	retireRun(
		work,
		run.runId,
		(send) => work.state.nativeFence?.tokens.includes(send.token) === true,
	);
	work.ended.push({ runId: run.runId, ...terminal });
	if (
		needsProbe &&
		reason.kind !== "project_inactive" &&
		reason.kind !== "session_ended"
	)
		issue(
			work,
			{ kind: "probe", runId: run.runId, target: { tag: "native_session" } },
			{ runId: run.runId },
		);
}

export function closeNative(work: Work, run: RunState): void {
	if (run.tag === "Queued" || work.state.inactive) return;
	issue(
		work,
		{ kind: nativePolicy(work.state.provider).closeEffect, runId: run.runId },
		{
			runId: run.runId,
			cleanupDeadline: deadline(work, "effect", work.ctx.policy.closeMs),
		},
	);
}

export function interrupt(
	work: Work,
	run: ActiveRun,
	by: "stop" | "run_now" | "end",
): void {
	if (run.tag === "Interrupting") return;
	if (run.tag === "Queued") {
		finish(work, run, "interrupted", {
			kind: "interrupted",
			by,
			forced: false,
		});
		return;
	}
	putRun(work, {
		...run,
		tag: "Interrupting",
		by,
		deadline: deadline(work, "interrupt", work.ctx.policy.interruptMs),
	});
	issue(
		work,
		{
			kind: nativePolicy(work.state.provider).controlEffect(by),
			runId: run.runId,
		},
		{ runId: run.runId },
	);
}

export function endQuery(work: Work, run: ActiveRun, nativeEnded = true): void {
	finish(
		work,
		run,
		run.tag === "Interrupting" ? "interrupted" : "completed",
		run.tag === "Interrupting"
			? { kind: "interrupted", by: run.by, forced: false }
			: { kind: "completed" },
		nativeEnded,
	);
}

export function recordResult(
	work: Work,
	run: ActiveRun,
	evidence: Extract<Evidence, { kind: "result" }>,
	order: number,
): void {
	const last = run.terminal.latest;
	if (
		last?.outcome === evidence.outcome &&
		last.error?.code === evidence.error?.code &&
		last.error?.retryable === evidence.error?.retryable
	)
		return;
	const terminal = accumulateTerminalEvidence(run.terminal, evidence);
	const updated = { ...run, terminal };
	putRun(work, updated);
	const policy = nativePolicy(work.state.provider);
	if (policy.runEnd === "result") {
		if (!policy.resultReleasesFence)
			work.state = {
				...work.state,
				nativeFence: {
					runId: run.runId,
					tokens: liveSends(work.state)
						.filter(
							(send) =>
								send.runId === run.runId &&
								(send.effect.kind === "start" || send.effect.kind === "steer"),
						)
						.map((send) => send.token),
					deadline: deadline(work, "settle", work.ctx.policy.settleMs),
				},
			};
		endQuery(work, updated, policy.resultReleasesFence);
	} else if (run.tag !== "Settling" && run.tag !== "Interrupting")
		putRun(work, {
			...updated,
			tag: "Settling",
			resultOrder: order,
			deadline: deadline(work, "settle", work.ctx.policy.settleMs),
		});
}

export function activity(work: Work, run: ActiveRun, order: number): void {
	if (
		run.tag === "Queued" ||
		run.tag === "Interrupting" ||
		(run.tag === "Settling" && order <= run.resultOrder)
	)
		return;
	putRun(work, {
		...run,
		tag: "Running",
		terminal: run.tag === "Settling" ? {} : run.terminal,
		deadline: deadline(work, "liveness", work.ctx.policy.livenessMs),
		activityOrder: work.state.nextOrder,
	});
	work.state = { ...work.state, nextOrder: work.state.nextOrder + 1 };
}

export function expireRun(work: Work, run: ActiveRun): void {
	if (run.tag === "Queued") {
		finish(work, run, "error", { kind: "fence_unconfirmed" });
		return;
	}
	if (run.tag === "Running" && run.deadline.kind === "liveness") {
		putRun(work, {
			...run,
			deadline: deadline(work, "fence", work.ctx.policy.fenceMs),
		});
		issue(
			work,
			{ kind: "probe", runId: run.runId, target: { tag: "native_session" } },
			{ runId: run.runId },
		);
		return;
	}
	if (run.tag === "Interrupting")
		finish(work, run, "interrupted", {
			kind: "interrupted",
			by: run.by,
			forced: true,
		});
	else if (run.tag === "Settling") endQuery(work, run);
	else
		finish(
			work,
			run,
			"error",
			run.tag === "Running"
				? { kind: "fence_unconfirmed" }
				: { kind: "deadline_expired", deadline: run.deadline.kind },
		);
	closeNative(work, run);
}
