import { Effect } from "effect";
import {
	RUNNER_WRITE_GATE_CLOSED,
	type RunnerCommandFailure,
	type RunnerRefusalReason,
	type RunnerWriteGate,
	runnerDeliveryEvidence,
	runnerFailure,
} from "../../src/lib/provider/runner/runner-protocol.js";
import type { SessionFailure } from "../../src/lib/provider/runner/session-runner.js";

/**
 * A fake connection's write, gated as RunnerSocket gates it (4.4): the gate is
 * read in the write's synchronous step, and the frame's refusal reader returns
 * the host refusal its reply carried.
 */
export const gatedWrite = <A, E extends SessionFailure>(
	canWrite: RunnerWriteGate | undefined,
	write: Effect.Effect<A, E>,
): Effect.Effect<A, E | RunnerCommandFailure> =>
	Effect.suspend((): Effect.Effect<A, E | RunnerCommandFailure> => {
		let refused: RunnerRefusalReason | undefined;
		if (canWrite && !canWrite(() => refused))
			return Effect.fail({
				...runnerFailure("write runner frame", "The write gate is closed"),
				code: RUNNER_WRITE_GATE_CLOSED,
			});
		return write.pipe(
			Effect.tapError((failure) =>
				Effect.sync(() => {
					const evidence = runnerDeliveryEvidence(failure);
					if (evidence?._tag === "Refused") refused = evidence.reason;
				}),
			),
		);
	});
