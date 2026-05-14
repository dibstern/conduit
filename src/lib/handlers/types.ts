// ─── Handler Types ───────────────────────────────────────────────────────────
// Shared types used by all handler modules.

import type {
	PollerManagerShape,
	SessionManagerShape,
} from "../domain/relay/Services/services.js";
import type { SessionStatusPollerService } from "../domain/relay/Services/session-status-poller.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { PromptOptions } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { OrchestrationEngine } from "../provider/orchestration-engine.js";
import type { PtyManager } from "../relay/pty-manager.js";
import type { InstanceConfig, OpenCodeInstance } from "../shared-types.js";
import type { ProjectRelayConfig, RelayMessage } from "../types.js";

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
	sessionMgr: SessionManagerShape;
	ptyManager: PtyManager;
	config: ProjectRelayConfig;
	log: Logger;
	/** Session status poller for processing state */
	statusPoller: Pick<SessionStatusPollerService, "isProcessing">;
	/** Message poller manager — used to start REST polling when viewing sessions */
	pollerManager: PollerManagerShape;
	connectPtyUpstream: (ptyId: string, cursor?: number) => Promise<void>;
	/** Instance management capability group (optional — only available in daemon mode) */
	instanceMgmt?: InstanceManagementDeps;
	/** Project management capability group (optional — only available in daemon mode) */
	projectMgmt?: ProjectManagementDeps;
	/**
	 * Phase 5: OrchestrationEngine for routing prompts through provider instances.
	 * When set, handleMessage() dispatches through the engine instead of calling
	 * client.session.prompt() directly. Optional — tests may omit it; production
	 * always provides it via relay-stack.ts.
	 */
	orchestrationEngine?: OrchestrationEngine;
}

// Re-export PromptOptions so prompt.ts can use it without a separate import
export type { PromptOptions };
