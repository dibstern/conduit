import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Equal,
	FiberMap,
	Ref,
	Schema,
	type Scope,
	Stream,
	SubscriptionRef,
	SynchronizedRef,
} from "effect";
import { accountLimit } from "../../../contracts/account-limit.js";
import {
	UsageHistoryPointSchema,
	type UsageReading,
	UsageReadingSchema,
} from "../../../contracts/limit-recovery.js";
import type { UsageHarness } from "../../../contracts/provider-instance.js";
import type {
	UsageAccount,
	UsageRead,
	UsageReader,
} from "../../../provider/usage-reader.js";
import {
	type AccountUsage,
	afterTurn,
	decide,
	emptyAccountUsage,
	freedBeforeReset,
	live,
	publishedReading,
	restored,
	retired,
	savedHistory,
	settle,
	shouldWake,
	waitedOut,
} from "./account-usage.js";

export { forecastUsage } from "./usage-forecast.js";

export interface UsageService {
	readonly setCursorKeychain?: (
		accountId: string,
		enabled: boolean,
	) => Effect.Effect<{ enabled: boolean; reason?: string }>;
	readonly readings: Stream.Stream<readonly UsageReading[]>;
	/** Merge a provider's sparse live windows into the account's published reading. */
	readonly update?: (
		accountId: string,
		harness: UsageHarness,
		reading: UsageRead,
	) => Effect.Effect<void>;
	/** The latest completed reading, without reading the account. */
	readonly latest: (
		accountId: string,
	) => Effect.Effect<UsageReading | undefined>;
	readonly refresh: (options: {
		readonly accountIds?: readonly string[];
		readonly maxAge: Duration.Input;
		/** How long to wait for a read in progress before answering with the current reading, marked checking. */
		readonly wait: Duration.Input | "until-settled";
	}) => Effect.Effect<readonly UsageReading[]>;
	readonly turnEnded: (accountId: string) => Effect.Effect<void>;
	readonly pickFailover: (
		excluding: string,
		modelId?: string,
	) => Effect.Effect<string | undefined>;
}

export class Usage extends Context.Service<Usage, UsageService>()("Usage") {}

const usageHistorySeriesSchema = Schema.Struct({
	resetsAt: Schema.optional(Schema.Number.check(Schema.isFinite())),
	points: Schema.Array(UsageHistoryPointSchema),
});

export const UsageHistorySnapshotSchema = Schema.Record(
	Schema.String,
	Schema.Struct({
		five_hour: Schema.optional(usageHistorySeriesSchema),
		seven_day: Schema.optional(usageHistorySeriesSchema),
		/** The reading while it is available or limited, shown as stale after a restart. */
		reading: Schema.optional(UsageReadingSchema),
	}),
);
export type UsageHistorySnapshot = typeof UsageHistorySnapshotSchema.Type;

type UsageState = {
	readonly accounts: ReadonlyMap<string, AccountUsage>;
};
type UsageStateRef = SubscriptionRef.SubscriptionRef<UsageState>;

type UsageOptions = {
	readonly accounts: Effect.Effect<readonly UsageAccount[]>;
	readonly accountHarness?: (
		accountId: string,
	) => Effect.Effect<UsageAccount["harness"] | undefined>;
	readonly order?: Effect.Effect<readonly string[]>;
	readonly readers: Readonly<Record<UsageHarness, UsageReader>>;
	readonly history?: {
		readonly load: Effect.Effect<UsageHistorySnapshot, unknown>;
		readonly save: (
			snapshot: UsageHistorySnapshot,
		) => Effect.Effect<void, unknown>;
	};
};

const withAccount = (
	state: UsageState,
	accountId: string,
	record: AccountUsage,
): UsageState => ({
	...state,
	accounts: new Map(state.accounts).set(accountId, record),
});

const readUsage = (
	// Stored readings can name harnesses that no current driver declares.
	readers: Readonly<Record<string, UsageReader | undefined>>,
	account: UsageAccount,
) =>
	Effect.suspend(() => {
		const reader = readers[account.harness];
		return reader
			? reader.read(account)
			: Effect.succeed<UsageRead>({
					status: "unavailable",
					windows: [],
					reason: "Usage reader is not available for this harness",
				});
	}).pipe(
		Effect.timeoutOrElse({
			duration: "30 seconds",
			orElse: () =>
				Effect.succeed<UsageRead>({
					status: "unknown",
					windows: [],
					reason: "Usage read timed out",
				}),
		}),
		Effect.catchCause(() =>
			Effect.succeed<UsageRead>({
				status: "unknown",
				windows: [],
				reason: "Usage read failed",
			}),
		),
	);

const settleRead =
	(
		state: UsageStateRef,
		saveHistory: Effect.Effect<void>,
		schedule: (accountId: string) => Effect.Effect<void>,
		account: UsageAccount,
		{
			result,
			startedAt,
		}: {
			readonly result: Deferred.Deferred<UsageReading>;
			readonly startedAt: number;
		},
	) =>
	(read: UsageRead) =>
		Effect.gen(function* () {
			const readAt = yield* Clock.currentTimeMillis;
			const { previous, reading } = yield* SubscriptionRef.modify(
				state,
				(current) => {
					const record = current.accounts.get(account.id) ?? emptyAccountUsage;
					const settled = settle(record, result, read, {
						accountId: account.id,
						harness: account.harness,
						readAt,
						startedAt,
					});
					return [
						{ previous: record.reading, reading: settled.reading },
						withAccount(current, account.id, settled.record),
					];
				},
			);
			yield* schedule(account.id);
			for (const freed of freedBeforeReset(previous, reading))
				yield* Effect.logInfo("Usage window free before reset", {
					accountId: account.id,
					...freed,
				});
			yield* Deferred.succeed(result, reading);
			yield* Effect.logWarning("Usage read settled").pipe(
				Effect.annotateLogs({
					accountId: account.id,
					durationMs: readAt - startedAt,
					outcome: read.status,
					...(read.reason ? { reason: read.reason } : {}),
				}),
			);
			yield* saveHistory;
		});

const readAccount =
	(
		state: UsageStateRef,
		scope: Scope.Scope,
		readers: UsageOptions["readers"],
		saveHistory: Effect.Effect<void>,
		schedule: (accountId: string) => Effect.Effect<void>,
	) =>
	(
		accountId: string,
		account: UsageAccount | undefined,
		{
			maxAge,
			wait,
		}: {
			readonly maxAge: number;
			readonly wait: Duration.Input | "until-settled";
		},
	) =>
		account
			? Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis;
						const pending = yield* Deferred.make<UsageReading>();
						// Deciding and marking the read in progress is one atomic step.
						const decision = yield* SubscriptionRef.modify(state, (current) => {
							const decision = decide(
								current.accounts.get(accountId) ?? emptyAccountUsage,
								now,
								maxAge,
								pending,
							);
							return [
								decision,
								decision.kind === "start"
									? withAccount(current, accountId, decision.record)
									: current,
							];
						});
						if (decision.kind === "reuse") return decision.reading;
						if (decision.kind === "start")
							yield* Effect.forkIn(
								restore(
									readUsage(readers, account).pipe(
										Effect.flatMap(
											settleRead(state, saveHistory, schedule, account, {
												result: pending,
												startedAt: now,
											}),
										),
									),
								),
								scope,
							);
						const settled = Deferred.await(decision.result);
						return yield* restore(
							wait === "until-settled"
								? settled
								: Effect.timeoutOrElse(settled, {
										duration: wait,
										orElse: () =>
											SubscriptionRef.get(state).pipe(
												Effect.map(({ accounts }) =>
													waitedOut(
														accounts.get(accountId) ?? emptyAccountUsage,
														{
															accountId,
															harness: account.harness,
															readAt: now,
														},
													),
												),
											),
									}),
						);
					}),
				)
			: Clock.currentTimeMillis.pipe(
					Effect.map(
						(readAt): UsageReading => ({
							accountId,
							harness: "claude",
							status: "unavailable",
							windows: [],
							reason: "Claude account is not configured",
							readAt,
							stale: false,
						}),
					),
				);

const makeHistoryWriter = (
	state: UsageStateRef,
	history: UsageOptions["history"],
	loaded: UsageHistorySnapshot,
) =>
	Effect.gen(function* () {
		if (!history) return Effect.void;
		const lastSaved = yield* SynchronizedRef.make(loaded);
		// Async filesystem writes outlive interruption; hold the writer until
		// the snapshot has finished saving.
		return SynchronizedRef.updateEffect(lastSaved, (saved) =>
			Effect.gen(function* () {
				const snapshot = savedHistory(
					(yield* SubscriptionRef.get(state)).accounts,
				);
				if (Equal.equals(snapshot, saved)) return saved;
				return yield* Effect.suspend(() => history.save(snapshot)).pipe(
					Effect.as(snapshot),
					Effect.catchCause((cause) =>
						Effect.logWarning("Usage history save failed", { cause }).pipe(
							Effect.as(saved),
						),
					),
				);
			}).pipe(Effect.uninterruptible),
		);
	});

const makeRefresh =
	(
		state: UsageStateRef,
		accounts: UsageOptions["accounts"],
		read: ReturnType<typeof readAccount>,
		saveHistory: Effect.Effect<void>,
	): UsageService["refresh"] =>
	({ accountIds, maxAge, wait }) =>
		Effect.gen(function* () {
			const configured = yield* accounts;
			const readings = yield* Effect.forEach(
				[...new Set(accountIds ?? configured.map((account) => account.id))],
				(accountId) =>
					read(
						accountId,
						configured.find((account) => account.id === accountId),
						{ maxAge: Duration.toMillis(maxAge), wait },
					),
				{ concurrency: 8 },
			);
			// Recheck eligibility after reads: account edits can happen in flight.
			const liveIds = new Set((yield* accounts).map((account) => account.id));
			yield* SubscriptionRef.update(state, (current) => ({
				accounts: new Map(
					[...current.accounts].map(([accountId, record]) => [
						accountId,
						liveIds.has(accountId) ? record : retired(record),
					]),
				),
			}));
			yield* saveHistory;
			return accountIds === undefined
				? readings.filter((reading) => liveIds.has(reading.accountId))
				: readings;
		});

const makeReadings = (
	state: UsageStateRef,
	viewers: Ref.Ref<number>,
	wake: Effect.Effect<void>,
) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const subscriptionScope = yield* Effect.scope;
			yield* Effect.acquireRelease(
				Ref.update(viewers, (count) => count + 1),
				() => Ref.update(viewers, (count) => count - 1),
			);
			let initial = true;
			return SubscriptionRef.changes(state).pipe(
				Stream.map(({ accounts }) =>
					[...accounts.values()].flatMap(
						(record) => publishedReading(record) ?? [],
					),
				),
				Stream.changes,
				Stream.tap(() => {
					if (!initial) return Effect.void;
					initial = false;
					// changes has captured the snapshot and joined the update stream
					// before this read can publish, so the snapshot always comes first.
					return Effect.forkIn(wake, subscriptionScope).pipe(Effect.asVoid);
				}),
			);
		}),
	);

/** Read every configured account whose wake has come, while someone is viewing or a plan window is full. */
const makeWake = (
	state: UsageStateRef,
	viewers: Ref.Ref<number>,
	configured: UsageOptions["accounts"],
	refresh: UsageService["refresh"],
) =>
	Effect.gen(function* () {
		const accountIds = (yield* configured).map((account) => account.id);
		const now = yield* Clock.currentTimeMillis;
		const watching = yield* Ref.get(viewers);
		const { accounts } = yield* SubscriptionRef.get(state);
		const due = accountIds.filter((accountId) =>
			shouldWake(accounts.get(accountId) ?? emptyAccountUsage, now, watching),
		);
		if (due.length > 0) yield* refresh({ accountIds: due, maxAge: 0, wait: 0 });
	});

const byOrder =
	(order: readonly string[]) => (a: UsageAccount, b: UsageAccount) => {
		const first = order.indexOf(a.id);
		const second = order.indexOf(b.id);
		return (
			(first === -1 ? order.length : first) -
			(second === -1 ? order.length : second)
		);
	};

const failoverHarness = (
	options: UsageOptions,
	excluding: string,
	accounts: readonly UsageAccount[],
) =>
	options.accountHarness?.(excluding) ??
	Effect.succeed(accounts.find((account) => account.id === excluding)?.harness);

const makePickFailover =
	(
		options: UsageOptions,
		refresh: UsageService["refresh"],
	): UsageService["pickFailover"] =>
	(excluding, modelId) =>
		Effect.gen(function* () {
			const order: readonly string[] = yield* options.order ??
				Effect.succeed([]);
			const accounts = [...(yield* options.accounts)].sort(byOrder(order));
			const harness = yield* failoverHarness(options, excluding, accounts);
			if (harness === undefined) return undefined;
			for (const account of accounts) {
				if (account.id === excluding || account.harness !== harness) continue;
				const [reading] = yield* refresh({
					accountIds: [account.id],
					maxAge: "30 seconds",
					wait: "5 seconds",
				});
				if (
					reading &&
					accountLimit({
						asker: "automatic",
						modelId,
						reading,
						now: yield* Clock.currentTimeMillis,
					}).kind === "go"
				)
					return account.id;
			}
			return undefined;
		});

const makeUpdate =
	(
		state: UsageStateRef,
		accounts: UsageOptions["accounts"],
		saveInBackground: Effect.Effect<void>,
		schedule: (accountId: string) => Effect.Effect<void>,
	): NonNullable<UsageService["update"]> =>
	(accountId, harness, reading) =>
		Effect.gen(function* () {
			if (
				!(yield* accounts).some(
					(account) => account.id === accountId && account.harness === harness,
				)
			)
				return;
			const readAt = yield* Clock.currentTimeMillis;
			const rescheduled = yield* SubscriptionRef.modify(state, (current) => {
				const record = current.accounts.get(accountId) ?? emptyAccountUsage;
				const next = live(record, reading, { accountId, harness, readAt });
				return [
					next.wakeAt !== record.wakeAt,
					withAccount(current, accountId, next),
				] as const;
			});
			if (rescheduled) yield* schedule(accountId);
			yield* saveInBackground;
		});

export const makeUsage = (options: UsageOptions) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const loaded = yield* (
			options.history?.load ?? Effect.succeed<UsageHistorySnapshot>({})
		).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("Usage history load failed", { cause }).pipe(
					Effect.as<UsageHistorySnapshot>({}),
				),
			),
		);
		const configured = new Set(
			(yield* options.accounts).map((account) => account.id),
		);
		const state = yield* SubscriptionRef.make<UsageState>({
			accounts: new Map(
				Object.entries(loaded).map(([accountId, saved]) => [
					accountId,
					configured.has(accountId)
						? restored(saved)
						: retired(restored(saved)),
				]),
			),
		});
		const saveHistory = yield* makeHistoryWriter(
			state,
			options.history,
			loaded,
		);
		// A live reading's background save may not have run before shutdown.
		yield* Effect.addFinalizer(() => saveHistory);
		const viewers = yield* Ref.make(0);
		const timers = yield* FiberMap.make<string, void>();
		// Settled reads, turn ends and fresh live readings restart their
		// account's timer. It reads wakeAt as it starts, so after racing writes
		// the last restart wins.
		const schedule = (accountId: string) =>
			FiberMap.run(
				timers,
				accountId,
				Effect.gen(function* () {
					const { accounts } = yield* SubscriptionRef.get(state);
					const wakeAt = accounts.get(accountId)?.wakeAt;
					if (wakeAt === undefined) return;
					yield* Effect.sleep(wakeAt - (yield* Clock.currentTimeMillis));
					// Every due account is read, so one added since anyone subscribed
					// is picked up. The wake's own read restarts this timer, so it
					// runs outside it.
					yield* Effect.forkIn(wake, scope);
				}),
			).pipe(Effect.asVoid);
		const refresh = makeRefresh(
			state,
			options.accounts,
			readAccount(state, scope, options.readers, saveHistory, schedule),
			saveHistory,
		);
		const wake = makeWake(state, viewers, options.accounts, refresh);
		return {
			readings: makeReadings(state, viewers, wake),
			update: makeUpdate(
				state,
				options.accounts,
				// Live readings arrive mid-turn; the turn must not wait on the disk.
				Effect.forkIn(saveHistory, scope).pipe(Effect.asVoid),
				schedule,
			),
			latest: (accountId) =>
				SubscriptionRef.get(state).pipe(
					Effect.map(({ accounts }) => accounts.get(accountId)?.reading),
				),
			refresh,
			turnEnded: (accountId) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					yield* SubscriptionRef.update(state, (current) =>
						withAccount(
							current,
							accountId,
							afterTurn(
								current.accounts.get(accountId) ?? emptyAccountUsage,
								now,
							),
						),
					);
					yield* schedule(accountId);
				}),
			pickFailover: makePickFailover(options, refresh),
		} satisfies UsageService;
	});
