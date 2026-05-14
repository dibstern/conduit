// ─── Test WebSocket Client ───────────────────────────────────────────────────
// Connects to the relay's WebSocket endpoint and provides typed helpers for
// sending messages, waiting for specific response types, and inspecting
// everything received. Used by integration tests.

import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import WebSocket from "ws";
import {
	type GetAgentsResponse,
	type GetCommandsResponse,
	type GetFileContentResponse,
	type GetFileListResponse,
	type GetFileTreeResponse,
	type GetProjectsResponse,
	type GetTodoResponse,
	type ListSessionsResponse,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";

export interface ReceivedMessage {
	type: string;
	[key: string]: unknown;
}

export class TestWsClient {
	private ws: WebSocket;
	private readonly rpcUrl: string;
	private received: ReceivedMessage[] = [];
	private activeSessionId: string | undefined;
	private waiters: Array<{
		predicate: (msg: ReceivedMessage) => boolean;
		resolve: (msg: ReceivedMessage) => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];
	private openPromise: Promise<void>;

	constructor(url: string) {
		this.rpcUrl = url.replace(/\/ws(\?.*)?$/, "/rpc");
		this.ws = new WebSocket(url);

		this.openPromise = new Promise<void>((resolve, reject) => {
			this.ws.once("open", () => resolve());
			this.ws.once("error", (err) => reject(err));
		});

		this.ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString()) as ReceivedMessage;
				this.received.push(msg);
				if (msg.type === "session_switched") {
					const sessionId = msg["sessionId"] ?? msg["id"];
					if (typeof sessionId === "string") {
						this.activeSessionId = sessionId;
					}
				}

				// Check waiters
				for (let i = this.waiters.length - 1; i >= 0; i--) {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					const waiter = this.waiters[i]!;
					if (waiter.predicate(msg)) {
						clearTimeout(waiter.timer);
						waiter.resolve(msg);
						this.waiters.splice(i, 1);
					}
				}
			} catch {
				// Ignore non-JSON messages
			}
		});
	}

	/** Wait for the WebSocket connection to open */
	async waitForOpen(): Promise<void> {
		await this.openPromise;
	}

	/** Send a typed message to the relay */
	send(msg: Record<string, unknown>): void {
		this.ws.send(JSON.stringify(msg));
	}

	getActiveSessionId(): string | undefined {
		if (this.activeSessionId) return this.activeSessionId;
		for (let index = this.received.length - 1; index >= 0; index--) {
			const msg = this.received[index];
			if (msg?.type === "session_switched") {
				const sessionId = msg["sessionId"] ?? msg["id"];
				return typeof sessionId === "string" ? sessionId : undefined;
			}
		}
		return undefined;
	}

	async sendMessage(
		text: string,
		opts: {
			readonly sessionId?: string;
			readonly images?: readonly string[];
			readonly originId?: string;
		} = {},
	): Promise<void> {
		const sessionId = opts.sessionId ?? this.getActiveSessionId();
		if (!sessionId) {
			throw new Error("Cannot send RPC message before session_switched");
		}
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.SendMessage({
							projectSlug: "integration-test",
							sessionId,
							text,
							...(opts.images ? { images: [...opts.images] } : {}),
							...(opts.originId ? { originId: opts.originId } : {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async syncInputDraft(
		text: string,
		opts: {
			readonly sessionId?: string;
			readonly originId?: string;
		} = {},
	): Promise<void> {
		const sessionId = opts.sessionId ?? this.getActiveSessionId();
		if (!sessionId) {
			throw new Error("Cannot sync input draft before session_switched");
		}
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.SyncInputDraft({
							projectSlug: "integration-test",
							sessionId,
							text,
							...(opts.originId ? { originId: opts.originId } : {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async cancelSession(sessionId = this.getActiveSessionId()): Promise<void> {
		if (!sessionId) {
			throw new Error("Cannot cancel before session_switched");
		}
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.CancelSession({
							projectSlug: "integration-test",
							sessionId,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async switchAgent(
		agentId: string,
		sessionId = this.getActiveSessionId(),
	): Promise<void> {
		if (!sessionId) {
			throw new Error("Cannot switch agent before session_switched");
		}
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.SwitchAgent({
							projectSlug: "integration-test",
							sessionId,
							agentId,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async switchModel(
		modelId: string,
		providerId: string,
		sessionId = this.getActiveSessionId(),
	): Promise<void> {
		if (!sessionId) {
			throw new Error("Cannot switch model before session_switched");
		}
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.SwitchModel({
							projectSlug: "integration-test",
							sessionId,
							modelId,
							providerId,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getAgents(
		sessionId = this.getActiveSessionId(),
	): Promise<GetAgentsResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetAgents({
							projectSlug: "integration-test",
							...(sessionId ? { sessionId } : {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getCommands(
		sessionId = this.getActiveSessionId(),
	): Promise<GetCommandsResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetCommands({
							projectSlug: "integration-test",
							...(sessionId ? { sessionId } : {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getProjects(): Promise<GetProjectsResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetProjects({
							projectSlug: "integration-test",
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getTodo(): Promise<GetTodoResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetTodo({
							projectSlug: "integration-test",
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.RenameSession({
							projectSlug: "integration-test",
							sessionId,
							title,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async searchSessions(
		query: string,
		roots?: boolean,
	): Promise<ListSessionsResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.ListSessions({
							projectSlug: "integration-test",
							query,
							...(roots !== undefined ? { roots } : {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getFileTree(): Promise<GetFileTreeResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetFileTree({
							projectSlug: "integration-test",
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getFileList(path = "."): Promise<GetFileListResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetFileList({
							projectSlug: "integration-test",
							path,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async getFileContent(path: string): Promise<GetFileContentResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetFileContent({
							projectSlug: "integration-test",
							path,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	/** Wait for a message matching a type (and optional predicate).
	 *  Default 10s: full relay pipeline (SSE → translate → tag → broadcast)
	 *  processes 26+ events with real I/O; measured throughput is 4-8s. */
	waitFor(
		type: string,
		opts?: { timeout?: number; predicate?: (msg: ReceivedMessage) => boolean },
	): Promise<ReceivedMessage> {
		const timeout = opts?.timeout ?? 10_000;

		// Check already-received messages first
		const existing = this.received.find(
			(m) => m.type === type && (!opts?.predicate || opts.predicate(m)),
		);
		if (existing) return Promise.resolve(existing);

		return new Promise<ReceivedMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.resolve === resolve);
				if (idx >= 0) this.waiters.splice(idx, 1);
				const types = this.received.map((m) => m.type).join(", ");
				reject(new Error(`Timeout waiting for "${type}" (got: [${types}])`));
			}, timeout);

			this.waiters.push({
				predicate: (m) =>
					m.type === type && (!opts?.predicate || opts.predicate(m)),
				resolve,
				reject,
				timer,
			});
		});
	}

	/** Wait for the initial connect handshake to settle (session_switched + status + lists) */
	async waitForInitialState(timeout = 5000): Promise<void> {
		await Promise.all([
			this.waitFor("session_switched", { timeout }),
			this.waitFor("status", { timeout }),
			this.waitFor("session_list", { timeout }),
		]);
		// Give agents/models a moment to arrive (they're async)
		await new Promise((r) => setTimeout(r, 100));
	}

	/**
	 * Wait for any of the given message types (first match wins).
	 * Useful when a response could start with different event types
	 * (e.g., "delta" or "thinking_delta" depending on model behavior).
	 */
	waitForAny(
		types: string[],
		opts?: { timeout?: number },
	): Promise<ReceivedMessage> {
		const timeout = opts?.timeout ?? 10_000;

		// Check already-received messages first
		const existing = this.received.find((m) => types.includes(m.type));
		if (existing) return Promise.resolve(existing);

		return new Promise<ReceivedMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.resolve === resolve);
				if (idx >= 0) this.waiters.splice(idx, 1);
				const receivedTypes = this.received.map((m) => m.type).join(", ");
				reject(
					new Error(
						`Timeout waiting for any of [${types.join(", ")}] (got: [${receivedTypes}])`,
					),
				);
			}, timeout);

			this.waiters.push({
				predicate: (m) => types.includes(m.type),
				resolve,
				reject,
				timer,
			});
		});
	}

	/** Get all received messages */
	getReceived(): ReceivedMessage[] {
		return [...this.received];
	}

	/** Get all messages of a specific type */
	getReceivedOfType(type: string): ReceivedMessage[] {
		return this.received.filter((m) => m.type === type);
	}

	/** Clear received messages */
	clearReceived(): void {
		this.received = [];
	}

	/** Close the connection */
	async close(): Promise<void> {
		// Cancel all waiters
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Client closed"));
		}
		this.waiters = [];

		if (
			this.ws.readyState === WebSocket.OPEN ||
			this.ws.readyState === WebSocket.CONNECTING
		) {
			return new Promise<void>((resolve) => {
				this.ws.once("close", () => resolve());
				this.ws.close();
			});
		}
	}
}
