import {
	type AdmissionRef,
	getAdmission,
	putAdmission,
	type Send,
	type SendFact,
	type SessionLedgerState,
	type Work,
} from "./run-ledger-internal.js";
import type {
	Evidence,
	IssuedEffect,
	LedgerCommand,
	RunEffect,
	SendToken,
} from "./run-ledger-model.js";

/** This is the complete lifecycle/receipt boundary. Refined probe classes depend on their target. */
export const evidenceClasses = {
	started: "lifecycle",
	activity: "lifecycle",
	result: "lifecycle",
	query_ended: "lifecycle",
	interaction_requested: "lifecycle",
	effect_outcome: "lifecycle",
	process_lost: "lifecycle",
	input_accepted: "receipt",
	input_declined: "receipt",
	accounting: "receipt",
	interaction_resolved: "receipt",
	input_present: "receipt",
	input_absent: "receipt",
	answer_consumed: "receipt",
	answer_pending: "receipt",
	native_idle: "lifecycle",
	native_busy: "lifecycle",
} as const;

type TokenEvidence = Evidence | { readonly kind: "process_lost" };
export interface Correlated {
	readonly evidence: TokenEvidence;
	readonly send: Send;
	readonly receipt: boolean;
	/** Admission-level presence identifies a send only without sibling ambiguity. */
	readonly probedInput?: Send;
	readonly admission?: {
		readonly ref: AdmissionRef;
		readonly value: NonNullable<ReturnType<typeof getAdmission>>;
	};
}
export type Correlation =
	| { readonly tag: "stale" }
	| { readonly tag: "rejected"; readonly diagnostic: string }
	| { readonly tag: "correlated"; readonly input: Correlated };

function accepts(send: Send, evidence: TokenEvidence): boolean {
	const effect = send.effect;
	const query = effect.kind === "start" || effect.kind === "steer";
	switch (evidence.kind) {
		case "input_accepted":
		case "input_declined":
		case "accounting":
		case "started":
		case "activity":
		case "result":
		case "query_ended":
		case "interaction_requested":
		case "process_lost":
			return query;
		case "interaction_resolved":
			return (
				query ||
				(effect.kind === "deliver_answer" &&
					effect.interactionId === evidence.interactionId)
			);
		case "effect_outcome":
			return true;
		case "probe_result": {
			if (effect.kind !== "probe") return false;
			const tag = evidence.finding.tag;
			if (effect.target.tag === "input")
				return tag === "input_present" || tag === "input_absent";
			if (effect.target.tag === "interaction")
				return tag === "answer_consumed" || tag === "answer_pending";
			return tag === "native_idle" || tag === "native_busy";
		}
	}
}

export function correlate(
	state: SessionLedgerState,
	command: LedgerCommand,
): Correlation | undefined {
	const raw =
		command.verb === "observe"
			? command.observation
			: command.verb === "settle" && "token" in command.settlement
				? command.settlement
				: undefined;
	if (!raw) return undefined;
	const send = state.sends.get(raw.token);
	if (!send) return { tag: "stale" };
	if (!accepts(send, raw))
		return {
			tag: "rejected",
			diagnostic: `Send ${send.effect.kind} cannot produce ${raw.kind}`,
		};
	const key = raw.kind === "probe_result" ? raw.finding.tag : raw.kind;
	const receipt = evidenceClasses[key] === "receipt";
	if (!receipt && !send.live) return { tag: "stale" };
	const value = send.admission
		? getAdmission(state, send.admission)
		: undefined;
	const { token: _token, ...evidence } = raw;
	const covered =
		raw.kind === "probe_result" && raw.finding.tag === "input_present"
			? (value?.sends.flatMap((token) => {
					const inputSend = state.sends.get(token);
					return inputSend && inputSend.order < send.order ? [inputSend] : [];
				}) ?? [])
			: [];
	return {
		tag: "correlated",
		input: {
			evidence,
			send,
			receipt,
			...(covered.length === 1 && covered[0]
				? { probedInput: covered[0] }
				: {}),
			...(send.admission && value
				? { admission: { ref: send.admission, value } }
				: {}),
		},
	};
}

function replaceSend(work: Work, send: Send): void {
	work.state = {
		...work.state,
		sends: new Map(work.state.sends).set(send.token, send),
	};
}

function retireWhere(work: Work, predicate: (send: Send) => boolean): void {
	const sends = new Map(work.state.sends);
	let changed = false;
	for (const [token, send] of sends)
		if (send.live && predicate(send)) {
			const { cleanupDeadline: _deadline, ...retired } = send;
			sends.set(token, {
				...retired,
				live: false,
			});
			changed = true;
		}
	if (changed) {
		const fence = work.state.nativeFence;
		work.state = {
			...work.state,
			sends,
			...(fence && !fence.tokens.some((token) => sends.get(token)?.live)
				? { nativeFence: undefined }
				: {}),
		};
	}
}

export function retireRun(
	work: Work,
	runId: string,
	retain?: (send: Send) => boolean,
): void {
	retireWhere(work, (send) => send.runId === runId && !retain?.(send));
}

export function retireSession(work: Work): void {
	retireWhere(work, () => true);
	if (work.state.nativeFence)
		work.state = { ...work.state, nativeFence: undefined };
}

export function retireSend(work: Work, send: Send): void {
	retireWhere(work, (item) => item.token === send.token);
}

export function recordSendFact(work: Work, send: Send, fact: SendFact): void {
	const current = work.state.sends.get(send.token);
	if (!current) return;
	if (
		current.facts.some(
			(known) =>
				known.kind === fact.kind &&
				(fact.kind !== "transport_failed" ||
					(known.kind === "transport_failed" && known.code === fact.code)) &&
				(fact.kind !== "retryable" ||
					(known.kind === "retryable" && known.at === fact.at)),
		)
	)
		return;
	const facts = [...current.facts, fact];
	if (
		fact.kind === "transport_succeeded" ||
		fact.kind === "native_completed" ||
		fact.kind === "transport_failed"
	) {
		const { cleanupDeadline: _deadline, ...settled } = current;
		replaceSend(work, { ...settled, facts });
	} else replaceSend(work, { ...current, facts });
}

export function inputAbsent(state: SessionLedgerState, probe: Send): boolean {
	let newer = false;
	for (const send of state.sends.values()) {
		if (
			!send.admission ||
			!probe.admission ||
			send.admission.inputId !== probe.admission.inputId ||
			send.admission.index !== probe.admission.index ||
			(send.effect.kind !== "start" && send.effect.kind !== "steer")
		)
			continue;
		if (send.order > probe.order) newer = true;
	}
	return !newer;
}

export function coveredByAbsence(
	state: SessionLedgerState,
	token: SendToken,
	proofs: readonly SendToken[],
): boolean {
	const send = state.sends.get(token);
	return (
		send !== undefined &&
		proofs.some((proof) => (state.sends.get(proof)?.order ?? -1) > send.order)
	);
}

function purpose(effect: RunEffect, runId: string, ref?: AdmissionRef): string {
	if (effect.kind === "probe")
		return `${runId}:probe:${effect.target.tag}:${ref ? `${ref.inputId}:${ref.index}` : effect.target.tag === "interaction" ? effect.target.interactionId : ""}`;
	if (effect.kind === "deliver_answer")
		return `${runId}:answer:${effect.interactionId}`;
	return `${runId}:${effect.kind}:${ref ? `${ref.inputId}:${ref.index}` : ""}`;
}

export function issue(
	work: Work,
	effect: RunEffect,
	scope: Pick<Send, "runId" | "admission" | "cleanupDeadline">,
): Send {
	const token = work.ctx.newId() as SendToken;
	const key = purpose(effect, scope.runId, scope.admission);
	const previous = [...work.state.sends.values()].filter(
		(item) => item.runId === scope.runId,
	);
	const attempt =
		effect.kind === "start"
			? token
			: [...previous].reverse().find((item) => item.effect.kind === "start")
					?.attempt;
	if (effect.kind === "start") retireRun(work, scope.runId);
	else
		for (const old of previous) if (old.purpose === key) retireSend(work, old);
	const retryAt =
		effect.kind === "probe"
			? work.ctx.now + work.ctx.policy.closeMs
			: undefined;
	const send: Send = {
		token,
		effect,
		purpose: key,
		order: work.state.nextOrder,
		live: true,
		runId: scope.runId,
		facts: [],
		...(retryAt === undefined ? {} : { probeRetryAt: retryAt }),
		...(attempt ? { attempt } : {}),
		...(scope.admission ? { admission: scope.admission } : {}),
		...(scope.cleanupDeadline
			? { cleanupDeadline: scope.cleanupDeadline }
			: {}),
		...(effect.kind === "deliver_answer"
			? { interactionId: effect.interactionId }
			: effect.kind === "probe" && effect.target.tag === "interaction"
				? { interactionId: effect.target.interactionId }
				: {}),
	};
	work.state = {
		...work.state,
		nextOrder: send.order + 1,
		sends: new Map(work.state.sends).set(token, send),
	};
	work.effects.push({ token, effect });
	if (scope.admission && (effect.kind === "start" || effect.kind === "steer")) {
		const value = getAdmission(work.state, scope.admission);
		if (value)
			putAdmission(work, scope.admission, {
				...value,
				sends: [...value.sends, token],
			});
	}
	return send;
}

export function retransmit(work: Work, send: Send): void {
	issue(work, send.effect, {
		runId: send.runId,
		...(send.admission ? { admission: send.admission } : {}),
		...(send.cleanupDeadline ? { cleanupDeadline: send.cleanupDeadline } : {}),
	});
}

/** Idle samples discharge only transmissions that existed when that probe was sent. */
export function confirmIdle(
	work: Work,
	probe: Send,
	covers: (send: Send) => boolean,
): void {
	retireWhere(work, (send) => send.order < probe.order && covers(send));
}

export function hasNewerWork(
	state: SessionLedgerState,
	probe: Send,
	fences: (effect: RunEffect) => boolean,
): boolean {
	const run = state.runs.get(probe.runId);
	return (
		(run?.activityOrder ?? -1) > probe.order ||
		liveSends(state).some(
			(send) => send.order > probe.order && fences(send.effect),
		)
	);
}

export function confirmClosed(work: Work, close: Send): void {
	retireWhere(
		work,
		(send) =>
			send.runId === close.runId &&
			send.attempt === close.attempt &&
			send.order <= close.order,
	);
	retireSend(work, close);
}

export function liveSends(state: SessionLedgerState): readonly Send[] {
	return [...state.sends.values()].filter((send) => send.live);
}

export function publicSends(
	state: SessionLedgerState,
): readonly IssuedEffect[] {
	return liveSends(state).map(({ token, effect }) => ({ token, effect }));
}

/** Pruning is driven by the single canonical input-record retention rule. */
export function pruneSends(work: Work, retained: ReadonlySet<SendToken>): void {
	const sends = new Map(
		[...work.state.sends].filter(
			([token, send]) =>
				send.live ||
				retained.has(token) ||
				work.state.runs.get(send.runId)?.tag !== "Ended",
		),
	);
	if (sends.size !== work.state.sends.size)
		work.state = { ...work.state, sends };
}
