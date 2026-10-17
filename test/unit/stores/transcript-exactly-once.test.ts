// @vitest-environment jsdom
import { Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
	SessionDetailEnvelope,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	transcriptStatus,
	viewTranscript,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { makeWsRpcClientsLayer } from "../../../src/lib/frontend/transport/shared-client.js";
import type { HistoryMessage } from "../../../src/lib/frontend/types.js";
import { detailRowsOf, detailUpserts } from "../../helpers/detail-rows.js";
import { makeRpcStream, makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

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
			state: {
				status: "completed",
				input: { _tag: "whole", value: {} },
				output: { _tag: "whole", text: "ok" },
			},
		},
	],
});

function adapter() {
	const feed = Effect.runSync(
		makeRpcStream<SessionDetailEnvelope, WsRpcError>(),
	);
	const table: StubTable = { SubscribeSessionDetail: () => feed.stream };
	const wire = makeRpcWire(table);
	return {
		...wire,
		get ready() {
			return wire.requests.some(
				(request) => request.tag === "SubscribeSessionDetail",
			);
		},
		async emit(envelope: SessionDetailEnvelope) {
			await Effect.runPromise(feed.emit(envelope));
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
	openSessionForSetup("A", "project-a");
});
afterEach(async () => {
	viewTranscript("project", null);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await runtime.dispose();
	runtimeMock.getRuntime.mockReset();
	runtimeMock.runTransportEffect.mockReset();
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
});

it("applies each detail update once", async () => {
	viewTranscript("project", "A");
	await vi.waitFor(() => expect(wire.ready).toBe(true));
	await wire.emit({
		_tag: "snapshot",
		sequence: 4,
		rows: [user, assistant("hello")].flatMap(detailRowsOf),
	});
	await wire.emit({ _tag: "synchronized" });
	await vi.waitFor(() => expect(transcriptStatus("A")._tag).toBe("live"));
	for (const envelope of detailUpserts(assistant("hello world"), 5))
		await wire.emit(envelope);
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

it("keeps a part in its place when a live update changes it", async () => {
	const tool = (id: string, status: "running" | "completed") => ({
		_tag: "part" as const,
		messageId: "a1",
		sortOrder: id === "tool-a" ? 1 : 2,
		part: {
			id,
			type: "tool" as const,
			callID: id,
			tool: "Read",
			state: {
				status,
				input: { _tag: "whole" as const, value: {} },
				...(status === "completed"
					? { output: { _tag: "whole" as const, text: "ok" } }
					: {}),
			},
		},
	});
	viewTranscript("project", "A");
	await vi.waitFor(() => expect(wire.ready).toBe(true));
	await wire.emit({
		_tag: "snapshot",
		sequence: 4,
		rows: [
			{
				_tag: "message",
				message: { id: "a1", role: "assistant", time: { created: 2 } },
			},
			{
				_tag: "part",
				messageId: "a1",
				sortOrder: 0,
				part: { id: "think", type: "reasoning", text: "hmm" },
			},
			tool("tool-a", "running"),
			tool("tool-b", "running"),
		],
	});
	await wire.emit({ _tag: "synchronized" });
	await vi.waitFor(() => expect(transcriptStatus("A")._tag).toBe("live"));
	await wire.emit({
		_tag: "upsert",
		sequence: 5,
		item: tool("tool-a", "completed"),
	});
	const parts = () =>
		getOrCreateSessionSlot("A").messages.transcript?.rows[0]?.parts ?? [];
	await vi.waitFor(() =>
		expect(parts().find((part) => part.id === "tool-a")?.state?.status).toBe(
			"completed",
		),
	);
	expect(parts().map((part) => part.id)).toEqual(["think", "tool-a", "tool-b"]);
});

it("moves a held part when a reconcile changes its place", async () => {
	const text = (id: string, sortOrder: number) => ({
		_tag: "part" as const,
		messageId: "a1",
		sortOrder,
		part: { id, type: "text" as const, text: id },
	});
	viewTranscript("project", "A");
	await vi.waitFor(() => expect(wire.ready).toBe(true));
	await wire.emit({
		_tag: "snapshot",
		sequence: 4,
		rows: [
			text("a", 0),
			text("b", 1),
			text("c", 2),
			{
				_tag: "message",
				message: { id: "a1", role: "assistant", time: { created: 2 } },
			},
		],
	});
	await wire.emit({ _tag: "synchronized" });
	await vi.waitFor(() => expect(transcriptStatus("A")._tag).toBe("live"));
	// A message snapshot re-sends every part, with one new in the middle.
	for (const item of [text("a", 0), text("new", 1), text("b", 2), text("c", 3)])
		await wire.emit({ _tag: "upsert", sequence: 5, item });
	const parts = () =>
		getOrCreateSessionSlot("A").messages.transcript?.rows[0]?.parts ?? [];
	await vi.waitFor(() => expect(parts()).toHaveLength(4));
	expect(parts().map((part) => part.id)).toEqual(["a", "new", "b", "c"]);
});
