import { Data, Effect, Option, Scheduler } from "effect";
import {
	currentRunnerWriteOrigin,
	currentWriteAuthorization,
	MissingWriteAuthorization,
} from "../../persistence/effect/commit-and-signal.js";
import type { ProcessStart } from "./process-table.js";
import type {
	makeRunnerReceiptStore,
	RunnerMember,
	RunnerRetirement,
	RunnerSignal,
	RunnerSignalAttempt,
} from "./runner-receipts.js";

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
export type Grant = StartingGrant | LiveGrant;
export type Write = { readonly kind: "output" } | { readonly kind: "evidence" };
export interface AuthorizedWrite {
	readonly [authorizedTypeId]: boolean;
	readonly grant: Grant;
	readonly write: Write;
}

export interface RunnerIdentity<A>
	extends Partial<{
		[Key in keyof typeof ProcessStart.Encoded]:
			| (typeof ProcessStart.Encoded)[Key]
			| undefined;
	}> {
	readonly runnerId: string;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly pid: number | undefined;
	readonly reaper: RunnerMember | undefined;
	readonly members: readonly RunnerMember[];
	readonly signalLog: readonly RunnerSignalAttempt[];
	readonly registeredAt: number;
	readonly socketPath: string | undefined;
	readonly signalled: boolean;
	readonly signal: RunnerSignal;
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
export interface Starting<A> extends RecordBase<A> {
	readonly tag: { readonly _tag: "Starting" };
	readonly grant: StartingGrant;
}
export interface Live<A> extends RecordBase<A> {
	readonly tag: { readonly _tag: "Live" };
	readonly grant: LiveGrant;
}
export interface Exiting<A> extends RecordBase<A> {
	readonly tag: {
		readonly _tag: "Exiting";
		readonly reason: "superseded" | "exited";
	};
	readonly grant: StartingGrant | LiveGrant;
}
export interface Retired<A> extends RecordBase<A> {
	readonly tag: { readonly _tag: "Retired" };
	readonly grant: StartingGrant | LiveGrant;
}
export type RunnerRecord<A> = Starting<A> | Live<A> | Exiting<A> | Retired<A>;
export type RunnerTag = RunnerRecord<never>["tag"];
type Revocation = "superseded" | "exited" | "retired";
type GrantState = {
	readonly phase:
		| "starting"
		| "live"
		| "stopping"
		| "detached-starting"
		| "detached-live"
		| "forgotten"
		| Revocation;
};

export class AuthorityUnavailable extends Data.TaggedError(
	"AuthorityUnavailable",
)<{
	readonly cause: unknown;
}> {}

/** This module owns records and capabilities; callers only receive frozen snapshots. */
export const makeRunnerAuthority = <A>(
	receipts?: Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>,
	retirement?: (runnerId: string) => RunnerRetirement | undefined,
) =>
	Effect.gen(function* () {
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
				startKey: identity.startKey,
				reaper: identity.reaper
					? Object.freeze({ ...identity.reaper })
					: undefined,
				members: Object.freeze(
					(identity.members ?? identity.signal?.members ?? []).map((member) =>
						Object.freeze({ ...member }),
					),
				),
				signalLog: Object.freeze([...(identity.signalLog ?? [])]),
				registeredAt: identity.registeredAt ?? 0,
				socketPath: identity.socketPath,
				signalled: identity.signalled ?? false,
				signal: identity.signal?.members
					? Object.freeze({
							...identity.signal,
							members: Object.freeze(
								identity.signal.members.map((member) =>
									Object.freeze({ ...member }),
								),
							),
							...(identity.signal.tag === "KillSent"
								? {
										sent: Object.freeze(
											identity.signal.sent.map((member) =>
												Object.freeze({ ...member }),
											),
										),
									}
								: {}),
						})
					: Object.freeze({ tag: "None" } satisfies RunnerSignal),
				attachmentId: identity.attachmentId,
				entry: identity.entry,
			});
		const save = (record: RunnerRecord<A>) => {
			Object.freeze(record.tag);
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
		// CONTRACT.md 6.2 lists authorize(g, w, now); 6.11 deleted the only
		// rule that read the clock (the cleanup grant's expiry), so `now` went.
		const authorize = (
			grant: Grant,
			write: Write,
		): Option.Option<AuthorizedWrite> => {
			const state = grants.get(grant);
			if (!state) return Option.none();
			const allowed = write.kind === "evidence" || state.phase === "live";
			return allowed
				? Option.some(Object.freeze({ [authorizedTypeId]: true, grant, write }))
				: Option.none();
		};
		const logDropped = (grant: Grant, write: Write) =>
			Effect.suspend(() => {
				const key = `${grant.runnerId}:${write.kind}`;
				if (dropped.has(key)) return Effect.void;
				dropped.add(key);
				const state = grants.get(grant);
				return (
					!state || state.phase === "starting"
						? Effect.logWarning
						: Effect.logDebug
				)(
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
						Option.isSome(authorize(grant, write))
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
					if (Option.isSome(authorize(grant, write))) return Effect.void;
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
		/** Flips the tag synchronously (AI1). A revoked runner's memory goes with its entry (6.11). */
		const revoke = (grant: Grant, reason: Revocation) =>
			Effect.sync(() => {
				const phase = grants.get(grant)?.phase;
				// A revoked grant never revives or changes reason (AI4).
				if (
					!phase ||
					phase === "superseded" ||
					phase === "exited" ||
					phase === "retired"
				)
					return;
				grants.set(grant, { phase: reason });
				const record = records.get(grant.runnerId);
				if (record?.grant !== grant) return;
				const base = {
					identity: record.identity,
					observation: record.observation,
					watcher: record.watcher,
					grant,
				};
				save(
					reason === "retired"
						? { ...base, tag: { _tag: "Retired" } }
						: { ...base, tag: { _tag: "Exiting", reason } },
				);
			}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
		const isStarting = (record: RunnerRecord<A>): record is Starting<A> =>
			record.tag._tag === "Starting";
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
				const retired = retirement
					? {
							rows: runners.flatMap((runner) => {
								const row = retirement(runner.runnerId);
								return row ? [row] : [];
							}),
							rejected: [],
						}
					: receipts
						? yield* receipts
								.retirements(runners.map((runner) => runner.runnerId))
								.pipe(
									Effect.mapError(
										(cause) => new AuthorityUnavailable({ cause }),
									),
								)
						: { rows: [], rejected: [] };
				const adopted = new Map<string, Grant>();
				const survivors: RunnerRecord<A>[] = [];
				for (const registration of runners) {
					if (
						retired.rejected.some(
							(error) => error.runnerId === registration.runnerId,
						)
					)
						continue;
					let record = records.get(registration.runnerId);
					if (
						record?.tag._tag === "Retired" ||
						record?.tag._tag === "Exiting"
					) {
						survivors.push(record);
						continue;
					}
					const tombstone = retired.rows.find(
						(row) => row.runnerId === registration.runnerId,
					);
					const start =
						registration.startTime !== undefined
							? registration
							: record?.identity;
					const identity = normalize({
						...record?.identity,
						...registration,
						startTime: start?.startTime,
						startKey: start?.startKey,
						entry: registration.entry ?? record?.identity.entry,
						...tombstone,
						...(tombstone
							? {
									pid: tombstone.identity.pid,
									startTime:
										tombstone.identity.tag === "Verified"
											? tombstone.identity.startTime
											: undefined,
									startKey:
										tombstone.identity.tag === "Verified"
											? tombstone.identity.startKey
											: undefined,
									signal: tombstone.signal,
									signalled: tombstone.signal.tag !== "None",
								}
							: {}),
					});
					if (!record)
						record = save(
							phase === "live" || tombstone
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
							grants.set(record.grant, { phase: "superseded" });
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
					if (tombstone) {
						yield* revoke(record.grant, "retired");
						const survivor = records.get(identity.runnerId);
						if (survivor) survivors.push(survivor);
						continue;
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
			beginStop: (grant: Grant) => {
				if (grants.get(grant)?.phase === "live")
					grants.set(grant, { phase: "stopping" });
			},
			observe: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record) save({ ...record, observation: "Observed" });
			},
			recordRetirement: (retirement: RunnerRetirement) => {
				const record = records.get(retirement.runnerId);
				if (record)
					save({
						...record,
						identity: normalize({
							...record.identity,
							reaper: retirement.reaper,
							members: retirement.members,
							signalLog: retirement.signalLog,
							signal: retirement.signal,
							signalled:
								record.identity.signalled || retirement.signal.tag !== "None",
						}),
					});
			},
			forget: (runnerId: string) => {
				const record = records.get(runnerId);
				if (record) {
					const state = grants.get(record.grant);
					if (
						state &&
						(state.phase === "starting" ||
							state.phase === "live" ||
							state.phase === "stopping")
					)
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
					"pid" | "startTime" | "startKey" | "signalled"
				> & {
					readonly signal?: RunnerSignal;
					readonly reaper?: RunnerMember | undefined;
					readonly members?: readonly RunnerMember[];
					readonly signalLog?: readonly RunnerSignalAttempt[];
				},
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
						startKey: evidence.startKey,
						signalled: record.identity.signalled || evidence.signalled,
						signal: evidence.signal ?? record.identity.signal,
						reaper: evidence.reaper ?? record.identity.reaper,
						members: evidence.members ?? record.identity.members,
						signalLog: evidence.signalLog ?? record.identity.signalLog,
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
		};
	});
