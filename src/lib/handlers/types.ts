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

/** Instance management capability group — only available in daemon mode. */
export interface InstanceManagementDeps {
	getInstances: () => ReadonlyArray<Readonly<OpenCodeInstance>>;
	addInstance: (id: string, config: InstanceConfig) => OpenCodeInstance;
	removeInstance: (id: string) => void;
	startInstance: (id: string) => Promise<void>;
	stopInstance: (id: string) => void;
	updateInstance: (
		id: string,
		updates: { name?: string; env?: Record<string, string>; port?: number },
	) => OpenCodeInstance;
	persistConfig: () => void;
}

/** Project management capability group — only available in daemon mode. */
export interface ProjectManagementDeps {
	getProjects: () => ReadonlyArray<{
		slug: string;
		title: string;
		directory: string;
		instanceId?: string;
	}>;
	setProjectInstance: (
		slug: string,
		instanceId: string,
	) => void | Promise<void>;
}

/** Port scan capability — only available in daemon mode. */
export interface ScanDeps {
	triggerScan: () => Promise<{
		discovered: number[];
		lost: number[];
		active: number[];
	}>;
}

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
	/** Session status poller for processing state */
	statusPoller: Pick<SessionStatusPoller, "isProcessing">;
	/** Shared session registry for client→session viewer tracking */
	registry: SessionRegistry;
	/** Message poller manager — used to start REST polling when viewing sessions */
	pollerManager: Pick<MessagePollerManager, "isPolling" | "startPolling">;
	connectPtyUpstream: (ptyId: string, cursor?: number) => Promise<void>;
	/** Fork-point metadata store — used to persist forkMessageId and parentID */
	forkMeta: {
		setForkEntry: (
			sessionId: string,
			entry: { forkMessageId: string; parentID: string },
		) => void;
	};
	/** Instance management capability group (optional — only available in daemon mode) */
	instanceMgmt?: InstanceManagementDeps;
	/** Project management capability group (optional — only available in daemon mode) */
	projectMgmt?: ProjectManagementDeps;
	/** Port scan capability (optional — only available in daemon mode) */
	scanDeps?: ScanDeps;
}

export type MessageHandler<K extends keyof PayloadMap = keyof PayloadMap> = (
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap[K],
) => Promise<void>;

// Re-export PromptOptions so prompt.ts can use it without a separate import
export type { PromptOptions };
