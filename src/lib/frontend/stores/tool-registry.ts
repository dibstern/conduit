// ─── Tool Registry ──────────────────────────────────────────────────────────
// Centralized state machine for tool lifecycle transitions.
// Pure TypeScript — no Svelte dependencies.

import type { ToolStatus } from "../../shared-types.js";
import type { ChatMessage, ToolMessage } from "../types.js";
import { generateUuid } from "../utils/format.js";
import type { FrontendLogger } from "../utils/logger.js";
import { createToolMessage } from "../utils/tool-message-factory.js";

// ─── Public Types ───────────────────────────────────────────────────────────

/** Fields accepted by seedFromHistory — required core + optional rich data. */
export type HistoryToolSeed = Pick<
	ToolMessage,
	"id" | "name" | "status" | "uuid"
> &
	Partial<
		Pick<ToolMessage, "result" | "isError" | "input" | "metadata" | "messageId">
	>;

export interface TruncationExtras {
	isTruncated?: boolean;
	fullContentLength?: number;
}

export type ToolTransitionResult =
	| { action: "create"; tool: ToolMessage }
	| { action: "update"; uuid: string; tool: ToolMessage }
	| { action: "reject"; reason: string }
	| { action: "duplicate" };

export type FinalizationResult =
	| { action: "finalized"; indices: number[] }
	| { action: "none" };

export interface ToolRegistryOptions {
	log?: FrontendLogger;
	uuidFn?: () => string;
}

export interface ToolRegistry {
	start(id: string, name: string, messageId?: string): ToolTransitionResult;
	executing(
		id: string,
		input?: unknown,
		metadata?: Record<string, unknown>,
	): ToolTransitionResult;
	complete(
		id: string,
		content: string,
		isError: boolean,
		extras?: TruncationExtras,
	): ToolTransitionResult;
	finalizeAll(messages: readonly ChatMessage[]): FinalizationResult;
	clear(): void;
	remove(id: string): void;
	getUuid(callId: string): string | undefined;
	/** Seed registry from history-loaded tool messages so SSE events can find them. */
	seedFromHistory(tools: ReadonlyArray<HistoryToolSeed>): void;
}

// ─── Transition Table ───────────────────────────────────────────────────────

// NOTE: complete() intentionally allows overriding "completed" status
// for late SSE results after handleDone force-finalization. See complete() impl.
const VALID_TRANSITIONS: Record<ToolStatus, ReadonlySet<ToolStatus>> = {
	pending: new Set(["running", "completed", "error"]),
	running: new Set(["completed", "error"]),
	completed: new Set(), // terminal
	error: new Set(), // terminal
};

function canTransition(from: ToolStatus, to: ToolStatus): boolean {
	return VALID_TRANSITIONS[from].has(to);
}

// ─── Internal Entry ─────────────────────────────────────────────────────────

interface ToolEntry {
	uuid: string;
	status: ToolStatus;
	tool: ToolMessage;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createToolRegistry(
	options?: ToolRegistryOptions,
): ToolRegistry {
	const log = options?.log;
	const makeUuid = options?.uuidFn ?? generateUuid;
	const entries = new Map<string, ToolEntry>();

	function start(
		id: string,
		name: string,
		messageId?: string,
	): ToolTransitionResult {
		if (entries.has(id)) {
			log?.info(
				`Duplicate tool_start for "${name}" (${id}), existing entry retained.`,
			);
			return { action: "duplicate" };
		}

		const uuid = makeUuid();
		const tool: ToolMessage = createToolMessage({
			uuid,
			id,
			name,
			status: "pending",
			...(messageId !== undefined && { messageId }),
		});
		entries.set(id, { uuid, status: "pending", tool });
		return { action: "create", tool };
	}

	function executing(
		id: string,
		input?: unknown,
		metadata?: Record<string, unknown>,
	): ToolTransitionResult {
		const tracked = entries.get(id);
		if (!tracked) {
			// Expected during session loading: SSE delivers events for tools
			// established before the cache/registry started tracking.
			return { action: "reject", reason: `Unknown tool ID: ${id}` };
		}

		// running→running: OpenCode sends multiple tool_executing events
		// as the tool part state evolves (e.g. metadata with sessionId arrives
		// after the initial running event for subagent/Task tools).
		if (tracked.status === "running") {
			// Merge updated input/metadata without changing status
			tracked.tool = {
				...tracked.tool,
				...(input !== undefined && { input }),
				...(metadata !== undefined && { metadata }),
			};
			return { action: "update", uuid: tracked.uuid, tool: tracked.tool };
		}

		// completed→running: Expected during history + SSE overlap.
		// Tool was loaded from REST as completed, SSE replays stale running event.
		// Silently ignore — the tool is already in a terminal state.
		if (tracked.status === "completed") {
			return {
				action: "reject",
				reason: "Tool already completed (stale executing event)",
			};
		}

		if (!canTransition(tracked.status, "running")) {
			const msg = `Invalid transition ${tracked.status} -> running for tool "${id}"`;
			log?.error(msg);
			return {
				action: "reject",
				reason: `Cannot transition from ${tracked.status} to running`,
			};
		}

		tracked.status = "running";
		tracked.tool = {
			...tracked.tool,
			status: "running",
			...(input !== undefined && { input }),
			...(metadata !== undefined && { metadata }),
		};
		return { action: "update", uuid: tracked.uuid, tool: tracked.tool };
	}

	function complete(
		id: string,
		content: string,
		isError: boolean,
		extras?: TruncationExtras,
	): ToolTransitionResult {
		const tracked = entries.get(id);
		if (!tracked) {
			// Expected during session loading: SSE delivers tool_result for tools
			// established before the cache/registry started tracking.
			return { action: "reject", reason: `Unknown tool ID: ${id}` };
		}

		const targetStatus: ToolStatus = isError ? "error" : "completed";

		// completed→completed/error: Allow override — handles late SSE results
		// after handleDone force-finalization. The late result carries the actual
		// output content, so we accept it.
		if (tracked.status === "completed") {
			// Allow the override — fall through to apply the update
		} else if (tracked.status === "error") {
			// error→error: Idempotent re-delivery, silently ignore
			if (targetStatus === "error") {
				return {
					action: "reject",
					reason: "Tool already in error state (idempotent)",
				};
			}
			// error→completed: Truly unexpected backward transition
			const msg = `Invalid transition ${tracked.status} -> ${targetStatus} for tool "${id}"`;
			log?.error(msg);
			return {
				action: "reject",
				reason: `Cannot transition from ${tracked.status} to ${targetStatus}`,
			};
		}

		tracked.status = targetStatus;
		tracked.tool = {
			...tracked.tool,
			status: targetStatus,
			result: content,
			isError,
			...extras,
		};
		return { action: "update", uuid: tracked.uuid, tool: tracked.tool };
	}

	function finalizeAll(messages: readonly ChatMessage[]): FinalizationResult {
		const indices: number[] = [];

		for (let i = 0; i < messages.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: safe — bounded by length check
			const msg = messages[i]!;
			if (msg.type !== "tool") continue;
			if (msg.status !== "pending" && msg.status !== "running") continue;

			indices.push(i);

			// Update internal tracking if this tool is in the registry
			const tracked = entries.get(msg.id);
			if (tracked) {
				tracked.status = "completed";
				tracked.tool = { ...tracked.tool, status: "completed" };
			}
		}

		if (indices.length === 0) return { action: "none" };
		return { action: "finalized", indices };
	}

	function clear(): void {
		entries.clear();
	}

	function remove(id: string): void {
		entries.delete(id);
	}

	function getUuid(callId: string): string | undefined {
		return entries.get(callId)?.uuid;
	}

	function seedFromHistory(tools: ReadonlyArray<HistoryToolSeed>): void {
		for (const t of tools) {
			if (entries.has(t.id)) continue; // already tracked
			entries.set(t.id, {
				uuid: t.uuid,
				status: t.status,
				tool: createToolMessage(t),
			});
		}
	}

	return {
		start,
		executing,
		complete,
		finalizeAll,
		clear,
		remove,
		getUuid,
		seedFromHistory,
	};
}
