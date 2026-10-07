// Helper functions shared between integration and E2E test harnesses.

import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect, Stream } from "effect";
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
	// Attaching /ws settles the relay's default session; the shell serves it
	// as its newest root.
	const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?p=e2e`);
	const previousWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* RpcClient.make(WsRpcGroup);
					const session = yield* client
						.SubscribeShell({ projectSlug: "e2e" })
						.pipe(
							Stream.flatMap((envelope) =>
								Stream.fromIterable(
									envelope._tag === "snapshot"
										? envelope.rows
										: envelope._tag === "upsert"
											? [envelope.item]
											: [],
								),
							),
							Stream.runHead,
							Effect.flatten,
							Effect.timeoutFail({
								duration: "5 seconds",
								onTimeout: () =>
									new Error("Timeout finding the default session"),
							}),
						);
					yield* client.SwitchModel({
						projectSlug: "e2e",
						sessionId: session.id,
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
		ws.close();
	}
}
