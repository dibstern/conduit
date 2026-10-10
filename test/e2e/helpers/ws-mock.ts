// Projects canned relay fixtures into the frontend's mocked RPC feeds.
// No real relay or OpenCode server needed.

import type { Page } from "@playwright/test";
import type { MockMessage } from "../fixtures/mockup-state.js";
import { projectLegacyRelayMessage } from "./detail-projection-mock.js";
import {
	ensureMockTranscriptRpc,
	type MockCatalog,
	type MockModelState,
	type RpcMockControl,
	sendMockDaemonList,
	sendMockModelState,
	sendMockProjectSetting,
	sendMockShellRowPatch,
	sendMockShellSnapshot,
	setMockRpcCatalog,
	setMockRpcProjectSlug,
} from "./rpc-mock.js";

const OPENCODE_CONNECTION_STATES = [
	"stopped",
	"starting",
	"connected",
	"reconnecting",
	"failed",
] as const;

/** Mock-only inputs served over the daemon-global subscriptions. */
const DAEMON_LIST_TAGS = new Map<
	string,
	"SubscribeProjects" | "SubscribeInstances" | "SubscribeServerStatus"
>([
	["project_list", "SubscribeProjects"],
	["instance_list", "SubscribeInstances"],
	["server_status", "SubscribeServerStatus"],
]);

/** Deliver a list message through its subscription; false if it is not one. */
function sendDaemonList(page: Page, message: MockMessage): boolean {
	const tag = DAEMON_LIST_TAGS.get(message.type);
	if (tag)
		sendMockDaemonList(
			page,
			tag,
			Object.fromEntries(
				Object.entries(message).filter(([key]) => key !== "type"),
			),
		);
	return tag !== undefined;
}

/**
 * Recorded fixtures still carry the retired model_info / variant_info /
 * context_window_info frames. The server now reports those settings through
 * GetModels (and the session's shell row), so the mock serves them there.
 */
function legacyModelState(message: MockMessage): MockModelState | null {
	const { type, sessionId: _sessionId, ...fields } = message;
	if (type === "model_info") return { active: fields };
	if (type === "variant_info") return { variant: fields };
	if (type === "context_window_info") return { contextWindow: fields };
	return null;
}

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
	const modelState: MockModelState = Object.assign(
		{},
		...messages.map(legacyModelState),
	);
	if (
		!models &&
		!commands &&
		agents.length === 0 &&
		Object.keys(modelState).length === 0
	)
		return null;
	return {
		...modelState,
		...(models ? { providers: models["providers"] as unknown[] } : {}),
		...(commands ? { commands: commands["commands"] as unknown[] } : {}),
		...(agents.length > 0 ? { agents } : {}),
	};
}

export interface WsMockOptions {
	/** Messages to seed on the first RPC connection; subscriptions replay their state. */
	initMessages: MockMessage[];

	/**
	 * Map of user-message-text → response messages.
	 * When the frontend sends an input.submit RPC, we match the text
	 * and send back the corresponding response sequence.
	 */
	responses: Map<string, MockMessage[]>;

	/** Delay (ms) between seeding init messages. Default: 0 (instant) */
	initDelay?: number;

	/** Delay (ms) between response messages. Default: 0 (instant) */
	messageDelay?: number;
}

export interface MockRelayProtocolContext {
	activeSessionId: string | null;
}

const SESSION_SCOPED_MESSAGE_TYPES = new Set([
	"compaction",
	"delta",
	"done",
	"error",
	"message_removed",
	"part_removed",
	"provider_session_reloaded",
	"result",
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

	if (SESSION_SCOPED_MESSAGE_TYPES.has(normalized.type) && sessionId) {
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
 * Set up RPC interception and relay fixture projections before navigating.
 * Must be called BEFORE page.goto().
 *
 * Returns a control object to await specific states.
 */
export async function mockRelayWebSocket(
	page: Page,
	options: WsMockOptions,
): Promise<WsMockControl> {
	const catalog = mockCatalog(options.initMessages);
	if (catalog) setMockRpcCatalog(page, catalog);
	// The project attach is an RPC reply, so every mocked relay needs /rpc.
	const rpc = await ensureMockTranscriptRpc(page);
	const control = new WsMockControl(page, rpc);
	// Seed roots first so status messages can update their rows.
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
	// Bind unscoped fixtures to the first page's session route. Seed once:
	// the RPC mock replays the latest projections to each new subscription.
	rpc.onConnect = () => {
		delete rpc.onConnect;
		void control.sendMessages(
			options.initMessages.filter((message) => message !== initialShell),
			options.initDelay ?? 0,
		);
	};
	rpc.onSendMessage = (payload) => {
		const text = payload["text"];
		if (typeof text !== "string") return;
		const response = options.responses.get(text);
		if (!response) return;
		const context = createMockRelayProtocolContext(
			typeof payload["sessionId"] === "string" ? payload["sessionId"] : null,
		);
		void control.sendMessages(
			normalizeMockRelayMessages(response, context),
			options.messageDelay ?? 0,
		);
	};

	return control;
}

/** Control object returned by mockRelayWebSocket */
export class WsMockControl {
	constructor(
		private readonly page: Page,
		private readonly rpcControl: RpcMockControl,
	) {}
	private readonly context = createMockRelayProtocolContext();

	/** RPC sockets opened so far; each page load opens a new one. */
	get connections(): number {
		return this.rpcControl.connections;
	}

	/** Update RPC projection state, with or without a connected client. */
	sendMessage(msg: MockMessage): void {
		if (
			msg.type === "mock_transcript_snapshot" ||
			msg.type === "mock_pending_input" ||
			msg.type === "mock_pending_input_removed"
		) {
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
		if (sendDaemonList(this.page, msg)) return;
		// Legacy fixture vocabulary for live project facts, which now ride
		// SubscribeProjectSettings (conduit-test-ni8.15 / ni8.40).
		if (msg.type === "client_count" && typeof msg["count"] === "number") {
			sendMockProjectSetting(this.page, {
				_tag: "clientCount",
				count: msg["count"],
			});
			return;
		}
		if (msg.type === "connection_status") {
			const status = OPENCODE_CONNECTION_STATES.find(
				(state) => state === msg["status"],
			);
			if (status)
				sendMockProjectSetting(this.page, {
					_tag: "opencodeConnection",
					instanceId: "opencode",
					status,
				});
			return;
		}
		const modelState = legacyModelState(msg);
		if (modelState) {
			sendMockModelState(this.page, modelState);
			return;
		}
		this.context.activeSessionId =
			new URL(this.page.url()).pathname.match(/^\/s\/([^/]+)/)?.[1] ?? null;
		// Legacy fixture vocabulary for session status, turn ends and goals,
		// which now ride the shell row (conduit-test-ni8.35).
		const rowSessionId =
			typeof msg["sessionId"] === "string"
				? msg["sessionId"]
				: this.context.activeSessionId;
		if (msg.type === "status" || msg.type === "session.goal_changed") {
			const { type: _type, ...goalState } = msg;
			if (rowSessionId)
				sendMockShellRowPatch(this.page, rowSessionId, () =>
					msg.type === "status"
						? { status: msg["status"] === "processing" ? "busy" : "idle" }
						: { goalState },
				);
			return;
		}
		// Like the projector on turn.completed: the row goes idle with an
		// advanced turn-end version. The transcript projection still runs.
		if (msg.type === "done" && rowSessionId)
			sendMockShellRowPatch(this.page, rowSessionId, (row) => ({
				status: "idle",
				lastTurnEndVersion:
					(typeof row["lastTurnEndVersion"] === "number"
						? row["lastTurnEndVersion"]
						: -1) + 1,
			}));
		const normalized = normalizeMockRelayMessage(msg, this.context);
		if (projectLegacyRelayMessage(this.page, normalized)) return;
		// Retired relay types without an RPC projection have no browser consumer.
		return;
	}

	/** Send multiple messages with optional delay between them. */
	async sendMessages(msgs: MockMessage[], delay = 0): Promise<void> {
		for (const msg of msgs) {
			this.sendMessage(msg);
			if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		}
	}

	/** Close the mocked RPC sockets (simulates server disconnect). */
	close(options?: { code?: number; reason?: string }): void {
		this.rpcControl.closeSockets(options);
	}
}
