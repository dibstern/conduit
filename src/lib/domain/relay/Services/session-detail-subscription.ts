// Session-Detail Subscription (delta source #1)
// The concrete SubscriptionSource for a session's detail view — the transcript
// of messages, streamed text, thinking, and tool activity.
//
// Its rows are `messages`, which carry a read-model version. The base reads
// the newest transcript page; live and resume queries use a version window.
// A message part carries no version of its own, so a part write advances the
// message that owns it and the whole current message comes back — which is why
// a delta here is a projected transcript message and not the raw event that
// caused it. The transcript is durable, so it also outlives event eviction.
//
// Ranged reads include tombstones, so catch-up can report messages removed
// while the client was away. The session's disappearance is the shell's to report.

import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Stream } from "effect";
import type { SessionDetailItemSchema } from "../../../contracts/ws-rpc.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
	type TranscriptPageCursorNotFoundError,
} from "../../../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../../../persistence/session-history-adapter.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { OpenCodeHistoryReconcileTag } from "./opencode-runtime-ingress-service.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { ConfigTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";

/**
 * A single detail row shared by the base and the deltas, as the seam requires.
 * - `transcriptMessage`: a projected transcript message — what this source
 *   streams, base and delta alike.
 * - `pendingInput`: an input conduit holds for the session, queued or steering.
 * - `inbox`: the session's inbox state (paused), computed on read.
 * - `event`: a raw committed event. Still on the wire for the browser's legacy
 *   delta arm, which conduit-test-ni8.5.20 retires; nothing produces it here.
 */
export type SessionDetailItem = typeof SessionDetailItemSchema.Type;

export type SessionDetailSubscriptionError =
	| ReadQueryEffectError
	| SqlError
	| TranscriptPageCursorNotFoundError;

/**
 * Subscribe to a session's detail stream. Cold start emits the transcript
 * snapshot, a `synchronized` boundary, then the messages that move; resume
 * replays only the messages that moved past `resumeFromSequence`, then goes
 * live. Lifecycle is the ambient Scope: closing it releases the advance
 * subscription.
 *
 * The read-query service and SessionEventBus are taken from context so the
 * transport (ni8.5) provides them once at the composition root.
 */
export const subscribeSessionDetail = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionDetailItem>,
	SessionDetailSubscriptionError,
	ReadQueryEffectTag | SessionEventBusTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const registry = yield* Effect.serviceOption(ProviderRegistryTag);
			const sessionRow = yield* Effect.either(
				readQuery.getSession(options.sessionId),
			);
			if (
				sessionRow._tag === "Right" &&
				sessionRow.right?.history_complete === 0
			) {
				const config = yield* Effect.serviceOption(ConfigTag);
				if (
					resolveProviderRoutingDriver(
						loadDaemonConfig(
							config._tag === "Some" ? config.value.configDir : undefined,
						),
						sessionRow.right.provider,
					) === "opencode"
				) {
					const ingress = yield* Effect.serviceOption(
						OpenCodeHistoryReconcileTag,
					);
					if (ingress._tag === "Some")
						yield* ingress.value.reconcileSession(options.sessionId);
				}
			}
			return stream<SessionDetailItem, SessionDetailSubscriptionError>({
				bus,
				source: {
					read: (range) =>
						Effect.gen(function* () {
							const page =
								range === undefined
									? yield* readQuery.readSessionTranscriptPage(
											options.sessionId,
											{
												limit: 50,
											},
										)
									: undefined;
							const result =
								page ??
								(yield* readQuery.readSessionTranscript(
									options.sessionId,
									range,
								));
							// Pending inputs ride the same window, bounded by the version
							// this read reports. A base read carries every one still
							// pending, whatever transcript page it returns.
							const through = range?.through ?? result.version;
							const pending = yield* readQuery.readPendingInputs(
								options.sessionId,
								{
									...(range?.after === undefined ? {} : { after: range.after }),
									through,
								},
							);
							const inputs = pending.rows.map(({ version, ...input }) => ({
								item: {
									_tag: "pendingInput" as const,
									input,
								} satisfies SessionDetailItem,
								version,
							}));
							// The inbox state moves with the session row. A base read always
							// carries it; a window carries it when the row moved inside it.
							const inbox = yield* readQuery.readInboxState(options.sessionId);
							const inboxRows =
								inbox &&
								(range === undefined ||
									(inbox.version > (range.after ?? -1) &&
										inbox.version <= through))
									? [
											{
												item: {
													_tag: "inbox" as const,
													inbox: {
														paused: inbox.paused,
														// Only the reasons that do not depend on the draft.
														steer:
															registry._tag === "Some" &&
															registry.value.getInstance(inbox.provider)
																?.steering === true
																? inbox.promptOpen
																	? "prompt_open"
																	: null
																: "no_steering",
													},
												} satisfies SessionDetailItem,
												version: Math.min(inbox.version, through),
											},
										]
									: [];
							return {
								// The adapter gets exactly these rows, so index `i` is still row `i`.
								// That is what lets each item keep the version its row
								// carries instead of borrowing the read's counter.
								rows: [
									...messageRowsToHistory(result.messages, {
										pageSize: result.messages.length,
									}).messages.map((message, index) => ({
										item: {
											_tag: "transcriptMessage" as const,
											message,
										} satisfies SessionDetailItem,
										version: result.messages[index]?.version ?? result.version,
									})),
									...inputs,
									...inboxRows,
								],
								version: result.version,
								...(range === undefined
									? {}
									: {
											removed: [
												...("removed" in result ? (result.removed ?? []) : []),
												...pending.removed,
											],
										}),
								...(page === undefined
									? {}
									: {
											hasMore: page.hasMore,
											...(page.messages[0] === undefined
												? {}
												: { cursor: page.messages[0].id }),
										}),
							};
						}),
					// A message is stored against the session that owns it — a subagent
					// message against the subagent session — and the projector reports
					// that owner, so naming this session is the whole routing test.
					route: (advance) => ({
						moved: advance.sessionIds.includes(options.sessionId),
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
