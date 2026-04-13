// ─── SDK Type Re-exports (Task 9) ────────────────────────────────────────────
// Single import point for types from @opencode-ai/sdk.
// All relay code should import SDK types from here, not directly from the SDK
// or from the legacy opencode-client.ts.
//
// SessionDetail extends SDK Session with extra fields that the OpenCode REST
// API returns at runtime but the SDK's generated types don't include.
// These will be cleaned up as the SDK types catch up.

import type { Session } from "@opencode-ai/sdk/client";

/**
 * Extended session type that includes fields present in OpenCode API responses
 * but missing from the SDK's generated Session type.
 *
 * The relay accesses these fields (modelID, providerID, agentID, slug, archived)
 * when reading session details from the API. They are optional because not all
 * sessions have them set.
 *
 * This type will converge to just `Session` as the SDK types catch up or as
 * handlers are refactored to obtain model/provider info from messages instead.
 */
export type SessionDetail = Session & {
	/** Model ID set on the session (from API, not in SDK types) */
	modelID?: string;
	/** Provider ID set on the session (from API, not in SDK types) */
	providerID?: string;
	/** Agent ID set on the session (from API, not in SDK types) */
	agentID?: string;
	/** URL slug for the session (from API, not in SDK types) */
	slug?: string;
	/** Whether the session is archived (from API, not in SDK types) */
	archived?: boolean;
};

export type {
	AgentPart,
	AssistantMessage,
	CompactionPart,
	// Event types
	Event,
	EventCommandExecuted,
	EventFileEdited,
	EventFileWatcherUpdated,
	EventInstallationUpdateAvailable,
	EventInstallationUpdated,
	EventLspClientDiagnostics,
	EventLspUpdated,
	EventMessagePartRemoved,
	EventMessagePartUpdated,
	EventMessageRemoved,
	EventMessageUpdated,
	EventPermissionReplied,
	EventPermissionUpdated,
	EventPtyCreated,
	EventPtyDeleted,
	EventPtyExited,
	EventPtyUpdated,
	EventServerConnected,
	EventServerInstanceDisposed,
	EventSessionCompacted,
	EventSessionCreated,
	EventSessionDeleted,
	EventSessionDiff,
	EventSessionError,
	EventSessionIdle,
	EventSessionStatus,
	EventSessionUpdated,
	EventTodoUpdated,
	EventVcsBranchUpdated,
	FileDiff,
	FilePart,
	GlobalEvent,
	Message,
	// Part types
	Part,
	PatchPart,
	// Permission types
	Permission,
	Project,
	Pty,
	ReasoningPart,
	RetryPart,
	// Session types
	Session,
	SessionStatus,
	SnapshotPart,
	StepFinishPart,
	StepStartPart,
	TextPart,
	// Other types
	Todo,
	ToolPart,
	// Tool state types
	ToolState,
	ToolStateCompleted,
	ToolStateError,
	ToolStatePending,
	ToolStateRunning,
	// Message types
	UserMessage,
} from "@opencode-ai/sdk/client";
