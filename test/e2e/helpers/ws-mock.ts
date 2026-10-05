// Intercepts the frontend's WebSocket connection using Playwright's
// page.routeWebSocket() and injects canned messages for visual testing.
// No real relay or OpenCode server needed.

import type { Page, WebSocketRoute } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { projectLegacyRelayMessage } from "./detail-projection-mock.js";
import {
	ensureMockTranscriptRpc,
	type MockCatalog,
	sendMockShellSnapshot,
	setMockRpcCatalog,
	setMockRpcProjectSlug,
} from "./rpc-mock.js";

/** Mock-only inputs served over GetModels/GetAgents/GetCommands, never over /ws. */
const CATALOG_MESSAGE_TYPES = new Set([
	"mock_model_catalog",
	"mock_agent_catalog",
	"mock_command_catalog",
]);

function mockCatalog(messages: readonly MockMessage[]): MockCatalog | null {
	const last = (type: string) => messages.filter((m) => m.type === type).at(-1);
	const models = last("mock_model_catalog");
	const commands = last("mock_command_catalog");
	const agents = messages.flatMap((m) =>
		m.type === "mock_agent_catalog"
			? [
					{
						providerScope: (m["providerScope"] as
							| { id: string; name: string }
							| undefined) ?? { id: "opencode", name: "OpenCode" },
						agents: m["agents"] as unknown[],
					},
				]
			: [],
	);
	if (!models && !commands && agents.length === 0) return null;
	return {
		...(models ? { providers: models["providers"] as unknown[] } : {}),
		...(commands ? { commands: commands["commands"] as unknown[] } : {}),
		...(agents.length > 0 ? { agents } : {}),
	};
}

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
	 * Use this to respond to remaining raw WS commands or test-only probes.
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
	"delta",
	"done",
	"error",
	"message_removed",
	"part_removed",
	"provider_session_reloaded",
	"result",
	"session_deleted",
	"session_forked",
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
	const sessionId = explicitSessionId ?? context.activeSessionId;

	if (
		(SESSION_SCOPED_MESSAGE_TYPES.has(normalized.type) ||
			normalized.type === "model_info") &&
		sessionId
	) {
		normalized["sessionId"] = sessionId;
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
	const streamedTranscript = [...options.responses.values()].some((messages) =>
		messages.some((message) =>
			[
				"user_message",
				"delta",
				"thinking_start",
				"thinking_delta",
				"tool_start",
				"result",
			].includes(message.type),
		),
	);
	const catalog = mockCatalog(options.initMessages);
	if (catalog) setMockRpcCatalog(page, catalog);
	if (
		streamedTranscript ||
		catalog ||
		options.initMessages.some((message) =>
			["shell_snapshot", "mock_transcript_snapshot"].includes(message.type),
		)
	)
		await ensureMockTranscriptRpc(page);
	const control = new WsMockControl(page);
	// Mock-only input: deliver roots through SubscribeShell, never through /ws.
	const initialShell = options.initMessages.find(
		(message) => message.type === "shell_snapshot" && message["roots"] === true,
	);
	const initialProject = options.initMessages.find(
		(message) => message.type === "project_list",
	);
	if (typeof initialProject?.["current"] === "string")
		setMockRpcProjectSlug(page, initialProject["current"]);
	if (Array.isArray(initialShell?.["sessions"]))
		sendMockShellSnapshot(page, initialShell["sessions"]);
	const initDelay = options.initDelay ?? 0;
	const msgDelay = options.messageDelay ?? 0;

	await page.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
		control._onRouted();
		control._setWs(ws);
		control._context.activeSessionId =
			new URL(page.url()).pathname.match(/^\/s\/([^/]+)/)?.[1] ?? null;

		// The daemon socket announces its project before the relay bootstrap;
		// the frontend hydrates on this message.
		const params = new URL(ws.url()).searchParams;
		const projectList = options.initMessages.find(
			(message) => message.type === "project_list",
		);
		const slug =
			params.get("p") ??
			(typeof projectList?.["current"] === "string"
				? projectList["current"]
				: "myapp");
		ws.send(JSON.stringify({ type: "project_attached", slug }));

		// Send init messages on connect (instant by default)
		const initMessages = (
			params.has("session")
				? options.initMessages
				: options.initMessages.filter(
						(message) => !SESSION_SCOPED_MESSAGE_TYPES.has(message.type),
					)
		).filter(
			(message) =>
				message.type !== "shell_snapshot" &&
				!CATALOG_MESSAGE_TYPES.has(message.type),
		);
		void sendSequence(control, initMessages, initDelay);

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
						void sendSequence(control, response, msgDelay);
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
	control: WsMockControl,
	messages: MockMessage[],
	delay: number,
): Promise<void> {
	for (const msg of messages) {
		control.sendMessage(msg);
		if (delay > 0) {
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

/** Control object returned by mockRelayWebSocket */
export class WsMockControl {
	constructor(private readonly page: Page) {
		this._routedPromise = new Promise((resolve) => {
			this._routedResolve = resolve;
		});
	}
	private _routedResolve?: () => void;
	private _routedPromise: Promise<void>;
	private _ws?: WebSocketRoute;
	private _clientMessages: string[] = [];
	readonly _context = createMockRelayProtocolContext();

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
		if (msg.type === "mock_transcript_snapshot") {
			projectLegacyRelayMessage(this.page, msg);
			return;
		}
		if (
			msg.type === "shell_snapshot" &&
			msg["roots"] === true &&
			Array.isArray(msg["sessions"])
		) {
			sendMockShellSnapshot(this.page, msg["sessions"]);
			return;
		}
		if (!this._ws) throw new Error("WebSocket not connected yet");
		this._context.activeSessionId =
			new URL(this.page.url()).pathname.match(/^\/s\/([^/]+)/)?.[1] ?? null;
		const normalized = normalizeMockRelayMessage(msg, this._context);
		projectLegacyRelayMessage(this.page, normalized);
		this._ws.send(JSON.stringify(normalized));
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
