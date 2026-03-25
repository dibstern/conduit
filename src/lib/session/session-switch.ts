// src/lib/session/session-switch.ts
// ─── Session Switch — Centralized session switching ─────────────────────────
// Single entry point for all session switches. Handlers delegate here instead
// of constructing session_switched messages manually.

import type { HistoryMessage, RequestId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";

// ─── Pure data types ────────────────────────────────────────────────────────

/** Discriminated union describing where session history came from. */
export type SessionHistorySource =
	| { readonly kind: "cached-events"; readonly events: readonly RelayMessage[] }
	| {
			readonly kind: "rest-history";
			readonly history: {
				readonly messages: readonly HistoryMessage[];
				readonly hasMore: boolean;
				readonly total?: number;
			};
	  }
	| { readonly kind: "empty" };

/** Options for building the session_switched message. */
export interface SessionSwitchMessageOptions {
	readonly draft?: string;
	readonly requestId?: RequestId;
}

/** Options for the switchClientToSession orchestrator. */
export interface SwitchClientOptions {
	readonly requestId?: RequestId;
	/** Skip cache/REST history lookup — send empty session_switched. Default: false. */
	readonly skipHistory?: boolean;
	/** Skip poller seeding. Default: false. */
	readonly skipPollerSeed?: boolean;
}

// ─── Dependency interface (principle of least privilege) ────────────────────

/** Narrowed deps for switchClientToSession — only what's needed, nothing more. */
export interface SessionSwitchDeps {
	readonly messageCache: {
		getEvents(sessionId: string): RelayMessage[] | null;
	};
	readonly sessionMgr: {
		loadPreRenderedHistory(
			sessionId: string,
			offset?: number,
		): Promise<{
			messages: HistoryMessage[];
			hasMore: boolean;
			total?: number;
		}>;
	};
	readonly wsHandler: {
		sendTo(clientId: string, msg: RelayMessage): void;
		setClientSession(clientId: string, sessionId: string): void;
	};
	readonly statusPoller?: { isProcessing(sessionId: string): boolean };
	readonly pollerManager?: {
		isPolling(sessionId: string): boolean;
		startPolling(sessionId: string, messages: unknown[]): void;
	};
	readonly client: {
		getMessages(sessionId: string): Promise<unknown[]>;
	};
	readonly log: {
		info(...args: unknown[]): void;
		warn(...args: unknown[]): void;
	};
	readonly getInputDraft: (sessionId: string) => string | undefined;
}
