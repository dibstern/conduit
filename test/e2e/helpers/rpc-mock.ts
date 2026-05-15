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
}

export interface RecordedRpcRequest {
	readonly tag: string;
	readonly payload: Record<string, unknown>;
}

export class RpcMockControl {
	private readonly requests: RecordedRpcRequest[] = [];

	record(tag: string, payload: Record<string, unknown>): void {
		this.requests.push({ tag, payload });
	}

	getRequests(): readonly RecordedRpcRequest[] {
		return this.requests;
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

async function handleMessage(
	ws: WebSocketRoute,
	handlers: Record<string, RpcHandler>,
	control: RpcMockControl,
	raw: unknown,
) {
	if (Array.isArray(raw)) {
		for (const item of raw) {
			await handleMessage(ws, handlers, control, item);
		}
		return;
	}
	if (isEffectRpcPing(raw)) {
		sendJson(ws, { _tag: "Pong" });
		return;
	}
	if (isEffectRpcRequest(raw)) {
		control.record(raw.tag, raw.payload ?? {});
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
	await page.routeWebSocket(/\/rpc/, (ws: WebSocketRoute) => {
		ws.onMessage((data) => {
			if (typeof data !== "string") return;
			try {
				void handleMessage(ws, options.handlers, control, JSON.parse(data));
			} catch {
				// Ignore malformed client frames in tests.
			}
		});
	});
	return control;
}
