// ─── Handler Types ───────────────────────────────────────────────────────────
// Shared types used by all handler modules.

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { QuestionBridge } from "../bridges/question-bridge.js";
import type { ForkEntry } from "../daemon/fork-metadata.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { PromptOptions } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { ProviderStateService } from "../persistence/provider-state-service.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { OrchestrationEngine } from "../provider/orchestration-engine.js";
import type { RelayEventSinkPersist } from "../provider/relay-event-sink.js";
import type { MessagePollerManager } from "../relay/message-poller-manager.js";
import type { PtyManager } from "../relay/pty-manager.js";
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
	client: OpenCodeAPI;
	sessionMgr: SessionManager;
	permissionBridge: PermissionBridge;
	questionBridge: QuestionBridge;
	overrides: SessionOverrides;
	ptyManager: PtyManager;
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
		setForkEntry: (sessionId: string, entry: ForkEntry) => void;
		getForkEntry: (sessionId: string) => ForkEntry | undefined;
	};
	/** Instance management capability group (optional — only available in daemon mode) */
	instanceMgmt?: InstanceManagementDeps;
	/** Project management capability group (optional — only available in daemon mode) */
	projectMgmt?: ProjectManagementDeps;
	/** Port scan capability (optional — only available in daemon mode) */
	scanDeps?: ScanDeps;
	/** SQLite read query service (optional — only available when persistence is configured) */
	readQuery?: ReadQueryService;
	/**
	 * Phase 5: OrchestrationEngine for routing prompts through provider adapters.
	 * When set, handleMessage() dispatches through the engine instead of calling
	 * client.session.prompt() directly. Optional — tests may omit it; production
	 * always provides it via relay-stack.ts.
	 */
	orchestrationEngine?: OrchestrationEngine;
	/**
	 * Claude event persistence deps (optional — only when SQLite is configured).
	 * Passed to RelayEventSink so Claude SDK events survive session switches.
	 */
	claudeEventPersist?: RelayEventSinkPersist;
	/** Provider state service for resume cursor persistence (optional). */
	providerStateService?: ProviderStateService;
}

export type MessageHandler<K extends keyof PayloadMap = keyof PayloadMap> = (
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap[K],
) => Promise<void>;

// Re-export PromptOptions so prompt.ts can use it without a separate import
export type { PromptOptions };
