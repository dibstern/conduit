import { Clock, Data, Effect, Option, Scheduler } from "effect";
import {
	currentRunnerWriteOrigin,
	currentWriteAuthorization,
	MissingWriteAuthorization,
} from "../../persistence/effect/commit-and-signal.js";
import type { makeRunnerReceiptStore } from "./runner-receipts.js";

const grantTypeId = Symbol("RunnerGrant");
const authorizedTypeId = Symbol("AuthorizedWrite");

interface GrantIdentity {
	readonly [grantTypeId]: boolean;
	readonly runnerId: string;
	readonly sessionId: string;
}

export interface StartingGrant extends GrantIdentity {
	readonly _tag: "Starting";
}
export interface LiveGrant extends GrantIdentity {
	readonly _tag: "Live";
}
export interface CohortTarget {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly ownedRunIds: readonly string[];
}
export interface CleanupGrant extends GrantIdentity {
	readonly _tag: "Cleanup";
	readonly target: CohortTarget;
	readonly expiresAt: number;
}
export type Grant = StartingGrant | LiveGrant | CleanupGrant;
export type Write =
	| { readonly kind: "output" }
	| { readonly kind: "cleanup" }
	| { readonly kind: "evidence" };
export interface AuthorizedWrite {
	readonly [authorizedTypeId]: boolean;
	readonly grant: Grant;
	readonly write: Write;
}

export interface RunnerIdentity<A> {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly pid: number | undefined;
	readonly startTime: string | undefined;
	readonly registeredAt: number;
	readonly socketPath: string | undefined;
	readonly ownedRunIds: readonly string[];
	readonly signalled: boolean;
	readonly attachmentId: string | undefined;
	readonly entry: A | undefined;
}
type Registration<A> = Pick<RunnerIdentity<A>, "runnerId" | "sessionId"> &
	Partial<Omit<RunnerIdentity<A>, "runnerId" | "sessionId">>;

interface RecordBase<A> {
	readonly identity: RunnerIdentity<A>;
	readonly observation: "Pending" | "Observed";
	readonly watcher: "Idle" | "Watching";
}
interface CleanupBase {
	readonly grant: CleanupGrant;
	readonly deadline: number;
	readonly ownedRunIds: readonly string[];
}
type Cleanup = CleanupBase &
	(
		| { readonly _tag: "Unavailable" }
		| { readonly _tag: "Ready" }
		| { readonly _tag: "Settling" }
	);
export interface Starting<A> extends RecordBase<A> {
	readonly tag: { readonly _tag: "Starting" };
	readonly grant: StartingGrant;
	readonly cleanup?: never;
}
export interface Live<A> extends RecordBase<A> {
	readonly tag: { readonly _tag: "Live" };
	readonly grant: LiveGrant;
	readonly cleanup?: never;
}
export interface Exiting<A> extends RecordBase<A> {
	readonly tag: {
		readonly _tag: "Exiting";
		readonly reason: "superseded" | "exited";
	};
	readonly grant: StartingGrant | LiveGrant;
	readonly cleanup: Cleanup;
}
export interface Retired<A> extends RecordBase<A> {
	readonly tag: { readonly _tag: "Retired" };
	readonly grant: StartingGrant | LiveGrant;
	readonly cleanup: Cleanup;
}
export type RunnerRecord<A> = Starting<A> | Live<A> | Exiting<A> | Retired<A>;
export type RunnerTag = RunnerRecord<never>["tag"];
type Revocation = "superseded" | "exited" | "retired";
type GrantState =
	| {
			readonly phase:
				| "starting"
				| "live"
				| "detached-starting"
				| "detached-live"
				| "forgotten";
	  }
	| { readonly phase: Revocation; readonly cleanup: CleanupGrant }
	| { readonly phase: "cleanup" | "cancelled-cleanup" };

export class AuthorityUnavailable extends Data.TaggedError(
	"AuthorityUnavailable",
)<{
	readonly cause: unknown;
}> {}

/** This module owns records and capabilities; callers only receive frozen snapshots. */
export const makeRunnerAuthority = <A>(
	receipts?: Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>,
) =>
	Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		const records = new Map<string, RunnerRecord<A>>();
		const grants = new WeakMap<Grant, GrantState>();
		const dropped = new Set<string>();
		const normalize = (identity: Registration<A>): RunnerIdentity<A> =>
			Object.freeze({
				runnerId: identity.runnerId,
				sessionId: identity.sessionId,
				driverKind: identity.driverKind ?? "claude",
				pid: identity.pid,
				startTime: identity.startTime,
				registeredAt: identity.registeredAt ?? 0,
				socketPath: identity.socketPath,
				ownedRunIds: Object.freeze([...(identity.ownedRunIds ?? [])]),
				signalled: identity.signalled ?? false,
				attachmentId: identity.attachmentId,
				entry: identity.entry,
			});
		const save = (record: RunnerRecord<A>) => {
			Object.freeze(record.tag);
			if (record.cleanup) Object.freeze(record.cleanup);
			const snapshot = Object.freeze(record);
			records.set(record.identity.runnerId, snapshot);
			return snapshot;
		};
		const mintStarting = (identity: RunnerIdentity<A>): StartingGrant => {
			const grant: StartingGrant = Object.freeze({
				[grantTypeId]: true,
				_tag: "Starting",
				runnerId: identity.runnerId,
				sessionId: identity.sessionId,
			});
			grants.set(grant, { phase: "starting" });
			return grant;
		};
		const mintLive = (identity: RunnerIdentity<A>): LiveGrant => {
			const grant: LiveGrant = Object.freeze({
				[grantTypeId]: true,
				_tag: "Live",
				runnerId: identity.runnerId,
				sessionId: identity.sessionId,
			});
			grants.set(grant, { phase: "live" });
			return grant;
		};
		const cleanupFor = (
			grant: Grant,
			ownedRunIds: readonly string[],
		): CleanupGrant => {
			const state = grants.get(grant);
			const previous = state && "cleanup" in state ? state.cleanup : undefined;
			if (previous) return previous;
			const permitsCleanup =
				state?.phase === "live" || state?.phase === "detached-live";
			const cleanup: CleanupGrant = Object.freeze({
				[grantTypeId]: true,
				_tag: "Cleanup",
				runnerId: grant.runnerId,
				sessionId: grant.sessionId,
				target: Object.freeze({
					runnerId: grant.runnerId,
					sessionId: grant.sessionId,
					ownedRunIds: Object.freeze(permitsCleanup ? [...ownedRunIds] : []),
				}),
				expiresAt: clock.currentTimeMillisUnsafe() + 3_000,
			});
			if (grants.has(grant))
				grants.set(cleanup, {
					phase: permitsCleanup ? "cleanup" : "cancelled-cleanup",
				});
			return cleanup;
		};
		const authorize = (
			grant: Grant,
			write: Write,
			now: number,
		): Option.Option<AuthorizedWrite> => {
			const state = grants.get(grant);
			if (!state) return Option.none();
			let allowed = write.kind === "evidence";
			if (write.kind === "output") allowed = state.phase === "live";
			if (write.kind === "cleanup")
				allowed =
					state.phase === "live" ||
					(grant._tag === "Cleanup" &&
						state.phase === "cleanup" &&
						now < grant.expiresAt);
			return allowed
				? Option.some(Object.freeze({ [authorizedTypeId]: true, grant, write }))
				: Option.none();
		};
		const logDropped = (grant: Grant, write: Write) =>
			Effect.suspend(() => {
				const key = `${grant.runnerId}:${write.kind}`;
				if (dropped.has(key)) return Effect.void;
				dropped.add(key);
				return Effect.logWarning(
					`Dropped stale runner write: runnerId=${grant.runnerId} kind=${write.kind}`,
				);
			});
		const guarded = <B, E = never, R = never>(
			grant: Grant | undefined,
			write: Write,
			op: Effect.Effect<B, E, R> | (() => B),
		): Effect.Effect<Option.Option<B>, E, R> =>
			Effect.suspend(() => {
				if (!grant)
					return Effect.die(
						new MissingWriteAuthorization({ runnerId: "unadopted" }),
					);
				if (typeof op === "function")
					return Effect.sync(() =>
						Option.isSome(
							authorize(grant, write, clock.currentTimeMillisUnsafe()),
						)
							? Option.some(op())
							: Option.none<B>(),
					).pipe(
						Effect.tap((result) =>
							Option.isNone(result) ? logDropped(grant, write) : Effect.void,
						),
					);
				const stale = {};
				let rejected = false;
				const check = Effect.suspend(() => {
					if (
						Option.isSome(
							authorize(grant, write, clock.currentTimeMillisUnsafe()),
						)
					)
						return Effect.void;
					rejected = true;
					return Effect.die(stale);
				});
				return check.pipe(
					Effect.andThen(op),
					Effect.provideService(currentWriteAuthorization, {
						runnerId: grant.runnerId,
						check,
						guarded: (operation) => guarded(grant, write, operation),
					}),
					Effect.provideService(currentRunnerWriteOrigin, grant.runnerId),
					Effect.provideService(Scheduler.PreventSchedulerYield, true),
					Effect.flatMap((value) =>
						rejected
							? logDropped(grant, write).pipe(Effect.as(Option.none<B>()))
							: Effect.succeed(Option.some(value)),
					),
					Effect.catchDefect((defect) =>
						defect === stale
							? logDropped(grant, write).pipe(Effect.as(Option.none<B>()))
							: Effect.die(defect),
					),
				);
			});
		const revoke = (
			grant: Grant,
			reason: Revocation,
			cohort?: { readonly ownedRunIds: readonly string[] },
		) =>
			Effect.gen(function* () {
				if (grant._tag === "Cleanup") return grant;
				const existing = grants.get(grant);
				const previousCleanup =
					existing && "cleanup" in existing ? existing.cleanup : undefined;
				const record = records.get(grant.runnerId);
				if (
					previousCleanup &&
					(reason !== "retired" ||
						record?.tag._tag === "Retired" ||
						record?.grant !== grant)
				)
					return previousCleanup;
				const cleanup =
					previousCleanup ?? cleanupFor(grant, cohort?.ownedRunIds ?? []);
				if (!existing) return cleanup;
				grants.set(grant, {
					phase: reason,
					cleanup,
				});
				if (!record || record.grant !== grant) return cleanup;
				const revokedBase = {
					identity: normalize({
						...record.identity,
						ownedRunIds: cleanup.target.ownedRunIds,
					}),
					observation: record.observation,
					watcher: record.watcher,
					grant,
					cleanup: {
						grant: cleanup,
						deadline: cleanup.expiresAt,
						ownedRunIds: cleanup.target.ownedRunIds,
						_tag:
							grants.get(cleanup)?.phase === "cleanup"
								? (record.cleanup?._tag ?? "Ready")
								: "Unavailable",
					} satisfies Cleanup,
				};
				const revoked =
					reason === "retired"
						? save({ ...revokedBase, tag: { _tag: "Retired" } })
						: save({ ...revokedBase, tag: { _tag: "Exiting", reason } });
				if (receipts)
					yield* receipts.retire({
						...revoked.identity,
						retiredAt: clock.currentTimeMillisUnsafe(),
					});
				return cleanup;
			}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
		const isStarting = (record: RunnerRecord<A>): record is Starting<A> =>
			record.tag._tag === "Starting";
		const hasCleanup = (
			record: RunnerRecord<A>,
		): record is Exiting<A> | Retired<A> =>
			record.tag._tag === "Exiting" || record.tag._tag === "Retired";
		const promote = (record: Starting<A>): Live<A> => ({
			...record,
			tag: { _tag: "Live" },
			grant: mintLive(record.identity),
		});
		const adopt = (
			runners: readonly Registration<A>[],
			phase: "starting" | "live",
		) =>
			Effect.gen(function* () {
				const retired = receipts
					? yield* receipts
							.retirements(runners.map((runner) => runner.runnerId))
							.pipe(
								Effect.mapError((cause) => new AuthorityUnavailable({ cause })),
							)
					: [];
				const adopted = new Map<string, Grant>();
				const survivors: RunnerRecord<A>[] = [];
				for (const registration of [...runners].sort(
					(a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0),
				)) {
					let record = records.get(registration.runnerId);
					if (
						record?.tag._tag === "Retired" ||
						record?.tag._tag === "Exiting"
					) {
						survivors.push(record);
						continue;
					}
					const tombstone = retired.find(
						(row) => row.runnerId === registration.runnerId,
					);
					const newer =
						phase === "starting" &&
						[...records.values()].some(
							(other) =>
								other !== record &&
								other.identity.sessionId === registration.sessionId &&
								other.tag._tag === "Starting" &&
								other.identity.registeredAt >= (registration.registeredAt ?? 0),
						);
					const identity = normalize({
						...record?.identity,
						...registration,
						entry: registration.entry ?? record?.identity.entry,
						...tombstone,
					});
					if (!record)
						record = save(
							phase === "live" || tombstone || newer
								? {
										identity,
										tag: { _tag: "Live" },
										grant: mintLive(identity),
										observation: "Pending",
										watcher: "Idle",
									}
								: {
										identity,
										tag: { _tag: "Starting" },
										grant: mintStarting(identity),
										observation: "Pending",
										watcher: "Idle",
									},
						);
					else {
						const changed =
							(registration.entry &&
								registration.entry !== record.identity.entry) ||
							(registration.attachmentId &&
								registration.attachmentId !== record.identity.attachmentId);
						if (changed) {
							const cleanup = cleanupFor(
								record.grant,
								record.identity.ownedRunIds,
							);
							grants.set(record.grant, {
								phase: "superseded",
								cleanup,
							});
							const base = {
								identity,
								observation: record.observation,
								watcher: record.watcher,
							};
							record =
								record.tag._tag === "Live"
									? save({
											...base,
											tag: { _tag: "Live" },
											grant: mintLive(identity),
										})
									: save({
											...base,
											tag: { _tag: "Starting" },
											grant: mintStarting(identity),
										});
						} else record = save({ ...record, identity });
					}
					if (tombstone || newer) {
						yield* revoke(record.grant, "retired", {
							ownedRunIds: identity.ownedRunIds,
						});
						const survivor = records.get(identity.runnerId);
						if (survivor) survivors.push(survivor);
						continue;
					}
					const previous = [...records.values()].find(
						(other) =>
							other !== record &&
							other.identity.sessionId === identity.sessionId &&
							other.tag._tag === (phase === "live" ? "Live" : "Starting"),
					);
					if (previous) {
						if (previous.identity.registeredAt > identity.registeredAt) {
							yield* revoke(record.grant, "retired", {
								ownedRunIds: identity.ownedRunIds,
							});
							const survivor = records.get(identity.runnerId);
							if (survivor) survivors.push(survivor);
							continue;
						}
						const reason =
							phase === "live" && identity.entry ? "superseded" : "retired";
						yield* revoke(previous.grant, reason, {
							ownedRunIds: previous.identity.ownedRunIds,
						});
						adopted.delete(previous.identity.runnerId);
						const survivor = records.get(previous.identity.runnerId);
						if (reason === "retired" && survivor) survivors.push(survivor);
					}
					if (phase === "live" && isStarting(record))
						record = save(promote(record));
					adopted.set(identity.runnerId, record.grant);
				}
				return { grants: adopted, survivors };
			}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
		return {
			get records(): ReadonlyMap<string, RunnerRecord<A>> {
				return new Map(records);
			},
			adopt,
			revoke,
			authorize,
			guarded,
			observe: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record) save({ ...record, observation: "Observed" });
			},
			markSignalled: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record)
					save({
						...record,
						identity: normalize({ ...record.identity, signalled: true }),
					});
			},
			forget: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record) {
					const state = grants.get(record.grant);
					if (state && (state.phase === "starting" || state.phase === "live"))
						grants.set(record.grant, {
							phase: "forgotten",
						});
				}
				return records.delete(runnerId);
			},
			captureBeforeRevoke: (
				runnerId: string,
				evidence: Pick<
					RunnerIdentity<A>,
					"pid" | "startTime" | "ownedRunIds" | "signalled"
				>,
			) => {
				const record = records.get(runnerId);
				if (
					!record ||
					(record.tag._tag !== "Starting" && record.tag._tag !== "Live")
				)
					return false;
				save({
					...record,
					identity: normalize({
						...record.identity,
						pid: evidence.pid,
						startTime: evidence.startTime,
						ownedRunIds: evidence.ownedRunIds,
						signalled: record.identity.signalled || evidence.signalled,
					}),
				});
				return true;
			},
			detach: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record) {
					const state = grants.get(record.grant);
					if (state?.phase === "live" || state?.phase === "starting")
						grants.set(record.grant, {
							phase:
								state.phase === "live" ? "detached-live" : "detached-starting",
						});
					save({
						...record,
						identity: normalize({
							...record.identity,
							entry: undefined,
							attachmentId: undefined,
						}),
					});
				}
			},
			startWatching: (runnerId: string) => {
				const record = records.get(runnerId);
				if (!record || record.watcher === "Watching") return false;
				save({ ...record, watcher: "Watching" });
				return true;
			},
			beginCleanup: (runnerId: string) => {
				const record = records.get(runnerId);
				if (!record || !hasCleanup(record) || record.cleanup._tag !== "Ready")
					return false;
				save({ ...record, cleanup: { ...record.cleanup, _tag: "Settling" } });
				return true;
			},
			finishCleanup: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record && hasCleanup(record) && record.cleanup._tag === "Settling")
					save({ ...record, cleanup: { ...record.cleanup, _tag: "Ready" } });
			},
		};
	});
