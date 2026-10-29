import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Equal,
	Fiber,
	FiberMap,
	Schedule,
	Schema,
	type Scope,
	Semaphore,
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
} from "./account-usage.js";

export { forecastUsage } from "./usage-forecast.js";

export interface UsageService {
	readonly setCursorKeychain?: (
		accountId: string,
		enabled: boolean,
	) => Effect.Effect<{ enabled: boolean; reason?: string }>;
	readonly readings: Stream.Stream<readonly UsageReading[]>;
	/** Merge a provider's sparse live windows into the account sampler's stream. */
	readonly update?: (
		accountId: string,
		harness: UsageHarness,
		reading: UsageRead,
	) => Effect.Effect<void>;
	/** The latest completed reading, without probing or starting the sampler. */
	readonly latest: (
		accountId: string,
	) => Effect.Effect<UsageReading | undefined>;
	readonly refresh: (options: {
		readonly accountIds?: readonly string[];
		readonly maxAge: Duration.Input;
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
	/** Bumped where the readings stream publishes: a refresh's end and a live update. */
	readonly published: number;
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
			duration: "5 seconds",
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
		account: UsageAccount,
		result: Deferred.Deferred<UsageReading>,
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
					});
					return [
						{ previous: record.reading, reading: settled.reading },
						withAccount(current, account.id, settled.record),
					];
				},
			);
			for (const freed of freedBeforeReset(previous, reading))
				yield* Effect.logInfo("Usage window free before reset", {
					accountId: account.id,
					...freed,
				});
			yield* Deferred.succeed(result, reading);
		});

const readAccount =
	(
		state: UsageStateRef,
		scope: Scope.Scope,
		readers: UsageOptions["readers"],
	) =>
	(accountId: string, account: UsageAccount | undefined, maxAge: number) =>
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
										Effect.flatMap(settleRead(state, account, pending)),
									),
								),
								scope,
							);
						return yield* restore(Deferred.await(decision.result));
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
	({ accountIds, maxAge }) =>
		Effect.gen(function* () {
			const configured = yield* accounts;
			const readings = yield* Effect.forEach(
				[...new Set(accountIds ?? configured.map((account) => account.id))],
				(accountId) =>
					read(
						accountId,
						configured.find((account) => account.id === accountId),
						Duration.toMillis(maxAge),
					),
				{ concurrency: 8 },
			);
			// Publish the latest completed reads, including a newer overlapping
			// refresh, so a slow batch cannot replace a fresh account reading.
			// Recheck eligibility after reads: account edits can happen in flight.
			const liveIds = new Set((yield* accounts).map((account) => account.id));
			yield* SubscriptionRef.update(state, (current) => ({
				accounts: new Map(
					[...current.accounts].map(([accountId, record]) => [
						accountId,
						liveIds.has(accountId) ? record : retired(record),
					]),
				),
				published: current.published + 1,
			}));
			yield* saveHistory;
			return accountIds === undefined
				? readings.filter((reading) => liveIds.has(reading.accountId))
				: readings;
		});

const makeReadings = (
	state: UsageStateRef,
	scope: Scope.Scope,
	refresh: UsageService["refresh"],
) =>
	Effect.gen(function* () {
		const subscriberLock = yield* Semaphore.make(1);
		let subscribers = 0;
		let sampler: Fiber.Fiber<void> | undefined;
		const readings = Stream.unwrap(
			Effect.gen(function* () {
				const subscriptionScope = yield* Effect.scope;
				yield* Effect.acquireRelease(
					subscriberLock.withPermits(1)(
						Effect.gen(function* () {
							subscribers++;
							if (subscribers === 1)
								sampler = yield* Effect.forkIn(
									refresh({ maxAge: "5 minutes" }).pipe(
										Effect.schedule(Schedule.fixed("5 minutes")),
										Effect.asVoid,
										Effect.interruptible,
									),
									scope,
								);
						}),
					),
					() =>
						subscriberLock.withPermits(1)(
							Effect.gen(function* () {
								subscribers--;
								if (subscribers === 0 && sampler) {
									yield* Fiber.interrupt(sampler);
									sampler = undefined;
								}
							}),
						),
				);
				let initial = true;
				return SubscriptionRef.changes(state).pipe(
					Stream.changesWith((a, b) => a.published === b.published),
					Stream.map(({ accounts }) =>
						[...accounts.values()].flatMap(
							(record) => publishedReading(record) ?? [],
						),
					),
					Stream.tap(() => {
						if (!initial) return Effect.void;
						initial = false;
						// changes has captured the snapshot and joined the update stream
						// before this read can publish, so the snapshot always comes first.
						return Effect.forkIn(
							refresh({ maxAge: "5 minutes" }),
							subscriptionScope,
						).pipe(Effect.asVoid);
					}),
				);
			}),
		);
		return { readings, viewers: () => subscribers };
	});

const makeTurnEnded = (
	state: UsageStateRef,
	viewers: () => number,
	refresh: UsageService["refresh"],
) =>
	Effect.gen(function* () {
		const timers = yield* FiberMap.make<string, void>();
		// The timer carries out the record's wakeAt; a later wakeAt replaces it.
		const wake = (accountId: string, wakeAt: number) =>
			Effect.gen(function* () {
				yield* Effect.sleep(wakeAt - (yield* Clock.currentTimeMillis));
				const due = yield* SubscriptionRef.modify(state, (current) => {
					const record = current.accounts.get(accountId);
					return record?.wakeAt === wakeAt
						? [
								shouldWake(record, viewers()),
								withAccount(current, accountId, {
									...record,
									wakeAt: undefined,
								}),
							]
						: [false, current];
				});
				if (due) yield* refresh({ accountIds: [accountId], maxAge: 0 });
			});
		const turnEnded: UsageService["turnEnded"] = (accountId) =>
			Effect.gen(function* () {
				const wakeAt = afterTurn(yield* Clock.currentTimeMillis);
				yield* SubscriptionRef.update(state, (current) =>
					withAccount(current, accountId, {
						...(current.accounts.get(accountId) ?? emptyAccountUsage),
						wakeAt,
					}),
				);
				yield* FiberMap.run(timers, accountId, wake(accountId, wakeAt));
			});
		return turnEnded;
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
			yield* SubscriptionRef.update(state, (current) => ({
				...withAccount(
					current,
					accountId,
					live(current.accounts.get(accountId) ?? emptyAccountUsage, reading, {
						accountId,
						harness,
						readAt,
					}),
				),
				published: current.published + 1,
			}));
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
			published: 0,
		});
		const saveHistory = yield* makeHistoryWriter(
			state,
			options.history,
			loaded,
		);
		// A live reading's background save may not have run before shutdown.
		yield* Effect.addFinalizer(() => saveHistory);
		const refresh = makeRefresh(
			state,
			options.accounts,
			readAccount(state, scope, options.readers),
			saveHistory,
		);
		const { readings, viewers } = yield* makeReadings(state, scope, refresh);
		return {
			readings,
			update: makeUpdate(
				state,
				options.accounts,
				// Live readings arrive mid-turn; the turn must not wait on the disk.
				Effect.forkIn(saveHistory, scope).pipe(Effect.asVoid),
			),
			latest: (accountId) =>
				SubscriptionRef.get(state).pipe(
					Effect.map(({ accounts }) => {
						const record = accounts.get(accountId);
						return record && publishedReading(record);
					}),
				),
			refresh,
			turnEnded: yield* makeTurnEnded(state, viewers, refresh),
			pickFailover: makePickFailover(options, refresh),
		} satisfies UsageService;
	});
