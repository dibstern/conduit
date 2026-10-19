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
import { makeCursorUsage } from "../../../provider/cursor/cursor-usage.js";
import { usageAccounts } from "../../../provider/usage-reader.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonStateTag } from "../Services/daemon-state.js";
import {
	makeUsage,
	Usage,
	type UsageHistorySnapshot,
	UsageHistorySnapshotSchema,
} from "../Services/usage.js";

export const makeConfiguredCursorUsage = Effect.gen(function* () {
	const config = yield* Effect.serviceOption(DaemonConfigRefTag);
	const persistence = yield* Effect.serviceOption(ConfigPersistenceTag);
	let binding = Option.isSome(config)
		? (yield* Ref.get(config.value)).cursorUsageBinding
		: undefined;
	return makeCursorUsage({
		getBinding: () => binding,
		saveBinding: (next) =>
			Effect.gen(function* () {
				if (Option.isNone(config) || Option.isNone(persistence))
					return yield* Effect.fail(
						new Error("Cursor usage settings are unavailable"),
					);
				const previous = yield* Ref.get(config.value);
				yield* Ref.update(
					config.value,
					({ cursorUsageBinding: _binding, ...current }) => ({
						...current,
						...(next ? { cursorUsageBinding: next } : {}),
					}),
				);
				yield* Effect.andThen(
					persistence.value.requestSave,
					persistence.value.flush,
				).pipe(
					Effect.onError(() =>
						Ref.update(
							config.value,
							({ cursorUsageBinding: _binding, ...current }) => ({
								...current,
								...(previous.cursorUsageBinding
									? { cursorUsageBinding: previous.cursorUsageBinding }
									: {}),
							}),
						),
					),
				);
				binding = next;
			}),
	});
});

/** One instance for the daemon, shared by every project's continuation module. */
export const UsageLive = (options: ClaudeUsageReaderOptions = {}) =>
	Layer.effect(
		Usage,
		Effect.gen(function* () {
			const state = yield* DaemonStateTag;
			const directory = yield* AccountDirectory;
			const config = yield* Effect.serviceOption(DaemonConfigRefTag);
			const accountList = Option.isSome(config)
				? directory.list.pipe(
						Effect.provideService(DaemonConfigRefTag, config.value),
					)
				: directory.list;
			const sdk = options.queryFactory
				? undefined
				: yield* loadClaudeSdkTestModule;
			const initial = yield* Ref.get(state);
			const historyFile = join(initial.configDir, "usage-history.json");
			const cursor = yield* makeConfiguredCursorUsage;
			const usage = yield* makeUsage({
				history: {
					load: Effect.tryPromise(() => readFile(historyFile, "utf8")).pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.fromJsonString(UsageHistorySnapshotSchema),
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
				accounts: Effect.map(accountList, usageAccounts),
				accountHarness: (id) =>
					Effect.map(accountList, (accounts) => {
						const account = accounts.find((account) => account.id === id);
						return account
							? PROVIDER_DRIVERS[account.driver].usageHarness
							: undefined;
					}),
				readers: {
					cursor: cursor.reader,
					claude: makeClaudeUsageReader({
						...options,
						cwd: options.cwd ?? initial.configDir,
						...(sdk ? { queryFactory: sdk.claudeSdk.query } : {}),
					}),
				},
			});
			return { ...usage, setCursorKeychain: cursor.setKeychain };
		}),
	);
