// Canonical type definitions for conduit, derived from ticket specs.

import type { Tracer } from "effect/Tracer";
import type { Logger } from "./logger.js";
import type { PushNotificationSender } from "./server/push.js";
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
	CommandInfo,
	DaemonSessionCursor,
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
	FileEntry,
	GlobalRelayEvent,
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
	RelayMessage,
	SessionInfo,
	TodoItem,
	TodoStatus,
	ToolName,
	ToolStatus,
	UntaggedRelayMessage,
	UsageInfo,
} from "./shared-types.js";
export { tagWithSessionId } from "./shared-types.js";

// Re-export SSEEvent as OpenCodeEvent for backward compatibility.
// SSEEvent = SDK Event union + gap events (see relay/opencode-events.ts).
// New code should import SSEEvent directly from relay/opencode-events.ts.

export type {
	SSEEvent,
	SSEEvent as OpenCodeEvent,
} from "./relay/opencode-events.js";

/** OpenCode global SSE event (wrapped) */
export interface GlobalEvent {
	directory: string;
	payload: import("./relay/opencode-events.js").SSEEvent;
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

/** Config for creating a per-project relay that receives attached sockets. */
export interface ProjectRelayConfig {
	/** Immediate cached environment snapshot; shell resolution runs in the background. */
	shellEnv?: (
		directory: string,
	) => Readonly<Record<string, string | undefined>>;
	/** Await the existing shell capture before speculative Claude boot only. */
	prepareShellEnv?: (directory: string) => Promise<boolean>;
	/** Shared HTTP server owned by the caller. */
	httpServer: import("node:http").Server;
	/**
	 * Standalone relays' OpenCode server URL (e.g., "http://localhost:4096").
	 * Daemon relays resolve theirs per request through `openCodeInstances`.
	 */
	opencodeUrl?: string;
	/** Credentials for `opencodeUrl`. */
	opencodeAuth?: { username: string; password: string };
	/** Daemon-owned OpenCode Instances module shared by project relays. */
	openCodeInstances?: import("./domain/daemon/Services/opencode-instances-service.js").OpenCodeInstances;
	/** Usage readings shared by every relay in this daemon. */
	usage?: import("./domain/daemon/Services/usage.js").UsageService;
	/** Daemon-owned worktree lifecycle shared with its project relays. */
	worktreeContext?: import("effect").Context.Context<
		import("./domain/daemon/Services/worktree-service.js").WorktreeServiceTag
	>;
	/** Shared daemon services; must include the daemon-owned ProviderAdapters. */
	daemonConfigContext?: import("effect").Context.Context<never>;
	/** Id of the OpenCode instance selected for this relay (default instance when omitted). */
	openCodeInstanceId?: string;
	/** Project working directory */
	projectDir: string;
	/** Additional Claude workspace folders, fixed for this relay's lifetime. */
	extraFolders?: readonly string[];
	/** URL slug for this project */
	slug: string;
	/** Session title for the initial session */
	sessionTitle?: string;
	/** Logger instance — defaults to a console-backed root logger */
	log?: Logger;
	/** Ambient daemon tracer borrowed by the relay ManagedRuntime. */
	tracer?: Tracer;
	/**
	 * Enables per-directory scoping via x-opencode-directory header.
	 * WebSocket upgrades are always owned by the caller, which attaches sockets
	 * to the relay.
	 */
	noServer?: boolean;
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
	/** Optional push notification manager for server-side push delivery */
	pushManager?: PushNotificationSender;
	/** Config directory for cache storage (default: projectDir/.conduit) */
	configDir?: string;
	/**
	 * Abort signal for cancelling relay creation mid-flight.
	 *
	 * Optional because standalone callers and tests don't need
	 * cancellation — only the daemon passes a signal (via ProjectRegistry)
	 * so it can abort in-flight relay creation when a project is removed.
	 */
	signal?: AbortSignal;
	/**
	 * Override the default poller gating config (SSE grace period, staleness
	 * threshold, max concurrent pollers). Useful for tests that need
	 * accelerated timing without real-time waits.
	 */
	pollerGatingConfig?: Partial<
		import("./relay/monitoring-types.js").PollerGatingConfig
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
	/** SQLite event-store path for Effect-native persistence services. */
	persistenceDbPath: string;
	/** Test seam: replaces only the session-title query. Overrides `claudeSdk.titleQuery`. */
	titleQuery?: import("./provider/claude/claude-provider-runtime.js").ClaudeOneShotQueryFactory;
	/**
	 * Test seam: replaces Claude session queries, title generation and forks.
	 * Directly supplied fakes run Claude sessions in-process.
	 * Defaults to the real SDK.
	 */
	claudeSdk?: {
		readonly query: NonNullable<
			import("./provider/claude/claude-provider-runtime.js").ClaudeProviderInstanceDeps["queryFactory"]
		>;
		readonly titleQuery: import("./provider/claude/claude-provider-runtime.js").ClaudeOneShotQueryFactory;
		readonly fork: import("./provider/claude/claude-session-fork.js").ClaudeSessionForkSdk;
		/** Agent transcript reads; defaults to the real SDK's. */
		readonly subagentSdk?: import("./provider/claude/claude-subagent-materializer.js").ClaudeSubagentSdk;
	};
}
