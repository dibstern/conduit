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

import { Effect, Stream } from "effect";
import type { SqlClient } from "effect/sql";
import { advanceTouchesScope } from "../../../contracts/read-model-advance.js";
import {
	ReadQueryEffectTag,
	type SessionScope,
} from "../../../persistence/effect/read-query-effect.js";
import type { SessionInfo } from "../../../shared-types.js";
import type { AccountDirectory } from "../../daemon/Services/account-directory.js";
import type { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import { makeSessionRows } from "../../daemon/Services/session-rows.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { ConfigTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import type { ShellSubscriptionError } from "./shell-subscription.js";

export const subscribeSessionFamily = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionInfo>,
	ShellSubscriptionError,
	| ReadQueryEffectTag
	| SessionEventBusTag
	| SessionActivityTag
	| ConfigTag
	| AccountDirectory
	| SqlClient.SqlClient
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const config = yield* ConfigTag;
			const scope: SessionScope = { projectIds: [config.slug] };
			const rows = yield* makeSessionRows({
				slug: config.slug,
				folders: [config.projectDir, ...(config.extraFolders ?? [])],
			});
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
					shareKey: `session-family/${config.slug}/${anchor}`,
					read: (range) =>
						rows.read({
							...range,
							familyOf: anchor,
							...(range === undefined ? { viewed: options.sessionId } : {}),
						}),
					route: (advance) => {
						if (!advanceTouchesScope(advance, scope))
							return { moved: false, removed: [] };
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
