// @vitest-environment jsdom
import { RpcClient, type RpcMessage } from "@effect/rpc";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTodosEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcClients,
	type WsRpcConnect,
} from "../../../src/lib/frontend/transport/shared-client.js";
import { WsRpcGroup } from "../../../src/lib/frontend/transport/ws-rpc.js";

const runtimeMock = vi.hoisted(() => ({
	getRuntime: vi.fn(),
	runTransportEffect: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => runtimeMock);

import {
	todoState,
	viewTodos,
} from "../../../src/lib/frontend/stores/todo.svelte.js";

interface Request {
	id: string;
	tag: string;
	payload: unknown;
	trafficClass: string;
}

// The real client over a fake wire: requests are captured per socket, and the
// test plays the server by writing frames back on the socket a request used.
function adapter() {
	const requests: Request[] = [];
	const interrupted: string[] = [];
	const deliver = new Map<
		string,
		(frame: RpcMessage.FromServerEncoded) => Effect.Effect<void>
	>();
	const connect: WsRpcConnect = ({ trafficClass }) =>
		Effect.gen(function* () {
			const protocol = RpcClient.Protocol.make((write) =>
				Effect.sync(() => {
					deliver.set(trafficClass, write);
					return {
						send: (frame: RpcMessage.FromClientEncoded) =>
							Effect.sync(() => {
								if (frame._tag === "Request")
									requests.push({
										id: frame.id,
										tag: frame.tag,
										payload: frame.payload,
										trafficClass,
									});
								if (frame._tag === "Interrupt")
									interrupted.push(frame.requestId);
							}),
						supportsAck: false,
						supportsTransferables: false,
					};
				}),
			);
			return yield* Layer.build(
				Layer.effect(RpcClient.Protocol, protocol),
			).pipe(
				Effect.flatMap((context) =>
					Effect.provide(RpcClient.make(WsRpcGroup), context),
				),
			);
		});
	return {
		requests,
		interrupted,
		connect,
		async emit(request: Request, envelope: SessionTodosEnvelope) {
			const write = deliver.get(request.trafficClass);
			if (!write) throw new Error(`${request.trafficClass} has not opened`);
			await Effect.runPromise(
				write({ _tag: "Chunk", requestId: request.id, values: [envelope] }),
			);
		},
	};
}

const todosRequest = (requests: Request[], sessionId: string) =>
	requests.find(
		(request) =>
			request.tag === "SubscribeSessionTodos" &&
			typeof request.payload === "object" &&
			request.payload !== null &&
			"sessionId" in request.payload &&
			request.payload.sessionId === sessionId,
	);
const settled = async (predicate: () => boolean) =>
	vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });

let wire: ReturnType<typeof adapter>;
let runtime: ManagedRuntime.ManagedRuntime<WsRpcClients, never>;
beforeEach(() => {
	wire = adapter();
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	runtimeMock.getRuntime.mockResolvedValue(runtime);
	runtimeMock.runTransportEffect.mockImplementation((effect) =>
		runtime.runPromise(effect),
	);
});
afterEach(async () => {
	viewTodos("project", null);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await runtime.dispose();
	runtimeMock.getRuntime.mockReset();
	runtimeMock.runTransportEffect.mockReset();
});

describe("todo feed", () => {
	it("subscribes for the viewed session on the control socket and follows its upserts", async () => {
		viewTodos("project", "A");
		await settled(() => todosRequest(wire.requests, "A") !== undefined);
		const request = todosRequest(wire.requests, "A");
		if (!request) throw new Error("missing request");
		expect(request.trafficClass).toBe("control");
		expect(request.payload).toEqual({ projectSlug: "project", sessionId: "A" });

		await wire.emit(request, {
			_tag: "snapshot",
			rows: [
				{
					sessionId: "A",
					items: [{ id: "t1", subject: "Plan", status: "in_progress" }],
				},
			],
			sequence: 4,
		});
		await wire.emit(request, { _tag: "synchronized" });
		await settled(() => todoState.items.length === 1);
		expect(todoState.items[0]).toMatchObject({ subject: "Plan" });

		await wire.emit(request, {
			_tag: "upsert",
			item: {
				sessionId: "A",
				items: [
					{ id: "t1", subject: "Plan", status: "completed" },
					{ id: "t2", subject: "Build", status: "in_progress" },
				],
			},
			sequence: 5,
		});
		await settled(() => todoState.items.length === 2);
		expect(todoState.items.map((item) => item.status)).toEqual([
			"completed",
			"in_progress",
		]);
	});

	it("switching sessions clears the list and moves the subscription", async () => {
		viewTodos("project", "A");
		await settled(() => todosRequest(wire.requests, "A") !== undefined);
		const a = todosRequest(wire.requests, "A");
		if (!a) throw new Error("missing request");
		await wire.emit(a, {
			_tag: "snapshot",
			rows: [
				{
					sessionId: "A",
					items: [{ id: "t1", subject: "A", status: "pending" }],
				},
			],
			sequence: 4,
		});
		await settled(() => todoState.items.length === 1);

		viewTodos("project", "B");
		expect(todoState.items).toEqual([]);
		await settled(() => todosRequest(wire.requests, "B") !== undefined);
		await settled(() => wire.interrupted.includes(a.id));
	});
});
