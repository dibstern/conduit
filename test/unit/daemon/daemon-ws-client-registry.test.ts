import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { WebSocket } from "ws";
import {
	DaemonWsClientRegistryLive,
	DaemonWsClientRegistryTag,
} from "../../../src/lib/domain/daemon/Services/daemon-ws-client-registry.js";

const makeSocket = () => {
	const socket = {
		readyState: WebSocket.OPEN,
		send: vi.fn(),
		close: vi.fn(),
	};
	return { socket, ws: socket as unknown as WebSocket };
};

describe("DaemonWsClientRegistry", () => {
	it.scoped(
		"replaces a reconnect without letting the old close remove the new socket",
		() =>
			Effect.gen(function* () {
				const registry = yield* DaemonWsClientRegistryTag;
				const first = makeSocket();
				const second = makeSocket();
				const detach = vi.fn();
				yield* registry.register("client", first.ws);
				yield* registry.setAttachment("client", first.ws, "a", detach);
				yield* registry.register("client", second.ws);
				yield* registry.remove("client", first.ws);
				expect(detach).toHaveBeenCalledTimes(1);
				expect(first.socket.close).toHaveBeenCalledTimes(1);
				yield* registry.broadcastUnattached({
					type: "project_list",
					projects: [],
				});
				expect(second.socket.send).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(DaemonWsClientRegistryLive)),
	);
	it.scoped("broadcasts daemon messages only to unattached sockets", () =>
		Effect.gen(function* () {
			const registry = yield* DaemonWsClientRegistryTag;
			const first = makeSocket();
			const second = makeSocket();
			yield* registry.register("first", first.ws);
			yield* registry.register("second", second.ws);
			yield* registry.setAttachment("second", second.ws, "project-a", () => {});

			yield* registry.broadcastUnattached({
				type: "project_list",
				projects: [],
			});

			expect(first.socket.send).toHaveBeenCalledTimes(1);
			expect(first.socket.send).toHaveBeenCalledWith(
				JSON.stringify({ type: "project_list", projects: [] }),
			);
			expect(second.socket.send).not.toHaveBeenCalled();
		}).pipe(Effect.provide(DaemonWsClientRegistryLive)),
	);
});
