/**
 * Public contract (CONTRACT.md 3.1, 3.13). State and entries stay opaque behind the four ledger
 * functions in run-ledger-decider.ts.
 */
import type {
	CanonicalEvent,
	InputRequest,
} from "../../contracts/stored-event.js";

export type ProviderKind = "claude" | "codex" | "cursor" | "opencode";
/**
 * Opaque host string, never parsed. Runner-held start or steer: bound by run_dispatched's
 * commandId and transmission, n minted by holdRun (4.11). A direct start: its run.requested runId.
 * Every other effect with no hold: from ctx.newId.
 */
export type SendToken = string & { readonly __brand: "SendToken" };
/**
 * Host-owned `runnerId:querySeq`, or `runnerId` on an older host. Never minted here. Only L1 and
 * 3.4 split it, at the last `:`.
 */
export type Label = string;
export type SendErrorCode = string;
export type RunOutcome = "completed" | "error" | "interrupted";
export type InterruptBy = "stop" | "run_now" | "end";

export type InputState =
	| { readonly tag: "Queued" }
	| { readonly tag: "Dispatching" }
	/** unknown: probe, never resend. */
	| { readonly tag: "Delivered"; readonly certainty: "sent" | "unknown" }
	| { readonly tag: "Accepted"; readonly nativeMessageId?: string }
	| { readonly tag: "Failed"; readonly reason: string };

export type LedgerCommand =
	/** Main's handoff (`input.sent`, D58). */
	| {
			readonly verb: "admit";
			readonly inputId: string;
			readonly delivery: "queue" | "steer";
			readonly request: InputRequest;
	  }
	| { readonly verb: "observe"; readonly observation: Observation }
	| { readonly verb: "control"; readonly control: Control }
	| { readonly verb: "settle"; readonly settlement: Settlement };

export type Observation =
	/** A kind the send cannot produce is Rejected at decide (3.4); SendToken carries no kind. */
	| ({ readonly tag: "Answer"; readonly token: SendToken } & Evidence)
	/** Main's run events the arm folds (3.4, D60); run.dispatched and run.released are Answers. */
	| ({ readonly tag: "Main"; readonly eventId: string } & MainRunEvent)
	| ({
			readonly tag: "Unsolicited";
			readonly label: Label;
			readonly eventId: string;
	  } & Unsolicited);

export type MainRunEvent =
	/** 3.4: a direct send (runsOpenCodeServer) is a transmission, its token the runId. */
	| {
			readonly kind: "run_requested";
			readonly runId: string;
			readonly inputId: string;
			readonly direct: boolean;
	  }
	/** 3.9: joins its input to requestedRunId's Run, or starts a steer's own Run. */
	| {
			readonly kind: "run_started";
			readonly inputId: string;
			readonly requestedRunId: string;
	  }
	/** 3.9, L6: turn.completed, turn.error or turn.interrupted; ends its Run's work as main's (D59). */
	| {
			readonly kind: "run_terminal";
			readonly runId: string;
			readonly outcome: RunOutcome;
			readonly code?: string;
	  };

export type Unsolicited = Extract<
	Evidence,
	{
		readonly kind:
			| "tasks_snapshot"
			| "task_event"
			| "turn_started"
			| "turn_ended"
			| "command_lifecycle"
			| "command_result"
			/** Its label's (3.10); resolved: natively. */
			| "interaction_requested"
			| "interaction_resolved"
			| "activity"
			| "result"
			| "query_ended";
	}
>;

export type Evidence =
	| { readonly kind: "started" }
	| { readonly kind: "input_accepted"; readonly nativeMessageId?: string }
	| { readonly kind: "input_declined"; readonly reason: string }
	| { readonly kind: "activity" }
	| {
			readonly kind: "interaction_requested";
			readonly interactionId: string;
			readonly interactionKind: "permission" | "question";
			readonly timeoutAt?: number;
	  }
	| { readonly kind: "interaction_resolved"; readonly interactionId: string }
	| {
			readonly kind: "result";
			readonly outcome: RunOutcome;
			readonly error?: { readonly code: string; readonly retryable: boolean };
	  }
	| { readonly kind: "query_ended" }
	| { readonly kind: "accounting" }
	| {
			readonly kind: "effect_outcome";
			readonly outcome:
				| { readonly tag: "succeeded" }
				| { readonly tag: "retryable"; readonly retryAt: number }
				/** Includes "native_resume_rejected". */
				| { readonly tag: "permanent"; readonly code: string }
				/** The host never called the provider (H4); 3.7 spaces the re-send. */
				| { readonly tag: "not_sent"; readonly retryAt: number }
				| { readonly tag: "delivery_unknown" };
	  }
	| {
			readonly kind: "probe_result";
			readonly finding:
				| { readonly tag: "input_present"; readonly nativeMessageId?: string }
				| { readonly tag: "input_absent" }
				| { readonly tag: "native_idle" }
				| { readonly tag: "native_busy" }
				| { readonly tag: "answer_consumed" }
				| { readonly tag: "answer_pending" };
	  }
	// background work (section 8)
	| {
			readonly kind: "tasks_snapshot";
			readonly tasks: readonly {
				readonly key: TaskKey;
				readonly taskType: string;
				readonly subagentType?: string;
				readonly description: string;
				readonly ambient: boolean;
			}[];
	  }
	| {
			readonly kind: "task_event";
			readonly key: TaskKey;
			readonly event:
				| "started"
				| "completed"
				| "failed"
				| "killed"
				| "notification";
	  }
	| { readonly kind: "turn_started"; readonly wakeTask?: TaskKey }
	/** A Claude wake's end (8.3). */
	| { readonly kind: "turn_ended" }
	| {
			readonly kind: "command_lifecycle";
			readonly commandId: string;
			readonly state: "queued" | "started" | "completed" | "cancelled";
	  }
	| { readonly kind: "command_result"; readonly commandId: string }
	// Hold facts of a runner-held send (4.11): read from the existing event stream, never copied
	// into a second store. The opaque token identifies this commandId and transmission.
	| {
			readonly kind: "run_dispatched";
			readonly runnerId: string;
			readonly commandId: string;
			readonly transmission: number;
	  }
	| {
			readonly kind: "run_released";
			readonly reason:
				| {
						readonly tag: "Refused";
						readonly why: "exiting" | "retiring" | "interrupted";
				  }
				| "NotSent"
				| "JournalAbsent"
				| "ResumeRejected";
	  }
	/** The effect row's marker; Settle writes it. */
	| { readonly kind: "delivery_indeterminate" }
	| {
			readonly kind: "runner_reply";
			readonly outcome:
				| { readonly tag: "succeeded" }
				| { readonly tag: "failed"; readonly code: string };
	  }
	| {
			readonly kind: "journal_answer";
			readonly answer: "running" | "finished" | "uncertain" | "absent";
	  };

export type Control =
	/**
	 * deadlineAt: the commit's payload.stop.deadlineAt; null for a commit L6 does not fold (no
	 * stop, or U2's retire), which opens and joins no deadline (L6).
	 */
	| { readonly kind: "stop"; readonly deadlineAt: number | null }
	| { readonly kind: "end"; readonly deadlineAt: number | null }
	/** The interrupt main's `interruptForInput` asks for (5.1, D58). */
	| {
			readonly kind: "run_now";
			readonly inputId: string;
			readonly deadlineAt: number | null;
	  }
	| {
			readonly kind: "answer";
			readonly interactionId: string;
			readonly answer: unknown;
	  }
	| { readonly kind: "stop_tasks"; readonly tasks: "all" | readonly TaskKey[] }
	| { readonly kind: "confirm_escalation"; readonly snapshotEntry: number }
	| {
			readonly kind: "native_command";
			readonly commandId: string;
			readonly text: string;
	  };

export type Settlement =
	| { readonly kind: "alarm_fired" }
	| { readonly kind: "hold_exhausted"; readonly commandId: string }
	/** A runner-held try that ended before any hold: no token (3.4, 4.4). */
	| {
			readonly kind: "unheld_outcome";
			readonly runId: string;
			readonly commandId: string;
			readonly outcome:
				| { readonly tag: "retryable"; readonly retryAt: number }
				/** Includes "project_inactive". */
				| { readonly tag: "permanent"; readonly code: string }
				| { readonly tag: "not_sent"; readonly retryAt: number };
	  }
	| {
			readonly kind: "process_started";
			readonly label: Label;
			readonly reattached: boolean;
	  }
	/**
	 * Retires runnerId (L1, 3.3); one per (runnerId, retiredAt) (6.5). Its stop commit's
	 * run.released events precede it in that transaction and fold first (4.5).
	 */
	| {
			readonly kind: "process_lost";
			readonly runnerId: string;
			readonly retiredAt: number;
	  }
	/** No producer at 1ba91324 or 6c9ff950: unbuilt (3.4). */
	| {
			readonly kind: "session_ended";
			readonly cause: "native_session_vanished";
	  };

/**
 * decide issues only probe, stop_task and cancel_request (3.12); every other kind is a main call
 * the arm folds into `live` (3.5, 3.10, 8.4, 8.5).
 */
export type RunEffect =
	| {
			readonly kind: "start";
			readonly runId: string;
			readonly inputId: string;
			readonly mode: "resume" | "fresh";
	  }
	| { readonly kind: "steer"; readonly runId: string; readonly inputId: string }
	/** A Stop or Run now commit's `payload.stop.owners` (L6), as runIds only (4.6); runId null with no active Run. */
	| {
			readonly kind: "interrupt";
			readonly runId: string | null;
			readonly runIds: readonly string[];
	  }
	/** label: the runner's latest label, a projection of the send's address (L2, 3.3); null while it has none. */
	| {
			readonly kind: "end_session";
			readonly runId: string | null;
			readonly label: Label | null;
	  }
	/** runId null: no Run reads the label (3.10, L6). */
	| {
			readonly kind: "deliver_answer";
			readonly runId: string | null;
			readonly label: Label;
			readonly interactionId: string;
			readonly answer: unknown;
	  }
	/** OpenCode Stop fallback; the fence stays held. */
	| { readonly kind: "cancel_request"; readonly runId: string | null }
	| {
			readonly kind: "probe";
			readonly runId: string | null;
			readonly target:
				| { readonly tag: "input"; readonly inputId: string }
				| { readonly tag: "interaction"; readonly interactionId: string }
				| { readonly tag: "native_session" };
	  }
	| { readonly kind: "stop_task"; readonly key: TaskKey }
	| {
			readonly kind: "send_native_command";
			readonly commandId: string;
			readonly text: string;
	  };

export interface DecideContext {
	readonly now: number;
	/**
	 * Mints Run ids and the tokens of effects with no hold from the folded event's sequence and a
	 * counter within the decision, so a replay mints the same ids; never repeats.
	 */
	readonly newId: () => string;
	readonly policy: {
		readonly settleMs: number;
		readonly probeMs: number;
		readonly nativeCommandMs: number;
	};
}

export type IssuedEffect =
	/** A runner-held start or steer main issued, folded from `run.dispatched` under its commandId; holdRun binds n. */
	| {
			readonly tag: "Held";
			readonly commandId: string;
			readonly effect: RunEffect;
	  }
	/** A direct start's token is its `run.requested` runId; every other effect with no hold gets ctx.newId(). */
	| {
			readonly tag: "Tokened";
			readonly token: SendToken;
			readonly effect: RunEffect;
	  };
export interface RunEnded {
	readonly runId: string;
	readonly outcome: RunOutcome;
	readonly reason: EndReason;
}
/** 3.8. */
export type EndReason =
	| { readonly tag: "completed" }
	/** code: the fold's first specific (10A). */
	| { readonly tag: "process_lost" | "session_ended"; readonly code?: string }
	/** forced: only the ledger stop deadline's alarm ended the work (3.8, L6). */
	| { readonly tag: "interrupted"; readonly forced: boolean }
	| {
			readonly tag: "provider_error";
			readonly code: string;
			readonly retryable: boolean;
	  }
	| { readonly tag: "refused"; readonly code: string };

export type Decision<Event> =
	| {
			readonly tag: "Accepted";
			readonly events: readonly Event[];
			readonly effects: readonly IssuedEffect[];
			readonly ended: readonly RunEnded[];
			readonly alarmAt?: number;
			readonly diagnostic?: string;
	  }
	| { readonly tag: "Rejected"; readonly diagnostic: string };

// Send chains (3.5): separate unions.
export type Transport =
	| { readonly tag: "Retrying"; readonly at: number }
	| { readonly tag: "Failed"; readonly code: SendErrorCode }
	| { readonly tag: "Issued" | "Unknown" | "Sent" };
export type Consumption =
	| { readonly tag: "None" }
	| {
			readonly tag: "NotConsumed";
			readonly why: "declined" | "absent" | "released" | "cancelled";
	  }
	| { readonly tag: "Observed" }
	| { readonly tag: "Accepted" };

/** Run: Settling only. Stop: the ledger stop deadline, one per session row (3.7, L6). */
export type DeadlineOwner =
	| "Run"
	| "Send"
	| "Interaction"
	| "NativeCommand"
	| "Stop";
/** Tagged by owner, with a required target; alarmAt is the earliest (3.7). */
export type Deadline = { readonly at: number } & (
	| { readonly owner: "Run"; readonly runId: string }
	/** A probe's retry deadline (3.7). */
	| { readonly owner: "Send"; readonly token: SendToken }
	| { readonly owner: "Interaction"; readonly interactionId: string }
	| { readonly owner: "NativeCommand"; readonly commandId: string }
	/** The ledger stop deadline: one per session row, its target the row, no field (3.7, L6). */
	| { readonly owner: "Stop" }
);

export type InteractionView =
	| {
			readonly tag: "Pending";
			readonly interactionId: string;
			readonly kind: "permission" | "question";
			readonly lastRefusal?: {
				readonly attempt: SendToken;
				readonly code: string;
			};
	  }
	| {
			readonly tag: "Answered";
			readonly interactionId: string;
			readonly kind: "permission" | "question";
			readonly delivery: "queued" | "sent" | "unknown" | "settled";
	  };

export interface InputView {
	readonly inputId: string;
	readonly state: InputState;
}

/**
 * A union by Run tag (3.6); `by` only on Interrupting. The stop owns the deadline while the Run
 * has work in it or its start waits on that work (3.7 End); Settling owns its own.
 */
export type ActiveRunView = {
	readonly runId: string;
	/** In admission order. */
	readonly inputs: readonly InputView[];
} & (
	| { readonly origin: "input" }
	| { readonly origin: "wake"; readonly wakeTask?: TaskKey }
) &
	(
		| {
				readonly tag: "Queued";
				readonly deadline?: Extract<Deadline, { readonly owner: "Stop" }>;
				/** After an unlaunch, the unlaunching outcome's retryAt: a field, not a Deadline (3.6, 3.7). */
				readonly retryAt?: number;
		  }
		| {
				readonly tag: "Starting" | "Running";
				readonly deadline?: Extract<Deadline, { readonly owner: "Stop" }>;
		  }
		| {
				readonly tag: "Interrupting";
				readonly by: InterruptBy;
				readonly deadline?: Extract<Deadline, { readonly owner: "Stop" }>;
		  }
		| {
				readonly tag: "Settling";
				readonly deadline: Extract<Deadline, { readonly owner: "Run" }>;
		  }
	);

export interface TaskKey {
	readonly taskId: string;
	readonly runId?: string;
}
/** kind from taskType; class per 8.2. */
export type Task = Extract<
	Evidence,
	{ readonly kind: "tasks_snapshot" }
>["tasks"][number] & {
	readonly kind: string;
	readonly class: "monitoring" | "serving" | "work";
};
/** Per runner: its latest snapshot and that snapshot's label. */
export type Tasks =
	| { readonly tag: "Unknown"; readonly label: Label }
	| {
			readonly tag: "Known";
			readonly label: Label;
			readonly tasks: ReadonlyMap<TaskKey, Task>;
	  };
export type TasksView =
	| { readonly tag: "none" }
	| { readonly tag: "unknown"; readonly label: Label }
	| {
			readonly tag: "live";
			readonly label: Label;
			readonly tasks: readonly Task[];
	  };
/** The gate stores its step, never its addresses (L3, 8.4). */
export interface PendingConfirm {
	/** A restart is a retire, then main's relaunch (8.4). */
	readonly step: "retire" | "end_session";
	/** A view: the labels the step's addresses have now; one confirm covers them all. */
	readonly labels: readonly Label[];
	readonly snapshotEntry: number;
	readonly tasks: Exclude<TasksView, { readonly tag: "none" }>;
}
export type LostWork = { readonly label: Label } & (
	| { readonly tag: "known"; readonly tasks: readonly Task[] }
	| { readonly tag: "unknown" }
);
/** Only the waiting variants carry a deadline (8.5). */
export type NativeCommand = { readonly commandId: string } & (
	| {
			readonly tag: "Sent" | "Started";
			readonly deadline: Extract<Deadline, { readonly owner: "NativeCommand" }>;
	  }
	/** Queued suspends confirmation; Unconfirmed has already expired. */
	| { readonly tag: "Queued" }
	| { readonly tag: "Unconfirmed" }
	| { readonly tag: "Completed" }
	| { readonly tag: "Cancelled" }
	| { readonly tag: "Failed"; readonly code: string }
);
export type NativeCommandView = NativeCommand;

export interface LedgerView {
	/** Main's `readInboxState.paused`, read from main's module (D58). */
	readonly paused: boolean;
	readonly active?: ActiveRunView;
	readonly inbox: readonly InputView[];
	/** Work that may still act, in issue order. */
	readonly live: readonly IssuedEffect[];
	readonly tasks: TasksView;
	readonly anythingMayAct: boolean;
	readonly pendingConfirm?: PendingConfirm;
	readonly lostWork: readonly LostWork[];
	readonly nativeCommands: readonly NativeCommandView[];
	/** The session's, each its label's (3.10). */
	readonly interactions: readonly InteractionView[];
}

/** Intake runs where the event is appended, never in decide (3.2). */
export interface ProviderIntake {
	readonly terminal: (
		event: CanonicalEvent,
		streamsSessionLifecycle: boolean,
		identity: { readonly runId: string; readonly token: SendToken },
	) => Extract<Observation, { readonly tag: "Answer" }> | undefined;
}
/**
 * Plain data and pure predicates over recorded evidence (3.2, section 9). The stop's deadline step
 * is U2's and the ledger's alarm is the same for every provider (L6), so no rule carries it.
 */
export interface ProviderDecisionRules {
	readonly fences: (effect: RunEffect) => boolean;
	readonly idleCovers: (
		effect: RunEffect,
		deliveryConfirmed: boolean,
	) => boolean;
	readonly workEnded: (evidence: readonly Evidence[]) => boolean;
}
export type ProviderPolicy = {
	readonly capabilities: { readonly backgroundTasks: boolean };
	readonly runEnd: "result" | "query_ended";
} & (
	| {
			readonly tag: "Ready";
			readonly intake: ProviderIntake;
			readonly rules: ProviderDecisionRules;
	  }
	/** Never silently borrow another provider's rules. */
	| { readonly tag: "Pending"; readonly ticket: string }
);
export type ProviderPolicyTable = {
	readonly [P in ProviderKind]: ProviderPolicy;
};
