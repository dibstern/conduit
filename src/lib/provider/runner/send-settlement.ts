import { Data, Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import type { InputDrafts } from "../../domain/relay/Services/input-drafts.js";
import type { ClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import type {
	CommitAndSignalProject,
	CommitAndSignalStamp,
} from "../../persistence/effect/commit-and-signal.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import type { TurnResult } from "../types.js";
import type { RunnerSendAnswer } from "./runner-protocol.js";
import type { StopReason } from "./runner-receipts.js";
import type { SessionFailure } from "./session-runner.js";

export class StoreUnavailable extends Data.TaggedError("StoreUnavailable")<{
	readonly cause: unknown;
}> {}

export class StoreRejected extends Data.TaggedError("StoreRejected")<{
	readonly cause: unknown;
}> {}

export type StoreFault = StoreUnavailable | StoreRejected;

/** SQL reasons distinguish a transient outage from malformed or rejected data. */
export const toStoreFault = (cause: unknown): StoreFault => {
	if (cause instanceof StoreUnavailable || cause instanceof StoreRejected)
		return cause;
	if (isSqlError(cause))
		return cause.isRetryable
			? new StoreUnavailable({ cause })
			: new StoreRejected({ cause });
	if (typeof cause === "object" && cause !== null && "cause" in cause)
		return toStoreFault(cause.cause);
	return new StoreRejected({ cause });
};

export const sendRetryBackoff = (attempt: number): number =>
	Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);

/** The source retains one immutable observation until this write commits. */
export const retrySettlementWrite = <A, E, R>(
	write: Effect.Effect<A, E, R>,
): Effect.Effect<A, StoreFault, R> =>
	Effect.gen(function* () {
		let ordinal = 0;
		while (true) {
			const result = yield* Effect.result(write);
			if (result._tag === "Success") return result.success;
			const fault = toStoreFault(result.failure);
			if (fault._tag === "StoreRejected") return yield* fault;
			yield* Effect.sleep(sendRetryBackoff(++ordinal));
		}
	});

export interface SendRef {
	readonly sessionId: string;
	readonly runId: string;
	readonly commandId: string;
	readonly requestSequence: number;
	readonly attempt: number;
}

export interface HeldSendRef extends SendRef {
	readonly runnerId: string;
	readonly transmission: number;
}

export type TerminalTurnResult = Omit<
	TurnResult,
	"status" | "nativeResumeRejected"
> & {
	readonly status:
		| "completed"
		| "error"
		| "interrupted"
		| "cancelled"
		| "steer-declined";
	readonly nativeResumeRejected?: false;
};

export const terminalTurnResult = (
	result: TurnResult | undefined,
): TerminalTurnResult | undefined => {
	if (
		!result ||
		result.nativeResumeRejected ||
		isClaudeResumeRefused(result.error)
	)
		return undefined;
	switch (result.status) {
		case "completed":
		case "error":
		case "interrupted":
		case "cancelled":
		case "steer-declined":
			return { ...result, status: result.status, nativeResumeRejected: false };
		default:
			return undefined;
	}
};

export const terminalFailureResult = (
	failure: SessionFailure,
): TerminalTurnResult => ({
	status: "error",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
	error: {
		message: failure.message,
		code: String(failure.code ?? "provider_failure"),
		...(failure.retryable !== undefined
			? { retryable: failure.retryable }
			: {}),
	},
});

export type SendEvidence = (
	| {
			readonly _tag: "replied";
			readonly send: HeldSendRef;
			readonly result: TerminalTurnResult;
	  }
	| {
			readonly _tag: "journal_finished";
			readonly send: HeldSendRef;
			readonly answer: Extract<RunnerSendAnswer, { status: "finished" }>;
	  }
	| {
			readonly _tag: "failed";
			readonly send: SendRef;
			readonly failure: SessionFailure;
	  }
	| { readonly _tag: "covered"; readonly send: SendRef }
	| {
			readonly _tag: "process_lost";
			readonly send: HeldSendRef;
			readonly reason: StopReason;
	  }
	| { readonly _tag: "delivery_unknown"; readonly send: HeldSendRef }
) & { readonly observedAt: number };

export type SendOutcome =
	| "succeeded"
	| "retryable"
	| "permanent"
	| "cancelled"
	| "delivery_unknown";

export type NormalizedTerminalEvidence =
	| {
			readonly _tag: "replied" | "journal_finished";
			readonly result: TerminalTurnResult;
	  }
	| { readonly _tag: "failed"; readonly failure: SessionFailure }
	| { readonly _tag: "covered" | "delivery_unknown" }
	| { readonly _tag: "process_lost"; readonly reason: StopReason };

/** Every send retry decision, including legacy recovery, passes through here. */
export const classify = (evidence: NormalizedTerminalEvidence): SendOutcome => {
	switch (evidence._tag) {
		case "failed":
			return evidence.failure.retryable === true ? "retryable" : "permanent";
		case "covered":
			return "cancelled";
		case "delivery_unknown":
			return "delivery_unknown";
		case "process_lost":
			return evidence.reason._tag === "EndSession" && !evidence.reason.orphan
				? "cancelled"
				: "permanent";
		case "replied":
		case "journal_finished": {
			const { result } = evidence;
			if (result.status === "completed") return "succeeded";
			if (result.status === "interrupted" || result.status === "cancelled")
				return "cancelled";
			return result.status !== "steer-declined" &&
				result.error?.retryable === true &&
				result.error.retryHandled !== true
				? "retryable"
				: "permanent";
		}
	}
	const exhaustive: never = evidence;
	return exhaustive;
};

export interface SettlementTx {
	readonly sql: SqlClient.SqlClient;
	readonly project: CommitAndSignalProject;
	readonly stamp: CommitAndSignalStamp;
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
	readonly userMessageIdForInput?: (
		driver: string,
		inputId: string,
	) => string | undefined;
	readonly inputDrafts?: Pick<InputDrafts, "restoreChange">;
	readonly afterCommit?: (effect: Effect.Effect<void>) => void;
	readonly driverKind?: string;
}
