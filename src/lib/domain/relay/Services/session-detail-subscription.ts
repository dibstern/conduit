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

import { Effect, Option, Schema, Stream } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
import {
	PartRemovalId,
	type ResumeBase,
	ResumePoint,
	type SessionDetailEnvelope,
	type SessionDetailItemSchema,
} from "../../../contracts/ws-rpc.js";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
	type TranscriptPageCursorNotFoundError,
} from "../../../persistence/effect/read-query-effect.js";
import {
	FRAME_ENVELOPE_BYTES,
	messageRowGroups,
	PAGE_FRAME_BUDGET,
	PAGE_MESSAGES,
} from "../../../persistence/session-history-adapter.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { OpenCodeHistoryReconcileTag } from "./opencode-runtime-ingress-service.js";
import { stream } from "./read-model-subscription.js";
import { encodeSessionDetail } from "./session-detail-wire.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { providerSteers } from "./session-inbox.js";

/**
 * A single detail row shared by the base and the deltas, as the seam requires.
 * - `message` / `part`: a transcript message without its parts, or one part.
 * - `pendingInput`: an input conduit holds for the session, queued or steering.
 * - `inbox`: the session's inbox state (paused), computed on read.
 */
export type SessionDetailItem = typeof SessionDetailItemSchema.Type;

/**
 * The most messages a catch-up onto the page a resume point names carries.
 * Only a snapshot replaces a saved page, so every open from it catches up
 * from the same point and the catch-up grows with each change since: past a
 * few turns, a snapshot is sent to be saved instead (conduit-test-y7eo.18).
 */
const SAVED_PAGE_CATCH_UP_MESSAGES = 10;

const partRowId = (messageId: string, partId: string) =>
	Schema.encodeSync(PartRemovalId)([messageId, partId]);

/**
 * What a {@link ResumePoint} says, readable only here: the store and session
 * that sent the snapshot, and the base a resume from it is checked against.
 */
const ResumePointBody = Schema.compose(
	Schema.StringFromBase64Url,
	Schema.parseJson(
		Schema.Struct({
			store: Schema.String,
			session: Schema.String,
			sequence: Schema.Number,
			cursor: Schema.optional(Schema.NonEmptyString),
		}),
	),
);

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
	readonly resumeBase?: ResumeBase;
	/** Resume from a saved snapshot; one from another store starts cold. */
	readonly resumePoint?: ResumePoint;
}): Stream.Stream<
	SessionDetailEnvelope,
	SessionDetailSubscriptionError,
	ReadQueryEffectTag | SessionEventBusTag | AccountDirectory
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			const directory = yield* AccountDirectory;
			const sessionRow = yield* Effect.either(
				readQuery.getSession(options.sessionId),
			);
			let boundId =
				sessionRow._tag === "Right" ? sessionRow.right?.provider : undefined;
			let account =
				boundId === undefined
					? undefined
					: yield* directory
							.resolve({ _tag: "Id", id: boundId })
							.pipe(Effect.option, Effect.map(Option.getOrUndefined));
			if (
				sessionRow._tag === "Right" &&
				sessionRow.right?.history_complete === 0
			) {
				if (getProviderDriver(account?.driver)?.runsOpenCodeServer) {
					const ingress = yield* Effect.serviceOption(
						OpenCodeHistoryReconcileTag,
					);
					if (ingress._tag === "Some")
						yield* ingress.value.reconcileSession(options.sessionId);
				}
			}
			const store = yield* readQuery.readStoreIdentity();
			const point = Option.getOrUndefined(
				Option.filter(
					Option.fromNullable(options.resumePoint).pipe(
						Option.flatMap(Schema.decodeOption(ResumePointBody)),
					),
					(body) => body.store === store && body.session === options.sessionId,
				),
			);
			// A saved snapshot resumes from the base its point names; a point
			// this store did not send for this session gets a fresh snapshot.
			// A client resuming from that very base holds the page as saved.
			const fromSavedPage =
				point !== undefined && options.resumeFromSequence === point.sequence;
			const resume =
				options.resumePoint === undefined
					? options
					: point === undefined
						? {}
						: {
								resumeFromSequence: options.resumeFromSequence,
								resumeBase: {
									sequence: point.sequence,
									...(point.cursor === undefined
										? {}
										: { cursor: point.cursor }),
								},
							};
			return stream<SessionDetailItem, SessionDetailSubscriptionError>({
				bus,
				source: {
					name: `session-detail/${options.sessionId}`,
					collections: ["messages", "sessions", "inputs"],
					shareReads: true,
					read: (range, base) =>
						Effect.gen(function* () {
							// Pending inputs, the inbox state and the rewind point ride the
							// same window as the transcript, bounded by the version its read
							// reports. A base read carries every input still pending,
							// whatever transcript page it returns.
							const held = (through: number) =>
								Effect.gen(function* () {
									// So does a resume, as they stand at its read: it starts from
									// the newest version the client was sent, which may have been
									// cut short, and the checksum covers only the transcript.
									const resuming =
										range?.after !== undefined && range.through === undefined;
									const moved = (version: number) =>
										range === undefined ||
										resuming ||
										(version > (range.after ?? -1) && version <= through);
									const at = (version: number) =>
										resuming ? through : Math.min(version, through);
									const pending = yield* readQuery.readPendingInputs(
										options.sessionId,
										{
											...(range?.after === undefined
												? {}
												: { after: range.after }),
											through,
										},
									);
									const current = resuming
										? yield* readQuery.readPendingInputs(options.sessionId, {
												through,
											})
										: pending;
									const inputs = current.rows.map(({ version, ...input }) => ({
										item: {
											_tag: "pendingInput" as const,
											input,
										} satisfies SessionDetailItem,
										version: at(version),
									}));
									// The inbox state moves with the session row. A base read
									// always carries it; a window carries it when the row moved
									// inside it.
									const inbox = yield* readQuery.readInboxState(
										options.sessionId,
									);
									if (inbox && inbox.provider !== boundId) {
										boundId = inbox.provider;
										account =
											boundId === undefined
												? undefined
												: yield* directory
														.resolve({ _tag: "Id", id: boundId })
														.pipe(
															Effect.option,
															Effect.map(Option.getOrUndefined),
														);
									}
									const inboxRows =
										inbox && moved(inbox.version)
											? [
													{
														item: {
															_tag: "inbox" as const,
															inbox: {
																paused: inbox.paused,
																// Only the reasons that do not depend on the draft.
																steer: providerSteers(account)
																	? inbox.promptOpen
																		? "prompt_open"
																		: null
																	: "no_steering",
															},
														} satisfies SessionDetailItem,
														version: at(inbox.version),
													},
												]
											: [];
									// The pending rewind point moves with the session row too.
									const session = yield* readQuery.getSession(
										options.sessionId,
									);
									const rewindRows =
										session && moved(session.version)
											? [
													{
														item: {
															_tag: "rewind" as const,
															messageId:
																session.pending_rewind_message_id ?? null,
														} satisfies SessionDetailItem,
														version: at(session.version),
													},
												]
											: [];
									return {
										rows: [...inputs, ...inboxRows, ...rewindRows],
										removed: pending.removed,
									};
								});
							if (range === undefined) {
								const page = yield* readQuery.readSessionTranscriptPage(
									options.sessionId,
									{ limit: PAGE_MESSAGES, previewTools: true },
								);
								const heldRows = yield* held(page.version);
								return {
									rows: [
										...messageRowGroups(page.messages, () => true).flat(),
										...heldRows.rows,
									],
									version: page.version,
									hasMore: page.hasMore,
									...(page.cursor === undefined ? {} : { cursor: page.cursor }),
								};
							}
							const listing =
								base === undefined
									? undefined
									: {
											since: base.sequence,
											...(base.cursor === undefined
												? {}
												: { from: base.cursor }),
										};
							const resuming = range.through === undefined;
							const window = yield* resuming
								? readQuery.readSessionTranscriptCatchUp(
										options.sessionId,
										range.after ?? -1,
										fromSavedPage
											? SAVED_PAGE_CATCH_UP_MESSAGES
											: PAGE_MESSAGES,
										listing,
									)
								: readQuery.readSessionTranscript(
										options.sessionId,
										range,
										listing,
									);
							if (window === "snapshot") return window;
							const heldRows = yield* held(range.through ?? window.version);
							const rows = [
								...messageRowGroups(
									window.messages,
									(version) =>
										version > (range.after ?? Number.NEGATIVE_INFINITY) &&
										version <= (range.through ?? Number.POSITIVE_INFINITY),
								).flat(),
								...heldRows.rows,
							];
							if (
								resuming &&
								FRAME_ENVELOPE_BYTES +
									rows.reduce(
										(bytes, row) =>
											Buffer.byteLength(JSON.stringify(row), "utf8") +
											1 +
											bytes,
										0,
									) >
									PAGE_FRAME_BUDGET
							)
								return "snapshot" as const;
							return {
								rows,
								version: window.version,
								removed: [
									...(window.removed ?? []),
									...(window.removedParts ?? []).map(
										({ messageId, partId: part, version }) => ({
											id: partRowId(messageId, part),
											version,
										}),
									),
									...heldRows.removed,
								],
								...(window.listing === undefined
									? {}
									: {
											listing: [
												...window.listing.messages.map(
													({ id, version }) => [id, version] as const,
												),
												...window.listing.parts.map(
													({ messageId, partId: part, version }) =>
														[partRowId(messageId, part), version] as const,
												),
											],
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
				...(resume.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: resume.resumeFromSequence }),
				...(resume.resumeBase === undefined
					? {}
					: { resumeBase: resume.resumeBase }),
			}).pipe(
				Stream.map(
					(envelope): SessionDetailEnvelope =>
						envelope._tag === "snapshot" && store !== undefined
							? {
									...envelope,
									resumePoint: ResumePoint.make(
										Schema.encodeSync(ResumePointBody)({
											store,
											session: options.sessionId,
											sequence: envelope.sequence,
											...(envelope.cursor === undefined
												? {}
												: { cursor: envelope.cursor }),
										}),
									),
								}
							: envelope,
				),
			);
		}),
	).pipe(encodeSessionDetail);
