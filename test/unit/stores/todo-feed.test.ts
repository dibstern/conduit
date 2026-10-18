// @vitest-environment jsdom
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SessionTodosEnvelope,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcClients,
} from "../../../src/lib/frontend/transport/shared-client.js";
import { makeRpcStream, makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

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

function adapter() {
	const feeds = new Map<
		string,
		Effect.Success<
			ReturnType<typeof makeRpcStream<SessionTodosEnvelope, WsRpcError>>
		>
	>();
	const table: StubTable = {
		SubscribeSessionTodos: ({ sessionId }) =>
			Stream.unwrap(
				makeRpcStream<SessionTodosEnvelope, WsRpcError>().pipe(
					Effect.map((feed) => {
						feeds.set(sessionId, feed);
						return feed.stream;
					}),
				),
			),
	};
	const wire = makeRpcWire(table);
	return {
		...wire,
		async emit(request: Request, envelope: SessionTodosEnvelope) {
			const payload = request.payload;
			if (
				typeof payload !== "object" ||
				payload === null ||
				!("sessionId" in payload)
			)
				throw new Error("missing session payload");
			const feed = await vi.waitFor(() => {
				const feed = feeds.get(String(payload.sessionId));
				if (!feed) throw new Error("subscription not ready");
				return feed;
			});
			await Effect.runPromise(feed.emit(envelope));
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
		expect(request.payload).toEqual({ sessionId: "A" });

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
