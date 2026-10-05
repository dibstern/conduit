// Single import point for types from @opencode-ai/sdk.
// All relay code should import SDK types from here, not directly from the SDK.
//
// SessionDetail keeps compatibility with older server session fields and slugs.

import type { Session } from "@opencode-ai/sdk/v2/types";

/**
 * Extended session type that includes fields present in OpenCode API responses
 * and permits the missing slug returned by older servers.
 *
 * The relay accesses these fields (modelID, providerID, agentID, slug, archived)
 * when reading session details from the API. They are optional because not all
 * sessions have them set.
 *
 */
export type SessionDetail = Omit<Session, "slug"> & {
	/** Model ID set on the session (from API, not in SDK types) */
	modelID?: string;
	/** Provider ID set on the session (from API, not in SDK types) */
	providerID?: string;
	/** Agent ID set on the session (from API, not in SDK types) */
	agentID?: string;
	/** Optional for compatibility with sessions returned by older servers */
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
	EventLspUpdated,
	EventMessagePartRemoved,
	EventMessagePartUpdated,
	EventMessageRemoved,
	EventMessageUpdated,
	EventPermissionAsked,
	EventPermissionReplied,
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
	Message as SdkMessage,
	// Part types
	Part,
	PatchPart,
	// Permission types
	PermissionRequest,
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
} from "@opencode-ai/sdk/v2/types";

// These replace the hand-maintained string unions in shared-types.ts with
// types derived directly from the SDK's discriminated unions.

import type {
	Part as _Part,
	ToolState as _ToolState,
} from "@opencode-ai/sdk/v2/types";

/**
 * Part type discriminant — derived from SDK `Part["type"]`.
 * Replaces the hand-maintained PartType union in shared-types.ts.
 */
export type PartType = _Part["type"];

/**
 * Tool status discriminant — derived from SDK `ToolState["status"]`.
 * Replaces the hand-maintained ToolStatus union in shared-types.ts.
 */
export type ToolStatus = _ToolState["status"];

// Local relay types (migrated from opencode-client.ts)
// These are simplified interfaces used by relay handlers and the OpenCodeAPI
// adapter. They do NOT match the SDK's strict types 1:1 (e.g., SDK Agent has
// many required fields that the API doesn't always return).

export interface PromptOptions {
	text: string;
	images?: string[];
	agent?: string;
	model?: { providerID: string; modelID: string };
	variant?: string;
}

/** Simplified agent info returned by app.agents(). */
export interface Agent {
	id: string;
	name: string;
	description?: string;
	/** Agent mode: "primary" (user-facing), "subagent" (task tool), or "all" */
	mode?: string;
	/** Whether the agent is hidden from user selection */
	hidden?: boolean;
}

export interface Provider {
	id: string;
	name: string;
	models?: Array<{
		id: string;
		name: string;
		limit?: { context?: number; output?: number };
		variants?: Record<string, Record<string, unknown>>;
	}>;
}

export interface ProviderListResult {
	providers: Provider[];
	defaults: Record<string, string>;
	connected: string[];
}

/**
 * Flat message shape used by the relay's REST polling pipeline.
 *
 * The SDK's `Message` (= `UserMessage | AssistantMessage`) does NOT include
 * a `parts` field; parts are returned separately. The relay's message-poller
 * and session-lifecycle code expect a flat message with inline parts, cost,
 * and token data. This interface preserves the shape that was previously in
 * `opencode-client.ts`.
 */
export interface Message {
	[key: string]: unknown;
	id: string;
	role: string;
	sessionID: string;
	parts?: Array<{
		id: string;
		type: string;
		[key: string]: unknown;
	}>;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
		contextWindow?: number;
	};
	time?: { created?: number; completed?: number };
	parentID?: string;
	finish?: string;
	error?: unknown;
}
