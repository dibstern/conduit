// Canonical type definitions for conduit, derived from ticket specs.

import type {
	PartType,
	PermissionId,
	ProviderPermissionUpdate,
	ToolStatus,
} from "./shared-types.js";

// Re-export all shared types (shared between server and frontend)
export type {
	AgentInfo,
	AskUserQuestion,
	BrowserMessage,
	CommandInfo,
	DaemonSessionCursor,
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
	FileEntry,
	GlobalBrowserMessage,
	InstanceConfig,
	InstanceStatus,
	ModelInfo,
	OpenCodeInstance,
	PartType,
	PerSessionEvent,
	PerSessionEventType,
	ProviderInfo,
	ProviderPermissionUpdate,
	ProviderPermissionUpdateDestination,
	PtyInfo,
	PtyStatus,
	SessionInfo,
	TodoItem,
	TodoStatus,
	ToolName,
	ToolStatus,
	UntaggedBrowserMessage,
	UsageInfo,
} from "./shared-types.js";
export { tagWithSessionId } from "./shared-types.js";

// Re-export SSEEvent as OpenCodeEvent for backward compatibility.
// SSEEvent = SDK Event union + gap events (see relay/opencode-events.ts).
// New code should import SSEEvent directly from relay/opencode-events.ts.

export type {
	SSEEvent,
	SSEEvent as OpenCodeEvent,
} from "./provider/opencode/opencode-events.js";

/** OpenCode global SSE event (wrapped) */
export interface GlobalEvent {
	directory: string;
	payload: import("./provider/opencode/opencode-events.js").SSEEvent;
}

export interface PartState {
	type: PartType;
	status?: ToolStatus;
	callID?: string;
	tool?: string;
	input?: unknown;
	output?: string;
	error?: string;
	time?: { start?: number; end?: number };
}

export interface PartDelta {
	sessionID: string;
	messageID: string;
	partID: string;
	field: string;
	delta: string;
}

export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

export type FrontendDecision = "allow" | "deny" | "allow_always";
export type OpenCodeDecision = "once" | "always" | "reject";

export interface PendingPermission {
	requestId: PermissionId;
	sessionId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	always: string[];
	permissionSuggestions?: ProviderPermissionUpdate[];
	permissionTitle?: string;
	permissionDisplayName?: string;
	permissionDescription?: string;
	permissionReason?: string;
	timestamp: number;
}

export interface ConnectionHealth {
	readonly connected: boolean;
	readonly lastEventAt: number | null;
	readonly reconnectCount: number;
	readonly stale: boolean;
}

export interface StoredProject {
	readonly slug: string;
	readonly folders: readonly [string, ...string[]];
	readonly repositoryIdentities?: Readonly<
		Record<string, import("./shared-types.js").RepositoryIdentity>
	>;
	readonly title: string;
	readonly lastUsed?: number;
	readonly addedAt?: number;
	readonly shellEnv?: import("./contracts/project-shell-env.js").ProjectShellEnvConfig;
	readonly setupScript?: string | undefined;
	readonly sessionMode?:
		| import("./contracts/project-file.js").SessionMode
		| undefined;
	readonly worktreeCleanup?:
		| import("./contracts/worktree.js").ProjectWorktreeCleanup
		| undefined;
}

export interface RecentProject {
	directory: string;
	slug: string;
	title?: string;
	lastUsed: number;
}

export interface FileContentResult {
	content: string;
	binary?: boolean;
	path: string;
}

/** Test seam: in-process Claude session queries, title generation and forks. */
export interface ClaudeSdkSeam {
	readonly query: NonNullable<
		import("./provider/claude/claude-provider-runtime.js").ClaudeProviderInstanceDeps["queryFactory"]
	>;
	readonly titleQuery: import("./provider/claude/claude-provider-runtime.js").ClaudeOneShotQueryFactory;
	readonly fork: import("./provider/claude/claude-session-fork.js").ClaudeSessionForkSdk;
	/** Agent transcript reads; defaults to the real SDK's. */
	readonly subagentSdk?: import("./provider/claude/claude-subagent-materializer.js").ClaudeSubagentSdk;
}

/** Config for creating a per-project relay that receives attached sockets. */
export interface ProjectServicesConfig {
	/** Immediate cached environment snapshot; shell resolution runs in the background. */
	shellEnv?: (
		directory: string,
	) => import("./contracts/project-shell-env.js").ProjectShellEnvSnapshot;
	/** Await the existing shell capture before speculative Claude boot only. */
	prepareShellEnv?: (directory: string) => Promise<boolean>;
	/** Project working directory */
	projectDir: string;
	/** Additional Claude workspace folders, fixed for this relay's lifetime. */
	extraFolders?: readonly string[];
	/** URL slug for this project */
	slug: string;
	/** Request the daemon's serialized worktree sweep after a session settles. */
	requestWorktreeCleanup?: () => import("effect").Effect.Effect<void>;
	/** Read this project's current effective cleanup rules from the daemon. */
	getWorktreeCleanup?: () => import("effect").Effect.Effect<
		import("./contracts/worktree.js").WorktreeCleanup | "off"
	>;
	/** Notify the daemon's other live relays; standalone relays use a no-op. */
	publishGlobalSetting: (
		tag: import("./contracts/ws-rpc.js").GlobalSettingTag,
	) => import("effect").Effect.Effect<void>;
	/** Config directory for cache storage (default: projectDir/.conduit) */
	configDir?: string;
	/**
	 * Override the default poller gating config (SSE grace period, staleness
	 * threshold, max concurrent pollers). Useful for tests that need
	 * accelerated timing without real-time waits.
	 */
	pollerGatingConfig?: Partial<
		import("./provider/opencode/monitoring-types.js").PollerGatingConfig
	>;
	/**
	 * Override the session-status polling interval in milliseconds.
	 * Default: 500ms. Tests can use a shorter interval for faster feedback.
	 */
	statusPollerInterval?: number;
	/**
	 * Override the message polling interval in milliseconds.
	 * Default: 750ms. Tests can use a shorter interval for faster feedback.
	 */
	messagePollerInterval?: number;
	/** Test seam: how long after a session's last SSE event its message poller skips reads. Default 2000ms. */
	messagePollerSseSilence?: number;
	/** SQLite event-store path for Effect-native persistence services. */
	persistenceDbPath: string;
	/** Test seam: replaces only the session-title query. Overrides `claudeSdk.titleQuery`. */
	titleQuery?: import("./provider/claude/claude-provider-runtime.js").ClaudeOneShotQueryFactory;
	/**
	 * Test seam: replaces Claude session queries, title generation and forks.
	 * Directly supplied fakes run Claude sessions in-process.
	 * Defaults to the real SDK.
	 */
	claudeSdk?: ClaudeSdkSeam;
}
