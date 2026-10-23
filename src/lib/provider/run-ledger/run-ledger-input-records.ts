import {
	coveredByAbsence,
	liveSends,
	pruneSends,
} from "./run-ledger-correlation.js";
import {
	type Admission,
	type AdmissionRef,
	activeRun,
	admissions,
	getAdmission,
	putAdmission,
	type SessionLedgerState,
	type Work,
} from "./run-ledger-internal.js";
import type { InputView, SendToken } from "./run-ledger-model.js";
import { sendProof } from "./run-ledger-send-proof.js";

export function uncertain(state: SessionLedgerState, inputId: string): boolean {
	return (
		state.inputs
			.get(inputId)
			?.admissions.some((item) => admissionUncertain(state, item)) ?? false
	);
}

function admissionUncertain(
	state: SessionLedgerState,
	item: Admission,
): boolean {
	if (item.state.tag === "Accepted") return false;
	return item.sends.some((token) => {
		if (coveredByAbsence(state, token, item.absenceProofs)) return false;
		const send = state.sends.get(token);
		if (!send) return false;
		const proof = sendProof(send);
		if (proof.uncertain) return true;
		if (proof.retryAt !== undefined && send.live) return false;
		if (item.state.tag === "Delivered") return true;
		if (item.state.tag === "Declined") return item.state.reason === "cancelled";
		return (
			send.effect.kind === "steer" &&
			(item.location.tag !== "Run" || send.runId !== item.location.runId)
		);
	});
}

export function uncertainAdmission(
	state: SessionLedgerState,
	inputId: string,
): AdmissionRef | undefined {
	const index =
		state.inputs
			.get(inputId)
			?.admissions.findIndex((item) => admissionUncertain(state, item)) ?? -1;
	return index < 0 ? undefined : { inputId, index };
}

export function inputView(
	state: SessionLedgerState,
	ref: AdmissionRef,
): InputView {
	const item = getAdmission(state, ref);
	return {
		inputId: ref.inputId,
		state:
			item?.location.tag === "Inbox"
				? { tag: "Queued" }
				: (item?.state ?? { tag: "Queued" }),
		uncertain: uncertain(state, ref.inputId),
	};
}

export function inbox(
	state: SessionLedgerState,
): ReturnType<typeof admissions> {
	return admissions(state).filter(
		({ admission }) => admission.location.tag === "Inbox",
	);
}

function moveRecord(work: Work, inputId: string, front: boolean): void {
	const record = work.state.inputs.get(inputId);
	if (!record) return;
	const rest = [...work.state.inputs].filter(([id]) => id !== inputId);
	work.state = {
		...work.state,
		inputs: new Map(
			front ? [[inputId, record], ...rest] : [...rest, [inputId, record]],
		),
	};
}

export function enqueue(
	work: Work,
	ref: AdmissionRef,
	priority = false,
	front = false,
): void {
	const item = getAdmission(work.state, ref);
	if (!item) return;
	putAdmission(work, ref, { ...item, priority, location: { tag: "Inbox" } });
	moveRecord(work, ref.inputId, front);
}

export function admit(
	work: Work,
	inputId: string,
	priority: boolean,
): AdmissionRef | undefined {
	const record = work.state.inputs.get(inputId);
	const found = record
		? [...record.admissions]
				.reverse()
				.findIndex((item) => item.location.tag !== "Resolved")
		: -1;
	const index =
		found < 0 || !record ? -1 : record.admissions.length - 1 - found;
	if (index >= 0 && record) {
		const item = record.admissions[index];
		if (!item || (item.state.tag === "Accepted" && priority)) return undefined;
		if (priority) enqueue(work, { inputId, index }, true, true);
		return priority ? { inputId, index } : undefined;
	}
	const admission: Admission = {
		role: "start",
		priority,
		location: { tag: "Inbox" },
		state: { tag: "Queued" },
		sends: [],
		absenceProofs: [],
		runs: [],
	};
	const ref = { inputId, index: record?.admissions.length ?? 0 };
	work.state = {
		...work.state,
		inputs: new Map(work.state.inputs).set(inputId, {
			inputId,
			admissions: [...(record?.admissions ?? []), admission],
		}),
	};
	moveRecord(work, inputId, priority);
	return ref;
}

export function attach(
	work: Work,
	ref: AdmissionRef,
	runId: string,
	role: "start" | "steer",
): void {
	const item = getAdmission(work.state, ref);
	if (item)
		putAdmission(work, ref, {
			...item,
			role,
			priority: false,
			location: { tag: "Run", runId },
			state: item.state.tag === "Delivered" ? item.state : { tag: "Queued" },
			runs: item.runs.includes(runId) ? item.runs : [...item.runs, runId],
		});
}

export function cancel(work: Work, inputId: string): void {
	const item = [...admissions(work.state)]
		.reverse()
		.find(
			(entry) =>
				entry.inputId === inputId &&
				entry.admission.location.tag !== "Resolved",
		);
	const run = activeRun(work.state);
	if (
		!item ||
		(item.admission.location.tag === "Run" &&
			(item.admission.state.tag === "Accepted" ||
				(item.admission.role === "start" && run?.tag !== "Queued")))
	) {
		work.diagnostic =
			"Only a queued or unaccepted steer input can be cancelled";
		return;
	}
	putAdmission(work, item, {
		...item.admission,
		location:
			item.admission.location.tag === "Run" && run?.tag !== "Queued"
				? item.admission.location
				: { tag: "Resolved" },
		state: { tag: "Declined", reason: "cancelled" },
	});
}

export function acceptReceipt(
	work: Work,
	ref: AdmissionRef,
	nativeMessageId?: string,
): void {
	const item = getAdmission(work.state, ref);
	if (!item) return;
	if (
		item.state.tag === "Accepted" &&
		item.state.nativeMessageId !== undefined &&
		nativeMessageId !== undefined &&
		nativeMessageId !== item.state.nativeMessageId
	) {
		work.diagnostic = "An accepted input cannot change native message identity";
		return;
	}
	const known =
		item.state.tag === "Accepted" ? item.state.nativeMessageId : undefined;
	const nativeId = nativeMessageId ?? known;
	if (item.state.tag === "Accepted" && nativeId === known) return;
	const cancelled =
		(item.state.tag === "Declined" && item.state.reason === "cancelled") ||
		(item.state.tag === "Accepted" && item.state.cancelled);
	const owner = item.runs.at(-1);
	putAdmission(work, ref, {
		...item,
		location:
			item.location.tag === "Inbox"
				? owner !== undefined && work.state.current === owner
					? { tag: "Run", runId: owner }
					: { tag: "Resolved" }
				: item.location,
		state: {
			tag: "Accepted",
			...(nativeId !== undefined ? { nativeMessageId: nativeId } : {}),
			...(cancelled ? { cancelled: true } : {}),
		},
	});
}

export function declineReceipt(
	work: Work,
	ref: AdmissionRef,
	reason: string,
): void {
	const item = getAdmission(work.state, ref);
	if (!item) return;
	if (item.state.tag === "Accepted") {
		work.diagnostic = "An accepted input cannot be declined";
		return;
	}
	if (item.state.tag === "Declined") return;
	putAdmission(work, ref, { ...item, state: { tag: "Declined", reason } });
	if (item.location.tag === "Run") enqueue(work, ref, false, true);
}

export function returnInputs(work: Work, runId: string, queued: boolean): void {
	for (const { admission, ...ref } of [...admissions(work.state)].reverse()) {
		if (admission.location.tag !== "Run" || admission.location.runId !== runId)
			continue;
		if (
			(admission.role === "steer" || queued) &&
			admission.state.tag !== "Accepted" &&
			admission.state.tag !== "Declined"
		)
			enqueue(work, ref, admission.priority, true);
		else
			putAdmission(work, ref, { ...admission, location: { tag: "Resolved" } });
	}
}

/** The only retention rule: live sends, untombstoned provenance, or uncertainty. */
export function pruneInputs(work: Work): void {
	const live = new Set(liveSends(work.state).map((send) => send.token));
	const inputs = new Map(
		[...work.state.inputs].filter(
			([inputId, record]) =>
				record.admissions.some(
					(item) =>
						item.location.tag !== "Resolved" ||
						item.sends.some((token) => live.has(token)) ||
						item.runs.some((id) => work.state.runs.get(id)?.tag !== "Ended"),
				) || uncertain(work.state, inputId),
		),
	);
	if (inputs.size !== work.state.inputs.size)
		work.state = { ...work.state, inputs };
	const retained = new Set<SendToken>();
	for (const record of inputs.values())
		for (const item of record.admissions)
			for (const token of item.sends) retained.add(token);
	// Probe receipts refer to the same retained admission; interaction receipts live with their Run.
	for (const send of work.state.sends.values())
		if (
			(send.admission && inputs.has(send.admission.inputId)) ||
			send.interactionId
		)
			retained.add(send.token);
	pruneSends(work, retained);
}
