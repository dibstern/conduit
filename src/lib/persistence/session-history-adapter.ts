// src/lib/persistence/session-history-adapter.ts
// Converts SQLite MessageWithParts[] → HistoryMessage[] for transcript consumers.
// Pure conversion with no I/O.

import { Option, Schema } from "effect";
import { ProjectSetupStateSchema } from "../contracts/project-setup.js";
import { Utf8Bytes } from "../contracts/tool-wire.js";
import { isSameModelIdentity } from "../provider/claude/claude-api-model-id.js";
import type {
	HistoryMessage,
	HistoryMessagePart,
	ToolStatus,
} from "../shared-types.js";
import type { MessagePartRow, MessageWithParts } from "./read-model-types.js";
import { projectTool } from "./tool-wire-projection.js";

function snapshotRowToHistory(
	row: MessageWithParts,
): HistoryMessage | undefined {
	if (!row.rest_payload) return undefined;
	const parsed: unknown = JSON.parse(row.rest_payload);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("id" in parsed) ||
		typeof parsed.id !== "string" ||
		!("role" in parsed) ||
		(parsed.role !== "user" && parsed.role !== "assistant") ||
		!("parts" in parsed) ||
		!Array.isArray(parsed.parts)
	)
		return undefined;
	const parts: HistoryMessagePart[] = parsed.parts.map((part: unknown) => {
		if (
			typeof part !== "object" ||
			part === null ||
			!("id" in part) ||
			typeof part.id !== "string" ||
			!("type" in part) ||
			typeof part.type !== "string"
		) {
			throw new TypeError(`Invalid snapshot part for ${row.id}`);
		}
		const state =
			"state" in part && typeof part.state === "object" && part.state !== null
				? part.state
				: undefined;
		const metadata =
			state && "metadata" in state && typeof state.metadata === "object"
				? browserMetadata(state.metadata ?? undefined)
				: undefined;
		return {
			...part,
			id: part.id,
			type: part.type as HistoryMessagePart["type"],
			...(state === undefined
				? {}
				: {
						state: {
							...state,
							metadata,
							...projectTool({
								name:
									"tool" in part && typeof part.tool === "string"
										? part.tool
										: undefined,
								input:
									"input" in state && state.input !== undefined
										? JSON.stringify(state.input)
										: undefined,
								output:
									"output" in state && typeof state.output === "string"
										? state.output
										: undefined,
							}),
						},
					}),
		};
	});
	return {
		...parsed,
		id: parsed.id,
		role: parsed.role,
		parts,
		...(row.is_backfilled === 1 ? { isBackfilled: true } : {}),
		...(row.turnCost !== undefined ? { turnCost: row.turnCost } : {}),
		...(row.input_id ? { inputId: row.input_id } : {}),
		...(row.steered === 1 ? { steered: true } : {}),
		...(row.role === "user" && row.turnTiming
			? { turnTiming: row.turnTiming }
			: {}),
	};
}

export interface HistoryResult {
	messages: HistoryMessage[];
	hasMore: boolean;
	total?: number;
}

/** Stored tool statuses as the browser knows them. The projector stores a tool
 *  that has only been announced as "started": not yet running, so pending. */
const TOOL_STATUSES = new Map<string, ToolStatus>([
	["started", "pending"],
	["pending", "pending"],
	["running", "running"],
	["completed", "completed"],
	["error", "error"],
]);

/** The tool metadata the browser reads: a subagent's session, a settled
 *  status, and a launching row's task, outcome, step, times and usage.
 *  Everything else stays on the server — an OpenCode edit's metadata alone
 *  holds the whole file twice over. */
const BROWSER_METADATA_KEYS = new Set([
	"status",
	"childSessionId",
	"sessionId",
	"providerTaskId",
	"backgrounded",
	"outcome",
	"currentStep",
	"activeToolName",
	"lastToolName",
	"taskStartedAt",
	"endTime",
	"pausedAt",
	"pausedMs",
	"taskDurationMs",
	"taskTotalTokens",
	"totalTokens",
	"taskToolUses",
	"toolUses",
]);

function browserMetadata(
	metadata: object | undefined,
): Record<string, string | number | boolean> | undefined {
	if (metadata === undefined) return undefined;
	const kept = Object.fromEntries(
		Object.entries(metadata).filter(
			(entry): entry is [string, string | number | boolean] =>
				BROWSER_METADATA_KEYS.has(entry[0]) &&
				(typeof entry[1] === "string" ||
					typeof entry[1] === "number" ||
					typeof entry[1] === "boolean"),
		),
	);
	return Object.keys(kept).length > 0 ? kept : undefined;
}

function parseObjectJson(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** A stored tool result as shown: JSON strings decoded, anything else raw. */
export function toolOutputText(result: string): string {
	try {
		const output: unknown = JSON.parse(result);
		return typeof output === "string" ? output : result;
	} catch {
		return result;
	}
}

function partRowToHistoryPart(row: MessagePartRow): HistoryMessagePart {
	if (row.type === "text" && row.metadata != null) {
		const value = parseObjectJson(row.metadata)?.["setup"];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const setup = Schema.decodeUnknownOption(ProjectSetupStateSchema)(
				Object.fromEntries(
					Object.entries(value).filter(([, field]) => field !== null),
				),
			);
			if (Option.isSome(setup))
				return {
					id: row.id,
					type: "setup",
					text: row.text ?? "",
					setup: setup.value,
					time: { start: row.created_at },
				};
		}
	}
	if (row.type === "compaction") {
		const metadata =
			row.metadata != null ? parseObjectJson(row.metadata) : undefined;
		return {
			id: row.id,
			type: "compaction",
			...(row.text ? { text: row.text } : {}),
			...(typeof metadata?.["preTokens"] === "number"
				? { preTokens: metadata["preTokens"] }
				: {}),
			...(typeof metadata?.["postTokens"] === "number"
				? { postTokens: metadata["postTokens"] }
				: {}),
			...(row.status === "failed" ? { failed: true } : {}),
		};
	}

	if (row.type === "error") {
		const metadata =
			row.metadata != null ? parseObjectJson(row.metadata) : undefined;
		return {
			id: row.id,
			type: "error",
			text: row.text,
			...(typeof metadata?.["code"] === "string"
				? { code: metadata["code"] }
				: {}),
			time: { start: row.created_at },
		};
	}

	if (row.type === "file") {
		const metadata =
			row.metadata != null ? parseObjectJson(row.metadata) : undefined;
		return {
			id: row.id,
			type: "file",
			...(typeof metadata?.["mime"] === "string"
				? { mime: metadata["mime"] }
				: {}),
			...(typeof metadata?.["filename"] === "string"
				? { filename: metadata["filename"] }
				: {}),
			...(typeof metadata?.["url"] === "string"
				? { url: metadata["url"] }
				: {}),
		};
	}

	let state: NonNullable<HistoryMessagePart["state"]> | undefined;
	if (
		row.status != null ||
		row.input != null ||
		row.result != null ||
		row.metadata != null
	) {
		const stateObj: NonNullable<HistoryMessagePart["state"]> = {
			...projectTool({
				name: row.tool_name,
				input: row.input,
				output: row.result == null ? undefined : toolOutputText(row.result),
				outputBytes: row.result_bytes,
			}),
		};
		const status =
			row.status == null ? undefined : TOOL_STATUSES.get(row.status);
		if (status) stateObj["status"] = status;
		const metadata = browserMetadata(
			row.metadata == null ? undefined : parseObjectJson(row.metadata),
		);
		if (metadata) stateObj["metadata"] = metadata;
		if (Object.keys(stateObj).length > 0) {
			state = stateObj;
		}
	}

	return {
		id: row.id,
		type: row.type as HistoryMessagePart["type"],
		// Per-part stamps, not the message's: a whole turn's tools share one
		// message row, so the message stamp would make every step 0ms long.
		time: { start: row.created_at, end: row.updated_at },
		...(row.text ? { text: row.text } : {}),
		...(row.tool_name != null ? { tool: row.tool_name } : {}),
		...(row.call_id != null ? { callID: row.call_id } : {}),
		...(state != null ? { state } : {}),
	};
}

/**
 * Convert message rows (with pre-loaded parts) from the SQLite projection
 * into the HistoryMessage format used by transcript consumers.
 *
 * Uses all ascending rows from the read model to detect exact `hasMore`, then
 * keeps the newest `pageSize` rows while preserving ascending display order.
 *
 * Tool parts go through the tool wire projection: long fields travel as
 * previews the browser expands through GetToolDetails.
 */
export function messageRowsToHistory(
	rows: MessageWithParts[],
	opts: { pageSize: number },
): HistoryResult {
	// The read query returns oldest-to-newest; keep the tail for REST parity.
	const hasMore = rows.length > opts.pageSize;
	const pageRows = hasMore ? rows.slice(rows.length - opts.pageSize) : rows;

	const messages: HistoryMessage[] = pageRows.map((row) => {
		const snapshot = snapshotRowToHistory(row);
		if (snapshot)
			return row.completed_at == null
				? snapshot
				: {
						...snapshot,
						time: {
							created: row.created_at,
							...snapshot.time,
							completed: row.completed_at,
						},
					};
		const parts = row.parts.map(partRowToHistoryPart);

		return {
			id: row.id,
			role: row.role as "user" | "assistant",
			...(row.is_backfilled === 1 ? { isBackfilled: true } : {}),
			...(row.input_id ? { inputId: row.input_id } : {}),
			...(row.steered === 1 ? { steered: true } : {}),
			time: {
				created: row.created_at,
				completed: row.completed_at ?? row.updated_at,
			},
			...(row.text ? { text: row.text } : {}),
			parts,
			...(row.cost != null ? { cost: row.cost } : {}),
			...(row.context_tokens != null
				? { contextTokens: row.context_tokens }
				: {}),
			...(row.turnCost !== undefined ? { turnCost: row.turnCost } : {}),
			...(row.role === "user" && row.turnTiming
				? { turnTiming: row.turnTiming }
				: {}),
			...(row.role === "user" && row.modelExecution
				? {
						modelExecution: {
							...row.modelExecution,
							...(row.modelExecution.expectedModel === undefined
								? {}
								: {
										drifted: !isSameModelIdentity(
											row.modelExecution.actualModel,
											row.modelExecution.expectedModel,
										),
									}),
						},
					}
				: {}),
			...(row.tokens_in != null ||
			row.tokens_out != null ||
			row.context_window != null
				? {
						tokens: {
							...(row.tokens_in != null ? { input: row.tokens_in } : {}),
							...(row.tokens_out != null ? { output: row.tokens_out } : {}),
							...(row.context_window != null
								? { context_window: row.context_window }
								: {}),
							...(row.tokens_cache_read != null ||
							row.tokens_cache_write != null
								? {
										cache: {
											...(row.tokens_cache_read != null
												? { read: row.tokens_cache_read }
												: {}),
											...(row.tokens_cache_write != null
												? { write: row.tokens_cache_write }
												: {}),
										},
									}
								: {}),
						},
					}
				: {}),
		} as HistoryMessage;
	});

	return { messages, hasMore };
}

/** The most a transcript page may weigh on the wire, as one encoded frame. */
export const PAGE_FRAME_BUDGET = Utf8Bytes.make(256 * 1024);

// What a frame holds besides its rows: the RPC wrapper and the page's
// sequence, cursor and paging flags.
const FRAME_ENVELOPE_BYTES = 1_024;

/**
 * The newest of `rows` that fit one frame of `budget`, oldest first. A row is
 * weighed whole, as its JSON, so a page never splits a message; the newest row
 * stays however large it is, so a page always holds one whole message.
 */
export function newestRowsWithin<T>(
	rows: readonly T[],
	budget: Utf8Bytes,
): readonly T[] {
	let bytes = FRAME_ENVELOPE_BYTES;
	for (let index = rows.length - 1; index >= 0; index--) {
		bytes += Buffer.byteLength(JSON.stringify(rows[index]), "utf8") + 1;
		if (bytes > budget && index < rows.length - 1) return rows.slice(index + 1);
	}
	return rows;
}
