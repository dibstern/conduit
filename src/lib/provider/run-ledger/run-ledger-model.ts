/**
 * Run Ledger public interface: everything a caller or a test may know.
 *
 * The decider works on one session at a time. A session has at most one
 * active Run; every other Run of the session is Ended (a Tombstone). Every
 * non-Ended state carries a Deadline, so "stuck busy" cannot be represented.
 *
 * Correlation: every transmission of a Run Effect is issued with a Send Token
 * that is never reused, including across retries. Every Observation and every
 * token-bearing Settlement names the token of the send it answers. Evidence for
 * a token that is no longer live never changes Run lifecycle state. This one
 * rule replaces per-kind staleness checks on run id, attempt, admission or
 * version; callers never reason about attempts.
 *
 * Deadlines are data owned by the obligation they bound; they are not sends.
 * Each Accepted decision projects one alarm, alarmAt, the earliest open
 * deadline after its events. The scheduler keeps a single timer at alarmAt and
 * reports alarm_fired; the decider fires every deadline due at ctx.now, so a
 * late or spurious fire finds nothing due and changes nothing.
 */

export type ProviderKind = "claude" | "cursor" | "opencode";

/** Opaque, minted by the decider from DecideContext.newId, never reused. */
export type SendToken = string & { readonly __brand: "SendToken" };

export type DeadlineKind =
	/** Start effect sent, waiting for the provider to start. */
	| "start"
	/** Running: liveness check, extended by provider activity. */
	| "liveness"
	/** Interrupting: waiting for a native interrupted result (30 s). */
	| "interrupt"
	/** Interrupting after the first deadline: waiting for close confirmation. */
	| "close"
	/** Settling: waiting for the native query to end after a result. */
	| "settle"
	/** Queued: waiting for the native-session fence or a probe to clear. */
	| "fence"
	/** Pending permission: delivers a rejection as the answer when it fires. */
	| "interaction"
	/** An in-flight effect's own deadline (cleanup can outlive the Tombstone). */
	| "effect";

export interface Deadline {
	readonly at: number;
	readonly kind: DeadlineKind;
}

export type EndReason =
	| { readonly kind: "completed" }
	| {
			readonly kind: "provider_error";
			readonly code: string;
			readonly retryable: boolean;
	  }
	| {
			readonly kind: "interrupted";
			readonly by: "stop" | "run_now" | "end";
			/** True when the run ended on the interrupt deadline, not native truth. */
			readonly forced: boolean;
	  }
	| { readonly kind: "process_lost" }
	| { readonly kind: "deadline_expired"; readonly deadline: DeadlineKind }
	| {
			readonly kind: "session_ended";
			readonly cause: "usage_limit_failover" | "native_session_vanished";
	  }
	| { readonly kind: "refused"; readonly code: string }
	| { readonly kind: "project_inactive" }
	| { readonly kind: "fence_unconfirmed" };

export type RunOutcome = "completed" | "error" | "interrupted";

export type InputState =
	| { readonly tag: "Queued" }
	| {
			readonly tag: "Delivered";
			/** "unknown": the transport could not confirm; probe, never resend. */
			readonly certainty: "sent" | "unknown";
	  }
	| {
			readonly tag: "Accepted";
			readonly nativeMessageId?: string;
			/** Native delivery is recorded without revoking a prior local cancellation. */
			readonly cancelled?: true;
	  }
	| { readonly tag: "Declined"; readonly reason: string };

/** Inputs to the decider, one variant per ledger verb. */
export type LedgerCommand =
	| {
			readonly verb: "admit";
			readonly inputId: string;
			readonly runNow: boolean;
	  }
	| { readonly verb: "observe"; readonly observation: Observation }
	| { readonly verb: "control"; readonly control: Control }
	| { readonly verb: "settle"; readonly settlement: Settlement };

/**
 * Provider evidence. `token` names the send this evidence answers:
 * - started, activity, result, query_ended, interaction_requested: the
 *   latest start or steer transmission the adapter delivered on that native
 *   query
 * - interaction_resolved: the deliver_answer transmission it confirms, or the
 *   query's latest start or steer when the provider resolved it natively
 * - input_accepted, input_declined, accounting: the start or steer
 *   transmission that carried that input
 * - effect_outcome: the effect's own token
 * - probe_result: the probe's token; the probe's target comes from the token
 * Evidence naming a token whose send cannot produce that kind is Rejected.
 */
export type Observation = { readonly token: SendToken } & Evidence;

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
	/** Classified by the provider's native policy. */
	| {
			readonly kind: "result";
			readonly outcome: RunOutcome;
			readonly error?: { readonly code: string; readonly retryable: boolean };
	  }
	| { readonly kind: "query_ended" }
	/** Late accounting: allowed for Tombstones, never changes Run state. */
	| { readonly kind: "accounting" }
	| {
			readonly kind: "effect_outcome";
			readonly outcome:
				| { readonly tag: "succeeded" }
				| { readonly tag: "retryable"; readonly retryAt: number }
				| { readonly tag: "permanent"; readonly code: string }
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
	  };

/** User actions. Session-scoped: they name no token. */
export type Control =
	| { readonly kind: "stop" }
	| { readonly kind: "run_now"; readonly inputId: string }
	| { readonly kind: "end" }
	| { readonly kind: "resume" }
	| { readonly kind: "cancel_input"; readonly inputId: string }
	| {
			readonly kind: "answer";
			readonly interactionId: string;
			readonly answer: unknown;
	  };

export type Settlement =
	/** The scheduler's single timer fired; deadlines due at ctx.now fire. */
	| { readonly kind: "alarm_fired" }
	/** Names any start or steer token of the lost attempt. */
	| { readonly kind: "process_lost"; readonly token: SendToken }
	| {
			readonly kind: "session_ended";
			readonly cause: "usage_limit_failover" | "native_session_vanished";
	  }
	| { readonly kind: "project_inactive" };

/** Durable instructions for the effect interpreter. */
export type RunEffect =
	| {
			readonly kind: "start";
			readonly runId: string;
			readonly inputId: string;
	  }
	| {
			readonly kind: "steer";
			readonly runId: string;
			readonly inputId: string;
	  }
	| { readonly kind: "interrupt"; readonly runId: string }
	| { readonly kind: "close"; readonly runId: string }
	| { readonly kind: "quarantine"; readonly runId: string }
	| { readonly kind: "kill_and_respawn"; readonly runId: string }
	| { readonly kind: "end_session"; readonly runId: string }
	| {
			readonly kind: "deliver_answer";
			readonly runId: string;
			readonly interactionId: string;
			readonly answer: unknown;
	  }
	/** Native-policy Stop fallback (OpenCode): cancel the request; the fence stays held. */
	| { readonly kind: "cancel_request"; readonly runId: string }
	| {
			readonly kind: "probe";
			readonly runId: string;
			readonly target:
				| { readonly tag: "input"; readonly inputId: string }
				| { readonly tag: "interaction"; readonly interactionId: string }
				| { readonly tag: "native_session" };
	  };

export interface DecideContext {
	readonly now: number;
	/** Mints Send Tokens and Run ids; must never repeat. */
	readonly newId: () => string;
	readonly policy: {
		readonly startMs: number;
		readonly livenessMs: number;
		/** 30 s per spec. */
		readonly interruptMs: number;
		readonly closeMs: number;
		readonly settleMs: number;
		readonly fenceMs: number;
	};
}

/** One transmission of a Run Effect. A retry is a new IssuedEffect with a new token. */
export interface IssuedEffect {
	readonly token: SendToken;
	readonly effect: RunEffect;
}

export interface RunEnded {
	readonly runId: string;
	readonly outcome: RunOutcome;
	readonly reason: EndReason;
}

/**
 * decide never throws and never mutates. A rejection leaves state unchanged;
 * the diagnostic says which transition was illegal and why. Stale evidence is
 * Accepted with no events, no effects and no terminals.
 */
export type Decision<Event> =
	| {
			readonly tag: "Accepted";
			readonly events: readonly Event[];
			readonly effects: readonly IssuedEffect[];
			/** Runs this decision Tombstoned, in order. */
			readonly ended: readonly RunEnded[];
			/** Earliest open deadline after this decision; absent cancels the alarm. */
			readonly alarmAt?: number;
	  }
	| { readonly tag: "Rejected"; readonly diagnostic: string };

export type RunTag =
	| "Queued"
	| "Starting"
	| "Running"
	| "Interrupting"
	| "Settling";

export type InteractionView =
	| {
			readonly tag: "Pending";
			readonly interactionId: string;
			readonly kind: "permission" | "question";
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
	/** True while the provider may have consumed it without confirmation: probe, never resend. */
	readonly uncertain: boolean;
}

/**
 * The externally visible state of one session: what the UI and the tests
 * observe. Derived on demand from SessionLedgerState; never stored.
 */
export interface LedgerView {
	readonly paused: boolean;
	readonly active?: {
		readonly runId: string;
		readonly tag: RunTag;
		readonly deadline: Deadline;
		/** Interrupting only. */
		readonly by?: "stop" | "run_now" | "end";
		/** Inputs owned by the active Run, in admission order. */
		readonly inputs: readonly InputView[];
		readonly interactions: readonly InteractionView[];
	};
	/** Inputs waiting for the next Run, in order. */
	readonly inbox: readonly InputView[];
	/** Every live send, in issue order: the native-session fence and the interpreter's work. */
	readonly live: readonly IssuedEffect[];
}
