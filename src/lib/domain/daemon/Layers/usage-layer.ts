import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { PROVIDER_DRIVERS } from "../../../contracts/provider-instance.js";
import { loadClaudeSdkTestModule } from "../../../provider/claude/claude-sdk-module.js";
import {
	type ClaudeUsageReaderOptions,
	makeClaudeUsageReader,
} from "../../../provider/claude/claude-usage-probe.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonStateTag } from "../Services/daemon-state.js";
import {
	makeUsage,
	Usage,
	type UsageHistorySnapshot,
	UsageHistorySnapshotSchema,
} from "../Services/usage.js";

/** One instance for the daemon, shared by every project's continuation module. */
export const UsageLive = (options: ClaudeUsageReaderOptions = {}) =>
	Layer.scoped(
		Usage,
		Effect.gen(function* () {
			const state = yield* DaemonStateTag;
			const directory = yield* AccountDirectory;
			const config = yield* Effect.serviceOption(DaemonConfigRefTag);
			const sdk = options.queryFactory
				? undefined
				: yield* loadClaudeSdkTestModule;
			const initial = yield* Ref.get(state);
			const historyFile = join(initial.configDir, "usage-history.json");
			return yield* makeUsage({
				history: {
					load: Effect.tryPromise(() => readFile(historyFile, "utf8")).pipe(
						Effect.flatMap(
							Schema.decodeUnknown(
								Schema.parseJson(UsageHistorySnapshotSchema),
							),
						),
						Effect.orElseSucceed((): UsageHistorySnapshot => ({})),
					),
					save: (snapshot) =>
						Effect.suspend(() => {
							const temporary = join(
								initial.configDir,
								`.usage-history.json.tmp.${process.pid}.${randomUUID()}`,
							);
							return Effect.tryPromise(async () => {
								await mkdir(initial.configDir, {
									recursive: true,
									mode: 0o700,
								});
								await writeFile(temporary, JSON.stringify(snapshot), {
									encoding: "utf8",
									mode: 0o600,
								});
								await rename(temporary, historyFile);
							}).pipe(
								Effect.ensuring(
									Effect.tryPromise(() => rm(temporary, { force: true })).pipe(
										Effect.ignore,
									),
								),
							);
						}),
				},
				order: Option.isSome(config)
					? Ref.get(config.value).pipe(
							Effect.map((current) => current.usageLimits?.order ?? []),
						)
					: Effect.succeed([]),
				accounts: Effect.map(directory.list, (accounts) =>
					accounts.flatMap((account) =>
						account.driver === "claude" && account.usageEligible
							? [
									{
										id: account.id,
										harness: PROVIDER_DRIVERS[account.driver].usageHarness,
										folder: account.folder,
										...(account.env ? { env: account.env } : {}),
									},
								]
							: [],
					),
				),
				readers: {
					claude: makeClaudeUsageReader({
						...options,
						cwd: options.cwd ?? initial.configDir,
						...(sdk ? { queryFactory: sdk.claudeSdk.query } : {}),
					}),
				},
			});
		}),
	);
