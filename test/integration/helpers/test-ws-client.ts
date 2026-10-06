// Connects to the relay's WebSocket endpoint and provides typed helpers for
// sending messages, waiting for specific response types, and inspecting
// everything received. Used by integration tests.

import { randomUUID } from "node:crypto";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect, Fiber, Stream } from "effect";
import WebSocket from "ws";
import { ProviderInstanceIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	type GetAgentsResponse,
	type GetCommandsResponse,
	type GetFileContentResponse,
	type GetFileListResponse,
	type GetFileTreeResponse,
	type GetModelsResponse,
	type GetProjectsResponse,
	type LoadMoreHistoryResponse,
	type PermissionDecision,
	type PtyListResponse,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";

export interface ReceivedMessage {
	type: string;
	[key: string]: unknown;
}

export class TestWsClient {
	private ws: WebSocket;
	private readonly rpcUrl: string;
	private readonly clientId = `test-${randomUUID()}`;
	private received: ReceivedMessage[] = [];
	private activeSessionId: string | undefined;
	private waiters: Array<{
		predicate: (msg: ReceivedMessage) => boolean;
		resolve: (msg: ReceivedMessage) => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];
	private openPromise: Promise<void>;
	private ptySubscription: Fiber.RuntimeFiber<void, unknown> | undefined;

	constructor(url: string, initialSessionId?: string) {
		const wsUrl = new URL(url);
		this.activeSessionId =
			wsUrl.searchParams.get("session") ?? initialSessionId;
		wsUrl.searchParams.set("client", this.clientId);
		this.rpcUrl = `${wsUrl.protocol}//${wsUrl.host}/rpc`;
		this.ws = new WebSocket(wsUrl);

		this.openPromise = new Promise<void>((resolve, reject) => {
			this.ws.once("open", () => resolve());
			this.ws.once("error", (err) => reject(err));
		});

		this.ws.on("message", (data) => {
			try {
				this.receive(JSON.parse(data.toString()) as ReceivedMessage);
			} catch {
				// Ignore non-JSON messages
			}
		});
	}

	private receive(msg: ReceivedMessage): void {
		this.received.push(msg);
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i];
			if (waiter === undefined) continue;
			if (waiter.predicate(msg)) {
				clearTimeout(waiter.timer);
				waiter.resolve(msg);
				this.waiters.splice(i, 1);
			}
		}
	}

	/** Wait for the WebSocket connection to open */
	async waitForOpen(): Promise<void> {
		await this.openPromise;
	}

	/** Send a typed message to the relay */
	send(msg: Record<string, unknown>): void {
		this.ws.send(JSON.stringify(msg));
	}

	getClientId(): string {
		return this.clientId;
	}

	getActiveSessionId(): string | undefined {
		if (this.activeSessionId) return this.activeSessionId;
		const family = this.received.find((msg) => msg.type === "session_family");
		const sessions = family?.["sessions"];
		if (!Array.isArray(sessions)) return undefined;
		const first = sessions[0];
		return first && typeof first.id === "string" ? first.id : undefined;
	}

	async sendMessage(
		text: string,
		opts: {
			readonly sessionId?: string;
			readonly images?: readonly string[];
			readonly originId?: string;
			readonly commandId?: string;
		} = {},
	): Promise<string> {
		const sessionId = opts.sessionId ?? this.getActiveSessionId();
		if (!sessionId) {
			throw new Error("Cannot send RPC message before selecting a session");
		}
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			const dispatchedSessionId = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						const result = yield* client.input.submit({
							projectSlug: "integration-test",
							sessionId,
							text,
							inputId: opts.commandId ?? crypto.randomUUID(),
							delivery: "queue",
							...(opts.images ? { images: [...opts.images] } : {}),
							...(opts.originId ? { originId: opts.originId } : {}),
						});
						// A queued submit is never refused; only a steer can be.
						if (!result.ok)
							return yield* Effect.dieMessage(
								`submit refused: ${result.reason}`,
							);
						return result.sessionId;
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
			if (this.activeSessionId === sessionId)
				this.activeSessionId = dispatchedSessionId;
			return dispatchedSessionId;
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async respondPermission(
		requestId: string,
		decision: PermissionDecision = "allow",
	): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.RespondPermission({
							projectSlug: "integration-test",
							originId: clientId,
							commandId: crypto.randomUUID(),
							requestId,
							decision,
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

	async createSession(
		title?: string,
		opts: { readonly providerId?: string; readonly instanceId?: string } = {},
	): Promise<ReceivedMessage> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.CreateSession({
							projectSlug: "integration-test",
							originId: clientId,
							...(title != null ? { title } : {}),
							...(opts.providerId ? { providerId: opts.providerId } : {}),
							...(opts.instanceId
								? { instanceId: ProviderInstanceIdSchema.make(opts.instanceId) }
								: {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
			this.activeSessionId = result.sessionId;
			return { type: "create_session_response", id: result.sessionId };
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async viewSession(
		sessionId: string,
		projectSlug = "integration-test",
	): Promise<ReceivedMessage> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		Reflect.set(globalThis, "WebSocket", WebSocket);
		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.ViewSession({
							projectSlug,
							sessionId,
							originId: clientId,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
			this.activeSessionId = sessionId;
			return { type: "view_session_response", id: sessionId, ...result };
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async switchSession(sessionId: string): Promise<ReceivedMessage> {
		return await this.viewSession(sessionId);
	}

	async loadTranscriptSnapshot(
		sessionId: string,
		projectSlug = "integration-test",
	): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		Reflect.set(globalThis, "WebSocket", WebSocket);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* Stream.runHead(
							client.SubscribeSessionDetail({ projectSlug, sessionId }),
						);
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

	async loadMoreHistory(
		sessionId: string,
		before?: string,
		projectSlug = "integration-test",
	): Promise<LoadMoreHistoryResponse> {
		const previousWebSocket = globalThis.WebSocket;
		Reflect.set(globalThis, "WebSocket", WebSocket);
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.LoadMoreHistory({
							projectSlug,
							sessionId,
							...(before ? { before } : {}),
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
			Reflect.set(globalThis, "WebSocket", previousWebSocket);
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.DeleteSession({
							projectSlug: "integration-test",
							sessionId,
							originId: clientId,
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

	async forkSession(
		opts: { readonly sessionId?: string; readonly messageId?: string } = {},
	): Promise<ReceivedMessage> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.ForkSession({
							projectSlug: "integration-test",
							originId: clientId,
							...(opts.sessionId != null ? { sessionId: opts.sessionId } : {}),
							...(opts.messageId != null ? { messageId: opts.messageId } : {}),
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
			this.activeSessionId = result.sessionId;
			return { type: "fork_session_response", id: result.sessionId };
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
			throw new Error("Cannot sync input draft before selecting a session");
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
			throw new Error("Cannot cancel before selecting a session");
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
							commandId: crypto.randomUUID(),
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
			throw new Error("Cannot switch agent before selecting a session");
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
			throw new Error("Cannot switch model before selecting a session");
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

	async getModels(
		sessionId = this.getActiveSessionId(),
	): Promise<GetModelsResponse> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.GetModels({
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

	async createPty(): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.CreatePty({
							projectSlug: "integration-test",
							originId: clientId,
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

	async closePty(ptyId: string): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.ClosePty({
							projectSlug: "integration-test",
							ptyId,
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

	async resizePty(
		ptyId: string,
		size: { readonly cols?: number; readonly rows?: number },
	): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.ResizePty({
							projectSlug: "integration-test",
							ptyId,
							originId: clientId,
							...(size.cols != null ? { cols: size.cols } : {}),
							...(size.rows != null ? { rows: size.rows } : {}),
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

	/**
	 * Follow the project's terminals over SubscribePtys, as the browser does.
	 * Each envelope lands in `received` as `{ type: "pty", ...envelope }`;
	 * resolves once the opening snapshot is synchronized.
	 */
	async subscribePtys(projectSlug = "integration-test"): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		const receive = (msg: ReceivedMessage) => this.receive(msg);
		try {
			this.ptySubscription = Effect.runFork(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client
							.SubscribePtys({ projectSlug })
							.pipe(
								Stream.runForEach((envelope) =>
									Effect.sync(() => receive({ type: "pty", ...envelope })),
								),
							);
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(Socket.layerWebSocket(this.rpcUrl)),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
			await this.waitFor("pty", {
				predicate: (msg) => msg["_tag"] === "synchronized",
			});
		} finally {
			globalThis.WebSocket = previousWebSocket;
		}
	}

	async ptyInput(ptyId: string, data: string): Promise<void> {
		const previousWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						yield* client.PtyInput({
							projectSlug: "integration-test",
							ptyId,
							data,
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

	async listPtys(): Promise<PtyListResponse> {
		const previousWebSocket = globalThis.WebSocket;
		const clientId = this.clientId;
		globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
		try {
			return await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.ListPtys({
							projectSlug: "integration-test",
							originId: clientId,
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

	/** Wait for the initial connect handshake to settle. */
	async waitForInitialState(timeout = 5000): Promise<void> {
		await Promise.all([
			this.waitFor("status", { timeout }),
			this.waitFor("session_family", { timeout }),
		]);
		const sessionId = this.getActiveSessionId();
		if (sessionId) await this.viewSession(sessionId);
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
		if (this.ptySubscription)
			await Effect.runPromise(Fiber.interrupt(this.ptySubscription));

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
