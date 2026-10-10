import {
	Clock,
	Context,
	Deferred,
	Effect,
	Fiber,
	FiberMap,
	Schedule,
	Stream,
	SubscriptionRef,
} from "effect";
import type { UsageReading } from "../../../contracts/limit-recovery.js";
import type {
	UsageAccount,
	UsageRead,
	UsageReader,
} from "../../../provider/usage-reader.js";

export interface UsageService {
	readonly readings: Stream.Stream<readonly UsageReading[]>;
	readonly refresh: (
		accountIds?: readonly string[],
	) => Effect.Effect<readonly UsageReading[]>;
	readonly turnEnded: (accountId: string) => Effect.Effect<void>;
	readonly pickFailover: (
		excluding: string,
	) => Effect.Effect<string | undefined>;
}

export class Usage extends Context.Tag("Usage")<Usage, UsageService>() {}

export const makeUsage = (options: {
	readonly accounts: Effect.Effect<readonly UsageAccount[]>;
	readonly order?: Effect.Effect<readonly string[]>;
	readonly readers: Readonly<
		Partial<Record<UsageAccount["harness"], UsageReader>>
	>;
}) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const current = yield* SubscriptionRef.make<readonly UsageReading[]>([]);
		const lock = yield* Effect.makeSemaphore(1);
		const subscriberLock = yield* Effect.makeSemaphore(1);
		const turnRefreshes = yield* FiberMap.make<string, void>();
		let subscribers = 0;
		let sampler: Fiber.RuntimeFiber<void> | undefined;
		const inFlight = new Map<string, Deferred.Deferred<UsageReading>>();
		const latest = new Map<string, UsageReading>();
		const read = (accountId: string, accounts: readonly UsageAccount[]) =>
			Effect.gen(function* () {
				const account = accounts.find((account) => account.id === accountId);
				const pending = yield* lock.withPermits(1)(
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							const existing = inFlight.get(accountId);
							if (existing) return existing;
							const pending = yield* Deferred.make<UsageReading>();
							inFlight.set(accountId, pending);
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
								Effect.timeoutTo({
									duration: "5 seconds",
									onTimeout: (): UsageRead => ({
										status: "unknown",
										windows: [],
										reason: "Usage read timed out",
									}),
									onSuccess: (value) => value,
								}),
								Effect.catchAllCause(() =>
									Effect.succeed<UsageRead>({
										status: "unknown",
										windows: [],
										reason: "Usage read failed",
									}),
								),
								Effect.flatMap((reading) =>
									Effect.gen(function* () {
										const value: UsageReading = {
											...reading,
											accountId,
											harness: account?.harness ?? "claude",
											readAt: yield* Clock.currentTimeMillis,
											stale: false,
										};
										// Decisions get the fresh result; only the published
										// readings keep showing the last good one, marked stale.
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
							return pending;
						}),
					),
				);
				return yield* Deferred.await(pending);
			});
		const refresh: UsageService["refresh"] = (accountIds) =>
			Effect.gen(function* () {
				const accounts = yield* options.accounts;
				const readings = yield* Effect.forEach(
					[...new Set(accountIds ?? accounts.map((account) => account.id))],
					(accountId) => read(accountId, accounts),
					{ concurrency: 8 },
				);
				// Publish the latest completed reads, including a newer overlapping
				// refresh, so a slow batch cannot replace a fresh account reading.
				yield* SubscriptionRef.set(current, [...latest.values()]);
				return readings;
			});
		const readings = Stream.unwrapScoped(
			Effect.gen(function* () {
				const subscriptionScope = yield* Effect.scope;
				yield* Effect.acquireRelease(
					subscriberLock.withPermits(1)(
						Effect.gen(function* () {
							subscribers++;
							if (subscribers === 1)
								sampler = yield* Effect.forkIn(
									refresh().pipe(
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
				return current.changes.pipe(
					Stream.tap(() => {
						if (!initial) return Effect.void;
						initial = false;
						// changes has captured the snapshot and joined the update stream
						// before this read can publish, so the snapshot always comes first.
						return Effect.forkIn(refresh(), subscriptionScope).pipe(
							Effect.asVoid,
						);
					}),
				);
			}),
		);
		// Only a viewer needs the fresh numbers; its subscription reads on join.
		const turnEnded: UsageService["turnEnded"] = (accountId) =>
			subscribers === 0
				? Effect.void
				: FiberMap.run(
						turnRefreshes,
						accountId,
						Effect.sleep("10 seconds").pipe(
							Effect.zipRight(refresh([accountId])),
							Effect.asVoid,
						),
					).pipe(Effect.asVoid);
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
				for (const account of accounts) {
					if (account.id === excluding) continue;
					const [reading] = yield* refresh([account.id]);
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
			refresh,
			turnEnded,
			pickFailover,
		} satisfies UsageService;
	});
