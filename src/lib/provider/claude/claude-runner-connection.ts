import { Effect, Result as Either } from "effect";
import {
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { connectRunner } from "../runner/runner-connection.js";
import { makeClaudeRunnerWire } from "./claude-runner-wire.js";
import { makeClaudeThreadRead } from "./claude-thread-read.js";

/** Keep provider-specific launch normalization and history access at this edge. */
export const connectClaudeRunner = (
	options: Parameters<typeof connectRunner>[0],
) =>
	Effect.gen(function* () {
		const read = yield* Effect.serviceOption(ReadQueryEffectTag);
		const readThread =
			read._tag === "Some"
				? yield* makeClaudeThreadRead.pipe(
						Effect.provideService(ReadQueryEffectTag, read.value),
					)
				: undefined;
		return yield* connectRunner({
			...options,
			driverKind: options.driverKind ?? "claude",
			wire: makeClaudeRunnerWire(() =>
				resolveClaudeLaunchConfig(
					Either.getOrElse(
						loadDaemonConfigResult(options.deps.daemonConfigDir),
						(error) => {
							if (error._tag === "NotFound") return null;
							throw error;
						},
					),
				),
			),
			...(readThread ? { readThread } : {}),
		});
	});
