// Shell Subscription (delta source #2)
// The concrete SubscriptionSource for the shell — the sidebar session list
// (root session summaries: title, attention, status, recency).
//
// It is two answers and a policy (ni8.5 §7). The sidebar table carries a
// read-model version per family, so "what changed" is `WHERE version >
// lastSeen` and nothing else: no event-type allowlist to drift out of step with
// the session projector, no per-session coalesce window, no replay out of the
// durable log, no per-row re-query. A burst that does not touch a sidebar row
// costs one indexed range scan returning nothing.
//
// Removals come from the same scan. A family that leaves the sidebar (its root
// deleted, or given a parent) keeps a tombstone at the version it left
// (conduit-test-y7eo.3), so a ranged read returns it as a `remove`. A deleted
// session, child included, leaves one marked `deleted`, which is what tells a
// device to leave it; a root given a parent only drops out of the list.
//
// Resume is therefore a CATCH-UP: a reconnecting device is sent the families
// that moved or left past its cursor, not the whole list again. A cursor from
// before the tombstones began, or past the current version, gets a snapshot.

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
 * Subscribe to the shell (session-list) stream. Cold start emits the
 * recency-ordered session set and resume the families changed or removed past
 * its cursor, then a `synchronized` boundary, then whole-session upserts and
 * removes as the read model advances. Lifecycle is the ambient
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
					// A descendant advance can change its root summary, and a
					// deletion can end a family. The projectors move the root's
					// sidebar row, or leave its tombstone, so the read finds either
					// by version.
					route: (advance) => ({
						moved:
							advance.sessionIds.length > 0 ||
							advance.removedSessionIds.length > 0,
						removed: [],
					}),
					resume: "catchUp",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			});
		}),
	);
