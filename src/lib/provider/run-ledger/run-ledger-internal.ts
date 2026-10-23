import type {
	Deadline,
	EndReason,
	Evidence,
	InputState,
	IssuedEffect,
	ProviderKind,
	RunEnded,
	RunOutcome,
	SendToken,
} from "./run-ledger-model.js";

export type TerminalEvidence =
	| Extract<Evidence, { kind: "result" }>
	| { readonly kind: "superseded" };
export interface TerminalSummary {
	readonly latest?: Extract<Evidence, { kind: "result" }>;
	readonly completed?: true;
	readonly specificFailure?: {
		readonly code: string;
		readonly retryable: boolean;
	};
	readonly genericFailure?: {
		readonly code: string;
		readonly retryable: boolean;
	};
}

export type Interaction =
	| {
			readonly tag: "Pending";
			readonly interactionId: string;
			readonly kind: "permission" | "question";
			readonly timeoutAt?: number;
	  }
	| {
			readonly tag: "Answered";
			readonly interactionId: string;
			readonly kind: "permission" | "question";
			readonly answer: unknown;
			readonly delivery: "queued" | "sent" | "unknown" | "settled";
	  }
	| { readonly tag: "Resolved"; readonly interactionId: string };

interface RunBase {
	readonly runId: string;
	readonly interactions: readonly Interaction[];
	readonly terminal: TerminalSummary;
	/** Position in the shared issue order of the latest provider activity. */
	readonly activityOrder?: number;
}
type LiveBase = RunBase & { readonly deadline: Deadline };
export type RunState =
	| (LiveBase & { readonly tag: "Queued" })
	| (LiveBase & { readonly tag: "Starting" })
	| (LiveBase & { readonly tag: "Running" })
	| (LiveBase & {
			readonly tag: "Interrupting";
			readonly by: "stop" | "run_now" | "end";
	  })
	| (LiveBase & { readonly tag: "Settling"; readonly resultOrder: number })
	| (RunBase & {
			readonly tag: "Ended";
			readonly outcome: RunOutcome;
			readonly reason: EndReason;
	  });
export type ActiveRun = Exclude<RunState, { tag: "Ended" }>;

export interface Admission {
	readonly role: "start" | "steer";
	readonly priority: boolean;
	readonly location:
		| { readonly tag: "Inbox" }
		| { readonly tag: "Run"; readonly runId: string }
		| { readonly tag: "Resolved" };
	readonly state: InputState;
	readonly sends: readonly SendToken[];
	readonly absenceProofs: readonly SendToken[];
	readonly accounted?: true;
	readonly runs: readonly string[];
}
export interface RunInput {
	readonly inputId: string;
	readonly admissions: readonly Admission[];
}
export interface AdmissionRef {
	readonly inputId: string;
	readonly index: number;
}
export type SendStatus =
	| { readonly tag: "sent" }
	| { readonly tag: "retry"; readonly at: number }
	| { readonly tag: "unknown" }
	| { readonly tag: "settled" }
	| { readonly tag: "native" }
	| { readonly tag: "observed" }
	| { readonly tag: "failed"; readonly code: string };
export interface Send extends IssuedEffect {
	readonly order: number;
	readonly live: boolean;
	readonly purpose: string;
	readonly runId: string;
	readonly attempt?: SendToken;
	readonly admission?: AdmissionRef;
	readonly interactionId?: string;
	readonly cleanupDeadline?: Deadline;
	readonly status: SendStatus;
}

export interface SessionLedgerState {
	readonly sessionId: string;
	readonly provider: ProviderKind;
	readonly runs: ReadonlyMap<string, RunState>;
	readonly inputs: ReadonlyMap<string, RunInput>;
	readonly sends: ReadonlyMap<SendToken, Send>;
	readonly paused: boolean;
	readonly inactive: boolean;
	readonly current?: string | undefined;
	readonly nextOrder: number;
}
export interface Work {
	state: SessionLedgerState;
	readonly ctx: import("./run-ledger-model.js").DecideContext;
	readonly effects: IssuedEffect[];
	readonly ended: RunEnded[];
	diagnostic?: string;
}

export function activeRun(state: SessionLedgerState): ActiveRun | undefined {
	const run = state.current ? state.runs.get(state.current) : undefined;
	return run?.tag === "Ended" ? undefined : run;
}

export function putRun(work: Work, run: RunState): void {
	work.state = {
		...work.state,
		runs: new Map(work.state.runs).set(run.runId, run),
	};
}

export function putAdmission(
	work: Work,
	ref: AdmissionRef,
	admission: Admission,
): void {
	const record = work.state.inputs.get(ref.inputId);
	if (!record) return;
	const admissions = record.admissions.map((item, index) =>
		index === ref.index ? admission : item,
	);
	work.state = {
		...work.state,
		inputs: new Map(work.state.inputs).set(ref.inputId, {
			...record,
			admissions,
		}),
	};
}

export function getAdmission(
	state: SessionLedgerState,
	ref: AdmissionRef,
): Admission | undefined {
	return state.inputs.get(ref.inputId)?.admissions[ref.index];
}

export function admissions(
	state: SessionLedgerState,
): readonly (AdmissionRef & { readonly admission: Admission })[] {
	return [...state.inputs.values()].flatMap((record) =>
		record.admissions.map((admission, index) => ({
			inputId: record.inputId,
			index,
			admission,
		})),
	);
}

export function runInputs(
	state: SessionLedgerState,
	runId: string,
): ReturnType<typeof admissions> {
	return admissions(state).filter(
		({ admission }) =>
			admission.location.tag === "Run" && admission.location.runId === runId,
	);
}
