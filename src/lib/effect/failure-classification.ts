import { Cause, Effect, Exit, Option } from "effect";
import type { RpcMessage } from "effect/rpc";

// Keep Effect-version-specific failure semantics here, shared by server and browser.
export const firstFailure = Cause.findErrorOption;
export const failures = <E>(cause: Cause.Cause<E>): ReadonlyArray<E> =>
	cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
export const defects = <E>(cause: Cause.Cause<E>): ReadonlyArray<unknown> =>
	cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect);
export const isInterrupted = Cause.hasInterrupts;
export const isInterruptedOnly = <E>(cause: Cause.Cause<E>): boolean =>
	cause.reasons.every(Cause.isInterruptReason);
export const isEmpty = <E>(cause: Cause.Cause<E>): boolean =>
	cause.reasons.length === 0;
export const isCause = Cause.isCause;
export const isUnknownException = Cause.isUnknownError;
export const isTimeoutException = Cause.isTimeoutError;
export const renderCause = Cause.pretty;
export const squashCause = Cause.squash;
export const mapFailures = Cause.map;
export const withoutFailures = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
	Cause.fromReasons(
		cause.reasons.filter((reason) => !Cause.isFailReason(reason)),
	);

/** A single typed failure. Causes with additional reasons remain ineligible. */
export const soleFailure = <E>(cause: Cause.Cause<E>): Option.Option<E> => {
	const reason = cause.reasons[0];
	return cause.reasons.length === 1 && reason && Cause.isFailReason(reason)
		? Option.some(reason.error)
		: Option.none();
};

/** Preserve the whole cause, promoting every typed failure to a defect. */
export const failuresAsDefects = <E>(
	cause: Cause.Cause<E>,
): Cause.Cause<never> =>
	Cause.fromReasons(
		cause.reasons.map((reason) =>
			Cause.isFailReason(reason)
				? Cause.makeDieReason(reason.error).annotate(
						Cause.reasonAnnotations(reason),
					)
				: reason,
		),
	);

/**
 * The current fiber's caller has cancelled it, including cancellation recorded
 * inside an uninterruptible region before the runtime can deliver it. A transport
 * interruption alone does not imply that the consumer has unsubscribed.
 */
export const isInterruptedByCaller = Effect.uninterruptible(
	Effect.map(
		// Entering an interruptible region delivers any pending caller cancellation.
		// Capture it inside the mask so cleanup can still distinguish a transport exit.
		Effect.exit(Effect.interruptible(Effect.void)),
		Exit.isFailure,
	),
);

/** Inspect the encoded RPC cause without decoding or changing the wire value. */
export const isEncodedInterrupted = (
	cause: Extract<
		RpcMessage.ExitEncoded<unknown, unknown>,
		{ _tag: "Failure" }
	>["cause"],
): boolean => cause.some((reason) => reason._tag === "Interrupt");
