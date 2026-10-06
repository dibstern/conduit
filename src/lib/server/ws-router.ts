// Pure logic for parsing incoming WebSocket messages, client tracking and
// broadcast targeting. Deliberately IO-free: no actual WebSocket I/O.

export interface IncomingMessage {
	type: string;
	[key: string]: unknown;
}

/**
 * Parse and validate an incoming WebSocket message.
 * Returns the parsed object or null if parsing fails.
 */
export function parseIncomingMessage(raw: string): IncomingMessage | null {
	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		if (typeof parsed.type !== "string") {
			return null;
		}
		return parsed as IncomingMessage;
	} catch {
		return null;
	}
}

export interface ClientTracker {
	addClient(clientId: string): number;
	removeClient(clientId: string): number;
	getClientCount(): number;
	getClientIds(): string[];
	hasClient(clientId: string): boolean;
	getBroadcastTargets(excludeClientId?: string): string[];
}

/**
 * Create a client tracker for managing connected WebSocket clients.
 */
export function createClientTracker(): ClientTracker {
	const clients = new Set<string>();

	return {
		addClient(clientId: string): number {
			clients.add(clientId);
			return clients.size;
		},

		removeClient(clientId: string): number {
			clients.delete(clientId);
			return clients.size;
		},

		getClientCount(): number {
			return clients.size;
		},

		getClientIds(): string[] {
			return [...clients];
		},

		hasClient(clientId: string): boolean {
			return clients.has(clientId);
		},

		getBroadcastTargets(excludeClientId?: string): string[] {
			if (!excludeClientId) return [...clients];
			return [...clients].filter((id) => id !== excludeClientId);
		},
	};
}
