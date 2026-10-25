import { Clock, Data, Effect, Scheduler } from "effect";
import type { makeRunnerReceiptStore } from "./runner-receipts.js";

export interface Grant {
	readonly runnerId: string;
	readonly sessionId: string;
}

export interface RunnerIdentity<A> {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly driverKind?: string | undefined;
	readonly pid?: number | undefined;
	readonly startTime?: string | undefined;
	readonly registeredAt?: number | undefined;
	readonly socketPath?: string | undefined;
	readonly ownedRunIds?: readonly string[] | undefined;
	readonly signalled?: boolean | undefined;
	readonly candidate?: boolean | undefined;
	readonly attachmentId?: string | undefined;
	readonly entry?: A | undefined;
}

export type RunnerTag =
	| { readonly _tag: "Starting" | "Live" }
	| { readonly _tag: "Exiting"; readonly reason: "superseded" | "exited" }
	| { readonly _tag: "Retired" };

export interface RunnerRecord<A> {
	identity: RunnerIdentity<A>;
	readonly tag: RunnerTag;
	readonly grant: Grant;
	readonly cleanup?: {
		readonly grant: Grant;
		readonly deadline: number;
		readonly ownedRunIds: readonly string[];
		readonly permitsCleanup: boolean;
		settling: boolean;
	};
	observed: boolean;
	watching: boolean;
}

export class AuthorityUnavailable extends Data.TaggedError(
	"AuthorityUnavailable",
)<{ readonly cause: unknown }> {}

type MutableRecord<A> = {
	-readonly [K in keyof RunnerRecord<A>]: RunnerRecord<A>[K];
};

/** Tags live here. Callers retain the record, so deleting it cannot revive a grant. */
export const makeRunnerAuthority = <A>(
	receipts?: Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>,
) =>
	Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		const records = new Map<string, MutableRecord<A>>();
		const revoke = (
			grant: Grant,
			reason: "superseded" | "exited" | "retired",
			cohort?: { readonly ownedRunIds: readonly string[] },
		) =>
			Effect.gen(function* () {
				const record = records.get(grant.runnerId);
				if (!record || record.grant !== grant)
					return { runnerId: grant.runnerId, sessionId: grant.sessionId };
				if (
					record.cleanup &&
					(reason !== "retired" || record.tag._tag === "Retired")
				)
					return record.cleanup.grant;
				const cleanup = {
					grant: { runnerId: grant.runnerId, sessionId: grant.sessionId },
					deadline: clock.currentTimeMillisUnsafe() + 3_000,
					permitsCleanup: record.tag._tag !== "Starting",
					settling: false,
					ownedRunIds:
						record.tag._tag === "Starting"
							? []
							: [...(cohort?.ownedRunIds ?? [])],
				};
				record.tag =
					reason === "retired"
						? { _tag: "Retired" }
						: { _tag: "Exiting", reason };
				record.cleanup = cleanup;
				record.identity = {
					...record.identity,
					ownedRunIds: cleanup.ownedRunIds,
				};
				// A crash before either this standalone flush or the next seam commit
				// can still re-adopt this process. The window is one commit-permit wait.
				if (receipts)
					yield* receipts.retire({
						...record.identity,
						ownedRunIds: cleanup.ownedRunIds,
						retiredAt: clock.currentTimeMillisUnsafe(),
					});
				return cleanup.grant;
			}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
		const adopt = (
			runners: readonly RunnerIdentity<A>[],
			phase: "starting" | "live",
		) =>
			Effect.gen(function* () {
				// Complete the durable read before granting anything. A failed read
				// defers the whole batch, including registrations without cursor rows.
				const retired = receipts
					? yield* receipts
							.retirements(runners.map((runner) => runner.runnerId))
							.pipe(
								Effect.mapError((cause) => new AuthorityUnavailable({ cause })),
							)
					: [];
				const grants = new Map<string, Grant>();
				const survivors: RunnerRecord<A>[] = [];
				for (const identity of [...runners].sort(
					(a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0),
				)) {
					let record = records.get(identity.runnerId);
					if (
						record &&
						(record.tag._tag === "Retired" || record.tag._tag === "Exiting")
					) {
						survivors.push(record);
						continue;
					}
					const newer =
						phase === "starting" &&
						[...records.values()].some(
							(other) =>
								other !== record &&
								other.identity.sessionId === identity.sessionId &&
								other.tag._tag === "Starting" &&
								(other.identity.registeredAt ?? 0) >=
									(identity.registeredAt ?? 0),
						);
					const tombstone = retired.find(
						(row) => row.runnerId === identity.runnerId,
					);
					if (!record) {
						record = {
							identity: { ...identity, ...(tombstone ?? {}) },
							grant: {
								runnerId: identity.runnerId,
								sessionId: identity.sessionId,
							},
							// A losing discovery is never granted Starting authority. Its
							// durable cohort belongs to the process from the previous daemon.
							tag:
								tombstone || newer
									? { _tag: "Retired" }
									: { _tag: phase === "live" ? "Live" : "Starting" },
							observed: false,
							watching: false,
						};
						records.set(identity.runnerId, record);
					} else {
						if (
							(identity.entry && identity.entry !== record.identity.entry) ||
							(identity.attachmentId &&
								identity.attachmentId !== record.identity.attachmentId)
						)
							record.grant = {
								runnerId: identity.runnerId,
								sessionId: identity.sessionId,
							};
						record.identity = {
							...record.identity,
							...identity,
							entry: identity.entry ?? record.identity.entry,
							...(tombstone ?? {}),
						};
						if (tombstone) record.tag = { _tag: "Retired" };
					}
					if (record.tag._tag === "Retired" || record.tag._tag === "Exiting") {
						survivors.push(record);
						continue;
					}
					const previous = [...records.values()].find(
						(other) =>
							other !== record &&
							other.identity.sessionId === identity.sessionId &&
							(phase === "live"
								? other.tag._tag === "Live"
								: other.tag._tag === "Starting"),
					);
					if (previous) {
						if (
							(previous.identity.registeredAt ?? 0) >
							(identity.registeredAt ?? 0)
						) {
							yield* revoke(record.grant, "retired", {
								ownedRunIds: identity.ownedRunIds ?? [],
							});
							survivors.push(record);
							continue;
						}
						const reason =
							phase === "live" && identity.entry ? "superseded" : "retired";
						yield* revoke(previous.grant, reason, {
							ownedRunIds: previous.identity.ownedRunIds ?? [],
						});
						grants.delete(previous.identity.runnerId);
						if (reason === "retired") survivors.push(previous);
					}
					if (phase === "live" || record.tag._tag !== "Live")
						record.tag = { _tag: phase === "live" ? "Live" : "Starting" };
					grants.set(identity.runnerId, record.grant);
				}
				return { grants, survivors };
			}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
		return { records: records as Map<string, RunnerRecord<A>>, adopt, revoke };
	});
