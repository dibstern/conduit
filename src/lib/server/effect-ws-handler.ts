import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { WebSocketHandlerShape } from "./ws-handler-shape.js";

export const makeEffectWsHandler = (): Effect.Effect<EffectWsHandler> =>
	Effect.sync(() => new EffectWsHandler());

export class EffectWsHandler implements WebSocketHandlerShape {
	private readonly clientSessions = new Map<string, string>();
	private readonly sessionClients = new Map<string, Set<string>>();
	private closed = false;

	setClientSession(clientId: string, sessionId: string): void {
		this.clientSessions.set(clientId, sessionId);
	}

	getClientSession(clientId: string): string | undefined {
		return this.clientSessions.get(clientId);
	}

	getClientsForSession(sessionId: string): string[] {
		return [...(this.sessionClients.get(sessionId) ?? [])];
	}

	registerSessionViewer(sessionId: string): () => void {
		if (this.closed) return () => {};
		const viewerId = `rpc-viewer-${randomUUID()}`;
		const viewers = this.sessionClients.get(sessionId) ?? new Set<string>();
		viewers.add(viewerId);
		this.sessionClients.set(sessionId, viewers);
		return () => {
			const current = this.sessionClients.get(sessionId);
			current?.delete(viewerId);
			if (current?.size === 0) this.sessionClients.delete(sessionId);
		};
	}

	close(): void {
		this.closed = true;
		this.clientSessions.clear();
		this.sessionClients.clear();
	}

	async drain(): Promise<void> {
		this.close();
	}
}
