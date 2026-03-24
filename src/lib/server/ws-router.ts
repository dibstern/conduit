// ─── WebSocket Message Router (Ticket 2.2) ──────────────────────────────────
// Pure logic for routing incoming WebSocket messages to correct handlers,
// client tracking, broadcast targeting, and state snapshot building.
// Deliberately IO-free: no actual WebSocket I/O — just routing decisions.

import type { RelayMessage } from "../types.js";

// ─── Message types from browser ──────────────────────────────────────────────

export type IncomingMessageType =
	| "message"
	| "permission_response"
	| "ask_user_response"
	| "question_reject"
	| "new_session"
	| "switch_session"
	| "delete_session"
	| "rename_session"
	| "fork_session"
	| "list_sessions"
	| "search_sessions"
	| "load_more_history"
	| "terminal_command"
	| "input_sync"
	| "switch_agent"
	| "switch_model"
	| "get_todo"
	| "get_agents"
	| "get_models"
	| "get_commands"
	| "get_projects"
	| "add_project"
	| "list_directories"
	| "remove_project"
	| "rename_project"
	| "get_file_list"
	| "get_file_content"
	| "get_file_tree"
	| "get_tool_content"
	| "pty_create"
	| "pty_input"
	| "pty_resize"
	| "pty_close"
	| "cancel"
	| "rewind"
	| "instance_add"
	| "instance_remove"
	| "instance_start"
	| "instance_stop"
	| "instance_update"
	| "instance_rename"
	| "set_project_instance"
	| "set_default_model"
	| "switch_variant"
	| "view_session"
	| "proxy_detect"
	| "scan_now"
	| "set_log_level";

const VALID_MESSAGE_TYPES = new Set<string>([
	"message",
	"permission_response",
	"ask_user_response",
	"question_reject",
	"new_session",
	"switch_session",
	"delete_session",
	"rename_session",
	"fork_session",
	"list_sessions",
	"search_sessions",
	"load_more_history",
	"terminal_command",
	"input_sync",
	"switch_agent",
	"switch_model",
	"get_todo",
	"get_agents",
	"get_models",
	"get_commands",
	"get_projects",
	"add_project",
	"list_directories",
	"remove_project",
	"rename_project",
	"get_file_list",
	"get_file_content",
	"get_file_tree",
	"get_tool_content",
	"pty_create",
	"pty_input",
	"pty_resize",
	"pty_close",
	"cancel",
	"rewind",
	"instance_add",
	"instance_remove",
	"instance_start",
	"instance_stop",
	"instance_update",
	"instance_rename",
	"set_project_instance",
	"set_default_model",
	"switch_variant",
	"view_session",
	"proxy_detect",
	"scan_now",
	"set_log_level",
]);

export interface IncomingMessage {
	type: string;
	[key: string]: unknown;
}

export interface RouteResult {
	handler: IncomingMessageType;
	payload: Record<string, unknown>;
}

export interface ErrorResult {
	type: "error";
	code: string;
	message: string;
}

// ─── Message routing ─────────────────────────────────────────────────────────

/**
 * Parse and validate an incoming WebSocket message.
 * Returns the parsed object or null if parsing fails.
 */
export function parseIncomingMessage(raw: string): IncomingMessage | null {
	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		if (typeof parsed.type !== "string") {
			return null;
		}
		return parsed as IncomingMessage;
	} catch {
		return null;
	}
}

/**
 * Route a parsed message to its handler.
 * Returns either a RouteResult or an ErrorResult for unknown types.
 */
export function routeMessage(msg: IncomingMessage): RouteResult | ErrorResult {
	if (!VALID_MESSAGE_TYPES.has(msg.type)) {
		return {
			type: "error",
			code: "UNKNOWN_MESSAGE_TYPE",
			message: `Unknown message type: ${msg.type}`,
		};
	}

	const { type, ...payload } = msg;
	return {
		handler: type as IncomingMessageType,
		payload,
	};
}

/**
 * Check if a route result is an error.
 */
export function isRouteError(
	result: RouteResult | ErrorResult,
): result is ErrorResult {
	return "type" in result && (result as ErrorResult).type === "error";
}

// ─── Client tracking ─────────────────────────────────────────────────────────

export interface ClientTracker {
	addClient(clientId: string): number;
	removeClient(clientId: string): number;
	getClientCount(): number;
	getClientIds(): string[];
	hasClient(clientId: string): boolean;
	getBroadcastTargets(excludeClientId?: string): string[];
}

/**
 * Create a client tracker for managing connected WebSocket clients.
 */
export function createClientTracker(): ClientTracker {
	const clients = new Set<string>();

	return {
		addClient(clientId: string): number {
			clients.add(clientId);
			return clients.size;
		},

		removeClient(clientId: string): number {
			clients.delete(clientId);
			return clients.size;
		},

		getClientCount(): number {
			return clients.size;
		},

		getClientIds(): string[] {
			return [...clients];
		},

		hasClient(clientId: string): boolean {
			return clients.has(clientId);
		},

		getBroadcastTargets(excludeClientId?: string): string[] {
			if (!excludeClientId) return [...clients];
			return [...clients].filter((id) => id !== excludeClientId);
		},
	};
}

// ─── Client count message factory ────────────────────────────────────────────

export function createClientCountMessage(count: number): RelayMessage {
	return { type: "client_count", count };
}
