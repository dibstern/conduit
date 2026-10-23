// [DEBUG-st33r] Throwaway probe: subscribe to one session's detail stream over
// the daemon's RPC socket and print the inbox/pendingInput rows the browser
// derives the Steer button from. Delete after diagnosis.
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeSocket } from "@effect/platform-node";
import { Duration, Effect, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { WsRpcGroup } from "../src/lib/contracts/ws-rpc.js";

const sessionId = process.argv[2] ?? "ses_1b665655521b48589b30dc8e7c921974";
const socketPath = join(homedir(), ".config/conduit/relay.sock");

const program = Effect.scoped(
	Effect.gen(function* () {
		const conn = createConnection(socketPath);
		yield* Effect.promise(
			() =>
				new Promise<void>((resolve, reject) => {
					conn.once("connect", () => resolve());
					conn.once("error", reject);
				}),
		);
		console.log("[DEBUG-st33r] connected");
		const socket = yield* NodeSocket.fromDuplex(Effect.succeed(conn));
		const envelopes = yield* RpcClient.make(WsRpcGroup).pipe(
			Effect.flatMap((client) =>
				client.SubscribeSessionDetail({ sessionId }).pipe(
					Stream.tap((e) =>
						Effect.sync(() =>
							console.log(
								`[DEBUG-st33r] chunk ${JSON.stringify(e).slice(0, 160)}`,
							),
						),
					),
					Stream.interruptWhen(
						Effect.sleep(
							Duration.seconds(Number(process.env.PROBE_SECS ?? 15)),
						),
					),
					Stream.runCollect,
				),
			),
			Effect.provide(
				RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }),
			),
			Effect.provideService(Socket.Socket, socket),
			Effect.provide(RpcSerialization.layerNdjson),
		);
		conn.destroy();
		return envelopes;
	}),
);

const envelopes = await Effect.runPromise(program);
const lines: string[] = [];
const visit = (value: unknown, path: string): void => {
	if (Array.isArray(value)) {
		for (const [i, v] of value.entries()) visit(v, `${path}[${i}]`);
		return;
	}
	if (value && typeof value === "object") {
		const tag = (value as { _tag?: unknown })._tag;
		if (tag === "inbox" || tag === "pendingInput")
			lines.push(`${path} ${JSON.stringify(value)}`);
		else for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
	}
};
visit(envelopes, "env");
const tags = [
	...new Set((envelopes as { _tag?: string }[]).map((e) => e?._tag)),
];
console.log(
	`[DEBUG-st33r] envelopes=${(envelopes as unknown[]).length} tags=${tags.join(",")}`,
);
for (const line of lines) console.log(line.slice(0, 400));
