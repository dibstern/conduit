// Typed browser RPC commands and subscription frames for integration tests.

import { randomUUID } from "node:crypto";
import { Socket } from "@effect/platform";
import { RpcClient, type RpcClientError, RpcSerialization } from "@effect/rpc";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	ManagedRuntime,
	Stream,
} from "effect";
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
	type HistoryMessageSchema,
	type LoadMoreHistoryResponse,
	type PermissionDecision,
	type PtyListResponse,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { isRecord } from "../../../src/lib/utils.js";

class TestRpc extends Context.Tag("IntegrationTestBrowserRpc")<
	TestRpc,
	RpcClient.FromGroup<typeof WsRpcGroup, RpcClientError.RpcClientError>
>() {}

type HistoryMessage = typeof HistoryMessageSchema.Type;

export interface ReceivedMessage {
	type: string;
	[key: string]: unknown;
}

export class TestWsClient {
	private readonly runtime: ManagedRuntime.ManagedRuntime<TestRpc, never>;
	private readonly client: Promise<TestRpc["Type"]>;
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
	private readonly projectSlug: string;
	private readonly subscriptions = new Map<
		string,
		Promise<Fiber.RuntimeFiber<void, unknown>>
	>();
	private detailSubscriptionKey: string | undefined;
	private readonly sessionRows = new Map<string, SessionInfo>();
	private readonly turnEndVersions = new Map<string, number>();
	private readonly turnCursors = new Map<string, number>();
	private closed = false;
	private failure: Error | undefined;

	constructor(url: string, initialSessionId?: string) {
		const wsUrl = new URL(url);
		this.activeSessionId =
			wsUrl.searchParams.get("session") ?? (initialSessionId || undefined);
		this.projectSlug = wsUrl.searchParams.get("p") ?? "integration-test";
		const protocol = RpcClient.layerProtocolSocket().pipe(
			Layer.provide(
				Socket.layerWebSocket(`${wsUrl.protocol}//${wsUrl.host}/rpc`),
			),
			Layer.provide(
				Layer.succeed(Socket.WebSocketConstructor, (rpcUrl) => {
					const socket = new WebSocket(rpcUrl);
					socket.once("error", (error) => this.fail(error));
					socket.once("close", () =>
						this.fail(new Error("Client RPC socket closed")),
					);
					return socket as unknown as globalThis.WebSocket;
				}),
			),
			Layer.provide(RpcSerialization.layerJson),
		);
		this.runtime = ManagedRuntime.make(
			Layer.scoped(TestRpc, RpcClient.make(WsRpcGroup)).pipe(
				Layer.provide(protocol),
			),
		);
		this.client = this.runtime.runPromise(
			TestRpc.pipe(Effect.timeout("10 seconds")),
		);
		this.openPromise = (async () => {
			await this.subscribeShell();
			await this.subscribeApprovals();
			if (this.activeSessionId)
				await this.subscribeSessionDetail(this.activeSessionId);
		})().catch((error: unknown) => {
			this.fail(error);
			throw error;
		});
	}

	private fail(error: unknown): void {
		if (this.closed) return;
		this.failure = error instanceof Error ? error : new Error(String(error));
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(this.failure);
		}
		this.waiters = [];
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

	/** Wait for the RPC connection and initial feeds to synchronize. */
	async waitForOpen(): Promise<void> {
		await this.openPromise;
	}

	async rpcCall<A, E>(
		invoke: (client: TestRpc["Type"]) => Effect.Effect<A, E>,
	): Promise<A> {
		if (this.closed) throw new Error("Client closed");
		if (this.failure) throw this.failure;
		const client = await this.client;
		return this.runtime.runPromise(
			invoke(client).pipe(Effect.timeout("10 seconds")),
		);
	}

	getClientId(): string {
		return this.clientId;
	}

	getActiveSessionId(): string | undefined {
		return this.activeSessionId;
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
		await this.subscribeSessionDetail(sessionId);
		await this.subscribeFamily(sessionId);
		const endedBefore = new Map(
			[...this.sessionRows].map(([id, row]) => [
				id,
				row.lastTurnEndVersion ?? -1,
			]),
		);
		this.turnEndVersions.set(sessionId, endedBefore.get(sessionId) ?? -1);
		const cursor = this.received.length;
		this.turnCursors.set(sessionId, cursor);
		const result = await this.rpcCall((client) =>
			client.input.submit({
				projectSlug: this.projectSlug,
				sessionId,
				text,
				inputId: opts.commandId ?? randomUUID(),
				delivery: "queue",
				originId: opts.originId ?? this.clientId,
				...(opts.images ? { images: [...opts.images] } : {}),
			}),
		);
		// A queued submit is never refused; only a steer can be.
		if (!result.ok) throw new Error(`submit refused: ${result.reason}`);
		const dispatchedSessionId = result.sessionId;
		if (dispatchedSessionId !== sessionId)
			this.turnEndVersions.set(
				dispatchedSessionId,
				endedBefore.get(dispatchedSessionId) ?? -1,
			);
		this.turnCursors.set(dispatchedSessionId, cursor);
		await this.subscribeSessionDetail(dispatchedSessionId);
		if (this.activeSessionId === sessionId)
			this.activeSessionId = dispatchedSessionId;
		return dispatchedSessionId;
	}

	async respondPermission(
		requestId: string,
		decision: PermissionDecision = "allow",
	): Promise<void> {
		const clientId = this.clientId;
		await this.rpcCall((client) =>
			client.RespondPermission({
				projectSlug: this.projectSlug,
				originId: clientId,
				commandId: crypto.randomUUID(),
				requestId,
				decision,
			}),
		);
	}

	async createSession(
		title?: string,
		opts: { readonly providerId?: string; readonly instanceId?: string } = {},
	): Promise<ReceivedMessage> {
		const clientId = this.clientId;
		const result = await this.rpcCall((client) =>
			client.CreateSession({
				projectSlug: this.projectSlug,
				originId: clientId,
				...(title != null ? { title } : {}),
				...(opts.providerId ? { providerId: opts.providerId } : {}),
				...(opts.instanceId
					? { instanceId: ProviderInstanceIdSchema.make(opts.instanceId) }
					: {}),
			}),
		);
		this.activeSessionId = result.sessionId;
		await this.subscribeSessionDetail(result.sessionId);
		return { type: "create_session_response", id: result.sessionId };
	}

	async viewSession(
		sessionId: string,
		projectSlug = this.projectSlug,
	): Promise<ReceivedMessage> {
		await this.subscribeSessionDetail(sessionId, projectSlug);
		const clientId = this.clientId;
		const result = await this.rpcCall((client) =>
			client.ViewSession({
				projectSlug,
				sessionId,
				originId: clientId,
			}),
		);
		this.activeSessionId = sessionId;
		await this.subscribeFamily(sessionId, projectSlug);
		return { type: "view_session_response", id: sessionId, ...result };
	}

	async switchSession(sessionId: string): Promise<ReceivedMessage> {
		return await this.viewSession(sessionId);
	}

	async loadTranscriptSnapshot(
		sessionId: string,
		projectSlug = this.projectSlug,
	): Promise<void> {
		await this.subscribeSessionDetail(sessionId, projectSlug);
	}

	async loadMoreHistory(
		sessionId: string,
		before?: string,
		projectSlug = this.projectSlug,
	): Promise<LoadMoreHistoryResponse> {
		await this.subscribeSessionDetail(sessionId, projectSlug);
		return await this.rpcCall((client) =>
			client.LoadMoreHistory({
				projectSlug,
				sessionId,
				...(before ? { before } : {}),
			}),
		);
	}

	async deleteSession(sessionId: string): Promise<void> {
		const clientId = this.clientId;
		await this.rpcCall((client) =>
			client.DeleteSession({
				projectSlug: this.projectSlug,
				sessionId,
				originId: clientId,
			}),
		);
	}

	async forkSession(
		opts: { readonly sessionId?: string; readonly messageId?: string } = {},
	): Promise<ReceivedMessage> {
		const clientId = this.clientId;
		const sessionId = opts.sessionId ?? this.getActiveSessionId();
		if (sessionId) await this.subscribeSessionDetail(sessionId);
		const result = await this.rpcCall((client) =>
			client.ForkSession({
				projectSlug: this.projectSlug,
				originId: clientId,
				...(sessionId ? { sessionId } : {}),
				...(opts.messageId != null ? { messageId: opts.messageId } : {}),
			}),
		);
		this.activeSessionId = result.sessionId;
		await this.subscribeSessionDetail(result.sessionId);
		return { type: "fork_session_response", id: result.sessionId };
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
		await this.subscribeSessionDetail(sessionId);
		await this.rpcCall((client) =>
			client.SyncInputDraft({
				projectSlug: this.projectSlug,
				sessionId,
				text,
				...(opts.originId ? { originId: opts.originId } : {}),
			}),
		);
	}

	async cancelSession(sessionId = this.getActiveSessionId()): Promise<void> {
		if (!sessionId) {
			throw new Error("Cannot cancel before selecting a session");
		}
		await this.subscribeSessionDetail(sessionId);
		await this.rpcCall((client) =>
			client.CancelSession({
				projectSlug: this.projectSlug,
				sessionId,
				commandId: crypto.randomUUID(),
			}),
		);
	}

	async switchAgent(
		agentId: string,
		sessionId = this.getActiveSessionId(),
	): Promise<void> {
		if (!sessionId) {
			throw new Error("Cannot switch agent before selecting a session");
		}
		await this.subscribeSessionDetail(sessionId);
		await this.rpcCall((client) =>
			client.SwitchAgent({
				projectSlug: this.projectSlug,
				sessionId,
				agentId,
			}),
		);
	}

	async switchModel(
		modelId: string,
		providerId: string,
		sessionId = this.getActiveSessionId(),
	): Promise<void> {
		if (!sessionId) {
			throw new Error("Cannot switch model before selecting a session");
		}
		await this.subscribeSessionDetail(sessionId);
		await this.rpcCall((client) =>
			client.SwitchModel({
				projectSlug: this.projectSlug,
				sessionId,
				modelId,
				providerId,
			}),
		);
	}

	async getAgents(
		sessionId = this.getActiveSessionId(),
	): Promise<GetAgentsResponse> {
		return await this.rpcCall((client) =>
			client.GetAgents({
				projectSlug: this.projectSlug,
				...(sessionId ? { sessionId } : {}),
			}),
		);
	}

	async getCommands(
		sessionId = this.getActiveSessionId(),
	): Promise<GetCommandsResponse> {
		return await this.rpcCall((client) =>
			client.GetCommands({
				projectSlug: this.projectSlug,
				...(sessionId ? { sessionId } : {}),
			}),
		);
	}

	async getModels(
		sessionId = this.getActiveSessionId(),
	): Promise<GetModelsResponse> {
		return await this.rpcCall((client) =>
			client.GetModels({
				projectSlug: this.projectSlug,
				...(sessionId ? { sessionId } : {}),
			}),
		);
	}

	async getProjects(): Promise<GetProjectsResponse> {
		return await this.rpcCall((client) =>
			client.GetProjects({
				projectSlug: this.projectSlug,
			}),
		);
	}

	async createPty(): Promise<void> {
		const clientId = this.clientId;
		await this.rpcCall((client) =>
			client.CreatePty({
				projectSlug: this.projectSlug,
				originId: clientId,
			}),
		);
	}

	async closePty(ptyId: string): Promise<void> {
		await this.rpcCall((client) =>
			client.ClosePty({
				projectSlug: this.projectSlug,
				ptyId,
			}),
		);
	}

	async resizePty(
		ptyId: string,
		size: { readonly cols?: number; readonly rows?: number },
	): Promise<void> {
		const clientId = this.clientId;
		await this.rpcCall((client) =>
			client.ResizePty({
				projectSlug: this.projectSlug,
				ptyId,
				originId: clientId,
				...(size.cols != null ? { cols: size.cols } : {}),
				...(size.rows != null ? { rows: size.rows } : {}),
			}),
		);
	}

	/**
	 * Follow the project's terminals over SubscribePtys, as the browser does.
	 * Each envelope lands in `received` as `{ type: "pty", ...envelope }`;
	 * resolves once the opening snapshot is synchronized.
	 */
	async subscribePtys(projectSlug = this.projectSlug): Promise<void> {
		await this.follow(
			"pty",
			(client) => client.SubscribePtys({ projectSlug }),
			{ projectSlug },
		);
	}

	/** Follow the project's root shell rows over SubscribeShell, as the
	 *  browser does. Each envelope lands in `received` as
	 *  `{ type: "shell", ...envelope }`. Idempotent. */
	async subscribeShell(): Promise<void> {
		const projectSlug = this.projectSlug;
		await this.follow(
			"shell",
			(client) => client.SubscribeShell({ projectSlug }),
			{ projectSlug },
			(envelope) => {
				const rows =
					envelope._tag === "snapshot"
						? envelope.rows
						: envelope._tag === "upsert"
							? [envelope.item]
							: [];
				if (envelope._tag === "snapshot") this.sessionRows.clear();
				for (const row of rows) this.sessionRows.set(row.id, row);
				if (envelope._tag === "remove") this.sessionRows.delete(envelope.id);
			},
		);
	}

	/**
	 * Wait until the session's shell row shows a new turn: busy or retry, or a
	 * newer turn end. The row is read when it is published, so a turn shorter
	 * than that read (a fast replay) reaches the client already idle, with only
	 * its turn end to show it ran (conduit-test-ni8.35). Call subscribeShell()
	 * before acting when the turn may end before this wait.
	 */
	async waitForTurnStart(
		sessionId = this.getActiveSessionId(),
		timeout = 5000,
	): Promise<void> {
		type Row = { id?: string; status?: string; lastTurnEndVersion?: number };
		const rowsOf = (msg: ReceivedMessage): Row[] =>
			msg["_tag"] === "upsert"
				? [msg["item"] as Row]
				: msg["_tag"] === "snapshot" && Array.isArray(msg["rows"])
					? (msg["rows"] as Row[])
					: [];
		const endedBefore =
			this.turnEndVersions.get(sessionId ?? "") ??
			Math.max(
				-1,
				...this.received
					.filter((msg) => msg.type === "shell")
					.flatMap(rowsOf)
					.filter((row) => row.id === sessionId)
					.map((row) => row.lastTurnEndVersion ?? -1),
			);
		const started = this.waitForAny(["shell", "family"], {
			timeout,
			cursor: this.turnCursors.get(sessionId ?? "") ?? 0,
			predicate: (msg) =>
				rowsOf(msg).some(
					(row) =>
						row.id === sessionId &&
						(row.status === "busy" ||
							row.status === "retry" ||
							(row.lastTurnEndVersion ?? -1) > endedBefore),
				),
		});
		await this.subscribeShell();
		await started;
	}

	/** The terminal shell row must advance past the fence captured before sending. */
	async waitForTurnEnd(
		sessionId = this.getActiveSessionId(),
		timeout = 10_000,
	): Promise<SessionInfo> {
		if (!sessionId)
			throw new Error("Cannot wait for a turn before selecting a session");
		const endedBefore = this.turnEndVersions.get(sessionId) ?? -1;
		const rowsOf = (msg: ReceivedMessage): readonly SessionInfo[] =>
			msg["_tag"] === "upsert"
				? [msg["item"] as SessionInfo]
				: msg["_tag"] === "snapshot"
					? (msg["rows"] as SessionInfo[])
					: [];
		const matches = (row: SessionInfo) =>
			row.id === sessionId &&
			(row.status === "idle" || row.status === "error") &&
			(row.lastTurnEndVersion ?? -1) > endedBefore;
		const frame = await this.waitForAny(["shell", "family"], {
			timeout,
			cursor: this.turnCursors.get(sessionId) ?? 0,
			predicate: (msg) => rowsOf(msg).some(matches),
		});
		return rowsOf(frame).find(matches) as SessionInfo;
	}

	async waitForTranscriptMessage(
		predicate: (message: HistoryMessage) => boolean,
		sessionId = this.getActiveSessionId(),
		timeout = 10_000,
	): Promise<HistoryMessage> {
		const frame = await this.waitFor("transcript_message", {
			timeout,
			cursor: this.turnCursors.get(sessionId ?? "") ?? 0,
			predicate: (msg) =>
				msg["sessionId"] === sessionId &&
				predicate(msg as unknown as HistoryMessage),
		});
		return frame as unknown as HistoryMessage;
	}

	async waitForAssistantText(
		sessionId = this.getActiveSessionId(),
		timeout = 10_000,
	): Promise<HistoryMessage> {
		return this.waitForTranscriptMessage(
			(message) =>
				message.role === "assistant" &&
				(message.parts ?? []).some(
					(part) =>
						part.type === "text" &&
						typeof part.text === "string" &&
						part.text.length > 0,
				),
			sessionId,
			timeout,
		);
	}

	async waitForToolState(
		partId: string,
		status: string | undefined,
		sessionId = this.getActiveSessionId(),
		timeout = 10_000,
	): Promise<NonNullable<HistoryMessage["parts"]>[number]> {
		const matches = (part: NonNullable<HistoryMessage["parts"]>[number]) =>
			part.id === partId &&
			part.type === "tool" &&
			(status === undefined ||
				(isRecord(part.state) && part.state["status"] === status));
		const message = await this.waitForTranscriptMessage(
			(message) => (message.parts ?? []).some(matches),
			sessionId,
			timeout,
		);
		return message.parts?.find(matches) as NonNullable<
			HistoryMessage["parts"]
		>[number];
	}

	/** Follow a session's family over SubscribeSessionFamily, as the browser
	 *  does for the viewed session. Each envelope lands in `received` as
	 *  `{ type: "family", familyOf: sessionId, ...envelope }`. Idempotent per
	 *  session. */
	async subscribeFamily(
		sessionId: string,
		projectSlug = this.projectSlug,
	): Promise<void> {
		await this.follow(
			"family",
			(client) => client.SubscribeSessionFamily({ projectSlug, sessionId }),
			{ projectSlug, familyOf: sessionId },
			(envelope) => {
				const rows =
					envelope._tag === "snapshot"
						? envelope.rows
						: envelope._tag === "upsert"
							? [envelope.item]
							: [];
				for (const row of rows) this.sessionRows.set(row.id, row);
				if (envelope._tag === "remove") this.sessionRows.delete(envelope.id);
			},
		);
	}

	/** Follow `familyOf`'s family and resolve with the rows of the first
	 *  envelope (snapshot or upsert) carrying a row that matches `predicate`. */
	async waitForFamilyRows(
		familyOf: string,
		predicate: (row: SessionInfo) => boolean = () => true,
		timeout?: number,
	): Promise<readonly SessionInfo[]> {
		const rowsOf = (msg: ReceivedMessage): readonly SessionInfo[] =>
			msg["_tag"] === "upsert"
				? [msg["item"] as SessionInfo]
				: msg["_tag"] === "snapshot"
					? (msg["rows"] as SessionInfo[])
					: [];
		const match = this.waitFor("family", {
			...(timeout !== undefined && { timeout }),
			predicate: (msg) =>
				msg["familyOf"] === familyOf && rowsOf(msg).some(predicate),
		});
		await this.subscribeFamily(familyOf);
		return rowsOf(await match);
	}

	/** Each feed records its typed envelopes and waits for synchronization. */
	private async follow<A extends object>(
		type: string,
		open: (client: TestRpc["Type"]) => Stream.Stream<A, unknown>,
		scope: { projectSlug: string; familyOf?: string; sessionId?: string },
		onEnvelope?: (envelope: A) => Promise<void> | void,
	): Promise<void> {
		const key = JSON.stringify([type, scope]);
		const existing = this.subscriptions.get(key);
		if (existing) {
			await existing;
			return;
		}
		const ready = (async () => {
			if (this.closed) throw new Error("Client closed");
			if (this.failure) throw this.failure;
			const client = await this.client;
			const synchronized = this.waitFor(type, {
				cursor: this.received.length,
				predicate: (msg) =>
					msg["_tag"] === "synchronized" &&
					msg["projectSlug"] === scope.projectSlug &&
					msg["familyOf"] === scope.familyOf &&
					msg["sessionId"] === scope.sessionId,
			});
			const fiber = this.runtime.runFork(
				Stream.runForEach(open(client), (envelope) =>
					Effect.promise(async () => {
						this.receive({ type, ...scope, ...envelope });
						await onEnvelope?.(envelope);
					}),
				).pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause))
								return;
							if (Exit.isFailure(exit)) this.fail(Cause.squash(exit.cause));
							else this.fail(new Error("RPC subscription ended"));
						}),
					),
				),
			);
			await synchronized;
			return fiber;
		})();
		this.subscriptions.set(key, ready);
		await ready;
	}

	async subscribeSessionDetail(
		sessionId: string,
		projectSlug = this.projectSlug,
	): Promise<void> {
		const scope = { projectSlug, sessionId };
		const key = JSON.stringify(["session_detail", scope]);
		while (
			this.detailSubscriptionKey !== undefined &&
			this.detailSubscriptionKey !== key
		) {
			const previous = this.detailSubscriptionKey;
			const subscription = this.subscriptions.get(previous);
			if (subscription)
				await this.runtime.runPromise(Fiber.interrupt(await subscription));
			if (this.subscriptions.get(previous) === subscription) {
				this.subscriptions.delete(previous);
				if (this.detailSubscriptionKey === previous)
					this.detailSubscriptionKey = undefined;
			}
		}
		this.detailSubscriptionKey = key;
		await this.follow(
			"session_detail",
			(client) => client.SubscribeSessionDetail({ projectSlug, sessionId }),
			scope,
			(envelope) => {
				const items =
					envelope._tag === "snapshot"
						? envelope.rows
						: envelope._tag === "upsert"
							? [envelope.item]
							: [];
				for (const item of items)
					if (item._tag === "event")
						this.receive({ ...item.event, type: item.event.type, sessionId });
					else if (item._tag === "transcriptMessage")
						this.receive({
							...item.message,
							type: "transcript_message",
							sessionId,
						});
			},
		);
	}

	private subscribeApprovals(): Promise<void> {
		const projectSlug = this.projectSlug;
		return this.follow(
			"approvals",
			(client) => client.SubscribeApprovals({ projectSlug }),
			{ projectSlug },
			(envelope) => {
				const items =
					envelope._tag === "snapshot"
						? envelope.rows
						: envelope._tag === "upsert"
							? [envelope.item]
							: [];
				for (const item of items)
					this.receive({ ...item, type: `${item._tag}_pending` });
				if (envelope._tag === "remove")
					this.receive({ type: "approval_removed", id: envelope.id });
			},
		);
	}

	/**
	 * Follow the project's alerts over SubscribeAlerts, as the browser does.
	 * Each envelope lands in `received` as `{ type: "alerts", ...envelope }`.
	 */
	subscribeAlerts(projectSlug = this.projectSlug): Promise<void> {
		return this.follow(
			"alerts",
			(client) => client.SubscribeAlerts({ projectSlug }),
			{ projectSlug },
		);
	}

	/**
	 * Follow a session's composer draft over SubscribeInputDraft. Each envelope
	 * lands in `received` as `{ type: "input_draft", ...envelope }`.
	 */
	async subscribeInputDraft(
		sessionId: string,
		projectSlug = this.projectSlug,
	): Promise<void> {
		await this.subscribeSessionDetail(sessionId, projectSlug);
		await this.follow(
			"input_draft",
			(client) => client.SubscribeInputDraft({ projectSlug, sessionId }),
			{ projectSlug, sessionId },
		);
	}

	async ptyInput(ptyId: string, data: string): Promise<void> {
		await this.rpcCall((client) =>
			client.PtyInput({
				projectSlug: this.projectSlug,
				ptyId,
				data,
			}),
		);
	}

	async listPtys(): Promise<PtyListResponse> {
		const clientId = this.clientId;
		return await this.rpcCall((client) =>
			client.ListPtys({
				projectSlug: this.projectSlug,
				originId: clientId,
			}),
		);
	}

	async renameSession(sessionId: string, title: string): Promise<void> {
		await this.subscribeSessionDetail(sessionId);
		await this.rpcCall((client) =>
			client.RenameSession({
				projectSlug: this.projectSlug,
				sessionId,
				title,
			}),
		);
	}

	async getFileTree(): Promise<GetFileTreeResponse> {
		return await this.rpcCall((client) =>
			client.GetFileTree({
				projectSlug: this.projectSlug,
			}),
		);
	}

	async getFileList(path = "."): Promise<GetFileListResponse> {
		return await this.rpcCall((client) =>
			client.GetFileList({
				projectSlug: this.projectSlug,
				path,
			}),
		);
	}

	async getFileContent(path: string): Promise<GetFileContentResponse> {
		return await this.rpcCall((client) =>
			client.GetFileContent({
				projectSlug: this.projectSlug,
				path,
			}),
		);
	}

	/** Wait for a message matching a type (and optional predicate).
	 *  Default 10s: full relay pipeline (SSE → translate → tag → broadcast)
	 *  processes 26+ events with real I/O; measured throughput is 4-8s. */
	waitFor(
		type: string,
		opts?: {
			timeout?: number;
			predicate?: (msg: ReceivedMessage) => boolean;
			cursor?: number;
		},
	): Promise<ReceivedMessage> {
		const timeout = opts?.timeout ?? 10_000;

		// Check already-received messages first
		const existing = this.received
			.slice(opts?.cursor ?? 0)
			.find((m) => m.type === type && (!opts?.predicate || opts.predicate(m)));
		if (existing) return Promise.resolve(existing);
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.reject(new Error("Client closed"));

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

	/** Select the requested/newest root, explicitly creating one when none exists. */
	async waitForInitialState(timeout = 5000): Promise<void> {
		await this.waitForOpen();
		let sessionId = this.getActiveSessionId();
		if (!sessionId) {
			await this.waitFor("shell", {
				timeout,
				predicate: (msg) => msg["_tag"] === "synchronized",
			});
			sessionId = this.sessionRows.values().next().value?.id;
			if (!sessionId)
				sessionId = String(
					(await this.createSession("Integration Test Session"))["id"],
				);
		}
		await this.viewSession(sessionId);
	}

	/**
	 * Wait for any of the given message types (first match wins).
	 * Useful when the same state can arrive through different subscriptions
	 * (e.g., "shell" or "family" for a session status update).
	 */
	waitForAny(
		types: string[],
		opts?: {
			timeout?: number;
			predicate?: (msg: ReceivedMessage) => boolean;
			cursor?: number;
		},
	): Promise<ReceivedMessage> {
		const timeout = opts?.timeout ?? 10_000;

		// Check already-received messages first
		const existing = this.received
			.slice(opts?.cursor ?? 0)
			.find(
				(m) =>
					types.includes(m.type) && (!opts?.predicate || opts.predicate(m)),
			);
		if (existing) return Promise.resolve(existing);
		if (this.failure) return Promise.reject(this.failure);
		if (this.closed) return Promise.reject(new Error("Client closed"));

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
				predicate: (m) =>
					types.includes(m.type) && (!opts?.predicate || opts.predicate(m)),
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
		for (const [id, row] of this.sessionRows)
			this.turnEndVersions.set(id, row.lastTurnEndVersion ?? -1);
		this.turnCursors.clear();
		this.received = [];
	}

	/** Close the connection */
	async close(): Promise<void> {
		this.closed = true;
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Client closed"));
		}
		this.waiters = [];
		await this.runtime.dispose();
	}
}
