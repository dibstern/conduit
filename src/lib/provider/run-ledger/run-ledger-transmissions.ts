import { answerOutcome, resolve } from "./run-ledger-answers.js";
import {
	type Correlated,
	confirmClosed,
	confirmIdle,
	hasNewerWork,
	inputAbsent,
	issue,
	liveSends,
	retireSend,
	retransmit,
	setSendStatus,
} from "./run-ledger-correlation.js";
import {
	acceptReceipt,
	declineReceipt,
	enqueue,
} from "./run-ledger-input-records.js";
import {
	getAdmission,
	putAdmission,
	putRun,
	type Send,
	type SessionLedgerState,
	type Work,
} from "./run-ledger-internal.js";
import { deadline, endQuery, finish } from "./run-ledger-lifecycle.js";
import type { Evidence } from "./run-ledger-model.js";
import { nativePolicy } from "./run-ledger-policy.js";

export function receipt(work: Work, input: Correlated): void {
	const evidence = input.evidence;
	// Provider proof fulfils the input probe, independently of admission disposition.
	// An old absence sample cannot answer a probe covering a newer transmission.
	if (
		input.admission &&
		(evidence.kind === "input_accepted" ||
			(evidence.kind === "probe_result" &&
				(evidence.finding.tag === "input_present" ||
					(evidence.finding.tag === "input_absent" &&
						inputAbsent(work.state, input.send)))))
	)
		for (const send of liveSends(work.state))
			if (
				send.effect.kind === "probe" &&
				send.effect.target.tag === "input" &&
				send.status.tag === "retry" &&
				send.admission?.inputId === input.admission.ref.inputId &&
				send.admission.index === input.admission.ref.index
			)
				setSendStatus(work, send, { tag: "settled" });
	switch (evidence.kind) {
		case "input_accepted":
			if (input.admission)
				acceptReceipt(work, input.admission.ref, evidence.nativeMessageId);
			return;
		case "input_declined":
			if (input.admission)
				declineReceipt(work, input.admission.ref, evidence.reason);
			return;
		case "interaction_resolved":
			resolve(work, input, evidence.interactionId);
			return;
		case "probe_result": {
			const finding = evidence.finding;
			if (finding.tag === "input_present" && input.admission)
				acceptReceipt(work, input.admission.ref, finding.nativeMessageId);
			if (
				finding.tag === "input_absent" &&
				input.admission &&
				input.admission.value.state.tag !== "Accepted" &&
				!input.admission.value.absenceProofs.includes(input.send.token)
			)
				putAdmission(work, input.admission.ref, {
					...input.admission.value,
					absenceProofs: [
						...input.admission.value.absenceProofs,
						input.send.token,
					],
					state: inputAbsent(work.state, input.send)
						? { tag: "Declined", reason: "input_absent" }
						: input.admission.value.state,
				});
			if (finding.tag === "answer_consumed" && input.send.interactionId)
				resolve(work, input, input.send.interactionId);
			return;
		}
		case "accounting":
			if (input.admission && !input.admission.value.accounted)
				putAdmission(work, input.admission.ref, {
					...input.admission.value,
					accounted: true,
				});
			return;
	}
}

function probe(work: Work, send: Send): void {
	const effect = send.effect;
	if (effect.kind === "start" || effect.kind === "steer")
		issue(
			work,
			{
				kind: "probe",
				runId: send.runId,
				target: { tag: "input", inputId: effect.inputId },
			},
			{
				runId: send.runId,
				...(send.admission ? { admission: send.admission } : {}),
			},
		);
	else
		issue(
			work,
			{ kind: "probe", runId: send.runId, target: { tag: "native_session" } },
			{ runId: send.runId },
		);
}

function scheduleRetry(work: Work, send: Send, at: number): void {
	if (
		send.status.tag === "unknown" ||
		send.status.tag === "failed" ||
		send.status.tag === "settled"
	)
		return;
	setSendStatus(work, send, { tag: "retry", at });
}

function unknownDelivery(work: Work, input: Correlated): void {
	if (
		input.send.status.tag === "unknown" ||
		input.send.status.tag === "failed" ||
		input.send.status.tag === "settled"
	)
		return;
	setSendStatus(work, input.send, { tag: "unknown" });
	if (
		input.admission &&
		input.admission.value.state.tag !== "Accepted" &&
		input.admission.value.state.tag !== "Declined"
	)
		putAdmission(work, input.admission.ref, {
			...input.admission.value,
			state: { tag: "Delivered", certainty: "unknown" },
		});
	if (input.send.effect.kind === "deliver_answer")
		answerOutcome(work, input, "unknown");
	else probe(work, input.send);
}

export function effectOutcome(
	work: Work,
	input: Correlated,
	outcome: Extract<Evidence, { kind: "effect_outcome" }>["outcome"],
): void {
	const send = input.send;
	if (send.status.tag === "native") return;
	if (send.effect.kind === "probe") {
		if (outcome.tag === "succeeded" || outcome.tag === "delivery_unknown")
			return;
		if (outcome.tag === "permanent") {
			setSendStatus(work, send, { tag: "failed", code: outcome.code });
			if (send.effect.target.tag !== "native_session") retireSend(work, send);
			return;
		}
	}
	if (outcome.tag === "retryable") {
		scheduleRetry(work, send, outcome.retryAt);
		return;
	}
	if (outcome.tag === "delivery_unknown") {
		unknownDelivery(work, input);
		return;
	}
	const succeeded = outcome.tag === "succeeded";
	if (send.effect.kind === "deliver_answer") {
		setSendStatus(
			work,
			send,
			succeeded ? { tag: "settled" } : { tag: "failed", code: outcome.code },
		);
		answerOutcome(work, input, succeeded ? "sent" : "failed");
		retireSend(work, send);
		return;
	}
	setSendStatus(work, send, { tag: "settled" });
	if (send.effect.kind === "start" || send.effect.kind === "steer") {
		inputOutcome(work, input, succeeded, succeeded ? "" : outcome.code);
		return;
	}
	cleanupOutcome(work, send, succeeded, succeeded ? "" : outcome.code);
}

function inputOutcome(
	work: Work,
	input: Correlated,
	succeeded: boolean,
	code: string,
): void {
	const item = input.admission;
	if (!item || item.value.state.tag === "Accepted") return;
	if (succeeded) {
		if (item.value.state.tag === "Queued")
			putAdmission(work, item.ref, {
				...item.value,
				state: { tag: "Delivered", certainty: "sent" },
			});
		return;
	}
	setSendStatus(work, input.send, { tag: "unknown" });
	const run = work.state.runs.get(input.send.runId);
	if (input.send.effect.kind === "start" && run && run.tag !== "Ended")
		finish(work, run, "error", { kind: "refused", code });
	else if (item.value.state.tag !== "Declined") {
		putAdmission(work, item.ref, {
			...item.value,
			state: { tag: "Declined", reason: code },
		});
		enqueue(work, item.ref, false, true);
	}
}

function cleanupSend(
	work: Work,
	send: Send,
	kind: "kill_and_respawn" | "interrupt",
): void {
	issue(
		work,
		{ kind, runId: send.runId },
		{
			runId: send.runId,
			cleanupDeadline: deadline(work, "effect", work.ctx.policy.closeMs),
		},
	);
}

function cleanupOutcome(
	work: Work,
	send: Send,
	succeeded: boolean,
	code: string,
): void {
	const policy = nativePolicy(work.state.provider);
	if (succeeded && policy.confirmsIdle(send.effect)) {
		confirmClosed(work, send);
		const owner = work.state.runs.get(send.runId);
		if (owner && owner.tag !== "Ended") endQuery(work, owner);
		return;
	}
	if (send.effect.kind === "close" && !succeeded) {
		retireSend(work, send);
		cleanupSend(work, send, "kill_and_respawn");
		return;
	}
	if (send.effect.kind === "cancel_request") {
		retireSend(work, send);
		cleanupSend(work, send, "interrupt");
		probe(work, send);
		return;
	}
	if (
		!succeeded &&
		(send.effect.kind === "kill_and_respawn" ||
			(send.effect.kind === "interrupt" && policy.interruptFailure === "fence"))
	) {
		setSendStatus(work, send, { tag: "failed", code });
		if (send.effect.kind === "kill_and_respawn")
			issue(
				work,
				{ kind: "quarantine", runId: send.runId },
				{ runId: send.runId },
			);
		probe(work, send);
		return;
	}
	retireSend(work, send);
	const run = work.state.runs.get(send.runId);
	if (!succeeded && run && run.tag !== "Ended")
		finish(work, run, "error", {
			kind: "provider_error",
			code,
			retryable: false,
		});
}

export function nativeProbe(
	work: Work,
	input: Correlated,
	idle: boolean,
): void {
	const policy = nativePolicy(work.state.provider);
	if (!idle) {
		scheduleRetry(work, input.send, work.ctx.now + work.ctx.policy.closeMs);
		return;
	}
	const newerWork = hasNewerWork(
		work.state,
		input.send,
		(effect) => effect.kind !== "probe" && policy.fences(effect),
	);
	if (newerWork) {
		retireSend(work, input.send);
		probe(work, input.send);
		return;
	}
	confirmIdle(work, input.send, (send) =>
		policy.idleCovers(
			send.effect,
			send.status.tag === "settled" || send.status.tag === "native",
		),
	);
	if (
		liveSends(work.state).some(
			(send) => send.effect.kind !== "probe" && policy.fences(send.effect),
		)
	)
		return;
	retireSend(work, input.send);
	const run = work.state.runs.get(input.send.runId);
	if (run && run.tag !== "Ended" && run.tag !== "Queued") endQuery(work, run);
}

export function retryPending(state: SessionLedgerState, send: Send): boolean {
	if (send.status.tag !== "retry" || !send.live || state.inactive) return false;
	if (send.effect.kind === "probe" && send.effect.target.tag === "input")
		return true;
	const item = send.admission ? getAdmission(state, send.admission) : undefined;
	const run = state.runs.get(send.runId);
	if (
		(send.effect.kind === "start" || send.effect.kind === "steer") &&
		run?.tag !== "Starting" &&
		run?.tag !== "Running"
	)
		return false;
	const interaction = run?.interactions.find(
		(entry) => entry.interactionId === send.interactionId,
	);
	return !(
		(send.admission &&
			(item?.state.tag === "Accepted" || item?.state.tag === "Declined")) ||
		((send.effect.kind === "deliver_answer" || send.interactionId) &&
			(interaction?.tag === "Resolved" ||
				(interaction?.tag === "Answered" &&
					(interaction.delivery === "sent" ||
						interaction.delivery === "settled"))))
	);
}

export function retryTransmission(work: Work, send: Send): void {
	if (!retryPending(work.state, send)) return;
	const run = work.state.runs.get(send.runId);
	retransmit(work, send);
	if (send.effect.kind === "start" && run && run.tag !== "Ended")
		putRun(work, {
			...run,
			tag: "Starting",
			terminal: {},
			deadline: deadline(work, "start", work.ctx.policy.startMs),
		});
}

export function cleanupDeadline(work: Work, send: Send): void {
	if (send.effect.kind === "close") {
		retireSend(work, send);
		cleanupSend(work, send, "kill_and_respawn");
		return;
	}
	if (send.effect.kind === "cancel_request") {
		cleanupOutcome(work, send, false, "cancel_request_unconfirmed");
		return;
	}
	setSendStatus(work, send, {
		tag: "failed",
		code: `${send.effect.kind}_unconfirmed`,
	});
	if (send.effect.kind === "kill_and_respawn")
		issue(
			work,
			{ kind: "quarantine", runId: send.runId },
			{ runId: send.runId },
		);
	probe(work, send);
}
