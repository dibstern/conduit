// src/lib/persistence/session-history-adapter.ts
// Converts SQLite MessageWithParts[] → HistoryMessage[] for transcript consumers.
// Pure conversion with no I/O.

import { isSameModelIdentity } from "../provider/claude/claude-api-model-id.js";
import type {
	HistoryMessage,
	HistoryMessagePart,
	ToolStatus,
} from "../shared-types.js";
import type { MessagePartRow, MessageWithParts } from "./read-model-types.js";

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
		return {
			...part,
			id: part.id,
			type: part.type as HistoryMessagePart["type"],
		};
	});
	return {
		...parsed,
		id: parsed.id,
		role: parsed.role,
		parts,
		...(row.is_backfilled === 1 ? { isBackfilled: true } : {}),
	};
}

export interface HistoryResult {
	messages: HistoryMessage[];
	hasMore: boolean;
	total?: number;
}

const KNOWN_TOOL_STATUSES = new Set<string>([
	"pending",
	"running",
	"completed",
	"error",
]);

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

function partRowToHistoryPart(row: MessagePartRow): HistoryMessagePart {
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
		const stateObj: {
			status?: ToolStatus;
			input?: unknown;
			output?: string;
			metadata?: Record<string, unknown>;
			[key: string]: unknown;
		} = {};
		if (row.status != null && KNOWN_TOOL_STATUSES.has(row.status)) {
			stateObj["status"] = row.status as ToolStatus;
		}
		if (row.input != null) {
			try {
				stateObj["input"] = JSON.parse(row.input as string);
			} catch {
				stateObj["input"] = row.input;
			}
		}
		if (row.result != null) {
			try {
				const output: unknown = JSON.parse(row.result);
				stateObj["output"] = typeof output === "string" ? output : row.result;
			} catch {
				stateObj["output"] = row.result;
			}
		}
		if (row.metadata != null) {
			const metadata = parseObjectJson(row.metadata);
			if (metadata) stateObj["metadata"] = metadata;
		}
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
		if (snapshot) return snapshot;
		const parts = row.parts.map(partRowToHistoryPart);

		return {
			id: row.id,
			role: row.role as "user" | "assistant",
			...(row.is_backfilled === 1 ? { isBackfilled: true } : {}),
			time: {
				created: row.created_at,
				completed: row.updated_at,
			},
			...(row.text ? { text: row.text } : {}),
			parts,
			...(row.cost != null ? { cost: row.cost } : {}),
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
