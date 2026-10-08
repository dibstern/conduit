// Shell Subscription (delta source #2)
// The concrete SubscriptionSource for the shell — the sidebar session list
// (root session summaries: title, attention, status, recency).
//
// It is two answers and a policy (ni8.5 §7). The sessions table carries a
// read-model version, so "what changed" is `WHERE version > lastSeen` and
// nothing else: no event-type allowlist to drift out of step with the session
// projector, no per-session coalesce window, no replay out of the durable log,
// no per-row re-query. A burst that does not touch a session row costs one
// indexed range scan returning nothing, which is what the 50ms window used to
// buy by filtering event types.
//
// Removals are the exception the column cannot serve: a deleted row leaves no
// version behind, so the advance names them (§8) and they become `remove`
// envelopes with no round trip.
//
// Resume is therefore a REBASE, not a catch-up. A client reconnecting across a
// deletion would otherwise keep showing a session that is gone — the query can
// only report rows that still exist. The full set is tens of rows and is read
// once per reconnect, which is what the unary session list cost on every
// reconnect anyway.

import { channel } from "node:diagnostics_channel";
import type { SqlError } from "@effect/sql/SqlError";
import { Duration, Effect, Option, Stream } from "effect";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import type { SessionInfo } from "../../../shared-types.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import {
	BackgroundLivenessTag,
	SessionCompactionsTag,
	SessionRetriesTag,
} from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";

export type ShellSubscriptionError = ReadQueryEffectError | SqlError;

/** What one sidebar read cost the server, for load tests. */
export interface SidebarRead {
	readonly ms: number;
	readonly rows: number;
}

const sidebarReads = channel("conduit:sidebar-read");

/**
 * Subscribe to the shell (session-list) stream. Cold start and resume both emit
 * the recency-ordered session set, a `synchronized` boundary, then whole-session
 * upserts and removes as the read model advances. Lifecycle is the ambient
 * Scope: closing it releases the advance subscription.
 *
 * The read-query service and SessionEventBus are taken from context so the
 * transport (ni8.5) provides them once at the composition root.
 */
export const subscribeShell = (
	options: { readonly resumeFromSequence?: number } = {},
): Stream.Stream<
	Envelope<SessionInfo>,
	ShellSubscriptionError,
	ReadQueryEffectTag | SessionEventBusTag | BackgroundLivenessTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const backgroundOf = yield* BackgroundLivenessTag;
			// Optional so read-only hosts need not wire it; the relay always does.
			const compactingOf = Option.getOrUndefined(
				yield* Effect.serviceOption(SessionCompactionsTag),
			);
			const retryingOf = Option.getOrUndefined(
				yield* Effect.serviceOption(SessionRetriesTag),
			);
			return stream<SessionInfo, ShellSubscriptionError>({
				bus,
				source: {
					name: "shell",
					shareReads: true,
					read: (range) =>
						readQuery.readSessionList({ ...range, backgroundOf }).pipe(
							Effect.timed,
							Effect.map(([elapsed, list]) => {
								if (sidebarReads.hasSubscribers)
									sidebarReads.publish({
										ms: Duration.toMillis(elapsed),
										rows: list.rows.length,
									} satisfies SidebarRead);
								return list;
							}),
							Effect.map((list) => ({
								...list,
								rows: list.rows.map((row) => {
									const compacting = compactingOf?.(row.item.id);
									const retrying = retryingOf?.(row.item.id);
									return compacting === undefined && retrying === undefined
										? row
										: {
												...row,
												item: {
													...row.item,
													...(compacting === undefined ? {} : { compacting }),
													...(retrying === undefined ? {} : { retrying }),
												},
											};
								}),
							})),
						),
					// A descendant advance can change its root summary. The
					// projectors move the root's sidebar row when it does, so the
					// read finds it by version.
					route: (advance) => ({
						moved: advance.sessionIds.length > 0,
						removed: advance.removedSessionIds,
					}),
					resume: "rebase",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			});
		}),
	);
