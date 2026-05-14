// ─── Message Handlers ────────────────────────────────────────────────────────
// Re-exports all handler functions and builds the EFFECT_MESSAGE_HANDLERS
// dispatch table. This module replaces the monolithic message-handlers.ts.

// ─── Types ───────────────────────────────────────────────────────────────────

export type { PayloadMap } from "./payloads.js";

// ─── Handler modules ─────────────────────────────────────────────────────────

export { filterAgents, handleGetAgents } from "./agent.js";
export { handleSwitchContextWindow } from "./context-window.js";
export {
	handleGetFileContent,
	handleGetFileList,
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
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "./model.js";
export {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "./permissions.js";
export {
	clearSessionInputDraft,
	getSessionInputDraft,
	handleMessage,
	handleRewind,
	syncInputDraftForSession,
} from "./prompt.js";
export { reloadProviderSessionForClient } from "./reload.js";
export {
	handleDeleteSession,
	handleForkSession,
	handleNewSession,
	handleSwitchSession,
	handleViewSession,
	loadMoreHistoryForSession,
	renameSessionForClient,
} from "./session.js";
export {
	handleAddProject,
	handleGetCommands,
	handleGetProjects,
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
import { PayloadSchemas } from "./payload-schemas.js";
import type { PayloadMap } from "./payloads.js";
import {
	handleAskUserResponse as handleAskUserResponseImpl,
	handlePermissionResponse as handlePermissionResponseImpl,
	handleQuestionReject as handleQuestionRejectImpl,
} from "./permissions.js";
import { handleRewind as handleRewindImpl } from "./prompt.js";
import {
	handleDeleteSession as handleDeleteSessionImpl,
	handleForkSession as handleForkSessionImpl,
	handleNewSession as handleNewSessionImpl,
	handleSwitchSession as handleSwitchSessionImpl,
	handleViewSession as handleViewSessionImpl,
} from "./session.js";
import {
	handleAddProject as handleAddProjectImpl,
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
	rewind: handleRewindImpl,
	// Permissions
	permission_response: handlePermissionResponseImpl,
	ask_user_response: handleAskUserResponseImpl,
	question_reject: handleQuestionRejectImpl,
	// Sessions
	new_session: handleNewSessionImpl,
	switch_session: handleSwitchSessionImpl,
	view_session: handleViewSessionImpl,
	delete_session: handleDeleteSessionImpl,
	fork_session: handleForkSessionImpl,
	// Settings
	add_project: handleAddProjectImpl,
	remove_project: handleRemoveProjectImpl,
	rename_project: handleRenameProjectImpl,
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
