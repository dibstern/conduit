import {
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Fiber,
	FiberMap,
	Schedule,
	Schema,
	Semaphore,
	Stream,
	SubscriptionRef,
} from "effect";
import {
	type UsageForecast,
	type UsageHistoryPoint,
	UsageHistoryPointSchema,
	type UsageReading,
} from "../../../contracts/limit-recovery.js";
import type {
	UsageAccount,
	UsageRead,
	UsageReader,
} from "../../../provider/usage-reader.js";

export interface UsageService {
	readonly setCursorKeychain?: (
		accountId: string,
		enabled: boolean,
	) => Effect.Effect<{ enabled: boolean; reason?: string }>;
	readonly readings: Stream.Stream<readonly UsageReading[]>;
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
	}),
);
export type UsageHistorySnapshot = typeof UsageHistorySnapshotSchema.Type;

export function forecastUsage(
	points: readonly UsageHistoryPoint[],
	latest: number,
	resetsAt: number | undefined,
	now: number,
): UsageForecast | undefined {
	const first = points[0];
	const last = points.at(-1);
	if (
		resetsAt === undefined ||
		!Number.isFinite(resetsAt) ||
		resetsAt <= now ||
		points.length < 3 ||
		!first ||
		!last ||
		last.at - first.at < 15 * 60_000 ||
		latest >= 100
	)
		return undefined;
	// Center time offsets to avoid cancellation with epoch-sized timestamps.
	const meanAt =
		points.reduce((sum, point) => sum + (point.at - first.at), 0) /
		points.length;
	const meanUtilization =
		points.reduce((sum, point) => sum + point.utilization, 0) / points.length;
	let covariance = 0;
	let variance = 0;
	for (const point of points) {
		const offset = point.at - first.at - meanAt;
		covariance += offset * (point.utilization - meanUtilization);
		variance += offset * offset;
	}
	const slope = covariance / variance;
	if (slope <= 0) return { kind: "under", atReset: Math.round(latest) };
	const projected = latest + slope * (resetsAt - last.at);
	return projected >= 100
		? { kind: "runs_out", at: last.at + (100 - latest) / slope }
		: { kind: "under", atReset: Math.round(projected) };
}

export const makeUsage = (options: {
	readonly accounts: Effect.Effect<readonly UsageAccount[]>;
	readonly accountHarness?: (
		accountId: string,
	) => Effect.Effect<UsageAccount["harness"] | undefined>;
	readonly order?: Effect.Effect<readonly string[]>;
	readonly readers: Readonly<
		Partial<Record<UsageAccount["harness"], UsageReader>>
	>;
	readonly history?: {
		readonly load: Effect.Effect<UsageHistorySnapshot, unknown>;
		readonly save: (
			snapshot: UsageHistorySnapshot,
		) => Effect.Effect<void, unknown>;
	};
}) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const historyStore = options.history;
		let history = yield* (
			historyStore?.load ?? Effect.succeed<UsageHistorySnapshot>({})
		).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("Usage history load failed", { cause }).pipe(
					Effect.as<UsageHistorySnapshot>({}),
				),
			),
		);
		let savedHistory = history;
		const historySaveLock = yield* Semaphore.make(1);
		const current = yield* SubscriptionRef.make<readonly UsageReading[]>([]);
		const lock = yield* Semaphore.make(1);
		const subscriberLock = yield* Semaphore.make(1);
		const turnRefreshes = yield* FiberMap.make<string, void>();
		let subscribers = 0;
		let sampler: Fiber.Fiber<void> | undefined;
		const inFlight = new Map<string, Deferred.Deferred<UsageReading>>();
		const latest = new Map<string, UsageReading>();
		const attemptedAt = new Map<string, number>();
		const read = (
			accountId: string,
			accounts: readonly UsageAccount[],
			maxAge: Duration.Input,
		) =>
			Effect.gen(function* () {
				const account = accounts.find((account) => account.id === accountId);
				const result = yield* lock.withPermits(1)(
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const existing = inFlight.get(accountId);
							if (existing) return Deferred.await(existing);
							const now = yield* Clock.currentTimeMillis;
							const cached = latest.get(accountId);
							const lastAttempt = attemptedAt.get(accountId);
							if (
								cached &&
								lastAttempt !== undefined &&
								now - lastAttempt < Duration.toMillis(maxAge)
							)
								return Effect.succeed(cached);
							const pending = yield* Deferred.make<UsageReading>();
							inFlight.set(accountId, pending);
							attemptedAt.set(accountId, now);
							const reading = Effect.suspend(() => {
								const reader = account && options.readers[account.harness];
								return account && reader
									? reader.read(account)
									: Effect.succeed<UsageRead>({
											status: "unavailable",
											windows: [],
											reason: account
												? "Usage reader is not available for this harness"
												: "Claude account is not configured",
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
								Effect.flatMap((reading) =>
									Effect.gen(function* () {
										const readAt = yield* Clock.currentTimeMillis;
										const windows =
											reading.status === "available" ||
											reading.status === "limited"
												? reading.windows.map((window) => {
														if (
															window.kind !== "five_hour" &&
															window.kind !== "seven_day"
														)
															return window;
														const parsedReset =
															window.resetsAt === undefined
																? undefined
																: Date.parse(window.resetsAt);
														const resetsAt =
															parsedReset !== undefined &&
															Number.isFinite(parsedReset)
																? parsedReset
																: undefined;
														const previous = history[accountId]?.[window.kind];
														const last = previous?.points.at(-1);
														const reset =
															// Claude recomputes resets_at per request, so only a
															// move of more than a few minutes is a new window.
															(resetsAt !== undefined &&
																previous?.resetsAt !== undefined &&
																resetsAt - previous.resetsAt > 10 * 60_000) ||
															(last !== undefined &&
																window.utilization < last.utilization);
														const points = [
															...(reset ? [] : (previous?.points ?? [])),
															{ at: readAt, utilization: window.utilization },
														].slice(-2016);
														const seriesReset = resetsAt ?? previous?.resetsAt;
														history = {
															...history,
															[accountId]: {
																...history[accountId],
																[window.kind]: {
																	points,
																	...(seriesReset === undefined
																		? {}
																		: { resetsAt: seriesReset }),
																},
															},
														};
														const forecast = forecastUsage(
															points,
															window.utilization,
															resetsAt,
															readAt,
														);
														return {
															...window,
															// Evenly spaced transport samples, including both ends.
															history:
																points.length <= 48
																	? points
																	: Array.from(
																			{ length: 48 },
																			(_, i) => i,
																		).flatMap(
																			(i) =>
																				points[
																					Math.round(
																						(i * (points.length - 1)) / 47,
																					)
																				] ?? [],
																		),
															...(forecast === undefined ? {} : { forecast }),
														};
													})
												: reading.windows;
										const value: UsageReading = {
											...reading,
											windows,
											accountId,
											harness: account?.harness ?? "claude",
											readAt,
											stale: false,
										};
										const previous = latest.get(accountId);
										if (
											value.status === "available" ||
											value.status === "limited"
										) {
											for (const window of value.windows) {
												const prior = previous?.windows.find(
													(candidate) =>
														candidate.kind === window.kind &&
														(candidate.kind !== "seven_day_model" ||
															(window.kind === "seven_day_model" &&
																candidate.model === window.model)),
												);
												if (
													window.utilization < 100 &&
													prior &&
													prior.utilization >= 100 &&
													prior.resetsAt &&
													Date.parse(prior.resetsAt) > readAt
												)
													yield* Effect.logInfo(
														"Usage window free before reset",
														{
															accountId,
															window: window.kind,
															...(window.kind === "seven_day_model"
																? { model: window.model }
																: {}),
															resetsAt: prior.resetsAt,
														},
													);
											}
										}
										// A failed attempt returns unknown to its caller. The cache
										// and subscribers retain the last reading, marked stale.
										yield* Effect.sync(() => {
											const previous = latest.get(accountId);
											latest.set(
												accountId,
												value.status === "unknown" && previous
													? { ...previous, stale: true }
													: value,
											);
											inFlight.delete(accountId);
										});
										yield* Deferred.succeed(pending, value);
									}),
								),
								Effect.ensuring(
									Effect.sync(() => {
										if (inFlight.get(accountId) === pending)
											inFlight.delete(accountId);
									}),
								),
							);
							yield* Effect.forkIn(restore(reading), scope);
							return Deferred.await(pending);
						}),
					),
				);
				return yield* result;
			});
		const refresh: UsageService["refresh"] = ({ accountIds, maxAge }) =>
			Effect.gen(function* () {
				const accounts = yield* options.accounts;
				const readings = yield* Effect.forEach(
					[...new Set(accountIds ?? accounts.map((account) => account.id))],
					(accountId) => read(accountId, accounts, maxAge),
					{ concurrency: 8 },
				);
				// Publish the latest completed reads, including a newer overlapping
				// refresh, so a slow batch cannot replace a fresh account reading.
				// Recheck eligibility after reads: account edits can happen in flight.
				const liveIds = new Set(
					(yield* options.accounts).map((account) => account.id),
				);
				for (const id of latest.keys()) {
					if (!liveIds.has(id)) {
						latest.delete(id);
						attemptedAt.delete(id);
					}
				}
				yield* SubscriptionRef.set(current, [...latest.values()]);
				if (historyStore)
					yield* historySaveLock.withPermits(1)(
						Effect.gen(function* () {
							if (history === savedHistory) return;
							const snapshot = history;
							yield* Effect.suspend(() => historyStore.save(snapshot)).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										savedHistory = snapshot;
									}),
								),
								Effect.catchCause((cause) =>
									Effect.logWarning("Usage history save failed", { cause }),
								),
								// Async filesystem writes outlive interruption; retain the
								// permit until the snapshot has finished saving.
								Effect.uninterruptible,
							);
						}),
					);
				return accountIds === undefined
					? readings.filter((reading) => liveIds.has(reading.accountId))
					: readings;
			});
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
				return SubscriptionRef.changes(current).pipe(
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
		// A successful turn can clear a full reading even without a viewer.
		const turnEnded: UsageService["turnEnded"] = (accountId) =>
			Effect.suspend(() =>
				subscribers === 0 &&
				!latest
					.get(accountId)
					?.windows.some(
						(window) =>
							(window.kind === "five_hour" || window.kind === "seven_day") &&
							window.utilization >= 100,
					)
					? Effect.void
					: FiberMap.run(
							turnRefreshes,
							accountId,
							Effect.sleep("10 seconds").pipe(
								Effect.andThen(refresh({ accountIds: [accountId], maxAge: 0 })),
								Effect.asVoid,
							),
						).pipe(Effect.asVoid),
			);
		const pickFailover: UsageService["pickFailover"] = (excluding) =>
			Effect.gen(function* () {
				const order: readonly string[] = yield* options.order ??
					Effect.succeed([]);
				const accounts = [...(yield* options.accounts)].sort((a, b) => {
					const first = order.indexOf(a.id);
					const second = order.indexOf(b.id);
					return (
						(first === -1 ? order.length : first) -
						(second === -1 ? order.length : second)
					);
				});
				const harness = yield* options.accountHarness?.(excluding) ??
					Effect.succeed(
						accounts.find((account) => account.id === excluding)?.harness,
					);
				if (harness === undefined) return undefined;
				for (const account of accounts) {
					if (account.id === excluding || account.harness !== harness) continue;
					const [reading] = yield* refresh({
						accountIds: [account.id],
						maxAge: "30 seconds",
					});
					if (
						reading &&
						reading.status !== "limited" &&
						reading.status !== "unavailable"
					)
						return account.id;
				}
				return undefined;
			});
		return {
			readings,
			latest: (accountId) => Effect.sync(() => latest.get(accountId)),
			refresh,
			turnEnded,
			pickFailover,
		} satisfies UsageService;
	});
