// ─── Handler Types ───────────────────────────────────────────────────────────
// Shared types used by all handler modules.

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type {
	OpenCodeClient,
	PromptOptions,
} from "../instance/opencode-client.js";
import type { Logger } from "../logger.js";
import type { MessageCache } from "../relay/message-cache.js";
import type { MessagePollerManager } from "../relay/message-poller-manager.js";
import type { PendingUserMessages } from "../relay/pending-user-messages.js";
import type { PtyManager } from "../relay/pty-manager.js";
import type { ToolContentStore } from "../relay/tool-content-store.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { SessionStatusPoller } from "../session/session-status-poller.js";
import type { InstanceConfig, OpenCodeInstance } from "../shared-types.js";
import type { ProjectRelayConfig, RelayMessage } from "../types.js";
import type { PayloadMap } from "./payloads.js";

export interface HandlerDeps {
	wsHandler: {
		broadcast: (msg: RelayMessage) => void;
		sendTo: (clientId: string, msg: RelayMessage) => void;
		// Per-tab session tracking
		setClientSession: (clientId: string, sessionId: string) => void;
		getClientSession: (clientId: string) => string | undefined;
		getClientsForSession: (sessionId: string) => string[];
		sendToSession: (sessionId: string, msg: RelayMessage) => void;
	};
	client: OpenCodeClient;
	sessionMgr: SessionManager;
	messageCache: MessageCache;
	pendingUserMessages: PendingUserMessages;
	permissionBridge: PermissionBridge;
	overrides: SessionOverrides;
	ptyManager: PtyManager;
	toolContentStore: ToolContentStore;
	config: ProjectRelayConfig;
	log: Logger;
	/** Optional session status poller for processing state */
	statusPoller?: Pick<SessionStatusPoller, "isProcessing">;
	/** Shared session registry for client→session viewer tracking */
	registry?: SessionRegistry;
	/** Optional message poller manager — used to start REST polling when viewing sessions */
	pollerManager?: Pick<MessagePollerManager, "isPolling" | "startPolling">;
	connectPtyUpstream: (ptyId: string, cursor?: number) => Promise<void>;
	/** Instance management (optional — only available in daemon mode) */
	getInstances?: () => ReadonlyArray<Readonly<OpenCodeInstance>>;
	addInstance?: (id: string, config: InstanceConfig) => OpenCodeInstance;
	removeInstance?: (id: string) => void;
	startInstance?: (id: string) => Promise<void>;
	stopInstance?: (id: string) => void;
	/** Update an instance's name, env, or port (optional — daemon mode only). */
	updateInstance?: (
		id: string,
		updates: { name?: string; env?: Record<string, string>; port?: number },
	) => OpenCodeInstance;
	/** Persist the current daemon config to disk (optional — daemon mode only). */
	persistConfig?: () => void;
	/** Change a project's instance binding and rebuild relay (optional — daemon mode only). */
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
	/** Return the current project list (for broadcasting after mutations). */
	getProjects?: () => ReadonlyArray<{
		slug: string;
		title: string;
		directory: string;
		instanceId?: string;
	}>;
	/** Remove a project from the registry (optional — daemon mode only). */
	removeProject?: (slug: string) => void | Promise<void>;
	/** Set a project's display title (optional — daemon mode only). */
	setProjectTitle?: (slug: string, title: string) => void;
}

export type MessageHandler<K extends keyof PayloadMap = keyof PayloadMap> = (
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap[K],
) => Promise<void>;

// Re-export PromptOptions so prompt.ts can use it without a separate import
export type { PromptOptions };
