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
// The feed anchors on the family root once a base read finds it, so deleting
// the member it was opened on (a finished subagent) does not orphan it.
// Resume is a rebase for the same reason as the shell: the query can only
// report rows that still exist.

import { Effect, Option, Stream } from "effect";
import { withCachedSessionGit } from "../../../git/session-git.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { SessionInfo } from "../../../shared-types.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { BackgroundLivenessTag, ConfigTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import type { ShellSubscriptionError } from "./shell-subscription.js";

export const subscribeSessionFamily = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionInfo>,
	ShellSubscriptionError,
	ReadQueryEffectTag | SessionEventBusTag | BackgroundLivenessTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const backgroundOf = yield* BackgroundLivenessTag;
			const config = Option.getOrUndefined(
				yield* Effect.serviceOption(ConfigTag),
			);
			let anchor = options.sessionId;
			const held = new Set<string>();
			return stream<SessionInfo, ShellSubscriptionError>({
				bus,
				source: {
					name: `session-family/${options.sessionId}`,
					read: (range) =>
						readQuery
							.readSessionList({ ...range, familyOf: anchor, backgroundOf })
							.pipe(
								Effect.map((list) => ({
									...list,
									rows: list.rows.map((row) => ({
										...row,
										item: config
											? withCachedSessionGit(row.item, config.projectDir)
											: row.item,
									})),
								})),
								Effect.tap(({ rows }) => {
									const ids = rows.map(({ item }) => item.id);
									if (range === undefined) {
										held.clear();
										const members = new Set(ids);
										const root = rows.find(
											({ item }) =>
												item.parentID === undefined ||
												!members.has(item.parentID),
										);
										if (root !== undefined) anchor = root.item.id;
									}
									for (const id of ids) held.add(id);
								}),
							),
					route: (advance) => {
						const removed = advance.removedSessionIds.filter((id) =>
							held.delete(id),
						);
						return { moved: advance.sessionIds.length > 0, removed };
					},
					resume: "rebase",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			});
		}),
	);
