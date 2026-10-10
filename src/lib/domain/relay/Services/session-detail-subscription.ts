// Session-Detail Subscription (delta source #1)
// The concrete SubscriptionSource for a session's detail view — the transcript
// of messages, streamed text, thinking, and tool activity.
//
// Its rows are messages and their parts, each carrying its own read-model
// version. The base reads the newest transcript page, up to 50 messages or
// 256 KB of frame, keeping or dropping a message with all its parts; live and
// resume queries use a version window. A part write moves that part and its
// message's header, so a live update carries the header and the part that
// changed, not the whole message: its size stays flat however long the turn
// grows. The transcript is durable, so it also outlives event eviction.
//
// Ranged reads include tombstones, so catch-up can report messages and parts
// removed while the client was away. The session's disappearance is the
// shell's to report.

import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Schema, Stream } from "effect";
import type {
	MessageVersion,
	PartVersion,
} from "../../../contracts/tool-wire.js";
import {
	PartRemovalId,
	type SessionDetailItemSchema,
} from "../../../contracts/ws-rpc.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
	type TranscriptPageCursorNotFoundError,
} from "../../../persistence/effect/read-query-effect.js";
import type { MessageWithParts } from "../../../persistence/read-model-types.js";
import {
	messageRowsToHistory,
	newestRowsWithin,
	PAGE_FRAME_BUDGET,
} from "../../../persistence/session-history-adapter.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { OpenCodeHistoryReconcileTag } from "./opencode-runtime-ingress-service.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { ConfigTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";

/**
 * A single detail row shared by the base and the deltas, as the seam requires.
 * - `message` / `part`: a transcript message without its parts, or one part.
 * - `pendingInput`: an input conduit holds for the session, queued or steering.
 * - `inbox`: the session's inbox state (paused), computed on read.
 */
export type SessionDetailItem = typeof SessionDetailItemSchema.Type;

/** Each row at the version its own table carries: a part's is never its message's. */
type DetailRow =
	| {
			readonly item: Extract<SessionDetailItem, { _tag: "message" }>;
			readonly version: MessageVersion;
	  }
	| {
			readonly item: Extract<SessionDetailItem, { _tag: "part" }>;
			readonly version: PartVersion;
	  };

/**
 * Split each projected message into its rows: a message row when `moved` says
 * its own version is in the window, and a row for each part the read returned.
 * One group per message, so a page can keep or drop a message whole. The
 * adapter gets exactly these messages, so index `i` is still message `i`.
 */
const messageRowGroups = (
	messages: MessageWithParts[],
	moved: (version: MessageVersion) => boolean,
): DetailRow[][] =>
	messageRowsToHistory(messages, {
		pageSize: messages.length,
	}).messages.map((message, index): DetailRow[] => {
		const stored = messages[index];
		if (stored === undefined) return [];
		// The parts travel as rows; text is theirs, joined.
		const { parts = [], text: _text, ...header } = message;
		// A REST snapshot's parts come from its payload, stored under the same ids.
		const projected = new Map(parts.map((part) => [part.id, part]));
		return [
			...(moved(stored.version)
				? [
						{
							item: { _tag: "message" as const, message: header },
							version: stored.version,
						},
					]
				: []),
			...stored.parts.flatMap((row): DetailRow[] => {
				const part = projected.get(row.id);
				return part === undefined
					? []
					: [
							{
								item: {
									_tag: "part",
									messageId: stored.id,
									sortOrder: row.sort_order,
									part,
								},
								version: row.version,
							},
						];
			}),
		];
	});

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
					name: `session-detail/${options.sessionId}`,
					shareReads: true,
					read: (range) =>
						Effect.gen(function* () {
							// Pending inputs and the inbox state ride the same window as
							// the transcript, bounded by the version its read reports. A
							// base read carries every input still pending, whatever
							// transcript page it returns.
							const held = (through: number) =>
								Effect.gen(function* () {
									const pending = yield* readQuery.readPendingInputs(
										options.sessionId,
										{
											...(range?.after === undefined
												? {}
												: { after: range.after }),
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
									// The inbox state moves with the session row. A base read
									// always carries it; a window carries it when the row moved
									// inside it.
									const inbox = yield* readQuery.readInboxState(
										options.sessionId,
									);
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
										rows: [...inputs, ...inboxRows],
										removed: pending.removed,
									};
								});
							if (range === undefined) {
								const page = yield* readQuery.readSessionTranscriptPage(
									options.sessionId,
									{ limit: 50, previewTools: true },
								);
								const groups = messageRowGroups(page.messages, () => true);
								// The page also ends where its frame would pass the budget,
								// never inside a message; "load older" pages from its
								// oldest whole message.
								const kept = newestRowsWithin(groups, PAGE_FRAME_BUDGET);
								const oldest = page.messages[groups.length - kept.length];
								const heldRows = yield* held(page.version);
								return {
									rows: [...kept.flat(), ...heldRows.rows],
									version: page.version,
									hasMore: page.hasMore || kept.length < groups.length,
									...(oldest === undefined ? {} : { cursor: oldest.id }),
								};
							}
							const window = yield* readQuery.readSessionTranscript(
								options.sessionId,
								range,
							);
							const heldRows = yield* held(range.through ?? window.version);
							return {
								rows: [
									...messageRowGroups(
										window.messages,
										(version) =>
											version > (range.after ?? Number.NEGATIVE_INFINITY) &&
											version <= (range.through ?? Number.POSITIVE_INFINITY),
									).flat(),
									...heldRows.rows,
								],
								version: window.version,
								removed: [
									...(window.removed ?? []),
									...(window.removedParts ?? []).map(
										({ messageId, partId, version }) => ({
											id: Schema.encodeSync(PartRemovalId)([messageId, partId]),
											version,
										}),
									),
									...heldRows.removed,
								],
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
