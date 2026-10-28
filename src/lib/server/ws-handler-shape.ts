import type { EventDelivery } from "./event-audiences.js";

export interface WebSocketHandlerShape {
	setClientSession(
		clientId: string,
		sessionId: string,
		projectId?: string,
		delivery?: EventDelivery,
	): void;
	getClientSession(clientId: string): string | undefined;
	getClientsForSession(sessionId: string): string[];
	/** Register a subscription viewer and return its presence cleanup. */
	registerSessionViewer(sessionId: string): () => void;
	close(): void;
	drain(): Promise<void>;
}
