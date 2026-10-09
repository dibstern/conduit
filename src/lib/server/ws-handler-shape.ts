export interface WebSocketHandlerShape {
	setClientSession(clientId: string, sessionId: string): void;
	getClientSession(clientId: string): string | undefined;
	getClientsForSession(sessionId: string): string[];
	/** Register a subscription viewer and return its presence cleanup. */
	registerSessionViewer(sessionId: string): () => void;
	close(): void;
	drain(): Promise<void>;
}
