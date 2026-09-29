import type { Page, WebSocketRoute } from "@playwright/test";

interface JsonRpcRequest {
	readonly jsonrpc?: "2.0";
	readonly id?: number | string | null;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

interface EffectRpcRequest {
	readonly _tag: "Request";
	readonly id: string;
	readonly tag: string;
	readonly payload?: Record<string, unknown>;
}

interface EffectRpcPing {
	readonly _tag: "Ping";
}

type RpcHandler = (
	params: Record<string, unknown>,
	request: JsonRpcRequest | EffectRpcRequest,
) => unknown | Promise<unknown>;

export interface RpcMockOptions {
	readonly handlers: Record<string, RpcHandler>;
	readonly streams?: Record<
		string,
		(params: Record<string, unknown>) => readonly unknown[]
	>;
}

export interface RecordedRpcRequest {
	readonly tag: string;
	readonly payload: Record<string, unknown>;
}

export class RpcMockControl {
	private readonly requests: RecordedRpcRequest[] = [];
	private readonly streams = new Map<
		string,
		{ ws: WebSocketRoute; id: string }
	>();
	private shellRows: readonly unknown[] | null = null;
	private shellSequence = 0;

	setShellRows(rows: readonly unknown[]): void {
		this.shellRows = rows;
		this.shellSequence++;
		if (this.streams.has("SubscribeShell")) {
			this.sendChunk("SubscribeShell", [
				{ _tag: "snapshot", sequence: this.shellSequence, rows },
				{ _tag: "synchronized" },
			]);
		}
	}

	initialShellFrames(): readonly unknown[] {
		return this.shellRows === null
			? []
			: [
					{
						_tag: "snapshot",
						sequence: this.shellSequence,
						rows: this.shellRows,
					},
					{ _tag: "synchronized" },
				];
	}

	record(tag: string, payload: Record<string, unknown>): void {
		this.requests.push({ tag, payload });
	}

	getRequests(): readonly RecordedRpcRequest[] {
		return this.requests;
	}

	registerStream(tag: string, ws: WebSocketRoute, id: string): void {
		this.streams.set(tag, { ws, id });
	}

	sendChunk(tag: string, values: readonly unknown[]): void {
		const stream = this.streams.get(tag);
		if (!stream) throw new Error(`No active ${tag} stream`);
		sendJson(stream.ws, { _tag: "Chunk", requestId: stream.id, values });
	}

	failStream(tag: string, message: string): void {
		const stream = this.streams.get(tag);
		if (!stream) throw new Error(`No active ${tag} stream`);
		this.streams.delete(tag);
		sendJson(stream.ws, {
			_tag: "Exit",
			requestId: stream.id,
			exit: {
				_tag: "Failure",
				cause: { _tag: "Fail", error: { _tag: "WsRpcError", message } },
			},
		});
	}

	closeStreamSocket(tag: string): void {
		const stream = this.streams.get(tag);
		if (!stream) throw new Error(`No active ${tag} stream`);
		this.streams.delete(tag);
		stream.ws.close();
	}

	async waitForRequest(
		predicate: (request: RecordedRpcRequest) => boolean,
		timeout = 5000,
	): Promise<RecordedRpcRequest> {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const match = this.requests.find(predicate);
			if (match) return match;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("Timed out waiting for RPC request");
	}
}

const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { method?: unknown }).method === "string";

const isEffectRpcRequest = (value: unknown): value is EffectRpcRequest =>
	typeof value === "object" &&
	value !== null &&
	(value as { _tag?: unknown })._tag === "Request" &&
	typeof (value as { tag?: unknown }).tag === "string" &&
	typeof (value as { id?: unknown }).id === "string";

const isEffectRpcPing = (value: unknown): value is EffectRpcPing =>
	typeof value === "object" &&
	value !== null &&
	(value as { _tag?: unknown })._tag === "Ping";

const sendJson = (ws: WebSocketRoute, message: unknown) => {
	ws.send(JSON.stringify(message));
};

const controls = new WeakMap<Page, RpcMockControl>();
const pendingShellRows = new WeakMap<Page, readonly unknown[]>();

export function sendMockShellSnapshot(
	page: Page,
	rows: readonly unknown[],
): void {
	const control = controls.get(page);
	if (control) control.setShellRows(rows);
	else pendingShellRows.set(page, rows);
}

async function handleMessage(
	ws: WebSocketRoute,
	handlers: Record<string, RpcHandler>,
	streams: RpcMockOptions["streams"],
	control: RpcMockControl,
	raw: unknown,
) {
	if (Array.isArray(raw)) {
		for (const item of raw) {
			await handleMessage(ws, handlers, streams, control, item);
		}
		return;
	}
	if (isEffectRpcPing(raw)) {
		sendJson(ws, { _tag: "Pong" });
		return;
	}
	if (isEffectRpcRequest(raw)) {
		control.record(raw.tag, raw.payload ?? {});
		const stream =
			streams?.[raw.tag] ??
			(raw.tag === "SubscribeShell" && control.initialShellFrames().length > 0
				? () => control.initialShellFrames()
				: undefined);
		if (stream) {
			control.registerStream(raw.tag, ws, raw.id);
			const values = stream(raw.payload ?? {});
			if (values.length > 0) control.sendChunk(raw.tag, values);
			return;
		}
		const handler = handlers[raw.tag];
		if (!handler) return;
		try {
			const result = await handler(raw.payload ?? {}, raw);
			sendJson(ws, {
				_tag: "Exit",
				requestId: raw.id,
				exit: { _tag: "Success", value: result },
			});
		} catch (error) {
			sendJson(ws, {
				_tag: "Defect",
				defect: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	if (!isJsonRpcRequest(raw)) return;

	if (raw.method === "@effect/rpc/Ping") {
		sendJson(ws, {
			jsonrpc: "2.0",
			method: "@effect/rpc/Pong",
		});
		return;
	}

	const handler = handlers[raw.method];
	if (!handler || raw.id == null) return;

	try {
		control.record(raw.method, raw.params ?? {});
		const result = await handler(raw.params ?? {}, raw);
		sendJson(ws, { jsonrpc: "2.0", id: raw.id, result });
	} catch (error) {
		sendJson(ws, {
			jsonrpc: "2.0",
			id: raw.id,
			error: {
				code: 0,
				message: error instanceof Error ? error.message : String(error),
			},
		});
	}
}

export async function mockWsRpc(
	page: Page,
	options: RpcMockOptions,
): Promise<RpcMockControl> {
	const control = new RpcMockControl();
	controls.set(page, control);
	const rows = pendingShellRows.get(page);
	if (rows) control.setShellRows(rows);
	await page.routeWebSocket(/\/rpc/, (ws: WebSocketRoute) => {
		ws.onMessage((data) => {
			if (typeof data !== "string") return;
			try {
				void handleMessage(
					ws,
					options.handlers,
					options.streams,
					control,
					JSON.parse(data),
				);
			} catch {
				// Ignore malformed client frames in tests.
			}
		});
	});
	return control;
}
