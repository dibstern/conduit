import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { SessionDetailEnvelope } from "../../contracts/ws-rpc.js";
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
import { historyToChatMessages } from "../utils/history-logic.js";
import { renderMarkdown } from "../utils/markdown.js";
import {
	advanceTurnIfNewMessage,
	getOrCreateSessionSlot,
	historyState,
	type PendingInput,
	restoreContextFromMessages,
	type SessionMessages,
	seedRegistryFromMessages,
	sessionMessages,
} from "./chat.svelte.js";
import { sessionState } from "./session.svelte.js";
import { refreshSessionSkills } from "./session-skills.svelte.js";

type ProjectRef = string;
export type TranscriptEntry = NonNullable<SessionMessages["transcript"]>;
type DetailRow = Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"] & {
	_tag: "transcriptMessage";
};

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

function toHistoryMessage(source: DetailRow["message"]): HistoryMessage {
	const parts = source.parts?.flatMap((part): HistoryMessagePart[] => {
		if (!isPartType(part.type)) return [];
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
			...base
		} = part;
		const partTime = record(time);
		return [
			{
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
								...(typeof state["output"] === "string"
									? { output: state["output"] }
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
			},
		];
	});
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

/** The server sends whole rows. Keep the held page contiguous below its floor. */
export function applyTranscriptEnvelope(
	entry: TranscriptEntry,
	envelope: SessionDetailEnvelope,
): TranscriptEntry {
	switch (envelope._tag) {
		case "snapshot": {
			const inbox = envelope.rows.flatMap((item) =>
				item._tag === "inbox" ? [item.inbox] : [],
			)[0];
			return {
				...entry,
				rows: envelope.rows
					.filter((item) => item._tag === "transcriptMessage")
					.map((item) => toHistoryMessage(item.message))
					.sort(rowOrder),
				pending: envelope.rows
					.flatMap((item) => (item._tag === "pendingInput" ? [item.input] : []))
					.sort(pendingOrder),
				paused: inbox?.paused ?? false,
				steer: inbox?.steer,
				hwm: envelope.sequence,
				hasMore: envelope.hasMore ?? false,
				...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
			};
		}
		case "upsert": {
			const hwm = Math.max(entry.hwm ?? 0, envelope.sequence);
			if (envelope.item._tag === "pendingInput") {
				const input = envelope.item.input;
				return {
					...entry,
					hwm,
					pending: [
						...entry.pending.filter((old) => old.inputId !== input.inputId),
						input,
					].sort(pendingOrder),
				};
			}
			if (envelope.item._tag === "inbox")
				return { ...entry, hwm, ...envelope.item.inbox };
			if (envelope.item._tag !== "transcriptMessage") return { ...entry, hwm };
			const row = toHistoryMessage(envelope.item.message);
			const held = entry.rows.some((old) => old.id === row.id);
			if (
				entry.hasMore &&
				!held &&
				entry.rows[0] &&
				rowOrder(row, entry.rows[0]) < 0
			)
				return { ...entry, hwm };
			return {
				...entry,
				hwm,
				rows: [...entry.rows.filter((old) => old.id !== row.id), row].sort(
					rowOrder,
				),
			};
		}
		case "remove":
			return {
				...entry,
				hwm: Math.max(entry.hwm ?? 0, envelope.sequence),
				rows: entry.rows.filter((row) => row.id !== envelope.id),
				pending: entry.pending.filter(
					(input) => `input:${input.inputId}` !== envelope.id,
				),
			};
		case "synchronized":
			return entry;
	}
}

const convertedRows = new WeakMap<HistoryMessage, ChatMessage[]>();
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

/** Reuse unchanged row items; keep local items (errors, notices) in place. */
export function deriveTranscriptMessages(
	entry: TranscriptEntry,
	previous: ChatMessage[],
): ChatMessage[] {
	const previousByUuid = new Map(previous.map((item) => [item.uuid, item]));
	const projected: ChatMessage[] = [];
	for (const row of entry.rows) {
		// A user row is created before its parts arrive; an empty bubble says nothing.
		if (row.role === "user" && !row.parts?.length) continue;
		let items = convertedRows.get(row);
		if (!items) {
			items = historyToChatMessages([row], renderMarkdown, entry.rows, uuidFor);
			convertedRows.set(row, items);
		}
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

let viewed: { project: ProjectRef; sessionId: string | null } | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, unknown> | null = null;
let pendingFrame: number | ReturnType<typeof setTimeout> | null = null;
const paging = new Map<string, Promise<void>>();

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
	slot.messages.historyHasMore = entry.hasMore;
	slot.messages.loadLifecycle = "ready";
	if (sessionState.currentId === sessionId)
		historyState.hasMore = entry.hasMore;
	slot.messages.toolRegistry.clear();
	seedRegistryFromMessages(
		slot.activity,
		slot.messages,
		slot.messages.messages,
	);
	restoreContextFromMessages(slot.messages);
}

async function stopFeed(): Promise<void> {
	const old = fiber;
	fiber = null;
	cancelFrame();
	if (old) await runTransportEffect(Fiber.interrupt(old));
}

export function viewTranscript(
	project: ProjectRef,
	sessionId: string | null,
): void {
	if (viewed?.project === project && viewed.sessionId === sessionId) return;
	viewed = { project, sessionId };
	const currentGeneration = ++generation;
	const slot = sessionId ? getOrCreateSessionSlot(sessionId) : null;
	if (slot && sessionId) {
		if (
			!slot.messages.transcript ||
			slot.messages.transcript.project !== project
		) {
			slot.messages.transcript = {
				rows: [],
				hwm: null,
				hasMore: false,
				status: { _tag: "cold" },
				project,
				pending: [],
			};
			slot.messages.loadLifecycle = "loading";
		} else {
			// The cached copy is only as current as the feed that stopped when we
			// left; it is not live again until the new feed synchronizes.
			slot.messages.transcript.status = { _tag: "cold" };
			install(sessionId, slot);
		}
	}
	void stopFeed().then(async () => {
		if (currentGeneration !== generation || !sessionId || !slot) return;
		const runtime = await getRuntime();
		if (currentGeneration !== generation) return;
		const next = runtime.runFork(
			Effect.flatMap(WsRpcClients, (clients) =>
				Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
					Stream.runForEach(
						supervise(
							Stream.suspend(() =>
								subscriptions.sessionDetail({
									sessionId,
									...(slot.messages.transcript?.hwm == null
										? {}
										: { resumeFromSequence: slot.messages.transcript.hwm }),
								}),
							),
							(status) => {
								if (
									currentGeneration === generation &&
									slot.messages.transcript
								)
									slot.messages.transcript.status = status;
							},
						),
						(envelope) =>
							Effect.sync(() => {
								if (
									currentGeneration !== generation ||
									!slot.messages.transcript
								)
									return;
								const before = slot.messages.transcript;
								let newUserMessage = false;
								let newAssistantId: string | null = null;
								if (
									envelope._tag === "upsert" &&
									envelope.item._tag === "transcriptMessage"
								) {
									const row = envelope.item.message;
									const held = before.rows.find((old) => old.id === row.id);
									// The server names a skill from the tool's input, which can
									// land after the tool starts.
									if (
										row.parts?.some(
											(part) =>
												part.tool?.toLowerCase() === "skill" &&
												JSON.stringify(part.state?.["input"]) !==
													JSON.stringify(
														held?.parts?.find((old) => old.id === part.id)
															?.state?.["input"],
													),
										)
									)
										refreshSessionSkills(sessionId);
									// A user row is new when it first has parts to show.
									newUserMessage =
										row.role === "user" &&
										!!row.parts?.length &&
										!held?.parts?.length;
									if (
										!held &&
										row.role === "assistant" &&
										before.status._tag === "live"
									)
										newAssistantId = row.id;
								}
								slot.messages.transcript = applyTranscriptEnvelope(
									before,
									envelope,
								);
								if (
									newAssistantId &&
									slot.messages.transcript.rows.some(
										(row) => row.id === newAssistantId,
									)
								)
									advanceTurnIfNewMessage(
										slot.activity,
										slot.messages,
										newAssistantId,
									);
								// A message may name a skill; the chip reloads the session's skills.
								if (newUserMessage) refreshSessionSkills(sessionId);
								if (
									envelope._tag === "snapshot" ||
									envelope._tag === "synchronized"
								) {
									cancelFrame();
									install(sessionId, slot);
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
}

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
			slot.messages.transcript = {
				...slot.messages.transcript,
				rows: [
					...response.messages.map(toHistoryMessage),
					...slot.messages.transcript.rows,
				]
					.filter(
						(row, index, all) =>
							all.findIndex((other) => other.id === row.id) === index,
					)
					.sort(rowOrder),
				hasMore: response.hasMore,
			};
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
