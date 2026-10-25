import { Effect } from "effect";

/** Shared ordinary idle grace for daemon-owned provider resources. */
export const instanceIdleTimeoutFromEnv = Effect.sync(() => {
	const configured = process.env["CONDUIT_OPENCODE_IDLE_TIMEOUT_MS"];
	return configured === undefined ? 600_000 : Number(configured);
}).pipe(
	Effect.filterOrFail(
		(ms) => Number.isInteger(ms) && ms > 0 && ms <= 2_147_483_647,
		() =>
			new Error(
				"CONDUIT_OPENCODE_IDLE_TIMEOUT_MS must be an integer from 1 to 2147483647",
			),
	),
	Effect.orDie,
);
