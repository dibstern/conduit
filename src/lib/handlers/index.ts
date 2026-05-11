// ─── Message Handlers ────────────────────────────────────────────────────────
// Re-exports all handler functions and builds the EFFECT_MESSAGE_HANDLERS
// dispatch table. This module replaces the monolithic message-handlers.ts.

// ─── Types ───────────────────────────────────────────────────────────────────

export type { PayloadMap } from "./payloads.js";

// ─── Handler modules ─────────────────────────────────────────────────────────

export { filterAgents, handleGetAgents, handleSwitchAgent } from "./agent.js";
export { handleSwitchContextWindow } from "./context-window.js";
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

// ─── Effect-based Dispatch ──────────────────────────────────────────────────
// Schema-validate the raw payload, then route to the matching Effect handler.

import { Effect, Schema } from "effect";
import { WebSocketError } from "../errors.js";
import {
	handleGetAgents as handleGetAgentsImpl,
	handleSwitchAgent as handleSwitchAgentImpl,
} from "./agent.js";
import { handleSwitchContextWindow as handleSwitchContextWindowImpl } from "./context-window.js";
import {
	handleGetFileContent as handleGetFileContentImpl,
	handleGetFileList as handleGetFileListImpl,
	handleGetFileTree as handleGetFileTreeImpl,
} from "./files.js";
import {
	handleInstanceAdd as handleInstanceAddImpl,
	handleInstanceRemove as handleInstanceRemoveImpl,
	handleInstanceRename as handleInstanceRenameImpl,
	handleInstanceStart as handleInstanceStartImpl,
	handleInstanceStop as handleInstanceStopImpl,
	handleInstanceUpdate as handleInstanceUpdateImpl,
	handleProxyDetect as handleProxyDetectImpl,
	handleScanNow as handleScanNowImpl,
	handleSetProjectInstance as handleSetProjectInstanceImpl,
} from "./instance.js";
import {
	handleGetModels as handleGetModelsImpl,
	handleSetDefaultModel as handleSetDefaultModelImpl,
	handleSwitchModel as handleSwitchModelImpl,
	handleSwitchVariant as handleSwitchVariantImpl,
} from "./model.js";
import { PayloadSchemas } from "./payload-schemas.js";
import type { PayloadMap } from "./payloads.js";
import {
	handleAskUserResponse as handleAskUserResponseImpl,
	handlePermissionResponse as handlePermissionResponseImpl,
	handleQuestionReject as handleQuestionRejectImpl,
} from "./permissions.js";
import {
	handleCancel as handleCancelImpl,
	handleInputSync as handleInputSyncImpl,
	handleMessage as handleMessageImpl,
	handleRewind as handleRewindImpl,
} from "./prompt.js";
import { handleReloadProviderSession as handleReloadProviderSessionImpl } from "./reload.js";
import {
	handleDeleteSession as handleDeleteSessionImpl,
	handleForkSession as handleForkSessionImpl,
	handleListSessions as handleListSessionsImpl,
	handleLoadMoreHistory as handleLoadMoreHistoryImpl,
	handleNewSession as handleNewSessionImpl,
	handleRenameSession as handleRenameSessionImpl,
	handleSearchSessions as handleSearchSessionsImpl,
	handleSwitchSession as handleSwitchSessionImpl,
	handleViewSession as handleViewSessionImpl,
} from "./session.js";
import {
	handleAddProject as handleAddProjectImpl,
	handleGetCommands as handleGetCommandsImpl,
	handleGetProjects as handleGetProjectsImpl,
	handleGetTodo as handleGetTodoImpl,
	handleListDirectories as handleListDirectoriesImpl,
	handleRemoveProject as handleRemoveProjectImpl,
	handleRenameProject as handleRenameProjectImpl,
} from "./settings.js";
import {
	handlePtyClose as handlePtyCloseImpl,
	handlePtyCreate as handlePtyCreateImpl,
	handlePtyInput as handlePtyInputImpl,
	handlePtyResize as handlePtyResizeImpl,
	handleTerminalCommand as handleTerminalCommandImpl,
} from "./terminal.js";
import { handleGetToolContent as handleGetToolContentImpl } from "./tool-content.js";

type AnyEffectHandler = (
	clientId: string,
	// biome-ignore lint/suspicious/noExplicitAny: handler union — payload varies per message type; erased at dispatch boundary
	payload: any,
	// biome-ignore lint/suspicious/noExplicitAny: handler union — E/R vary per handler; erased at dispatch boundary
) => Effect.Effect<void, any, any>;

/**
 * Maps every message type to its Effect-based handler implementation.
 *
 * Handlers pull their dependencies from the Effect context via Tags.
 */
export const EFFECT_MESSAGE_HANDLERS: Record<
	keyof PayloadMap,
	AnyEffectHandler
> = {
	// Prompt
	message: handleMessageImpl,
	cancel: handleCancelImpl,
	rewind: handleRewindImpl,
	input_sync: handleInputSyncImpl,
	// Permissions
	permission_response: handlePermissionResponseImpl,
	ask_user_response: handleAskUserResponseImpl,
	question_reject: handleQuestionRejectImpl,
	// Sessions
	new_session: handleNewSessionImpl,
	switch_session: handleSwitchSessionImpl,
	view_session: handleViewSessionImpl,
	delete_session: handleDeleteSessionImpl,
	rename_session: handleRenameSessionImpl,
	fork_session: handleForkSessionImpl,
	list_sessions: handleListSessionsImpl,
	search_sessions: handleSearchSessionsImpl,
	load_more_history: handleLoadMoreHistoryImpl,
	// Agents
	get_agents: handleGetAgentsImpl,
	switch_agent: handleSwitchAgentImpl,
	// Models
	get_models: handleGetModelsImpl,
	switch_model: handleSwitchModelImpl,
	set_default_model: handleSetDefaultModelImpl,
	switch_variant: handleSwitchVariantImpl,
	switch_context_window: handleSwitchContextWindowImpl,
	// Settings
	get_commands: handleGetCommandsImpl,
	get_projects: handleGetProjectsImpl,
	add_project: handleAddProjectImpl,
	list_directories: handleListDirectoriesImpl,
	remove_project: handleRemoveProjectImpl,
	rename_project: handleRenameProjectImpl,
	get_todo: handleGetTodoImpl,
	// Files
	get_file_list: handleGetFileListImpl,
	get_file_content: handleGetFileContentImpl,
	get_file_tree: handleGetFileTreeImpl,
	get_tool_content: handleGetToolContentImpl,
	// Terminal
	terminal_command: handleTerminalCommandImpl,
	pty_create: handlePtyCreateImpl,
	pty_input: handlePtyInputImpl,
	pty_resize: handlePtyResizeImpl,
	pty_close: handlePtyCloseImpl,
	// Instance management
	instance_add: handleInstanceAddImpl,
	instance_remove: handleInstanceRemoveImpl,
	instance_start: handleInstanceStartImpl,
	instance_stop: handleInstanceStopImpl,
	instance_update: handleInstanceUpdateImpl,
	instance_rename: handleInstanceRenameImpl,
	set_project_instance: handleSetProjectInstanceImpl,
	proxy_detect: handleProxyDetectImpl,
	scan_now: handleScanNowImpl,
	// Reload
	reload_provider_session: handleReloadProviderSessionImpl,
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
