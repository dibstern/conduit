// ─── Message Handlers ────────────────────────────────────────────────────────
// Re-exports all handler functions and builds the MESSAGE_HANDLERS dispatch
// table. This module replaces the monolithic message-handlers.ts.
//
// The Effect-based dispatch function (dispatchMessageEffect) lives alongside
// the legacy dispatchMessage. It will be wired up in Layer 6 when the
// WebSocket handler migrates to Effect.

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
export { handleReloadProviderSession } from "./reload.js";
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
import { handleReloadProviderSession } from "./reload.js";
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
export const MESSAGE_HANDLERS: Record<keyof PayloadMap, MessageHandler> = {
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
	reload_provider_session: handleReloadProviderSession as MessageHandler,
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
	const fn = (MESSAGE_HANDLERS as Record<string, MessageHandler | undefined>)[
		handler
	];
	if (fn) {
		await fn(deps, clientId, payload as PayloadMap[keyof PayloadMap]);
	} else {
		deps.log.warn(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Unhandled: ${handler}`,
		);
	}
}

// ─── Effect-based Dispatch ──────────────────────────────────────────────────
// The Effect dispatch pipeline: Schema-validate the raw payload, then
// route to the matching *Effect handler. Will be wired up by the
// WebSocket layer in Layer 6.

import { Effect, Schema } from "effect";
import { WebSocketError } from "../errors.js";
import { handleGetAgentsEffect, handleSwitchAgentEffect } from "./agent.js";
import {
	handleGetFileContentEffect,
	handleGetFileListEffect,
	handleGetFileTreeEffect,
} from "./files.js";
import {
	handleInstanceAddEffect,
	handleInstanceRemoveEffect,
	handleInstanceRenameEffect,
	handleInstanceStartEffect,
	handleInstanceStopEffect,
	handleInstanceUpdateEffect,
	handleProxyDetectEffect,
	handleScanNowEffect,
	handleSetProjectInstanceEffect,
} from "./instance.js";
import {
	handleGetModelsEffect,
	handleSetDefaultModelEffect,
	handleSwitchModelEffect,
	handleSwitchVariantEffect,
} from "./model.js";
import { PayloadSchemas } from "./payload-schemas.js";
import {
	handleAskUserResponseEffect,
	handlePermissionResponseEffect,
	handleQuestionRejectEffect,
} from "./permissions.js";
import {
	handleCancelEffect,
	handleInputSyncEffect,
	handleMessageEffect,
	handleRewindEffect,
} from "./prompt.js";
import { handleReloadProviderSessionEffect } from "./reload.js";
import {
	handleDeleteSessionEffect,
	handleForkSessionEffect,
	handleListSessionsEffect,
	handleLoadMoreHistoryEffect,
	handleNewSessionEffect,
	handleRenameSessionEffect,
	handleSearchSessionsEffect,
	handleSwitchSessionEffect,
	handleViewSessionEffect,
} from "./session.js";
import {
	handleAddProjectEffect,
	handleGetCommandsEffect,
	handleGetProjectsEffect,
	handleGetTodoEffect,
	handleListDirectoriesEffect,
	handleRemoveProjectEffect,
	handleRenameProjectEffect,
} from "./settings.js";
import {
	handlePtyCloseEffect,
	handlePtyCreateEffect,
	handlePtyInputEffect,
	handlePtyResizeEffect,
	handleTerminalCommandEffect,
} from "./terminal.js";
import { handleGetToolContentEffect } from "./tool-content.js";

type AnyEffectHandler = (
	clientId: string,
	// biome-ignore lint/suspicious/noExplicitAny: handler union — payload varies per message type; erased at dispatch boundary
	payload: any,
	// biome-ignore lint/suspicious/noExplicitAny: handler union — E/R vary per handler; erased at dispatch boundary
) => Effect.Effect<void, any, any>;

/**
 * Maps every message type to its Effect-based handler implementation.
 *
 * Unlike MESSAGE_HANDLERS (which takes deps as a first argument), these
 * handlers pull their dependencies from the Effect context via Tags.
 */
const EFFECT_MESSAGE_HANDLERS: Record<keyof PayloadMap, AnyEffectHandler> = {
	// Prompt
	message: handleMessageEffect,
	cancel: handleCancelEffect,
	rewind: handleRewindEffect,
	input_sync: handleInputSyncEffect,
	// Permissions
	permission_response: handlePermissionResponseEffect,
	ask_user_response: handleAskUserResponseEffect,
	question_reject: handleQuestionRejectEffect,
	// Sessions
	new_session: handleNewSessionEffect,
	switch_session: handleSwitchSessionEffect,
	view_session: handleViewSessionEffect,
	delete_session: handleDeleteSessionEffect,
	rename_session: handleRenameSessionEffect,
	fork_session: handleForkSessionEffect,
	list_sessions: handleListSessionsEffect,
	search_sessions: handleSearchSessionsEffect,
	load_more_history: handleLoadMoreHistoryEffect,
	// Agents
	get_agents: handleGetAgentsEffect,
	switch_agent: handleSwitchAgentEffect,
	// Models
	get_models: handleGetModelsEffect,
	switch_model: handleSwitchModelEffect,
	set_default_model: handleSetDefaultModelEffect,
	switch_variant: handleSwitchVariantEffect,
	// Settings
	get_commands: handleGetCommandsEffect,
	get_projects: handleGetProjectsEffect,
	add_project: handleAddProjectEffect,
	list_directories: handleListDirectoriesEffect,
	remove_project: handleRemoveProjectEffect,
	rename_project: handleRenameProjectEffect,
	get_todo: handleGetTodoEffect,
	// Files
	get_file_list: handleGetFileListEffect,
	get_file_content: handleGetFileContentEffect,
	get_file_tree: handleGetFileTreeEffect,
	get_tool_content: handleGetToolContentEffect,
	// Terminal
	terminal_command: handleTerminalCommandEffect,
	pty_create: handlePtyCreateEffect,
	pty_input: handlePtyInputEffect,
	pty_resize: handlePtyResizeEffect,
	pty_close: handlePtyCloseEffect,
	// Instance management
	instance_add: handleInstanceAddEffect,
	instance_remove: handleInstanceRemoveEffect,
	instance_start: handleInstanceStartEffect,
	instance_stop: handleInstanceStopEffect,
	instance_update: handleInstanceUpdateEffect,
	instance_rename: handleInstanceRenameEffect,
	set_project_instance: handleSetProjectInstanceEffect,
	proxy_detect: handleProxyDetectEffect,
	scan_now: handleScanNowEffect,
	// Reload
	reload_provider_session: handleReloadProviderSessionEffect,
};

/**
 * Effect-based message dispatch with Schema validation.
 *
 * 1. Looks up the handler by message type
 * 2. Decodes the raw payload through the matching Schema
 * 3. Invokes the handler
 *
 * Error semantics:
 * - Unknown message type: fails with WebSocketError
 * - Schema decode failure: fails with ParseError (a defect — the client
 *   sent malformed data)
 * - Handler domain errors: propagate as RelayError subtypes for the caller
 *   to handle (e.g. serialize as error responses)
 */
export const dispatchMessageEffect = (
	clientId: string,
	type: string,
	raw: unknown,
) =>
	Effect.gen(function* () {
		const handler = EFFECT_MESSAGE_HANDLERS[type as keyof PayloadMap];
		if (!handler) {
			return yield* Effect.fail(
				new WebSocketError({
					message: `Unknown message type: ${type}`,
				}),
			);
		}
		const schema = PayloadSchemas[type as keyof PayloadMap];
		const payload = yield* Schema.decodeUnknown(schema)(raw);
		return yield* handler(clientId, payload);
	});
