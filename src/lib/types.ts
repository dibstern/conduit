// Canonical type definitions for conduit, derived from ticket specs.

import type { Logger } from "./logger.js";
import type { PushNotificationSender } from "./server/push.js";
import type {
	DaemonSessionQueryOptions,
	DaemonSessionQueryResult,
	PartType,
	PermissionId,
	ProviderPermissionUpdate,
	ToolStatus,
} from "./shared-types.js";

type MaybePromise<T> = T | PromiseLike<T>;

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
	readonly title: string;
	readonly lastUsed?: number;
	readonly instanceId?: string;
	readonly shellEnv?: import("./contracts/project-shell-env.js").ProjectShellEnvConfig;
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
	/**
	 * Enables per-directory scoping via x-opencode-directory header.
	 * WebSocket upgrades are always owned by the caller, which attaches sockets
	 * to the relay.
	 */
	noServer?: boolean;
	/** Return the relay's registered project list (for the project switcher). */
	getProjects?: () => MaybePromise<
		ReadonlyArray<{
			slug: string;
			title: string;
			folders: readonly [string, ...string[]];
			instanceId?: string;
		}>
	>;
	/** List sessions across every registered project without starting relays. */
	listDaemonSessions?: (
		options: DaemonSessionQueryOptions,
	) => MaybePromise<DaemonSessionQueryResult>;
	/** Notify browsers on other project relays that the daemon list changed. */
	broadcastSessionListChanged?: () => Promise<void>;
	/** Notify the daemon's other live relays; standalone relays use a no-op. */
	publishGlobalSetting: (
		tag: import("./contracts/ws-rpc.js").GlobalProjectSetting["_tag"],
	) => import("effect").Effect.Effect<void>;
	/** Refresh the daemon's cached git context before publishing a turn-end list. */
	refreshSessionGit?: () => Promise<void>;
	/** Remove a project from the registry. */
	removeProject?: (slug: string) => void | Promise<void>;
	/** Create or update a project's folders and display title. */
	saveProject?: (
		input: import("./contracts/ws-rpc.js").SaveProjectInput,
	) => Promise<{
		project: import("./shared-types.js").ProjectInfo;
		warnings: readonly import("./project-folders.js").FolderIssue[];
	}>;
	/** Return the current list of OpenCode instances (for the instance switcher). */
	getInstances?: () => MaybePromise<
		ReadonlyArray<Readonly<import("./shared-types.js").OpenCodeInstance>>
	>;
	/** Add a new instance. Returns the created instance. */
	addInstance?: (
		id: string,
		config: import("./shared-types.js").InstanceConfig,
	) => MaybePromise<import("./shared-types.js").OpenCodeInstance>;
	/** Remove an instance by ID. */
	removeInstance?: (id: string) => MaybePromise<void>;
	/** Start a managed instance. */
	startInstance?: (id: string) => Promise<void>;
	/** Stop an instance. */
	stopInstance?: (id: string) => MaybePromise<void>;
	/** Update an instance's name, env, or port. */
	updateInstance?: (
		id: string,
		updates: {
			name?: string;
			env?: Record<string, string>;
			port?: number;
			driver?: import("./contracts/provider-instance.js").ProviderDriverKind;
			configDir?: string;
		},
	) => MaybePromise<import("./shared-types.js").OpenCodeInstance>;
	/** Persist daemon config to disk after instance mutations. */
	persistConfig?: () => MaybePromise<void>;
	/** Change a project's instance binding and rebuild relay. */
	setProjectInstance?: (
		slug: string,
		instanceId: string,
	) => void | Promise<void>;
	/** Trigger an immediate port scan (optional — daemon mode only). */
	triggerScan?: () => Promise<{
		discovered: number[];
		lost: number[];
		active: number[];
	}>;
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
	/**
	 * Test seam: replaces Claude session queries, title generation and forks.
	 * Directly supplied fakes run Claude sessions in-process.
	 * Defaults to the real SDK.
	 */
	claudeSdk?: {
		readonly query: NonNullable<
			import("./provider/claude/claude-provider-runtime.js").ClaudeProviderInstanceDeps["queryFactory"]
		>;
		readonly titleQuery: import("./domain/relay/Services/session-title-service.js").ClaudeTitleQueryFactory;
		readonly fork: import("./provider/claude/claude-session-fork.js").ClaudeSessionForkSdk;
	};
}
