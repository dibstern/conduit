// src/lib/provider/claude/index.ts
/**
 * Claude Agent SDK adapter module.
 *
 * Re-exports the public surface for the Claude provider adapter.
 */

export type { ClaudeAdapterDeps } from "./claude-adapter.js";
export { ClaudeAdapter } from "./claude-adapter.js";
export type { ClaudeEventTranslatorDeps } from "./claude-event-translator.js";
export { ClaudeEventTranslator } from "./claude-event-translator.js";
export type { ClaudePermissionBridgeDeps } from "./claude-permission-bridge.js";
export { ClaudePermissionBridge } from "./claude-permission-bridge.js";
export { PromptQueue } from "./prompt-queue.js";
export type {
	CanUseTool,
	ClaudeAdapterConfig,
	ClaudeQueryRuntime,
	ClaudeResumeCursor,
	ClaudeSessionContext,
	PendingApproval,
	PendingQuestion,
	PermissionMode,
	PermissionResult,
	PromptQueueController,
	PromptQueueItem,
	SDKMessage,
	SDKUserMessage,
	ToolInFlight,
} from "./types.js";
