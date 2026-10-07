// @vitest-environment jsdom
import { RpcClient, type RpcMessage } from "@effect/rpc";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	transcriptStatus,
	viewTranscript,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcConnect,
} from "../../../src/lib/frontend/transport/shared-client.js";
import { WsRpcGroup } from "../../../src/lib/frontend/transport/ws-rpc.js";
import type { HistoryMessage } from "../../../src/lib/frontend/types.js";

const runtimeMock = vi.hoisted(() => ({
	getRuntime: vi.fn(),
	runTransportEffect: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => runtimeMock);
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (text: string) => text,
}));

const user: HistoryMessage = {
	id: "u1",
	role: "user",
	time: { created: 1 },
	parts: [{ id: "u-text", type: "text", text: "hello" }],
};
const assistant = (text: string): HistoryMessage => ({
	id: "a1",
	role: "assistant",
	time: { created: 2 },
	parts: [
		{ id: "a-text", type: "text", text },
		{
			id: "tool-1",
			type: "tool",
			callID: "tool-1",
			tool: "Read",
			state: { status: "completed", input: {}, output: "ok" },
		},
	],
});

function adapter() {
	let requestId: string | undefined;
	let deliver:
		| ((frame: RpcMessage.FromServerEncoded) => Effect.Effect<void>)
		| undefined;
	const connect: WsRpcConnect = ({ trafficClass }) =>
		Effect.gen(function* () {
			const protocol = RpcClient.Protocol.make((write) =>
				Effect.sync(() => {
					if (trafficClass === "stream") deliver = write;
					return {
						send: (frame: RpcMessage.FromClientEncoded) =>
							Effect.sync(() => {
								if (
									frame._tag === "Request" &&
									frame.tag === "SubscribeSessionDetail"
								)
									requestId = frame.id;
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
		connect,
		get ready() {
			return requestId !== undefined && deliver !== undefined;
		},
		async emit(envelope: SessionDetailEnvelope) {
			if (!requestId || !deliver) throw new Error("subscription not ready");
			await Effect.runPromise(
				deliver({ _tag: "Chunk", requestId, values: [envelope] }),
			);
		},
	};
}

let wire: ReturnType<typeof adapter>;
let runtime: ManagedRuntime.ManagedRuntime<
	import("../../../src/lib/frontend/transport/shared-client.js").WsRpcClients,
	never
>;
beforeEach(() => {
	wire = adapter();
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	runtimeMock.getRuntime.mockResolvedValue(runtime);
	runtimeMock.runTransportEffect.mockImplementation((effect) =>
		runtime.runPromise(effect),
	);
	sessionState.currentId = "A";
});
afterEach(async () => {
	viewTranscript("project", null);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await runtime.dispose();
	runtimeMock.getRuntime.mockReset();
	runtimeMock.runTransportEffect.mockReset();
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = null;
});

it("applies each detail update once", async () => {
	viewTranscript("project", "A");
	await vi.waitFor(() => expect(wire.ready).toBe(true));
	await wire.emit({
		_tag: "snapshot",
		sequence: 4,
		rows: [user, assistant("hello")].map((message) => ({
			_tag: "transcriptMessage",
			message,
		})),
	});
	await wire.emit({ _tag: "synchronized" });
	await vi.waitFor(() => expect(transcriptStatus("A")._tag).toBe("live"));
	await wire.emit({
		_tag: "upsert",
		sequence: 5,
		item: { _tag: "transcriptMessage", message: assistant("hello world") },
	});
	await vi.waitFor(() =>
		expect(
			getOrCreateSessionSlot("A").messages.messages.some(
				(message) =>
					message.type === "assistant" && message.rawText === "hello world",
			),
		).toBe(true),
	);
	expect(
		getOrCreateSessionSlot("A").messages.messages.filter(
			(message) =>
				message.type === "assistant" && message.rawText.includes("world"),
		),
	).toHaveLength(1);
});
