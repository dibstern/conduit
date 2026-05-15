// ─── Shared OpenCode Test Utilities ──────────────────────────────────────────
// Helper functions shared between integration and E2E test harnesses.

import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import WebSocket from "ws";
import { WsRpcGroup } from "../../src/lib/contracts/ws-rpc.js";

const OPENCODE_URL = process.env["OPENCODE_URL"] ?? "http://localhost:4096";

export async function isOpenCodeRunning(url?: string): Promise<boolean> {
	try {
		const res = await fetch(`${url ?? OPENCODE_URL}/path`, {
			signal: AbortSignal.timeout(3000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function switchModelViaWs(
	relayPort: number,
	modelId: string,
	providerId: string,
): Promise<void> {
	const sessionId = await new Promise<string>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("Timeout switching model"));
		}, 5000);
		ws.on("message", (data) => {
			try {
				const message = JSON.parse(data.toString()) as {
					type?: string;
					id?: unknown;
					sessionId?: unknown;
				};
				if (message.type !== "session_switched") return;
				clearTimeout(timer);
				ws.close();
				const id = message.sessionId ?? message.id;
				if (typeof id === "string") {
					resolve(id);
				} else {
					reject(new Error("session_switched did not include a session id"));
				}
			} catch {
				// Ignore non-JSON setup frames.
			}
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});

	const previousWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* RpcClient.make(WsRpcGroup);
					yield* client.SwitchModel({
						projectSlug: "e2e",
						sessionId,
						modelId,
						providerId,
					});
				}),
			).pipe(
				Effect.provide(RpcClient.layerProtocolSocket()),
				Effect.provide(
					Socket.layerWebSocket(`ws://127.0.0.1:${relayPort}/rpc`),
				),
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
				Effect.provide(RpcSerialization.layerJson),
			),
		);
	} finally {
		globalThis.WebSocket = previousWebSocket;
	}
}
