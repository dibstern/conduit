import { Effect, Fiber, Option, Schema, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { ProjectSetupStateSchema } from "../../contracts/project-setup.js";
import {
	PartRemovalId,
	type SessionDetailEnvelope,
} from "../../contracts/ws-rpc.js";
import { makeResumeLedger, type ResumeLedger } from "../transport/resume.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { type FeedStatus, supervise } from "../transport/supervise.js";
import { loadMoreHistoryRpc } from "../transport/ws-rpc-client.js";
import type {
	ChatMessage,
	HistoryMessage,
	HistoryMessagePart,
	ToolStatus,
} from "../types.js";
import {
	type HistoryConversionCache,
	historyToChatMessages,
} from "../utils/history-logic.js";
import { renderMarkdown } from "../utils/markdown.js";
import {
	advanceTurnIfNewMessage,
	clearSessionChatState,
	draftSend,
	getOrCreateSessionSlot,
	historyState,
	type PendingInput,
	restoreContextFromMessages,
	type SessionMessages,
	sessionMessages,
} from "./chat.svelte.js";
import {
	forgetTranscript,
	openSavedTranscript,
	type SavedSnapshot,
	type SavedTranscript,
	saveTranscript,
} from "./saved-transcripts.js";
import { sessionState } from "./session.svelte.js";
import { refreshSessionSkills } from "./session-skills.svelte.js";

type ProjectRef = string;
export type TranscriptEntry = NonNullable<SessionMessages["transcript"]>;
type DetailItem = Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"];
type WireMessage = Extract<DetailItem, { _tag: "message" }>["message"];
type WirePart = Extract<DetailItem, { _tag: "part" }>["part"];

declare global {
	/** Opt-in browser performance evidence; ordinary sessions allocate nothing. */
	var __conduitTranscriptMarkdownRenders: Record<string, number> | undefined;
	var __conduitMeasureTranscriptApply: boolean | undefined;
}

const FRAME_FALLBACK_DELAY_MS = 16;

const partTypes: ReadonlySet<string> = new Set([
	"text",
	"reasoning",
	"file",
	"tool",
	"step-start",
	"step-finish",
	"snapshot",
	"patch",
	"agent",
	"retry",
	"compaction",
	"subtask",
	"thinking",
	"error",
	"setup",
]);
const isPartType = (type: string): type is HistoryMessagePart["type"] =>
	partTypes.has(type);
const isToolStatus = (status: unknown): status is ToolStatus =>
	status === "pending" ||
	status === "running" ||
	status === "completed" ||
	status === "error";
const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;

function toHistoryPart(part: WirePart): HistoryMessagePart | undefined {
	if (!isPartType(part.type)) return undefined;
	const {
		type,
		state,
		time,
		text,
		renderedHtml,
		callID,
		tool,
		preTokens,
		postTokens,
		failed,
		code,
		setup,
		...base
	} = part;
	const partTime = record(time);
	return {
		...base,
		type,
		...(text === undefined ? {} : { text }),
		...(renderedHtml === undefined ? {} : { renderedHtml }),
		...(callID === undefined ? {} : { callID }),
		...(tool === undefined ? {} : { tool }),
		...(state === undefined
			? {}
			: {
					state: {
						...state,
						...(isToolStatus(state["status"])
							? { status: state["status"] }
							: {}),
						...(typeof state["error"] === "string"
							? { error: state["error"] }
							: {}),
					},
				}),
		...(partTime === undefined
			? {}
			: {
					time: {
						...(typeof partTime["start"] === "number"
							? { start: partTime["start"] }
							: {}),
						...(typeof partTime["end"] === "number"
							? { end: partTime["end"] }
							: {}),
					},
				}),
		...(typeof preTokens === "number" ? { preTokens } : {}),
		...(typeof postTokens === "number" ? { postTokens } : {}),
		...(failed === true ? { failed } : {}),
		...(typeof code === "string" ? { code } : {}),
		...(Schema.is(ProjectSetupStateSchema)(setup) ? { setup } : {}),
	};
}

function toHistoryMessage(source: WireMessage): HistoryMessage {
	const parts = source.parts?.flatMap((part) => toHistoryPart(part) ?? []);
	const {
		parts: _sourceParts,
		tokens: sourceTokens,
		isBackfilled,
		inputId,
		steered,
		time,
		cost,
		modelExecution,
		turnTiming,
		...base
	} = source;
	const tokens = record(sourceTokens);
	const cache = record(tokens?.["cache"]);
	return {
		...base,
		...(isBackfilled === undefined ? {} : { isBackfilled }),
		...(inputId === undefined ? {} : { inputId }),
		...(steered === undefined ? {} : { steered }),
		...(parts === undefined ? {} : { parts }),
		...(time === undefined
			? {}
			: {
					time: {
						...(time.created === undefined ? {} : { created: time.created }),
						...(time.completed === undefined
							? {}
							: { completed: time.completed }),
					},
				}),
		...(cost === undefined ? {} : { cost }),
		...(turnTiming === undefined
			? {}
			: {
					turnTiming: {
						startedAt: turnTiming.startedAt,
						...(turnTiming.endedAt === undefined
							? {}
							: { endedAt: turnTiming.endedAt }),
						waits: turnTiming.waits.map((wait) => ({
							id: wait.id,
							from: wait.from,
							...(wait.to === undefined ? {} : { to: wait.to }),
						})),
					},
				}),
		...(modelExecution === undefined
			? {}
			: {
					modelExecution: {
						actualModel: modelExecution.actualModel,
						...(modelExecution.requestedModel === undefined
							? {}
							: { requestedModel: modelExecution.requestedModel }),
						...(modelExecution.expectedModel === undefined
							? {}
							: { expectedModel: modelExecution.expectedModel }),
						...(modelExecution.drifted === undefined
							? {}
							: { drifted: modelExecution.drifted }),
					},
				}),
		...(tokens === undefined
			? {}
			: {
					tokens: {
						...(typeof tokens["input"] === "number"
							? { input: tokens["input"] }
							: {}),
						...(typeof tokens["output"] === "number"
							? { output: tokens["output"] }
							: {}),
						...(typeof tokens["context_window"] === "number"
							? { context_window: tokens["context_window"] }
							: {}),
						...(cache === undefined
							? {}
							: {
									cache: {
										...(typeof cache["read"] === "number"
											? { read: cache["read"] }
											: {}),
										...(typeof cache["write"] === "number"
											? { write: cache["write"] }
											: {}),
									},
								}),
					},
				}),
	};
}

const rowOrder = (a: HistoryMessage, b: HistoryMessage): number =>
	(a.time?.created ?? 0) - (b.time?.created ?? 0) || a.id.localeCompare(b.id);
const pendingOrder = (a: PendingInput, b: PendingInput): number =>
	a.admittedAt - b.admittedAt || a.inputId.localeCompare(b.inputId);

/**
 * `parts` with `part` replacing its namesake in place while its order holds, or
 * placed by its order. A part an older page brought has none and sorts first,
 * since that page brought its message whole.
 */
const placePart = (
	parts: readonly HistoryMessagePart[],
	part: HistoryMessagePart,
	order: TranscriptEntry["partOrder"],
	moved: boolean,
): HistoryMessagePart[] => {
	if (!moved && parts.some((old) => old.id === part.id))
		return parts.map((old) => (old.id === part.id ? part : old));
	const rest = parts.filter((old) => old.id !== part.id);
	const rank = (of: HistoryMessagePart) => order.get(of.id) ?? -1;
	const at = rest.findIndex((old) => rank(old) > rank(part));
	return at === -1
		? [...rest, part]
		: [...rest.slice(0, at), part, ...rest.slice(at)];
};

/** `order` without `partIds`. */
const withoutOrders = (
	order: TranscriptEntry["partOrder"],
	partIds: readonly string[],
): TranscriptEntry["partOrder"] => {
	if (!partIds.some((id) => order.has(id))) return order;
	const next = new Map(order);
	for (const id of partIds) next.delete(id);
	return next;
};

/** The entry with `messageId`'s parts rewritten, held or still waiting for it. */
const withParts = (
	entry: TranscriptEntry,
	messageId: string,
	change: (parts: readonly HistoryMessagePart[]) => HistoryMessagePart[],
): TranscriptEntry =>
	entry.rows.some((row) => row.id === messageId)
		? {
				...entry,
				rows: entry.rows.map((row) =>
					row.id === messageId
						? { ...row, parts: change(row.parts ?? []) }
						: row,
				),
			}
		: {
				...entry,
				waiting: new Map(entry.waiting).set(
					messageId,
					change(entry.waiting.get(messageId) ?? []),
				),
			};

const withoutWaiting = (
	waiting: TranscriptEntry["waiting"],
	messageId: string,
): TranscriptEntry["waiting"] => {
	if (!waiting.has(messageId)) return waiting;
	const next = new Map(waiting);
	next.delete(messageId);
	return next;
};

const withRow = (entry: TranscriptEntry, item: DetailItem): TranscriptEntry => {
	switch (item._tag) {
		case "message": {
			const header = toHistoryMessage(item.message);
			const held = entry.rows.find((old) => old.id === header.id);
			const waiting = withoutWaiting(entry.waiting, header.id);
			// Keep the held page contiguous below its floor. The server sends a
			// header after its parts, so the parts queued for it go with it.
			if (
				entry.hasMore &&
				!held &&
				entry.rows[0] &&
				rowOrder(header, entry.rows[0]) < 0
			)
				return { ...entry, waiting };
			// A message row leaves its parts in place: they move as rows of their own.
			const row = {
				...header,
				parts: held?.parts ?? entry.waiting.get(header.id) ?? [],
			};
			return {
				...entry,
				waiting,
				rows: [...entry.rows.filter((old) => old.id !== row.id), row].sort(
					rowOrder,
				),
			};
		}
		case "part": {
			const part = toHistoryPart(item.part);
			if (part === undefined) return entry;
			const held = entry.partOrder.get(part.id);
			const partOrder =
				held === item.sortOrder
					? entry.partOrder
					: new Map(entry.partOrder).set(part.id, item.sortOrder);
			// A part arrives before its message's header: rows arrive in version
			// order, and a part write also advances the message that owns it.
			// A part with no order came whole with an older page and stays put.
			return withParts({ ...entry, partOrder }, item.messageId, (parts) =>
				placePart(
					parts,
					part,
					partOrder,
					held !== undefined && held !== item.sortOrder,
				),
			);
		}
		case "pendingInput": {
			const input = item.input;
			return {
				...entry,
				pending: [
					...entry.pending.filter((old) => old.inputId !== input.inputId),
					input,
				].sort(pendingOrder),
			};
		}
		case "inbox":
			return { ...entry, ...item.inbox };
		case "rewind":
			return { ...entry, pendingRewindMessageId: item.messageId };
	}
};

/** The server sends a message's header and each part as separate rows. */
export function applyTranscriptEnvelope(
	entry: TranscriptEntry,
	envelope:
		| SessionDetailEnvelope
		| Awaited<ReturnType<typeof loadMoreHistoryRpc>>,
): TranscriptEntry {
	if ("messages" in envelope) {
		// Older pages still bring whole messages. Preserve their existing
		// precedence on overlap, and keep every other held row by identity.
		const rows = new Map<string, HistoryMessage>();
		for (const source of envelope.messages)
			if (!rows.has(source.id)) rows.set(source.id, toHistoryMessage(source));
		for (const row of entry.rows) if (!rows.has(row.id)) rows.set(row.id, row);
		return {
			...entry,
			rows: [...rows.values()].sort(rowOrder),
			hasMore: envelope.hasMore,
		};
	}
	switch (envelope._tag) {
		case "snapshot": {
			const startedAt = globalThis.__conduitMeasureTranscriptApply
				? performance.now()
				: undefined;
			// Build locally, then publish once. Parts may precede their header.
			const messages = new Map<string, HistoryMessage>();
			const parts = new Map<string, Map<string, HistoryMessagePart>>();
			const partOrder = new Map<string, number>();
			const pending = new Map<string, PendingInput>();
			let next: TranscriptEntry = {
				...entry,
				rows: [],
				waiting: new Map(),
				partOrder,
				pending: [],
				hasMore: false,
				pendingRewindMessageId: null,
				paused: false,
				steer: undefined,
			};
			for (const item of envelope.rows) {
				switch (item._tag) {
					case "message": {
						const header = toHistoryMessage(item.message);
						messages.set(header.id, { ...header, parts: [] });
						break;
					}
					case "part": {
						const part = toHistoryPart(item.part);
						if (!part) break;
						const group =
							parts.get(item.messageId) ??
							new Map<string, HistoryMessagePart>();
						group.set(part.id, part);
						parts.set(item.messageId, group);
						partOrder.set(part.id, item.sortOrder);
						break;
					}
					case "pendingInput":
						pending.set(item.input.inputId, item.input);
						break;
					case "inbox":
					case "rewind":
						next = withRow(next, item);
						break;
				}
			}
			const waiting = new Map<string, HistoryMessagePart[]>();
			for (const [messageId, group] of parts) {
				const ordered = [...group.values()].sort(
					(a, b) => (partOrder.get(a.id) ?? -1) - (partOrder.get(b.id) ?? -1),
				);
				const header = messages.get(messageId);
				if (header) messages.set(messageId, { ...header, parts: ordered });
				else waiting.set(messageId, ordered);
			}
			next = {
				...next,
				rows: [...messages.values()].sort(rowOrder),
				waiting,
				pending: [...pending.values()].sort(pendingOrder),
				hwm: envelope.sequence,
				hasMore: envelope.hasMore ?? false,
				...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
			};
			if (startedAt !== undefined)
				performance.measure("conduit:transcript-apply", {
					start: startedAt,
					end: performance.now(),
					detail: { partCount: partOrder.size },
				});
			return next;
		}
		case "upsert":
			return withRow(
				{ ...entry, hwm: Math.max(entry.hwm ?? 0, envelope.sequence) },
				envelope.item,
			);
		case "remove": {
			const hwm = Math.max(entry.hwm ?? 0, envelope.sequence);
			return Option.match(
				Schema.decodeUnknownOption(PartRemovalId)(envelope.id),
				{
					onSome: ([messageId, partId]) =>
						withParts(
							{
								...entry,
								hwm,
								partOrder: withoutOrders(entry.partOrder, [partId]),
							},
							messageId,
							(parts) => parts.filter((part) => part.id !== partId),
						),
					onNone: () => ({
						...entry,
						hwm,
						rows: entry.rows.filter((row) => row.id !== envelope.id),
						waiting: withoutWaiting(entry.waiting, envelope.id),
						pending: entry.pending.filter(
							(input) => `input:${input.inputId}` !== envelope.id,
						),
						partOrder: withoutOrders(
							entry.partOrder,
							[
								...(entry.rows.find((row) => row.id === envelope.id)?.parts ??
									[]),
								...(entry.waiting.get(envelope.id) ?? []),
							].map((part) => part.id),
						),
					}),
				},
			);
		}
		case "synchronized":
			return entry;
	}
}

const convertedParts: HistoryConversionCache["parts"] = new WeakMap();
/** What each slot's feed has applied, and where it resumes from, so its
 *  resumes are checked. Keyed by the slot, so it goes when the slot is
 *  evicted; reset with the transcript. */
const ledgers = new WeakMap<SessionMessages, ResumeLedger>();
// Projected UUIDs contain "/"; local generateUuid() values never do.
const uuidFor = (messageId: string, partId: string): string =>
	`${messageId}/${partId}`;
const toolRank = { pending: 0, running: 1, completed: 2, error: 2 };
const reuseIfEqual = (
	next: ChatMessage,
	previous: ChatMessage | undefined,
): ChatMessage =>
	previous &&
	Object.keys(next).length === Object.keys(previous).length &&
	Object.entries(next).every(([key, value]) =>
		Object.entries(previous).some(
			([oldKey, oldValue]) => oldKey === key && oldValue === value,
		),
	)
		? previous
		: next;

function mergeSticky(
	next: ChatMessage,
	previous: ChatMessage | undefined,
): ChatMessage {
	if (!previous || next.type !== previous.type) return next;
	if (next === previous) return previous;
	let merged: ChatMessage;
	if (next.type === "assistant" && previous.type === "assistant")
		merged = { ...next, finalized: next.finalized || previous.finalized };
	else if (next.type === "thinking" && previous.type === "thinking")
		merged = {
			...next,
			done: next.done || previous.done,
			...(next.duration === undefined && previous.duration !== undefined
				? { duration: previous.duration }
				: {}),
		};
	else if (next.type === "tool" && previous.type === "tool")
		merged = {
			...next,
			status:
				toolRank[previous.status] >= toolRank[next.status]
					? previous.status
					: next.status,
			...(next.input !== undefined || previous.input !== undefined
				? { input: next.input ?? previous.input }
				: {}),
			...(next.metadata !== undefined || previous.metadata !== undefined
				? { metadata: next.metadata ?? previous.metadata }
				: {}),
		};
	else merged = next;
	return reuseIfEqual(merged, previous);
}

/** Reuse unchanged parts; keep local items (errors, notices) in place. */
export function deriveTranscriptMessages(
	entry: TranscriptEntry,
	previous: ChatMessage[],
): ChatMessage[] {
	const previousByUuid = new Map(previous.map((item) => [item.uuid, item]));
	const messageOrders = new Map<
		string,
		NonNullable<ChatMessage["messageOrder"]>
	>();
	for (const item of previous)
		if (item.messageOrder)
			messageOrders.set(item.messageOrder.id, item.messageOrder);
	const cache: HistoryConversionCache = {
		parts: convertedParts,
		messageOrders,
	};
	const projected: ChatMessage[] = [];
	for (const row of entry.rows) {
		// A user row is created before its parts arrive; an empty bubble says nothing.
		if (row.role === "user" && !row.parts?.length) continue;
		const items = historyToChatMessages(
			[row],
			(text) => {
				const counts = globalThis.__conduitTranscriptMarkdownRenders;
				if (counts) counts[row.id] = (counts[row.id] ?? 0) + 1;
				return renderMarkdown(text);
			},
			entry.rows,
			uuidFor,
			cache,
		);
		for (const item of items)
			projected.push(mergeSticky(item, previousByUuid.get(item.uuid)));
	}
	const projectedIndex = new Map(projected.map((item, i) => [item.uuid, i]));
	const after = new Map<string, ChatMessage[]>();
	const atEnd: ChatMessage[] = [];
	let anchor: string | null = null;
	for (const item of previous) {
		if (projectedIndex.has(item.uuid)) {
			anchor = item.uuid;
			continue;
		}
		// A removed projected row must disappear, not become a local item.
		if (item.uuid.includes("/")) continue;
		// The legacy error arm's notice gives way to the projected turn error
		// that landed after it.
		const anchorIndex =
			anchor === null ? -1 : (projectedIndex.get(anchor) ?? -1);
		if (
			item.type === "system" &&
			item.variant === "error" &&
			projected.some(
				(other, i) =>
					i > anchorIndex &&
					other.type === "system" &&
					other.variant === "error" &&
					other.text === item.text,
			)
		)
			continue;
		if (anchor && projectedIndex.has(anchor)) {
			const group = after.get(anchor) ?? [];
			group.push(item);
			after.set(anchor, group);
		} else atEnd.push(item);
	}
	return projected
		.flatMap((item) => [item, ...(after.get(item.uuid) ?? [])])
		.concat(atEnd);
}

/** The session drawn from its saved page at load, until the server places it. */
export const savedDraw = $state({ sessionId: null as string | null });
/** The record each drawn slot came from; its view resumes from it. */
const drawn = new WeakMap<SessionMessages, SavedTranscript>();

/** The open session, once the server has placed it: null while it is only
 *  drawn from its saved page, so nothing asks the server about it yet. */
export const placedSessionId = (): string | null =>
	sessionState.currentId === savedDraw.sessionId
		? null
		: sessionState.currentId;

/** The route left the drawn session before the server placed it. Its record
 *  stays: nothing has disowned it. */
export function leaveSavedDraw(sessionId: string | undefined): void {
	const left = savedDraw.sessionId;
	if (left === null || left === sessionId) return;
	savedDraw.sessionId = null;
	if (sessionState.currentId === left) sessionState.currentId = null;
}

const emptyTranscript = (project: ProjectRef): TranscriptEntry => ({
	rows: [],
	hwm: null,
	hasMore: false,
	status: { _tag: "cold" },
	project,
	pending: [],
	waiting: new Map(),
	partOrder: new Map(),
});
const paging = new Map<string, Promise<void>>();

function install(
	sessionId: string,
	slot: ReturnType<typeof getOrCreateSessionSlot>,
): void {
	const entry = slot.messages.transcript;
	if (!entry || sessionMessages.get(sessionId) !== slot.messages) return;
	slot.messages.messages = deriveTranscriptMessages(
		entry,
		slot.messages.messages,
	);
	// The placed send takes over from the draft's copy in the same frame.
	if (
		draftSend.sessionId === sessionId &&
		slot.messages.messages.some((message) => message.type === "user")
	)
		draftSend.message = null;
	slot.messages.historyHasMore = entry.hasMore;
	slot.messages.loadLifecycle = "ready";
	if (sessionState.currentId === sessionId)
		historyState.hasMore = entry.hasMore;
	restoreContextFromMessages(slot.messages);
}

/**
 * Draw a session's saved page before the server has answered anything. It is
 * provisional: `placeSavedDraw` keeps it once the server places the session in
 * the record's project, and the view then resumes from it.
 */
export function drawSavedTranscript(record: SavedTranscript): void {
	const slot = getOrCreateSessionSlot(record.sessionId);
	if (slot.messages.transcript) return;
	slot.messages.transcript = applyTranscriptEnvelope(
		emptyTranscript(record.project),
		record.snapshot,
	);
	drawn.set(slot.messages, record);
	savedDraw.sessionId = record.sessionId;
	sessionState.currentId = record.sessionId;
	install(record.sessionId, slot);
}

/**
 * The server has placed the drawn session in `project` (null: it does not
 * exist). Anywhere but the record's project, the drawn page and its record go,
 * leaving exactly what a load without one shows.
 */
export function placeSavedDraw(
	sessionId: string,
	project: ProjectRef | null,
): void {
	if (savedDraw.sessionId !== sessionId) return;
	savedDraw.sessionId = null;
	const slot = sessionMessages.get(sessionId);
	if (slot && drawn.get(slot)?.project === project) return;
	clearSessionChatState(sessionId);
	void forgetTranscript(sessionId);
	if (sessionState.currentId === sessionId) sessionState.currentId = null;
}

/** One live transcript feed: viewing a session stops the feed of the one
 *  viewed before. Each view (the open session, the task drawer) owns one. */
function transcriptView(): {
	view: (project: ProjectRef, sessionId: string | null) => void;
	/** The viewed session's load: the same promise throughout, settling true
	 *  once its first load completes and false if it is left first. */
	loaded: (
		project: ProjectRef,
		sessionId: string,
	) => Promise<boolean> | undefined;
	requested: (
		project: ProjectRef,
		sessionId: string,
	) => Promise<void> | undefined;
} {
	let viewed: {
		project: ProjectRef;
		sessionId: string | null;
		/** Settles true once the first load completes, false if left first. */
		loaded: Promise<boolean>;
		settle: (loaded: boolean) => void;
		requested: Promise<void>;
		issue: () => void;
	} | null = null;
	let generation = 0;
	let fiber: RuntimeFiber<void, unknown> | null = null;
	let pendingFrame: number | ReturnType<typeof setTimeout> | null = null;
	/** This view's stops, chained: its feed starts only after every earlier
	 *  feed of this view is confirmed dead, so two feeds never share a ledger. */
	let stopped: Promise<void> = Promise.resolve();

	function cancelFrame(): void {
		if (pendingFrame === null) return;
		if (
			typeof cancelAnimationFrame === "function" &&
			typeof pendingFrame === "number"
		)
			cancelAnimationFrame(pendingFrame);
		else clearTimeout(pendingFrame);
		pendingFrame = null;
	}

	function stopFeed(): Promise<void> {
		const old = fiber;
		fiber = null;
		cancelFrame();
		stopped = stopped.then(async () => {
			if (old) await runTransportEffect(Fiber.interrupt(old));
		});
		return stopped;
	}

	return {
		view: (project, sessionId) => {
			if (viewed?.project === project && viewed.sessionId === sessionId) return;
			viewed?.settle(false);
			viewed?.issue();
			let settle: (loaded: boolean) => void = () => {};
			const loaded = new Promise<boolean>((resolve) => {
				settle = resolve;
			});
			let issue: () => void = () => {};
			const requested = new Promise<void>((resolve) => {
				issue = resolve;
			});
			viewed = { project, sessionId, loaded, settle, requested, issue };
			const currentGeneration = ++generation;
			const slot = sessionId ? getOrCreateSessionSlot(sessionId) : null;
			// Only a session this page has not loaded yet opens from a saved page.
			let saved: Promise<SavedTranscript | undefined> =
				Promise.resolve(undefined);
			const draw = slot ? drawn.get(slot.messages) : undefined;
			if (slot) drawn.delete(slot.messages);
			if (slot && sessionId) {
				if (draw?.project === project) {
					// Drawn at load and placed by the server: resume from that page.
					saved = Promise.resolve(draw);
					ledgers.delete(slot.messages);
				} else if (
					!slot.messages.transcript ||
					slot.messages.transcript.project !== project
				) {
					saved = openSavedTranscript(sessionId);
					ledgers.delete(slot.messages);
					slot.messages.transcript = emptyTranscript(project);
					slot.messages.loadLifecycle = "loading";
				} else {
					// The cached copy is only as current as the feed that stopped when we
					// left; it is not live again until the new feed synchronizes.
					slot.messages.transcript = {
						...slot.messages.transcript,
						status: { _tag: "cold" },
					};
					install(sessionId, slot);
				}
			}
			let opened: SavedSnapshot | undefined;
			let subscribed = false;
			let received = false;
			void saved.then((record) => {
				if (
					currentGeneration !== generation ||
					record?.project !== project ||
					!slot ||
					received
				)
					return;
				opened = record.snapshot;
				if (subscribed && slot.messages.transcript) {
					// A cold request is already in flight. Draw only until its first reply.
					slot.messages.transcript = applyTranscriptEnvelope(
						slot.messages.transcript,
						record.snapshot,
					);
					install(sessionId ?? record.sessionId, slot);
				}
			});
			void stopFeed().then(async () => {
				if (currentGeneration !== generation || !sessionId || !slot) return;
				const runtime = await getRuntime();
				if (currentGeneration !== generation) return;
				const ledger = ledgers.get(slot.messages) ?? makeResumeLedger();
				ledgers.set(slot.messages, ledger);
				// Drawn first, once; a restarted feed resumes from what it applied.
				let firstSubscription = true;
				// The server's snapshot, saved once it synchronizes with no change
				// between: only then is it exactly the rows at its sequence.
				let unsaved: SavedSnapshot | undefined;
				const next = runtime.runFork(
					Effect.flatMap(WsRpcClients, (clients) =>
						Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
							Stream.runForEach(
								supervise(
									Stream.suspend(() => {
										const first = firstSubscription ? opened : undefined;
										firstSubscription = false;
										subscribed = true;
										return subscriptions.sessionDetail({
											sessionId,
											ledger,
											saved: first,
											onSubscribe: issue,
										});
									}),
									(status) => {
										if (
											currentGeneration === generation &&
											slot.messages.transcript
										)
											slot.messages.transcript = {
												...slot.messages.transcript,
												status,
											};
									},
								),
								(envelope) =>
									Effect.sync(() => {
										if (
											currentGeneration !== generation ||
											!slot.messages.transcript
										)
											return;
										received = true;
										const before = slot.messages.transcript;
										const item =
											envelope._tag === "upsert" ? envelope.item : undefined;
										const messageId =
											item?._tag === "part"
												? item.messageId
												: item?._tag === "message"
													? item.message.id
													: undefined;
										const was = before.rows.find((row) => row.id === messageId);
										// Skill names and running state follow the tool's input,
										// output and status, which can arrive in separate updates.
										if (
											item?._tag === "part" &&
											item.part.tool?.toLowerCase() === "skill" &&
											JSON.stringify(item.part.state) !==
												JSON.stringify(
													(
														was?.parts ?? before.waiting.get(item.messageId)
													)?.find((old) => old.id === item.part.id)?.state,
												)
										)
											refreshSessionSkills(sessionId);
										if (envelope._tag === "synchronized" && unsaved) {
											const snapshot = unsaved;
											// A restored server may be older than the saved page. Keep its
											// CAS token even when the network won and nothing was drawn.
											void saved.then((record) =>
												saveTranscript(
													sessionId,
													project,
													snapshot,
													record?.project === project
														? record.snapshot.resumePoint
														: undefined,
												),
											);
										}
										unsaved =
											envelope._tag === "snapshot" && envelope !== opened
												? envelope
												: undefined;
										const after = applyTranscriptEnvelope(before, envelope);
										slot.messages.transcript = after;
										const now = after.rows.find((row) => row.id === messageId);
										if (
											now?.role === "assistant" &&
											!was &&
											before.status._tag === "live"
										)
											advanceTurnIfNewMessage(
												slot.activity,
												slot.messages,
												now.id,
											);
										// A user row is new when it first has parts to show. A message
										// may name a skill; the chip reloads the session's skills.
										if (
											now?.role === "user" &&
											now.parts?.length &&
											!was?.parts?.length
										)
											refreshSessionSkills(sessionId);
										if (
											envelope._tag === "snapshot" ||
											envelope._tag === "synchronized"
										) {
											cancelFrame();
											install(sessionId, slot);
											if (envelope._tag === "synchronized")
												viewed?.settle(true);
										} else if (pendingFrame === null) {
											const render = () => {
												pendingFrame = null;
												if (currentGeneration === generation)
													install(sessionId, slot);
											};
											pendingFrame =
												typeof requestAnimationFrame === "function"
													? requestAnimationFrame(render)
													: setTimeout(render, FRAME_FALLBACK_DELAY_MS);
										}
									}),
							),
						),
					),
				);
				if (currentGeneration === generation) fiber = next;
				else runtime.runFork(Fiber.interrupt(next));
			});
		},
		loaded: (project, sessionId) =>
			viewed?.project === project && viewed.sessionId === sessionId
				? viewed.loaded
				: undefined,
		requested: (project, sessionId) =>
			viewed?.project === project && viewed.sessionId === sessionId
				? viewed.requested
				: undefined,
	};
}

const openView = transcriptView();
/** The open session's transcript feed. */
export const viewTranscript = openView.view;
/** The open session's view while it is open. */
export const sessionViewLoaded = openView.loaded;
/** Settles when the detail request starts, or the pending view is left. */
export const sessionDetailRequested = openView.requested;
/** The desktop task drawer's feed for the selected task's Child Session. */
export const viewTaskTranscript = transcriptView().view;

export function transcriptStatus(sessionId: string): FeedStatus {
	return sessionMessages.get(sessionId)?.transcript?.status ?? { _tag: "cold" };
}

/** What a transcript view shows about its feed. Cold and catching up look the
 *  same to a reader: rows may be on screen but are not current yet. No
 *  transcript at all (no session open) has nothing to wait for. */
export function transcriptFeed(
	entry: Pick<TranscriptEntry, "status"> | null,
): "live" | "catchingUp" | "failing" {
	if (!entry || entry.status._tag === "live") return "live";
	return entry.status._tag === "failing" ? "failing" : "catchingUp";
}

export function loadOlderTranscript(sessionId: string): Promise<void> {
	const existing = paging.get(sessionId);
	if (existing) return existing;
	const slot = getOrCreateSessionSlot(sessionId);
	const entry = slot.messages.transcript;
	if (!entry || !entry.hasMore || !entry.rows[0]) return Promise.resolve();
	slot.messages.historyLoading = true;
	if (sessionState.currentId === sessionId) historyState.loading = true;
	const request = loadMoreHistoryRpc({
		projectSlug: entry.project,
		sessionId,
		before: entry.rows[0].id,
	})
		.then((response) => {
			if (
				sessionMessages.get(sessionId) !== slot.messages ||
				!slot.messages.transcript
			)
				return;
			slot.messages.transcript = applyTranscriptEnvelope(
				slot.messages.transcript,
				response,
			);
			install(sessionId, slot);
		})
		.finally(() => {
			slot.messages.historyLoading = false;
			if (sessionState.currentId === sessionId) historyState.loading = false;
			paging.delete(sessionId);
		});
	paging.set(sessionId, request);
	return request;
}
