import { Cause, Effect, HashSet, Option, type Schema } from "effect";

// Keep Effect-version-specific failure semantics here, shared by server and browser.
export const firstFailure = Cause.failureOption;
export const failures = Cause.failures;
export const defects = Cause.defects;
export const isInterrupted = Cause.isInterrupted;
export const isInterruptedOnly = Cause.isInterruptedOnly;
export const isEmpty = Cause.isEmpty;
export const isCause = Cause.isCause;
export const isUnknownException = Cause.isUnknownException;
export const isTimeoutException = Cause.isTimeoutException;
export const renderCause = Cause.pretty;
export const squashCause = Cause.squash;
export const withoutFailures = Cause.stripFailures;

/** A bare typed failure. Composite causes remain ineligible, even with one error. */
export const soleFailure = <E>(cause: Cause.Cause<E>): Option.Option<E> =>
	Cause.isFailType(cause) ? Option.some(cause.error) : Option.none();

/** Preserve the whole cause, promoting every typed failure to a defect. */
export const failuresAsDefects = <E>(
	cause: Cause.Cause<E>,
): Cause.Cause<never> => Cause.flatMap(cause, Cause.die);

/**
 * The current fiber's caller has cancelled it, including cancellation recorded
 * inside an uninterruptible region before the runtime can deliver it. A transport
 * interruption alone does not imply that the consumer has unsubscribed.
 */
export const isInterruptedByCaller = Effect.map(
	Effect.descriptor,
	(fiber) => HashSet.size(fiber.interruptors) > 0,
);

/** Inspect the encoded RPC cause without decoding or changing the wire value. */
export const isEncodedInterrupted = (
	cause: Schema.CauseEncoded<unknown, unknown>,
): boolean =>
	cause._tag === "Interrupt" ||
	((cause._tag === "Sequential" || cause._tag === "Parallel") &&
		(isEncodedInterrupted(cause.left) || isEncodedInterrupted(cause.right)));
