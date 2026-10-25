import { Effect, Option } from "effect";
import { defaultFor } from "../../account-directory.js";
import { AccountUnroutable } from "../../contracts/limit-recovery.js";
import { AttachmentStoreTag } from "../../domain/persistence/Services/attachment-store.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { connectRunner } from "../runner/runner-connection.js";
import {
	claudeLaunchConfigFromAccounts,
	makeClaudeRunnerWire,
} from "./claude-runner-wire.js";
import { makeClaudeThreadRead } from "./claude-thread-read.js";

/** Keep provider-specific launch normalization and history access at this edge. */
export const connectClaudeRunner = (
	options: Parameters<typeof connectRunner>[0],
) =>
	Effect.gen(function* () {
		const accounts = yield* options.deps.accounts ?? Effect.succeed(undefined);
		const claudeLaunchConfig =
			accounts && Option.isNone(defaultFor(accounts, "claude"))
				? null
				: claudeLaunchConfigFromAccounts(accounts);
		const read = yield* Effect.serviceOption(ReadQueryEffectTag);
		const attachments = yield* Effect.serviceOption(AttachmentStoreTag);
		const readThread =
			options.readThread ??
			(read._tag === "Some" && attachments._tag === "Some"
				? yield* makeClaudeThreadRead.pipe(
						Effect.provideService(ReadQueryEffectTag, read.value),
						Effect.provideService(AttachmentStoreTag, attachments.value),
					)
				: undefined);
		return yield* connectRunner({
			...options,
			deps: { ...options.deps, claudeLaunchConfig },
			driverKind: options.driverKind ?? "claude",
			wire: makeClaudeRunnerWire(() => {
				if (claudeLaunchConfig === null)
					throw new AccountUnroutable({
						ref: { _tag: "DriverDefault", driver: "claude" },
					});
				return claudeLaunchConfig;
			}),
			...(readThread ? { readThread } : {}),
		});
	});
