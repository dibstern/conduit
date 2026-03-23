// ─── Message Handlers ────────────────────────────────────────────────────────
// Re-exports all handler functions and builds the MESSAGE_HANDLERS dispatch
// table. This module replaces the monolithic message-handlers.ts.

// ─── Types ───────────────────────────────────────────────────────────────────

export type { PayloadMap } from "./payloads.js";
export type { HandlerDeps, MessageHandler } from "./types.js";

// ─── Session resolution ──────────────────────────────────────────────────────

export { resolveSession, resolveSessionForLog } from "./resolve-session.js";

// ─── Handler modules ─────────────────────────────────────────────────────────

export { filterAgents, handleGetAgents, handleSwitchAgent } from "./agent.js";
export {
	handleGetFileContent,
	handleGetFileList,
	handleGetFileTree,
} from "./files.js";
export {
	handleInstanceAdd,
	handleInstanceRemove,
	handleInstanceRename,
	handleInstanceStart,
	handleInstanceStop,
	handleInstanceUpdate,
	handleProxyDetect,
	handleScanNow,
	handleSetProjectInstance,
} from "./instance.js";
export {
	handleGetModels,
	handleSetDefaultModel,
	handleSwitchModel,
	handleSwitchVariant,
} from "./model.js";
export {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "./permissions.js";
export {
	clearSessionInputDraft,
	getSessionInputDraft,
	handleCancel,
	handleInputSync,
	handleMessage,
	handleRewind,
} from "./prompt.js";
export {
	handleDeleteSession,
	handleForkSession,
	handleListSessions,
	handleLoadMoreHistory,
	handleNewSession,
	handleRenameSession,
	handleSearchSessions,
	handleSwitchSession,
	handleViewSession,
} from "./session.js";
export {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
	handleGetTodo,
	handleListDirectories,
	handleRemoveProject,
	handleRenameProject,
} from "./settings.js";
export {
	handlePtyClose,
	handlePtyCreate,
	handlePtyInput,
	handlePtyResize,
	handleTerminalCommand,
} from "./terminal.js";
export { handleGetToolContent } from "./tool-content.js";

// ─── Dispatch Table ──────────────────────────────────────────────────────────

import { handleGetAgents, handleSwitchAgent } from "./agent.js";
import {
	handleGetFileContent,
	handleGetFileList,
	handleGetFileTree,
} from "./files.js";
import {
	handleInstanceAdd,
	handleInstanceRemove,
	handleInstanceRename,
	handleInstanceStart,
	handleInstanceStop,
	handleInstanceUpdate,
	handleProxyDetect,
	handleScanNow,
	handleSetProjectInstance,
} from "./instance.js";
import {
	handleGetModels,
	handleSetDefaultModel,
	handleSwitchModel,
	handleSwitchVariant,
} from "./model.js";
import type { PayloadMap } from "./payloads.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "./permissions.js";
import {
	handleCancel,
	handleInputSync,
	handleMessage,
	handleRewind,
} from "./prompt.js";
import { resolveSessionForLog } from "./resolve-session.js";
import {
	handleDeleteSession,
	handleForkSession,
	handleListSessions,
	handleLoadMoreHistory,
	handleNewSession,
	handleRenameSession,
	handleSearchSessions,
	handleSwitchSession,
	handleViewSession,
} from "./session.js";
import {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
	handleGetTodo,
	handleListDirectories,
	handleRemoveProject,
	handleRenameProject,
} from "./settings.js";
import {
	handlePtyClose,
	handlePtyCreate,
	handlePtyInput,
	handlePtyResize,
	handleTerminalCommand,
} from "./terminal.js";
import { handleGetToolContent } from "./tool-content.js";
import type { HandlerDeps, MessageHandler } from "./types.js";

// The dispatch table maps handler names to handler functions. Each handler
// accepts a specific PayloadMap type, but the table stores them as the
// default MessageHandler (union payload). This is safe because dispatchMessage
// only calls a handler with the payload matching its key. The cast is the
// single trust boundary — Phase 2 will add Valibot runtime validation here.
export const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
	message: handleMessage as MessageHandler,
	permission_response: handlePermissionResponse as MessageHandler,
	ask_user_response: handleAskUserResponse as MessageHandler,
	question_reject: handleQuestionReject as MessageHandler,
	new_session: handleNewSession as MessageHandler,
	switch_session: handleSwitchSession as MessageHandler,
	view_session: handleViewSession as MessageHandler,
	delete_session: handleDeleteSession as MessageHandler,
	rename_session: handleRenameSession as MessageHandler,
	fork_session: handleForkSession as MessageHandler,
	list_sessions: handleListSessions as MessageHandler,
	search_sessions: handleSearchSessions as MessageHandler,
	load_more_history: handleLoadMoreHistory as MessageHandler,
	get_agents: handleGetAgents as MessageHandler,
	switch_agent: handleSwitchAgent as MessageHandler,
	get_models: handleGetModels as MessageHandler,
	switch_model: handleSwitchModel as MessageHandler,
	set_default_model: handleSetDefaultModel as MessageHandler,
	switch_variant: handleSwitchVariant as MessageHandler,
	get_commands: handleGetCommands as MessageHandler,
	get_projects: handleGetProjects as MessageHandler,
	add_project: handleAddProject as MessageHandler,
	list_directories: handleListDirectories as MessageHandler,
	remove_project: handleRemoveProject as MessageHandler,
	rename_project: handleRenameProject as MessageHandler,
	get_file_list: handleGetFileList as MessageHandler,
	get_file_content: handleGetFileContent as MessageHandler,
	get_file_tree: handleGetFileTree as MessageHandler,
	get_tool_content: handleGetToolContent as MessageHandler,
	terminal_command: handleTerminalCommand as MessageHandler,
	pty_create: handlePtyCreate as MessageHandler,
	pty_input: handlePtyInput as MessageHandler,
	pty_resize: handlePtyResize as MessageHandler,
	pty_close: handlePtyClose as MessageHandler,
	cancel: handleCancel as MessageHandler,
	rewind: handleRewind as MessageHandler,
	input_sync: handleInputSync as MessageHandler,
	get_todo: handleGetTodo as MessageHandler,
	instance_add: handleInstanceAdd as MessageHandler,
	instance_remove: handleInstanceRemove as MessageHandler,
	instance_start: handleInstanceStart as MessageHandler,
	instance_stop: handleInstanceStop as MessageHandler,
	instance_update: handleInstanceUpdate as MessageHandler,
	instance_rename: handleInstanceRename as MessageHandler,
	set_project_instance: handleSetProjectInstance as MessageHandler,
	proxy_detect: handleProxyDetect as MessageHandler,
	scan_now: handleScanNow as MessageHandler,
};

/**
 * Dispatch a client WebSocket message to the appropriate handler.
 * Returns without error for unrecognised handler names (logged only).
 */
export async function dispatchMessage(
	deps: HandlerDeps,
	clientId: string,
	handler: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const fn = MESSAGE_HANDLERS[handler];
	if (fn) {
		await fn(deps, clientId, payload as PayloadMap[keyof PayloadMap]);
	} else {
		deps.log.warn(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Unhandled: ${handler}`,
		);
	}
}
