import { Context, Effect, Layer, Option, Ref } from "effect";
import { WebSocket, WebSocketServer } from "ws";
import type { RelayMessage } from "../../../shared-types.js";

export interface DaemonWsClient {
	readonly ws: WebSocket;
	readonly slug: string | null;
	readonly detach: () => void;
}

export interface DaemonWsClientRegistry {
	readonly server: WebSocketServer;
	readonly register: (clientId: string, ws: WebSocket) => Effect.Effect<void>;
	readonly get: (
		clientId: string,
	) => Effect.Effect<Option.Option<DaemonWsClient>>;
	readonly setAttachment: (
		clientId: string,
		ws: WebSocket,
		slug: string | null,
		detach: () => void,
	) => Effect.Effect<boolean>;
	readonly remove: (clientId: string, ws: WebSocket) => Effect.Effect<void>;
	readonly broadcastUnattached: (message: RelayMessage) => Effect.Effect<void>;
}

export class DaemonWsClientRegistryTag extends Context.Tag(
	"DaemonWsClientRegistry",
)<DaemonWsClientRegistryTag, DaemonWsClientRegistry>() {}

export const DaemonWsClientRegistryLive = Layer.scoped(
	DaemonWsClientRegistryTag,
	Effect.gen(function* () {
		const clients = yield* Ref.make(new Map<string, DaemonWsClient>());
		const server = new WebSocketServer({ noServer: true });

		const registry: DaemonWsClientRegistry = {
			server,
			register: (clientId, ws) =>
				Effect.gen(function* () {
					const previous = (yield* Ref.get(clients)).get(clientId);
					if (previous) {
						previous.detach();
						previous.ws.close();
					}
					yield* Ref.update(clients, (current) => {
						const next = new Map(current);
						next.set(clientId, { ws, slug: null, detach: () => {} });
						return next;
					});
				}),
			get: (clientId) =>
				Ref.get(clients).pipe(
					Effect.map((current) => Option.fromNullable(current.get(clientId))),
				),
			setAttachment: (clientId, ws, slug, detach) =>
				Ref.modify(clients, (current) => {
					const entry = current.get(clientId);
					if (entry?.ws !== ws) return [false, current] as const;
					const next = new Map(current);
					next.set(clientId, { ws, slug, detach });
					return [true, next] as const;
				}),
			remove: (clientId, ws) =>
				Ref.update(clients, (current) => {
					if (current.get(clientId)?.ws !== ws) return current;
					const next = new Map(current);
					next.delete(clientId);
					return next;
				}),
			broadcastUnattached: (message) =>
				Effect.gen(function* () {
					const data = JSON.stringify(message);
					for (const entry of (yield* Ref.get(clients)).values()) {
						if (entry.slug !== null || entry.ws.readyState !== WebSocket.OPEN) {
							continue;
						}
						yield* Effect.try(() => entry.ws.send(data)).pipe(
							Effect.catchAll(() => Effect.void),
						);
					}
				}),
		};

		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				for (const entry of (yield* Ref.get(clients)).values()) {
					entry.detach();
					entry.ws.close();
				}
				yield* Ref.set(clients, new Map());
				yield* Effect.sync(() => server.close()).pipe(
					Effect.catchAll(() => Effect.void),
				);
			}),
		);

		return registry;
	}),
);
