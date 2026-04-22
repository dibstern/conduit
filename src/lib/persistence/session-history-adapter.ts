// src/lib/persistence/session-history-adapter.ts
// ─── Session History Adapter ────────────────────────────────────────────────
// Converts SQLite MessageWithParts[] → HistoryMessage[] for session_switched messages.
// Pure conversion with no I/O.

import type {
	HistoryMessage,
	HistoryMessagePart,
	ToolStatus,
} from "../shared-types.js";
import type { MessagePartRow, MessageWithParts } from "./read-query-service.js";

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

function partRowToHistoryPart(row: MessagePartRow): HistoryMessagePart {
	let state: NonNullable<HistoryMessagePart["state"]> | undefined;
	if (row.status != null || row.input != null || row.result != null) {
		const stateObj: {
			status?: ToolStatus;
			input?: unknown;
			output?: string;
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
			stateObj["output"] = row.result;
		}
		state = stateObj;
	}

	return {
		id: row.id,
		type: row.type as HistoryMessagePart["type"],
		...(row.text ? { text: row.text } : {}),
		...(row.tool_name != null ? { tool: row.tool_name } : {}),
		...(row.call_id != null ? { callID: row.call_id } : {}),
		...(state != null ? { state } : {}),
	};
}

/**
 * Convert message rows (with pre-loaded parts) from the SQLite projection
 * into the HistoryMessage format expected by the frontend's session_switched
 * handler.
 *
 * Uses the over-fetch pattern: pass rows over-fetched by 1 (i.e. the query
 * was run with `limit = pageSize + 1`). This function detects `hasMore` by
 * checking `rows.length > pageSize`, then slices to `pageSize`.
 */
export function messageRowsToHistory(
	rows: MessageWithParts[],
	opts: { pageSize: number },
): HistoryResult {
	// Over-fetch detection: if rows.length > pageSize, there are more rows.
	// Slice to pageSize before building messages.
	const hasMore = rows.length > opts.pageSize;
	const pageRows = hasMore ? rows.slice(0, opts.pageSize) : rows;

	const messages: HistoryMessage[] = pageRows.map((row) => {
		const parts = row.parts.map(partRowToHistoryPart);

		return {
			id: row.id,
			role: row.role as "user" | "assistant",
			time: {
				created: row.created_at,
				completed: row.updated_at,
			},
			...(row.text ? { text: row.text } : {}),
			parts,
			...(row.cost != null ? { cost: row.cost } : {}),
			...(row.tokens_in != null || row.tokens_out != null
				? {
						tokens: {
							...(row.tokens_in != null ? { input: row.tokens_in } : {}),
							...(row.tokens_out != null ? { output: row.tokens_out } : {}),
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
