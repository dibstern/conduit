// ─── Shared Types ───────────────────────────────────────────────────────────
// Canonical type definitions for conduit, derived from ticket specs.

import type { Logger } from "./logger.js";
import type { KnownOpenCodeEvent } from "./relay/opencode-events.js";
import type { PushNotificationManager } from "./server/push.js";
import type { PartType, PermissionId, ToolStatus } from "./shared-types.js";

// Re-export all shared types (shared between server and frontend)
export type {
	AgentInfo,
	AskUserQuestion,
	CommandInfo,
	FileEntry,
	InstanceConfig,
	InstanceStatus,
	ModelInfo,
	OpenCodeInstance,
	PartType,
	ProviderInfo,
	PtyInfo,
	PtyStatus,
	RelayMessage,
	SessionInfo,
	TodoItem,
	TodoStatus,
	ToolName,
	ToolStatus,
	UsageInfo,
} from "./shared-types.js";

/** OpenCode SSE event shape — structural base for all events */
export interface BaseOpenCodeEvent {
	type: string;
	properties: Record<string, unknown>;
}

// Composed union: every typed SSE event + the structural fallback for
// unknown/future events.  Downstream consumers continue to import
// `OpenCodeEvent`; the union is transparent.
export type OpenCodeEvent = KnownOpenCodeEvent | BaseOpenCodeEvent;

/** OpenCode global SSE event (wrapped) */
export interface GlobalEvent {
	directory: string;
	payload: OpenCodeEvent;
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

// ─── Server-only types ──────────────────────────────────────────────────────

export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

// ─── IPC Protocol ───────────────────────────────────────────────────────────

export type IPCCommand =
	| { cmd: "get_status" }
	| { cmd: "list_projects" }
	| { cmd: "shutdown" }
	| { cmd: "restart_with_config" }
	| { cmd: "add_project"; directory: string }
	| { cmd: "remove_project"; slug: string }
	| { cmd: "set_project_title"; slug: string; title: string }
	| { cmd: "set_pin"; pin: string }
	| { cmd: "set_keep_awake"; enabled: boolean }
	| { cmd: "set_keep_awake_command"; command: string; args: string[] }
	| { cmd: "set_agent"; slug: string; agent: string }
	| { cmd: "set_model"; slug: string; provider: string; model: string }
	| { cmd: "instance_list" }
	| {
			cmd: "instance_add";
			name: string;
			managed: boolean;
			port?: number;
			env?: Record<string, string>;
			url?: string;
	  }
	| { cmd: "instance_remove"; id: string }
	| { cmd: "instance_start"; id: string }
	| { cmd: "instance_stop"; id: string }
	| {
			cmd: "instance_update";
			id: string;
			name?: string;
			env?: Record<string, string>;
			port?: number;
	  }
	| { cmd: "instance_status"; id: string };

export interface IPCResponse {
	ok: boolean;
	error?: string;
	slug?: string;
	directory?: string;
	projects?: readonly unknown[];
	uptime?: number;
	port?: number;
	projectCount?: number;
	clientCount?: number;
	instances?: readonly unknown[];
	instance?: unknown;
	[key: string]: unknown;
}

// ─── Permission types ───────────────────────────────────────────────────────

export type FrontendDecision = "allow" | "deny" | "allow_always";
export type OpenCodeDecision = "once" | "always" | "reject";

export interface PendingPermission {
	requestId: PermissionId;
	sessionId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	always: string[];
	timestamp: number;
}

// ─── Connection health ──────────────────────────────────────────────────────

export interface ConnectionHealth {
	connected: boolean;
	lastEventAt: number | null;
	reconnectCount: number;
}

// ─── Project info ───────────────────────────────────────────────────────────

export interface StoredProject {
	readonly slug: string;
	readonly directory: string;
	readonly title: string;
	readonly lastUsed?: number;
	readonly instanceId?: string;
}

// ─── Recent project entry ───────────────────────────────────────────────────

export interface RecentProject {
	directory: string;
	slug: string;
	title?: string;
	lastUsed: number;
}

// ─── File content result ────────────────────────────────────────────────────

export interface FileContentResult {
	content: string;
	binary?: boolean;
	path: string;
}

// ─── Per-Project Relay Config ────────────────────────────────────────────────

/** Config for creating a per-project relay that attaches to an existing server. */
export interface ProjectRelayConfig {
	/** The HTTP server to attach the WebSocket handler to */
	httpServer: import("node:http").Server;
	/** OpenCode server URL (e.g., "http://localhost:4096") */
	opencodeUrl: string;
	/** Project working directory */
	projectDir: string;
	/** URL slug for this project */
	slug: string;
	/** Session title for the initial session */
	sessionTitle?: string;
	/** Logger instance — defaults to a console-backed root logger */
	log?: Logger;
	/**
	 * When true, create WebSocket server in noServer mode.
	 * The caller (daemon) handles HTTP upgrades and routes to handleUpgrade().
	 * Also enables per-directory scoping via x-opencode-directory header.
	 */
	noServer?: boolean;
	/** Optional auth check on WebSocket upgrade (threaded to ws-handler verifyClient). */
	verifyClient?: (
		info: {
			origin: string;
			secure: boolean;
			req: import("node:http").IncomingMessage;
		},
		callback: (result: boolean, code?: number, message?: string) => void,
	) => void;
	/** Return the relay's registered project list (for the project switcher). */
	getProjects?: () => ReadonlyArray<{
		slug: string;
		title: string;
		directory: string;
		instanceId?: string;
	}>;
	/** Remove a project from the registry. */
	removeProject?: (slug: string) => void | Promise<void>;
	/** Set a project's display title. */
	setProjectTitle?: (slug: string, title: string) => void;
	/** Add a new project by directory path. Returns the created project info. */
	addProject?: (
		directory: string,
		instanceId?: string,
	) => Promise<{
		slug: string;
		title: string;
		directory: string;
		instanceId?: string;
	}>;
	/** Return the current list of OpenCode instances (for the instance switcher). */
	getInstances?: () => ReadonlyArray<
		Readonly<import("./shared-types.js").OpenCodeInstance>
	>;
	/** Add a new instance. Returns the created instance. */
	addInstance?: (
		id: string,
		config: import("./shared-types.js").InstanceConfig,
	) => import("./shared-types.js").OpenCodeInstance;
	/** Remove an instance by ID. */
	removeInstance?: (id: string) => void;
	/** Start a managed instance. */
	startInstance?: (id: string) => Promise<void>;
	/** Stop an instance. */
	stopInstance?: (id: string) => void;
	/** Update an instance's name, env, or port. */
	updateInstance?: (
		id: string,
		updates: { name?: string; env?: Record<string, string>; port?: number },
	) => import("./shared-types.js").OpenCodeInstance;
	/** Persist daemon config to disk after instance mutations. */
	persistConfig?: () => void;
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
	/** Return cached update version if one is available (for replaying to new clients). */
	getCachedUpdate?: () => string | null;
	/** Optional push notification manager for server-side push delivery */
	pushManager?: PushNotificationManager;
	/** Config directory for cache storage (default: projectDir/.conduit) */
	configDir?: string;
	/**
	 * Abort signal for cancelling relay creation mid-flight.
	 *
	 * Optional because standalone/skeleton mode callers and tests don't need
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
	/**
	 * Optional service registry for tracking drainable services.
	 * When provided, relay services (pollers, SSE consumer, etc.) register
	 * themselves so the daemon can drain them all on shutdown.
	 * Standalone/test usage works without it.
	 */
	registry?: import("./daemon/service-registry.js").ServiceRegistry;
	/** Optional: shared PersistenceLayer for dual-write to SQLite event store. */
	persistence?: import("./persistence/persistence-layer.js").PersistenceLayer;
	/** Feature flag: enable dual-write to SQLite. Defaults to true (opt-out). */
	dualWriteEnabled?: boolean;
	/** Phase 4: Read flag overrides for read switchover (per sub-phase). */
	readFlags?: import("./persistence/read-flags.js").ReadFlagConfig;
}
