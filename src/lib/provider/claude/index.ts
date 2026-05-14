// src/lib/provider/claude/index.ts
/**
 * Claude Agent SDK provider instance module.
 *
 * Re-exports the public surface for the Claude provider instance.
 */

export type { ClaudeEventTranslatorDeps } from "./claude-event-translator.js";
export { ClaudeEventTranslator } from "./claude-event-translator.js";
export type { ClaudePermissionBridgeDeps } from "./claude-permission-bridge.js";
export { ClaudePermissionBridge } from "./claude-permission-bridge.js";
export type { ClaudeProviderInstanceDeps } from "./claude-provider-instance.js";
export {
	ClaudeDriver,
	ClaudeProviderInstance,
} from "./claude-provider-instance.js";
export {
	EffectPromptQueue,
	makeEffectPromptQueue,
} from "./effect-prompt-queue.js";
export type {
	CanUseTool,
	ClaudeResumeCursor,
	ClaudeSessionContext,
	Options,
	PendingApproval,
	PendingQuestion,
	PermissionMode,
	PermissionResult,
	PromptQueueController,
	Query,
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultError,
	SDKResultMessage,
	SDKResultSuccess,
	SDKSystemMessage,
	SDKUserMessage,
	ToolInFlight,
} from "./types.js";
