// src/lib/provider/claude/index.ts
/**
 * Claude Agent SDK provider instance module.
 *
 * Re-exports the public surface for the Claude provider instance.
 */

export type {
	ClaudeCapabilitiesService,
	ClaudeCapabilitiesServiceDeps,
} from "./claude-capabilities-service.js";
export {
	ClaudeCapabilitiesServiceLive,
	ClaudeCapabilitiesServiceTag,
	makeClaudeCapabilitiesService,
	makeUnsafeClaudeCapabilitiesService,
} from "./claude-capabilities-service.js";
export type { ClaudeEventTranslatorDeps } from "./claude-event-translator.js";
export { ClaudeEventTranslator } from "./claude-event-translator.js";
export type { ClaudePermissionBridgeDeps } from "./claude-permission-bridge.js";
export { ClaudePermissionBridge } from "./claude-permission-bridge.js";
export {
	ClaudePermissionService,
	type ClaudePermissionServiceDeps,
} from "./claude-permission-service.js";
export type { ClaudeProviderInstanceDeps } from "./claude-provider-instance.js";
export {
	ClaudeDriver,
	ClaudeProviderInstance,
} from "./claude-provider-instance.js";
export {
	ClaudeProviderRuntime,
	ClaudeProviderRuntimeLive,
	ClaudeProviderRuntimeTag,
	makeClaudeProviderRuntime,
} from "./claude-provider-runtime.js";
export type {
	ClaudeSubagentSdk,
	MaterializeClaudeSubagentsInput,
	MaterializedClaudeSubagent,
} from "./claude-subagent-materializer.js";
export {
	claudeSubagentSessionId,
	defaultClaudeSubagentSdk,
	makeClaudeSubagentMaterializer,
} from "./claude-subagent-materializer.js";
export type { ClaudeTranslationServiceDeps } from "./claude-translation-service.js";
export {
	ClaudeTranslationService,
	makeClaudeTranslationService,
} from "./claude-translation-service.js";
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
	SessionMessage,
	ToolInFlight,
} from "./types.js";
