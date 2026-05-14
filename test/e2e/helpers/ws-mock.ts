// ─── WebSocket Mock Helper ────────────────────────────────────────────────────
// Intercepts the frontend's WebSocket connection using Playwright's
// page.routeWebSocket() and injects canned messages for visual testing.
// No real relay or OpenCode server needed.

import type { Page, WebSocketRoute } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";

export interface WsMockOptions {
	/** Messages to send immediately on WebSocket connect */
	initMessages: MockMessage[];

	/**
	 * Map of user-message-text → response messages.
	 * When the frontend sends a "message" command, we match the text
	 * and send back the corresponding response sequence.
	 */
	responses: Map<string, MockMessage[]>;

	/** Delay (ms) between init messages. Default: 0 (instant) */
	initDelay?: number;

	/** Delay (ms) between response messages. Default: 0 (instant) */
	messageDelay?: number;

	/**
	 * Optional callback invoked for every client message.
	 * Use this to respond to messages like switch_session, view_session, etc.
	 * The control object can be used to send responses back to the client.
	 */
	onClientMessage?: (
		parsed: Record<string, unknown>,
		control: WsMockControl,
	) => void;
}

export interface MockRelayProtocolContext {
	activeSessionId: string | null;
}

const SESSION_SCOPED_MESSAGE_TYPES = new Set([
	"ask_user",
	"ask_user_error",
	"ask_user_resolved",
	"delta",
	"done",
	"error",
	"history_page",
	"message_removed",
	"part_removed",
	"permission_request",
	"permission_resolved",
	"provider_session_reloaded",
	"result",
	"session_deleted",
	"session_forked",
	"session_switched",
	"status",
	"thinking_delta",
	"thinking_start",
	"thinking_stop",
	"tool_content",
	"tool_executing",
	"tool_result",
	"tool_start",
	"user_message",
]);

export function createMockRelayProtocolContext(
	activeSessionId: string | null = null,
): MockRelayProtocolContext {
	return { activeSessionId };
}

export function normalizeMockRelayMessage(
	msg: MockMessage,
	context: MockRelayProtocolContext,
): MockMessage {
	const normalized: MockMessage = { ...msg };
	const explicitSessionId =
		typeof normalized["sessionId"] === "string"
			? normalized["sessionId"]
			: null;
	const switchedSessionId =
		normalized.type === "session_switched" &&
		typeof normalized["id"] === "string"
			? normalized["id"]
			: null;
	const sessionId =
		explicitSessionId ?? switchedSessionId ?? context.activeSessionId;

	if (SESSION_SCOPED_MESSAGE_TYPES.has(normalized.type) && sessionId) {
		normalized["sessionId"] = sessionId;
	}

	if (normalized.type === "session_switched" && sessionId) {
		context.activeSessionId = sessionId;
		const events = Array.isArray(normalized["events"])
			? (normalized["events"] as MockMessage[])
			: null;
		if (events) {
			const eventContext = createMockRelayProtocolContext(sessionId);
			normalized["events"] = normalizeMockRelayMessages(events, eventContext);
		}
	}

	return normalized;
}

export function normalizeMockRelayMessages(
	messages: MockMessage[],
	context: MockRelayProtocolContext,
): MockMessage[] {
	return messages.map((msg) => normalizeMockRelayMessage(msg, context));
}

/**
 * Set up WS interception on the page before navigating.
 * Must be called BEFORE page.goto().
 *
 * Returns a control object to await specific states.
 */
export async function mockRelayWebSocket(
	page: Page,
	options: WsMockOptions,
): Promise<WsMockControl> {
	const control = new WsMockControl();
	const initDelay = options.initDelay ?? 0;
	const msgDelay = options.messageDelay ?? 0;

	await page.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
		control._onRouted();
		control._setWs(ws);

		// Send init messages on connect (instant by default)
		void sendSequence(ws, options.initMessages, initDelay, control._context);

		// Listen for frontend messages and respond
		ws.onMessage((data) => {
			control._onClientMessage(typeof data === "string" ? data : "");
			try {
				const parsed = typeof data === "string" ? JSON.parse(data) : null;
				if (!parsed) return;

				// Invoke custom handler if provided
				if (options.onClientMessage) {
					options.onClientMessage(parsed as Record<string, unknown>, control);
				}

				if (parsed.type === "message" && typeof parsed.text === "string") {
					const response = options.responses.get(parsed.text);
					if (response) {
						void sendSequence(ws, response, msgDelay, control._context);
					}
				}

				if (parsed.type === "get_agents") {
					const agentList = options.initMessages.find(
						(m) => m.type === "agent_list",
					);
					if (agentList) {
						ws.send(JSON.stringify(agentList));
					}
				}
			} catch {
				// Ignore parse errors
			}
		});
	});

	return control;
}

/** Send messages with delays between them */
async function sendSequence(
	ws: WebSocketRoute,
	messages: MockMessage[],
	delay: number,
	context: MockRelayProtocolContext,
): Promise<void> {
	for (const msg of messages) {
		ws.send(JSON.stringify(normalizeMockRelayMessage(msg, context)));
		if (delay > 0) {
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

/** Control object returned by mockRelayWebSocket */
export class WsMockControl {
	private _routedResolve?: () => void;
	private _routedPromise: Promise<void>;
	private _ws?: WebSocketRoute;
	private _clientMessages: string[] = [];
	readonly _context = createMockRelayProtocolContext();

	constructor() {
		this._routedPromise = new Promise((resolve) => {
			this._routedResolve = resolve;
		});
	}

	/** @internal */
	_onRouted(): void {
		this._routedResolve?.();
	}

	/** @internal */
	_setWs(ws: WebSocketRoute): void {
		this._ws = ws;
	}

	/** @internal */
	_onClientMessage(data: string): void {
		this._clientMessages.push(data);
	}

	/** Wait until the WebSocket route has been established */
	async waitForRoute(): Promise<void> {
		return this._routedPromise;
	}

	/** Send a message to the connected client (for mid-test injections). */
	sendMessage(msg: MockMessage): void {
		if (!this._ws) throw new Error("WebSocket not connected yet");
		this._ws.send(
			JSON.stringify(normalizeMockRelayMessage(msg, this._context)),
		);
	}

	/** Send multiple messages with optional delay between them. */
	async sendMessages(msgs: MockMessage[], delay = 0): Promise<void> {
		for (const msg of msgs) {
			this.sendMessage(msg);
			if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		}
	}

	/** Close the WebSocket connection (simulates server disconnect). */
	close(options?: { code?: number; reason?: string }): void {
		if (!this._ws) throw new Error("WebSocket not connected yet");
		this._ws.close(options);
	}

	/** Get all messages sent by the client (parsed JSON). */
	getClientMessages(): unknown[] {
		return this._clientMessages.map((m) => JSON.parse(m));
	}

	/** Wait for a client message matching a predicate. */
	async waitForClientMessage(
		predicate: (msg: unknown) => boolean,
		timeout = 5000,
	): Promise<unknown> {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const match = this.getClientMessages().find(predicate);
			if (match) return match;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("Timed out waiting for client message");
	}
}
