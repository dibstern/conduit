import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RelayMessage } from "../shared-types.js";
import type { IncomingMessageType } from "./ws-router.js";

export interface WsClientConnectedEvent {
	clientId: string;
	clientCount: number;
	requestedSessionId?: string;
}

export interface WsClientDisconnectedEvent {
	clientId: string;
	clientCount: number;
	sessionId?: string;
}

export interface WsMessageEvent {
	clientId: string;
	handler: IncomingMessageType;
	payload: Record<string, unknown>;
}

export interface WebSocketHandlerShape {
	broadcast(msg: RelayMessage): void;
	sendTo(clientId: string, msg: RelayMessage): void;
	setClientSession(clientId: string, sessionId: string): void;
	getClientSession(clientId: string): string | undefined;
	getClientsForSession(sessionId: string): string[];
	sendToSession(sessionId: string, msg: RelayMessage): void;
	broadcastPerSessionEvent(sessionId: string, msg: RelayMessage): void;
	markClientBootstrapped(clientId: string): void;
	getClientCount(): number;
	getClientIds(): string[];
	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
	close(): void;
	drain(): Promise<void>;
	on(
		event: "client_connected",
		cb: (data: WsClientConnectedEvent) => void,
	): void;
	on(
		event: "client_disconnected",
		cb: (data: WsClientDisconnectedEvent) => void,
	): void;
	on(event: "message", cb: (data: WsMessageEvent) => void): void;
	on(
		event: "client_error",
		cb: (data: { clientId: string; error: Error }) => void,
	): void;
	once(
		event: "client_connected",
		cb: (data: WsClientConnectedEvent) => void,
	): void;
	once(
		event: "client_disconnected",
		cb: (data: WsClientDisconnectedEvent) => void,
	): void;
	once(event: "message", cb: (data: WsMessageEvent) => void): void;
	once(
		event: "client_error",
		cb: (data: { clientId: string; error: Error }) => void,
	): void;
}
