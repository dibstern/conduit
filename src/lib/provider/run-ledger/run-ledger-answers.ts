import { type Correlated, issue } from "./run-ledger-correlation.js";
import {
	type ActiveRun,
	type Interaction,
	putRun,
	type RunState,
	type Work,
} from "./run-ledger-internal.js";
import type { Evidence } from "./run-ledger-model.js";

export function putInteraction(
	work: Work,
	runId: string,
	interaction: Interaction,
): void {
	const run = work.state.runs.get(runId);
	if (!run) return;
	const found = run.interactions.some(
		(item) => item.interactionId === interaction.interactionId,
	);
	putRun(work, {
		...run,
		interactions: found
			? run.interactions.map((item) =>
					item.interactionId === interaction.interactionId ? interaction : item,
				)
			: [...run.interactions, interaction],
	});
}

export function request(
	work: Work,
	run: ActiveRun,
	evidence: Extract<Evidence, { kind: "interaction_requested" }>,
): void {
	if (
		run.interactions.some(
			(item) => item.interactionId === evidence.interactionId,
		)
	)
		return;
	putInteraction(work, run.runId, {
		tag: "Pending",
		interactionId: evidence.interactionId,
		kind: evidence.interactionKind,
		...(evidence.timeoutAt !== undefined
			? { timeoutAt: evidence.timeoutAt }
			: {}),
	});
}

export function answer(
	work: Work,
	run: ActiveRun | undefined,
	interactionId: string,
	value: unknown,
): void {
	const interaction = run?.interactions.find(
		(item) => item.interactionId === interactionId,
	);
	if (!run || !interaction) {
		work.diagnostic = "Cannot answer an unknown interaction";
		return;
	}
	if (interaction.tag !== "Pending") return;
	putInteraction(work, run.runId, {
		tag: "Answered",
		interactionId,
		kind: interaction.kind,
		answer: value,
		delivery: "queued",
	});
	issue(
		work,
		{ kind: "deliver_answer", runId: run.runId, interactionId, answer: value },
		{ runId: run.runId },
	);
}

export function resolve(
	work: Work,
	input: Correlated,
	interactionId: string,
): void {
	const run = work.state.runs.get(input.send.runId);
	const item = run?.interactions.find(
		(entry) => entry.interactionId === interactionId,
	);
	if (
		item?.tag === "Resolved" ||
		(item?.tag === "Answered" && item.delivery === "sent")
	)
		return;
	if (item?.tag === "Answered")
		putInteraction(work, input.send.runId, { ...item, delivery: "sent" });
	else
		putInteraction(work, input.send.runId, { tag: "Resolved", interactionId });
}

export function answerOutcome(
	work: Work,
	input: Correlated,
	delivery: "sent" | "unknown" | "failed",
): void {
	const interactionId = input.send.interactionId;
	const run = work.state.runs.get(input.send.runId);
	const item = run?.interactions.find(
		(entry) => entry.interactionId === interactionId,
	);
	if (
		item?.tag !== "Answered" ||
		item.delivery === "sent" ||
		item.delivery === "settled"
	)
		return;
	putInteraction(
		work,
		input.send.runId,
		delivery === "failed"
			? { tag: "Pending", interactionId: item.interactionId, kind: item.kind }
			: { ...item, delivery },
	);
	if (delivery !== "sent" && run?.tag !== "Ended")
		issue(
			work,
			{
				kind: "probe",
				runId: input.send.runId,
				target: { tag: "interaction", interactionId: item.interactionId },
			},
			{ runId: input.send.runId },
		);
}

export function timeoutAnswer(
	work: Work,
	run: RunState | undefined,
	interactionId: string,
): void {
	if (!run || run.tag === "Ended") return;
	const item = run.interactions.find(
		(entry) => entry.interactionId === interactionId,
	);
	if (
		item?.tag === "Pending" &&
		item.kind === "permission" &&
		item.timeoutAt !== undefined &&
		work.ctx.now >= item.timeoutAt
	)
		answer(work, run, interactionId, { decision: "reject", reason: "timeout" });
}

export function closeInteractions(work: Work, run: ActiveRun): void {
	putRun(work, {
		...run,
		interactions: run.interactions.map(
			(item): Interaction =>
				item.tag === "Pending"
					? { tag: "Resolved", interactionId: item.interactionId }
					: item.tag === "Answered" &&
							(item.delivery === "queued" || item.delivery === "unknown")
						? { ...item, delivery: "settled" }
						: item,
		),
	});
}
