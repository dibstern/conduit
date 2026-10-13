// Session Family Subscription (ni8.28)
// The concrete SubscriptionSource for one session family: the root a viewed
// session descends from and every descendant (subagent and fork rows). It is
// the shell adapter scoped to one family, and replaces the `session_family`
// push the relay used to send each viewer after every family change.
//
// Rows are versioned like the shell's roots: a member moves when anything in
// its subtree does, because its summary aggregates descendants. Removals come
// from the advance, kept to ids this family has served so another family's
// deletion stays silent.
//
// The feed anchors on the family root (the topmost ancestor still present, so
// an orphan family has one too), resolved once at subscribe, so deleting
// the member it was opened on (a finished subagent) does not orphan it, and
// every device viewing any member of one family asks the same question: the
// source is named by that root and shares its window reads (y7eo.15). The read
// is therefore a pure function of the window and the store. The base depends
// on the viewed session; windows do not. The ids served are tracked from the
// envelopes each subscriber is sent.
// Resume is a rebase for the same reason as the shell: the query can only
// report rows that still exist.

import { SqlClient } from "@effect/sql";
import { Effect, Stream } from "effect";
import { withCachedSessionGit } from "../../../git/session-git.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { SessionInfo } from "../../../shared-types.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { resolveSessionAccountIds } from "../../daemon/Services/session-accounts.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { BackgroundLivenessTag, ConfigTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { withSessionWorktreeStatus } from "./session-workspace.js";
import type { ShellSubscriptionError } from "./shell-subscription.js";

export const subscribeSessionFamily = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionInfo>,
	ShellSubscriptionError,
	| ReadQueryEffectTag
	| SessionEventBusTag
	| BackgroundLivenessTag
	| ConfigTag
	| AccountDirectory
	| SqlClient.SqlClient
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const backgroundOf = yield* BackgroundLivenessTag;
			const config = yield* ConfigTag;
			const sql = yield* SqlClient.SqlClient;
			const accounts = yield* AccountDirectory;
			const anchor =
				(yield* readQuery.getSessionFamilyRoot(options.sessionId)) ??
				options.sessionId;
			const held = new Set<string>();
			return stream<SessionInfo, ShellSubscriptionError>({
				bus,
				source: {
					name: `session-family/${anchor}`,
					collections: ["sessions"],
					shareReads: true,
					read: (range) =>
						readQuery
							.readSessionList({
								...range,
								familyOf: anchor,
								...(range === undefined ? { viewed: options.sessionId } : {}),
								backgroundOf,
							})
							.pipe(
								Effect.flatMap((list) =>
									Effect.gen(function* () {
										const accountIds = yield* resolveSessionAccountIds(
											list.rows.map((row) => row.item.id),
										).pipe(
											Effect.provideService(SqlClient.SqlClient, sql),
											Effect.provideService(AccountDirectory, accounts),
										);
										return yield* Effect.forEach(list.rows, (row) =>
											Effect.gen(function* () {
												return {
													...row,
													item: yield* withSessionWorktreeStatus(
														withCachedSessionGit(
															{
																...row.item,
																projectSlug: config.slug,
																accountId: accountIds.get(row.item.id) ?? null,
															},
															[
																config.projectDir,
																...(config.extraFolders ?? []),
															],
														),
														config,
													),
												};
											}),
										).pipe(Effect.map((rows) => ({ ...list, rows })));
									}),
								),
							),
					route: (advance) => {
						const removed = advance.removedSessionIds.filter((id) =>
							held.delete(id),
						);
						return { moved: true, removed };
					},
					resume: "rebase",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			}).pipe(
				// Pulled in order, so `route` sees every envelope sent before it.
				Stream.tap((envelope) =>
					Effect.sync(() => {
						if (envelope._tag === "snapshot") {
							held.clear();
							for (const row of envelope.rows) held.add(row.id);
						} else if (envelope._tag === "upsert") held.add(envelope.item.id);
						else if (envelope._tag === "remove") held.delete(envelope.id);
					}),
				),
			);
		}),
	);
