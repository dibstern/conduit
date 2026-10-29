import { Effect, Fiber, Option, Schema, Stream } from "effect";
import { ProjectSetupStateSchema } from "../../contracts/project-setup.js";
import {
	PartRemovalId,
	type SessionDetailEnvelope,
	type SessionDetailWindow,
	type SessionDetailWindowRequest,
	type SessionPromptSummary,
} from "../../contracts/ws-rpc.js";
import { makeResumeLedger, type ResumeLedger } from "../transport/resume.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { type FeedStatus, supervise } from "../transport/supervise.js";
import { rpc } from "../transport/ws-rpc-client.js";
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
import { isSubagentToolName } from "../utils/subagent-tools.js";
import {
	advanceTurnIfNewMessage,
	clearSessionChatState,
	createEmptySessionMessages,
	getOrCreateSessionActivity,
	getOrCreateSessionSlot,
	historyState,
	localSends,
	type PendingInput,
	restoreContextFromMessages,
	SessionMessages,
	sessionMessages,
} from "./chat.svelte.js";
import {
	forgetTranscript,
	openSavedTranscript,
	type SavedSnapshot,
	type SavedTranscript,
	saveTranscript,
} from "./saved-transcripts.js";
import { selection } from "./selection.svelte.js";
import { sessionState } from "./session.svelte.js";
import { refreshSessionSkills } from "./session-skills.svelte.js";
import { settleTurnInput } from "./turn.svelte.js";

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
						...(modelExecution.effort === undefined
							? {}
							: { effort: modelExecution.effort }),
						...(modelExecution.contextWindow === undefined
							? {}
							: { contextWindow: modelExecution.contextWindow }),
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
		case "window":
			return { ...entry, window: item.window, hasMore: item.window.hasEarlier };
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
		| Awaited<ReturnType<typeof rpc<"LoadMoreHistory">>>,
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
				window: undefined,
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
					case "window":
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
				hasMore: next.window?.hasEarlier ?? envelope.hasMore ?? false,
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
// History reports a running tool as completed, so a later failure must outrank it.
const toolRank = { pending: 0, running: 1, completed: 2, error: 3 };
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
export const placedSessionId = (): string | null => {
	const shown = selection.shown;
	return shown.kind === "placed" ? shown.sessionId : null;
};

/** The route left the drawn session before the server placed it. Its record
 *  stays: nothing has disowned it. */
export function leaveSavedDraw(sessionId: string | undefined): void {
	const left = savedDraw.sessionId;
	if (left === null || left === sessionId) return;
	savedDraw.sessionId = null;
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
function install(
	sessionId: string,
	slot: ReturnType<typeof getOrCreateSessionSlot>,
	primary = true,
): void {
	const entry = slot.messages.transcript;
	if (!entry || (primary && sessionMessages.get(sessionId) !== slot.messages))
		return;
	slot.messages.messages = deriveTranscriptMessages(
		entry,
		slot.messages.messages,
	);
	slot.messages.historyHasMore = entry.hasMore;
	slot.messages.loadLifecycle = "ready";
	if (primary && sessionState.currentId === sessionId)
		historyState.hasMore = entry.hasMore;
	// Context belongs to this slot. A private view never changes the primary's
	// estimate; its read projection uses session context when it is available.
	if (entry.window?.kind !== "historical")
		restoreContextFromMessages(slot.messages);
	reconcileInputs(sessionId, entry);
}

/** Persisted input identities settle the session's one local input owner. */
function reconcileInputs(sessionId: string, entry: TranscriptEntry): void {
	// A run can end before its user message is placed, leaving no shell
	// completion boundary for its send intent. The live row ends that exact input.
	if (entry.status._tag === "live")
		for (const row of entry.rows)
			if (
				row.role === "user" &&
				row.inputId &&
				row.turnTiming?.endedAt !== undefined
			)
				settleTurnInput(row.inputId);
	// The placed send, or its tray row, takes over from the local copy in the
	// same frame.
	for (const [inputId, send] of localSends)
		if (
			send.sessionId === sessionId &&
			(entry.rows.some(
				(row) => row.role === "user" && row.inputId === inputId,
			) ||
				entry.pending.some((input) => input.inputId === inputId))
		)
			localSends.delete(inputId);
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
): boolean {
	if (savedDraw.sessionId !== sessionId) return false;
	savedDraw.sessionId = null;
	const slot = sessionMessages.get(sessionId);
	if (slot && drawn.get(slot)?.project === project) return false;
	clearSessionChatState(sessionId);
	void forgetTranscript(sessionId);
	return true;
}

/** One live transcript feed: viewing a session stops the feed of the one
 *  viewed before. Each view (the open session, the task drawer) owns one. */
export interface TranscriptView {
	readonly id: symbol;
	readonly generation: number;
	readonly sessionId: string | null;
	readonly chat: Readonly<SessionMessages>;
	readonly pageError: unknown;
	readonly prompts: readonly SessionPromptSummary[];
	readonly window: SessionDetailWindow;
	readonly navigation: {
		id: number;
		target: { messageId: string } | "latest";
		phase: "loading" | "placing";
	} | null;
	readonly transition: { id: number; kind: "replace" | "prepend" } | null;
	navigate: (messageId: string) => void;
	loadMessage: (messageId: string) => Promise<void>;
	latest: () => void;
	loadNewer: () => Promise<void>;
	acknowledgePlacement: (id: number, placed?: boolean) => void;
	loadOlder: () => Promise<void>;
	dispose: () => void;
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
}

function transcriptView(primary: boolean): TranscriptView {
	type Slot = ReturnType<typeof getOrCreateSessionSlot>;
	type Body = {
		entry: TranscriptEntry;
		ledger: ResumeLedger;
		request: SessionDetailWindowRequest | undefined;
		fiber: Fiber.Fiber<void, unknown> | null;
		frame: ReturnType<typeof setTimeout> | number | null;
		alive: boolean;
		ready: Promise<void>;
		finish: () => void;
	};
	let currentSlot = $state.raw<Slot | null>(null);
	let currentSessionId = $state<string | null>(null);
	let pageError = $state.raw<unknown>(null);
	let prompts = $state.raw<readonly SessionPromptSummary[]>([]);
	let navigation = $state.raw<TranscriptView["navigation"]>(null);
	let transition = $state.raw<TranscriptView["transition"]>(null);
	let revision = $state(0);
	let generation = 0;
	let paging: Promise<void> | null = null;
	let active: Body | null = null;
	let pending: Body | null = null;
	let indexFiber: Fiber.Fiber<void, unknown> | null = null;
	let scheduledNavigation: {
		timer: ReturnType<typeof setTimeout>;
		run: () => void;
		finish: () => void;
	} | null = null;
	let stopped: Promise<void> = Promise.resolve();
	const empty = createEmptySessionMessages();
	let viewed: {
		project: ProjectRef;
		sessionId: string | null;
		loaded: Promise<boolean>;
		settle: (loaded: boolean) => void;
		requested: Promise<void>;
		issue: () => void;
	} | null = null;

	function cancelFrame(body: Body): void {
		if (body.frame === null) return;
		if (
			typeof cancelAnimationFrame === "function" &&
			typeof body.frame === "number"
		)
			cancelAnimationFrame(body.frame);
		else clearTimeout(body.frame);
		body.frame = null;
	}

	function interrupt(fiber: Fiber.Fiber<void, unknown> | null): void {
		if (fiber)
			stopped = stopped.then(() => runTransportEffect(Fiber.interrupt(fiber)));
	}

	function retire(body: Body | null): void {
		if (!body) return;
		body.alive = false;
		cancelFrame(body);
		body.finish();
		interrupt(body.fiber);
	}

	function cancelPending(): void {
		retire(pending);
		pending = null;
		if (currentSlot) currentSlot.messages.historyLoading = false;
		if (primary) historyState.loading = false;
		paging = null;
	}

	function cancelScheduled(): void {
		if (!scheduledNavigation) return;
		clearTimeout(scheduledNavigation.timer);
		scheduledNavigation.finish();
		scheduledNavigation = null;
	}

	function startIndex(project: string, sessionId: string, epoch: number): void {
		let staged: Map<string, SessionPromptSummary> | null = null;
		let failure: Error | undefined;
		const ordered = (rows: Iterable<SessionPromptSummary>) =>
			[...rows].sort(
				(a, b) =>
					a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			);
		void stopped.then(async () => {
			if (epoch !== generation) return;
			const runtime = await getRuntime();
			if (epoch !== generation) return;
			const fiber = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								subscriptions.sessionPromptIndex({ sessionId }),
								(status) => {
									if (
										epoch === generation &&
										(status._tag === "failed" || status._tag === "failing")
									) {
										failure = new Error(status.lastError);
										pageError = failure;
									}
								},
							),
							(envelope) =>
								Effect.sync(() => {
									if (epoch !== generation) return;
									switch (envelope._tag) {
										case "snapshot":
											staged = new Map(
												envelope.rows.map((row) => [row.id, row]),
											);
											break;
										case "snapshotChunk":
											for (const row of envelope.rows) staged?.set(row.id, row);
											break;
										case "synchronized":
											if (staged) prompts = ordered(staged.values());
											staged = null;
											if (pageError === failure) pageError = null;
											failure = undefined;
											break;
										case "upsert": {
											const next =
												staged ?? new Map(prompts.map((row) => [row.id, row]));
											next.set(envelope.item.id, envelope.item);
											if (!staged) prompts = ordered(next.values());
											break;
										}
										case "remove":
											if (staged) staged.delete(envelope.id);
											else
												prompts = prompts.filter(
													(row) => row.id !== envelope.id,
												);
											break;
									}
								}),
						),
					),
				),
			);
			if (epoch === generation) indexFiber = fiber;
			else interrupt(fiber);
		});
	}

	function startBody(
		request: SessionDetailWindowRequest | undefined,
		navigationId?: number,
		pageDirection?: "before" | "after",
		saved: Promise<SavedTranscript | undefined> = Promise.resolve(undefined),
		place = true,
	): Promise<void> {
		const session = viewed;
		const slot = currentSlot;
		if (!session?.sessionId || !slot) return Promise.resolve();
		const { project, sessionId } = session;
		const epoch = generation;
		const replacement = navigationId !== undefined;
		let finish = () => {};
		const body: Body = {
			entry: replacement
				? emptyTranscript(project)
				: (slot.messages.transcript ?? emptyTranscript(project)),
			ledger: replacement
				? makeResumeLedger()
				: (ledgers.get(slot.messages) ?? makeResumeLedger()),
			request,
			fiber: null,
			frame: null,
			alive: true,
			ready: new Promise<void>((resolve) => {
				finish = resolve;
			}),
			finish: () => finish(),
		};
		if (replacement) pending = body;
		else {
			active = body;
			ledgers.set(slot.messages, body.ledger);
		}
		const current = () =>
			epoch === generation &&
			body.alive &&
			(body === active || body === pending);
		const publish = () => {
			if (!current() || active !== body) return;
			slot.messages.transcript = body.entry;
			install(sessionId, slot, primary);
		};
		let opened: SavedSnapshot | undefined;
		let subscribed = false;
		let received = false;
		void saved.then((record) => {
			if (!current() || record?.project !== project || received) return;
			opened = record.snapshot;
			if (subscribed) {
				body.entry = applyTranscriptEnvelope(body.entry, record.snapshot);
				publish();
			}
		});
		void stopped.then(async () => {
			if (!current()) return;
			const runtime = await getRuntime();
			if (!current()) return;
			let firstSubscription = true;
			let unsaved: SavedSnapshot | undefined;
			const fiber = runtime.runFork(
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
										ledger: body.ledger,
										saved: first,
										...(request ? { window: request } : {}),
										onSubscribe: session.issue,
									});
								}),
								(status) => {
									if (!current()) return;
									body.entry = { ...body.entry, status };
									if (
										body === pending &&
										(status._tag === "failing" || status._tag === "failed")
									) {
										pageError = new Error(status.lastError);
										if (navigation?.id === navigationId) navigation = null;
										retire(body);
										pending = null;
									} else if (body === active) {
										slot.messages.transcript = body.entry;
										if (status._tag === "failed")
											pageError = new Error(status.lastError);
									}
								},
							),
							(envelope) =>
								Effect.sync(() => {
									if (!current()) return;
									received = true;
									const before = body.entry;
									body.entry = applyTranscriptEnvelope(before, envelope);
									if (envelope._tag === "synchronized") {
										if (body === pending && navigationId !== undefined) {
											if (
												pageDirection &&
												body.entry.rows.length === 0 &&
												active
											) {
												const window = view.window;
												active.entry = {
													...active.entry,
													hasMore:
														pageDirection === "before"
															? false
															: active.entry.hasMore,
													window: {
														...window,
														...(pageDirection === "before"
															? { hasEarlier: false }
															: { hasLater: false }),
													},
												};
												slot.messages.transcript = active.entry;
												install(sessionId, slot, primary);
												retire(body);
												pending = null;
												navigation = null;
												return;
											}
											retire(active);
											active = body;
											pending = null;
											ledgers.set(slot.messages, body.ledger);
											transition = { id: navigationId, kind: "replace" };
											const requested = navigation;
											if (requested && requested.id === navigationId) {
												const rows = body.entry.rows.filter(
													(row) => row.role === "user",
												);
												const target =
													pageDirection === "before"
														? rows.at(-1)?.id
														: pageDirection === "after"
															? rows[0]?.id
															: undefined;
												navigation = place
													? {
															...requested,
															...(target
																? { target: { messageId: target } }
																: {}),
															phase: "placing",
														}
													: null;
											}
										}
										cancelFrame(body);
										publish();
										session.settle(true);
										body.finish();
										if (primary && !request && unsaved) {
											const snapshot = unsaved;
											void saved.then((record) =>
												current() && active === body
													? saveTranscript(
															sessionId,
															project,
															snapshot,
															record?.project === project
																? record.snapshot.resumePoint
																: undefined,
														)
													: undefined,
											);
										}
										unsaved = undefined;
										return;
									}
									unsaved =
										envelope._tag === "snapshot" && envelope !== opened
											? envelope
											: undefined;
									// A replacement and each historical refresh become visible only at
									// the synchronized barrier. The committed window remains readable.
									if (body === pending || request) return;
									slot.messages.transcript = body.entry;
									const item =
										envelope._tag === "upsert" ? envelope.item : undefined;
									const messageId =
										item?._tag === "part"
											? item.messageId
											: item?._tag === "message"
												? item.message.id
												: undefined;
									const was = before.rows.find((row) => row.id === messageId);
									const now = body.entry.rows.find(
										(row) => row.id === messageId,
									);
									if (
										item?._tag === "part" &&
										item.part.tool?.toLowerCase() === "skill" &&
										JSON.stringify(item.part.state) !==
											JSON.stringify(
												(
													was?.parts ?? before.waiting.get(item.messageId)
												)?.find((part) => part.id === item.part.id)?.state,
											)
									)
										refreshSessionSkills(sessionId);
									if (
										primary &&
										now?.role === "assistant" &&
										!was &&
										before.status._tag === "live"
									)
										advanceTurnIfNewMessage(
											slot.activity,
											slot.messages,
											now.id,
										);
									if (
										now?.role === "user" &&
										now.parts?.length &&
										!was?.parts?.length
									)
										refreshSessionSkills(sessionId);
									if (
										envelope._tag === "snapshot" ||
										item?._tag === "pendingInput"
									) {
										cancelFrame(body);
										publish();
									} else if (body.frame === null) {
										const render = () => {
											body.frame = null;
											publish();
										};
										body.frame =
											typeof requestAnimationFrame === "function"
												? requestAnimationFrame(render)
												: setTimeout(render, FRAME_FALLBACK_DELAY_MS);
									}
								}),
						),
					),
				),
			);
			if (current()) body.fiber = fiber;
			else interrupt(fiber);
		});
		return body.ready;
	}

	function requestNavigation(
		target: NonNullable<TranscriptView["navigation"]>["target"],
		request?: SessionDetailWindowRequest,
		direction?: "before" | "after",
		place = true,
	): Promise<void> {
		cancelPending();
		pageError = null;
		const id = ++revision;
		const loaded =
			active?.entry.status._tag !== "failed" &&
			(target === "latest"
				? view.window.kind === "latest"
				: view.chat.transcript?.rows.some(
						(row) => row.id === target.messageId,
					));
		navigation = {
			id,
			target,
			phase: loaded && !direction ? "placing" : "loading",
		};
		if (loaded && !direction) {
			if (!place) navigation = null;
			cancelScheduled();
			return Promise.resolve();
		}
		// Sample at most once per frame interval. A continuous drag keeps making
		// progress; moves between samples replace only the queued target.
		return new Promise<void>((resolve) => {
			const run = () => {
				if (navigation?.id !== id) {
					resolve();
					return;
				}
				void startBody(request, id, direction, undefined, place).then(resolve);
			};
			if (scheduledNavigation) {
				scheduledNavigation.finish();
				scheduledNavigation.run = run;
				scheduledNavigation.finish = resolve;
			} else {
				const timer = setTimeout(() => {
					const scheduled = scheduledNavigation;
					scheduledNavigation = null;
					scheduled?.run();
				}, 16);
				scheduledNavigation = { timer, run, finish: resolve };
			}
		});
	}

	const view: TranscriptView = {
		id: Symbol("transcript-view"),
		get generation() {
			return revision;
		},
		get sessionId() {
			return primary ? placedSessionId() : currentSessionId;
		},
		get chat() {
			if (primary) return sessionMessages.get(placedSessionId() ?? "") ?? empty;
			// Private windows read session notices and terminal state without
			// becoming another writer of the session's activity or messages.
			const owned = currentSlot?.messages ?? empty;
			const shared = sessionMessages.get(currentSessionId ?? "");
			const activity = currentSlot?.activity;
			const ended =
				activity?.phase === "idle" &&
				activity.endedGeneration === activity.turnGeneration;
			const existing = new Map(
				shared?.messages.map((message) => [message.uuid, message]),
			);
			const messages = owned.messages.map((message): ChatMessage => {
				const merged = mergeSticky(message, existing.get(message.uuid));
				if (!ended) return merged;
				if (merged.type === "assistant" && !merged.finalized)
					return { ...merged, finalized: true };
				if (merged.type === "thinking" && !merged.done)
					return { ...merged, done: true, duration: 0 };
				if (
					merged.type === "tool" &&
					(merged.status === "pending" || merged.status === "running") &&
					!isSubagentToolName(merged.name)
				)
					return { ...merged, status: "completed" };
				return merged;
			});
			const ids = new Set(messages.map((message) => message.uuid));
			for (const message of shared?.messages ?? [])
				if (!message.uuid.includes("/") && !ids.has(message.uuid))
					messages.push(message);
			return {
				messages,
				transcript: owned.transcript,
				currentAssistantText: owned.currentAssistantText,
				loadLifecycle: owned.loadLifecycle,
				contextPercent: shared?.contextPercent ?? owned.contextPercent,
				historyHasMore: owned.historyHasMore,
				historyLoading: owned.historyLoading,
			};
		},
		get prompts() {
			return prompts;
		},
		get navigation() {
			return navigation;
		},
		get transition() {
			return transition;
		},
		get pageError() {
			return pageError;
		},
		get window() {
			const entry = view.chat.transcript;
			return (
				entry?.window ?? {
					kind: "latest",
					hasEarlier: entry?.hasMore ?? false,
					hasLater: false,
					...(entry?.rows[0] ? { firstMessageId: entry.rows[0].id } : {}),
					...(entry?.rows.at(-1)
						? { lastMessageId: entry.rows.at(-1)?.id }
						: {}),
				}
			);
		},
		navigate: (messageId) => {
			void requestNavigation(
				{ messageId },
				{ anchorMessageId: messageId, direction: "from" },
			);
		},
		loadMessage: (messageId) =>
			requestNavigation(
				{ messageId },
				{ anchorMessageId: messageId, direction: "from" },
				undefined,
				false,
			),
		latest: () => {
			void requestNavigation("latest");
		},
		acknowledgePlacement: (id, placed = true) => {
			if (navigation?.id !== id || navigation.phase !== "placing") return;
			navigation = null;
			if (!placed)
				pageError = new Error("This message is no longer available.");
		},
		dispose: () => view.view(viewed?.project ?? "", null),
		loadNewer: () => {
			const { lastMessageId, hasLater } = view.window;
			return hasLater && lastMessageId
				? requestNavigation(
						{ messageId: lastMessageId },
						{ anchorMessageId: lastMessageId, direction: "after" },
						"after",
					)
				: Promise.resolve();
		},
		loadOlder: () => {
			const window = view.window;
			if (window.kind === "historical")
				return window.hasEarlier && window.firstMessageId
					? requestNavigation(
							{ messageId: window.firstMessageId },
							{ anchorMessageId: window.firstMessageId, direction: "before" },
							"before",
						)
					: Promise.resolve();
			if (primary && view.sessionId !== currentSessionId)
				return Promise.resolve();
			if (paging) return paging;
			const target = currentSlot;
			const id = currentSessionId;
			const entry = target?.messages.transcript;
			if (!target || !id || !entry?.hasMore || !entry.rows[0])
				return Promise.resolve();
			const currentGeneration = generation;
			const body = active;
			const pageRevision = ++revision;
			pageError = null;
			target.messages.historyLoading = true;
			if (primary && sessionState.currentId === id) historyState.loading = true;
			const current = () =>
				generation === currentGeneration &&
				active === body &&
				revision === pageRevision &&
				currentSlot === target &&
				paging === request;
			const request = rpc("LoadMoreHistory", {
				sessionId: id,
				before: entry.rows[0].id,
			})
				.then((response) => {
					if (!current() || !target.messages.transcript) return;
					// Unary pages have no read version. Any intervening envelope,
					// including one at the same sequence, can make this page stale.
					// Discard it and permit a retry instead of resurrecting old rows.
					if (target.messages.transcript !== entry) return;
					target.messages.transcript = applyTranscriptEnvelope(
						target.messages.transcript,
						response,
					);
					if (target.messages.transcript.window)
						target.messages.transcript = {
							...target.messages.transcript,
							window: {
								...target.messages.transcript.window,
								firstMessageId: target.messages.transcript.rows[0]?.id,
								hasEarlier: response.hasMore,
							},
						};
					if (body) body.entry = target.messages.transcript;
					transition = { id: pageRevision, kind: "prepend" };
					install(id, target, primary);
				})
				.catch((error: unknown) => {
					if (current()) pageError = error;
					throw error;
				})
				.finally(() => {
					if (!current()) return;
					target.messages.historyLoading = false;
					if (primary && sessionState.currentId === id)
						historyState.loading = false;
					paging = null;
				});
			paging = request;
			return request;
		},
		view: (project, sessionId) => {
			if (viewed?.project === project && viewed.sessionId === sessionId) return;
			viewed?.settle(false);
			viewed?.issue();
			++generation;
			++revision;
			cancelScheduled();
			cancelPending();
			retire(active);
			active = null;
			interrupt(indexFiber);
			indexFiber = null;
			prompts = [];
			navigation = null;
			transition = null;
			pageError = null;
			let settle = (_loaded: boolean) => {};
			let issue = () => {};
			const loaded = new Promise<boolean>((resolve) => {
				settle = resolve;
			});
			const requested = new Promise<void>((resolve) => {
				issue = resolve;
			});
			viewed = { project, sessionId, loaded, settle, requested, issue };
			currentSessionId = sessionId;
			currentSlot = sessionId
				? primary
					? getOrCreateSessionSlot(sessionId)
					: {
							activity: getOrCreateSessionActivity(sessionId),
							messages: new SessionMessages(),
						}
				: null;
			const slot = currentSlot;
			if (!sessionId || !slot) {
				settle(false);
				issue();
				return;
			}
			let saved: Promise<SavedTranscript | undefined> =
				Promise.resolve(undefined);
			const draw = drawn.get(slot.messages);
			drawn.delete(slot.messages);
			if (draw?.project === project) {
				saved = Promise.resolve(draw);
				ledgers.delete(slot.messages);
			} else if (
				!slot.messages.transcript ||
				slot.messages.transcript.project !== project ||
				slot.messages.transcript.window?.kind === "historical"
			) {
				saved = primary
					? openSavedTranscript(sessionId)
					: Promise.resolve(undefined);
				ledgers.delete(slot.messages);
				slot.messages.transcript = emptyTranscript(project);
				slot.messages.loadLifecycle = "loading";
			} else {
				slot.messages.transcript = {
					...slot.messages.transcript,
					status: { _tag: "cold" },
				};
				install(sessionId, slot, primary);
			}
			startIndex(project, sessionId, generation);
			void startBody(undefined, undefined, undefined, saved);
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
	return view;
}

export const primaryTranscript = transcriptView(true);
const openView = primaryTranscript;
/** The open session's transcript feed. */
export const viewTranscript = openView.view;
/** The open session's view while it is open. */
export const sessionViewLoaded = openView.loaded;
/** Settles when the detail request starts, or the pending view is left. */
export const sessionDetailRequested = openView.requested;
/** The desktop task drawer's feed for the selected task's Child Session. */
export function createTranscriptView(): TranscriptView {
	return transcriptView(false);
}

export function transcriptStatus(sessionId: string): FeedStatus {
	return sessionMessages.get(sessionId)?.transcript?.status ?? { _tag: "cold" };
}

/** What a transcript view shows about its feed. Cold and catching up look the
 *  same to a reader: rows may be on screen but are not current yet. No
 *  transcript at all (no session open) has nothing to wait for. */
export function transcriptFeed(
	entry: Pick<TranscriptEntry, "status"> | null,
): "live" | "catchingUp" | "failing" | "failed" {
	if (!entry || entry.status._tag === "live") return "live";
	if (entry.status._tag === "failed") return "failed";
	return entry.status._tag === "failing" ? "failing" : "catchingUp";
}

export function loadOlderTranscript(sessionId: string): Promise<void> {
	return primaryTranscript.sessionId === sessionId
		? primaryTranscript.loadOlder()
		: Promise.resolve();
}
