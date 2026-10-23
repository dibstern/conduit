import { timeoutAnswer } from "./run-ledger-answers.js";
import {
	type ActiveRun,
	activeRun,
	type Send,
	type SessionLedgerState,
	type Work,
} from "./run-ledger-internal.js";
import { closeNative, expireRun } from "./run-ledger-lifecycle.js";
import { sendProof } from "./run-ledger-send-proof.js";
import {
	cleanupDeadline,
	retryPending,
	retryTransmission,
} from "./run-ledger-transmissions.js";

type OpenDeadline = { readonly at: number; readonly owner: string } & (
	| { readonly kind: "run"; readonly run: ActiveRun }
	| { readonly kind: "fence"; readonly runId: string }
	| {
			readonly kind: "interaction";
			readonly run: ActiveRun;
			readonly interactionId: string;
	  }
	| { readonly kind: "retry" | "cleanup"; readonly send: Send }
);

/** Deadlines are read from their owners, never scheduled as separate work. */
export function openDeadlines(
	state: SessionLedgerState,
): readonly OpenDeadline[] {
	const deadlines: OpenDeadline[] = [];
	const fence = state.nativeFence;
	if (fence?.deadline)
		deadlines.push({
			kind: "fence",
			runId: fence.runId,
			owner: `fence:${fence.runId}`,
			at: fence.deadline.at,
		});
	const run = activeRun(state);
	if (run) {
		deadlines.push({
			kind: "run",
			owner: `run:${run.runId}`,
			at: run.deadline.at,
			run,
		});
		for (const item of run.interactions)
			if (
				item.tag === "Pending" &&
				item.kind === "permission" &&
				item.timeoutAt !== undefined
			)
				deadlines.push({
					kind: "interaction",
					owner: `interaction:${run.runId}:${item.interactionId}`,
					at: item.timeoutAt,
					run,
					interactionId: item.interactionId,
				});
	}
	for (const send of state.sends.values()) {
		if (!send.live) continue;
		if (send.cleanupDeadline)
			deadlines.push({
				kind: "cleanup",
				owner: `cleanup:${send.purpose}`,
				at: send.cleanupDeadline.at,
				send,
			});
		const retryAt = sendProof(send).retryAt;
		if (retryAt !== undefined && retryPending(state, send))
			deadlines.push({
				kind: "retry",
				owner: `retry:${send.purpose}`,
				at: retryAt,
				send,
			});
	}
	return deadlines.sort((a, b) => a.at - b.at);
}

export function fireAlarm(work: Work): void {
	// Re-read the owners: an expiry can discharge or transfer another deadline.
	// A zero-duration re-arm waits for the next alarm, even across send retries.
	const fired = new Set<string>();
	for (;;) {
		const next = openDeadlines(work.state).find(
			(deadline) => !fired.has(deadline.owner),
		);
		if (!next || next.at > work.ctx.now) return;
		fired.add(next.owner);
		switch (next.kind) {
			case "fence": {
				const fence = work.state.nativeFence;
				if (!fence) break;
				work.state = {
					...work.state,
					nativeFence: { runId: fence.runId, tokens: fence.tokens },
				};
				const owner = work.state.runs.get(next.runId);
				if (owner) closeNative(work, owner);
				break;
			}
			case "run":
				expireRun(work, next.run);
				break;
			case "interaction":
				timeoutAnswer(work, next.run, next.interactionId);
				break;
			case "retry":
				retryTransmission(work, next.send);
				break;
			case "cleanup":
				cleanupDeadline(work, next.send);
				break;
		}
	}
}
