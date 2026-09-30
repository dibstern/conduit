// @vitest-environment jsdom
import { RpcClient, type RpcMessage } from "@effect/rpc";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
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
const pageMock = vi.hoisted(() => ({ loadMoreHistoryRpc: vi.fn() }));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => runtimeMock);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => pageMock);
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (text: string) => text,
}));

import {
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	loadOlderTranscript,
	transcriptStatus,
	viewTranscript,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";

interface Request {
	id: string;
	tag: string;
	payload: unknown;
}

function adapter() {
	const requests: Request[] = [];
	const interrupted: string[] = [];
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
								if (frame._tag === "Request")
									requests.push({
										id: frame.id,
										tag: frame.tag,
										payload: frame.payload,
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
		async emit(request: Request, envelope: SessionDetailEnvelope) {
			if (!deliver) throw new Error("stream socket has not opened");
			await Effect.runPromise(
				deliver({
					_tag: "Chunk",
					requestId: request.id,
					values: [envelope],
				}),
			);
		},
		async fail(request: Request) {
			if (!deliver) throw new Error("stream socket has not opened");
			await Effect.runPromise(
				deliver({
					_tag: "Exit",
					requestId: request.id,
					exit: {
						_tag: "Failure",
						cause: {
							_tag: "Fail",
							error: { _tag: "WsRpcError", message: "closed" },
						},
					},
				}),
			);
		},
	};
}

const row = (id: string, text: string): HistoryMessage => ({
	id,
	role: "user",
	time: { created: Number(id.replace(/\D/g, "")) || 1 },
	parts: [{ id: `${id}-text`, type: "text", text }],
});
const snapshot = (
	rows: HistoryMessage[],
	sequence: number,
	hasMore = false,
): SessionDetailEnvelope => ({
	_tag: "snapshot",
	sequence,
	hasMore,
	rows: rows.map((message) => ({ _tag: "transcriptMessage", message })),
});
const requestFor = (
	requests: Request[],
	sessionId: string,
	index = 0,
): Request | undefined =>
	requests.filter(
		(request) =>
			request.tag === "SubscribeSessionDetail" &&
			typeof request.payload === "object" &&
			request.payload !== null &&
			"sessionId" in request.payload &&
			request.payload.sessionId === sessionId,
	)[index];
const settled = async (predicate: () => boolean) =>
	vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });

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
	pageMock.loadMoreHistoryRpc.mockReset();
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = null;
});

describe("transcript feed interface", () => {
	it("installs a cold snapshot and reaches live", async () => {
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const request = requestFor(wire.requests, "A");
		if (!request) throw new Error("missing request");
		expect(request.payload).not.toHaveProperty("resumeFromSequence");
		await wire.emit(request, snapshot([row("u1", "hello")], 7));
		await wire.emit(request, { _tag: "synchronized" });
		await settled(() => transcriptStatus("A")._tag === "live");
		expect(getOrCreateSessionSlot("A").messages.messages).toMatchObject([
			{ type: "user", text: "hello", uuid: "u1/user" },
		]);
	});

	it("restores the context bar from a projected completed result", async () => {
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const request = requestFor(wire.requests, "A");
		if (!request) throw new Error("missing request");
		await wire.emit(
			request,
			snapshot(
				[
					{
						id: "assistant-1",
						role: "assistant",
						time: { created: 1, completed: 2 },
						parts: [{ id: "text-1", type: "text", text: "done" }],
						tokens: { input: 100, output: 50, context_window: 1000 },
					},
				],
				1,
			),
		);
		await settled(
			() => getOrCreateSessionSlot("A").messages.contextPercent === 15,
		);
	});

	it("shows cached rows immediately and resumes from the held HWM", async () => {
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const first = requestFor(wire.requests, "A");
		if (!first) throw new Error("missing request");
		await wire.emit(first, snapshot([row("u1", "cached")], 9));
		await wire.emit(first, { _tag: "synchronized" });
		await settled(() => transcriptStatus("A")._tag === "live");
		viewTranscript("project", "B");
		await settled(() => requestFor(wire.requests, "B") !== undefined);
		viewTranscript("project", "A");
		expect(getOrCreateSessionSlot("A").messages.messages[0]).toMatchObject({
			text: "cached",
		});
		// Cached rows are not live until the resumed feed synchronizes.
		expect(transcriptStatus("A")._tag).toBe("cold");
		await settled(() => requestFor(wire.requests, "A", 1) !== undefined);
		const resumed = requestFor(wire.requests, "A", 1);
		expect(resumed?.payload).toHaveProperty("resumeFromSequence", 9);
		if (!resumed) throw new Error("missing resumed request");
		await wire.emit(resumed, { _tag: "synchronized" });
		await settled(() => transcriptStatus("A")._tag === "live");
	});

	it("interrupts outgoing A and B feeds during A→B→A", async () => {
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const first = requestFor(wire.requests, "A");
		viewTranscript("project", "B");
		await settled(() => requestFor(wire.requests, "B") !== undefined);
		const second = requestFor(wire.requests, "B");
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A", 1) !== undefined);
		await settled(
			() =>
				first !== undefined &&
				second !== undefined &&
				wire.interrupted.includes(first.id) &&
				wire.interrupted.includes(second.id),
		);
		expect(wire.requests.length - wire.interrupted.length).toBe(1);
	});

	it("resyncs from a fresh snapshot after a suffix length mismatch", async () => {
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const first = requestFor(wire.requests, "A");
		if (!first) throw new Error("missing request");
		await wire.emit(first, snapshot([row("u1", "hello")], 4));
		await wire.emit(first, { _tag: "synchronized" });
		await settled(() => transcriptStatus("A")._tag === "live");
		await wire.emit(first, {
			_tag: "upsert",
			sequence: 5,
			item: { _tag: "transcriptMessage", message: row("u1", "!") },
			textSuffixes: [{ partId: "u1-text", from: 999, total: 1000 }],
		});
		// The decoder's sent prefix is untrustworthy, so the transport re-asks
		// for whole rows instead of resuming; the feed never reports failing.
		await settled(() => requestFor(wire.requests, "A", 1) !== undefined);
		const second = requestFor(wire.requests, "A", 1);
		if (!second) throw new Error("missing resync request");
		expect(second.payload).not.toHaveProperty("resumeFromSequence");
		expect(transcriptStatus("A")._tag).toBe("live");
		await wire.emit(second, snapshot([row("u1", "hello!")], 5));
		await wire.emit(second, { _tag: "synchronized" });
		await settled(
			() => getOrCreateSessionSlot("A").messages.transcript?.hwm === 5,
		);
		expect(
			getOrCreateSessionSlot("A").messages.messages.map((message) =>
				message.type === "user" ? message.text : message.uuid,
			),
		).toEqual(["hello!"]);
	});

	it("pages below the floor, updates hasMore, and coalesces concurrent loads", async () => {
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const first = requestFor(wire.requests, "A");
		if (!first) throw new Error("missing request");
		await wire.emit(first, snapshot([row("u2", "new")], 2, true));
		await wire.emit(first, { _tag: "synchronized" });
		await settled(
			() => getOrCreateSessionSlot("A").messages.transcript?.hwm === 2,
		);
		let finish:
			| ((value: { messages: HistoryMessage[]; hasMore: boolean }) => void)
			| undefined;
		pageMock.loadMoreHistoryRpc.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const one = loadOlderTranscript("A");
		const two = loadOlderTranscript("A");
		expect(two).toBe(one);
		expect(pageMock.loadMoreHistoryRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "project",
			sessionId: "A",
			before: "u2",
		});
		finish?.({ messages: [row("u1", "old")], hasMore: false });
		await one;
		expect(
			getOrCreateSessionSlot("A").messages.messages.map(
				(message) => message.uuid,
			),
		).toEqual(["u1/user", "u2/user"]);
		expect(getOrCreateSessionSlot("A").messages.historyHasMore).toBe(false);
	});
});
