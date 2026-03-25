// ─── Session Registry ────────────────────────────────────────────────────────
// Single source of truth for client→session associations.
// Replaces the scattered tracking across ws-handler.clientSessions,
// pollerManager.viewerCounts, and relay-stack viewer management.

import type { Logger } from "../logger.js";

export class SessionRegistry {
	/** Primary state: clientId → sessionId */
	private clients = new Map<string, string>();
	private log: Logger | undefined;

	constructor(log?: Logger) {
		this.log = log;
	}

	/** Set which session a client is viewing. Handles switching automatically. */
	setClientSession(clientId: string, sessionId: string): void {
		const previous = this.clients.get(clientId);
		if (previous === sessionId) return; // no-op
		this.clients.set(clientId, sessionId);
		this.log?.info(`client=${clientId} registered for session=${sessionId}`);
	}

	/** Get the session a client is viewing. */
	getClientSession(clientId: string): string | undefined {
		return this.clients.get(clientId);
	}

	/** Get all client IDs viewing a specific session. */
	getViewers(sessionId: string): string[] {
		const result: string[] = [];
		for (const [cid, sid] of this.clients) {
			if (sid === sessionId) result.push(cid);
		}
		return result;
	}

	/** Get the number of clients viewing a session. */
	getViewerCount(sessionId: string): number {
		let count = 0;
		for (const sid of this.clients.values()) {
			if (sid === sessionId) count++;
		}
		return count;
	}

	/** Check if any client is viewing a session. */
	hasViewers(sessionId: string): boolean {
		for (const sid of this.clients.values()) {
			if (sid === sessionId) return true;
		}
		return false;
	}

	/** Remove a client entirely. Returns the session they were viewing. */
	removeClient(clientId: string): string | undefined {
		const sessionId = this.clients.get(clientId);
		this.clients.delete(clientId);
		if (sessionId) {
			this.log?.info(
				`client=${clientId} unregistered from session=${sessionId}`,
			);
		}
		return sessionId;
	}

	/** Clear all state. */
	clear(): void {
		this.clients.clear();
	}
}
