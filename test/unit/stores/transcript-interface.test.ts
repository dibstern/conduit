// @vitest-environment jsdom
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ResumePoint,
	type SessionDetailEnvelope,
	type WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { SavedTranscript } from "../../../src/lib/frontend/stores/saved-transcripts.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { makeWsRpcClientsLayer } from "../../../src/lib/frontend/transport/shared-client.js";
import type { HistoryMessage } from "../../../src/lib/frontend/types.js";

const runtimeMock = vi.hoisted(() => ({
	getRuntime: vi.fn(),
	runTransportEffect: vi.fn(),
}));
const pageMock = vi.hoisted(() => ({ rpc: vi.fn() }));
const savedMock = vi.hoisted(() => ({
	openSavedTranscript: vi.fn<() => Promise<SavedTranscript | undefined>>(),
	saveTranscript: vi.fn(() => Promise.resolve()),
	forgetTranscript: vi.fn(() => Promise.resolve()),
}));
vi.mock(
	"../../../src/lib/frontend/stores/saved-transcripts.js",
	() => savedMock,
);
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
import {
	loadOlderTranscript,
	transcriptStatus,
	viewTranscript,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";
import { makeRpcStream, makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

interface Request {
	id: string;
	tag: string;
	payload: unknown;
}

function adapter() {
	const feeds = new Map<
		string,
		Effect.Success<
			ReturnType<typeof makeRpcStream<SessionDetailEnvelope, WsRpcError>>
		>[]
	>();
	const table: StubTable = {
		SubscribeSessionDetail: ({ sessionId }) =>
			Stream.unwrap(
				makeRpcStream<SessionDetailEnvelope, WsRpcError>().pipe(
					Effect.map((feed) => {
						const subscriptions = feeds.get(sessionId) ?? [];
						subscriptions.push(feed);
						feeds.set(sessionId, subscriptions);
						return feed.stream;
					}),
				),
			),
	};
	const wire = makeRpcWire(table);
	const feedFor = (request: Request) =>
		vi.waitFor(() => {
			const payload = request.payload;
			if (
				typeof payload !== "object" ||
				payload === null ||
				!("sessionId" in payload)
			)
				throw new Error("missing session payload");
			const index = wire.requests
				.filter((candidate) => {
					const other = candidate.payload;
					return (
						candidate.tag === "SubscribeSessionDetail" &&
						typeof other === "object" &&
						other !== null &&
						"sessionId" in other &&
						other.sessionId === payload.sessionId
					);
				})
				.findIndex((candidate) => candidate.id === request.id);
			const feed = feeds.get(String(payload.sessionId))?.[index];
			if (!feed) throw new Error("subscription not ready");
			return feed;
		});
	return {
		...wire,
		async emit(request: Request, envelope: SessionDetailEnvelope) {
			await Effect.runPromise((await feedFor(request)).emit(envelope));
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
): Extract<SessionDetailEnvelope, { _tag: "snapshot" }> => ({
	_tag: "snapshot",
	sequence,
	hasMore,
	rows: rows.flatMap(detailRowsOf),
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
	savedMock.openSavedTranscript.mockResolvedValue(undefined);
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
	pageMock.rpc.mockReset();
	savedMock.openSavedTranscript.mockReset();
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
});

describe("transcript feed interface", () => {
	it("starts the feed while storage is pending and rejects a late saved draw", async () => {
		let finish: ((record: SavedTranscript) => void) | undefined;
		savedMock.openSavedTranscript.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		const request = requestFor(wire.requests, "A");
		if (!request) throw new Error("missing request");
		await wire.emit(request, snapshot([row("u1", "newer live page")], 10));
		await wire.emit(request, { _tag: "synchronized" });
		await settled(() => transcriptStatus("A")._tag === "live");
		finish?.({
			schema: 1,
			sessionId: "A",
			project: "project",
			buildId: "test",
			protocolVersion: 1,
			openedAt: 1,
			snapshot: {
				...snapshot([row("u1", "old saved page")], 1),
				resumePoint: ResumePoint.make("saved"),
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getOrCreateSessionSlot("A").messages.messages).toMatchObject([
			{ type: "user", text: "newer live page" },
		]);
		expect(requestFor(wire.requests, "A", 1)).toBeUndefined();
	});

	it("resumes from a saved page that is ready when the subscription starts", async () => {
		savedMock.openSavedTranscript.mockResolvedValue({
			schema: 1,
			sessionId: "A",
			project: "project",
			buildId: "test",
			protocolVersion: 1,
			openedAt: 1,
			snapshot: {
				...snapshot([row("u1", "saved page")], 7),
				resumePoint: ResumePoint.make("saved"),
			},
		});
		viewTranscript("project", "A");
		await settled(() => requestFor(wire.requests, "A") !== undefined);
		expect(requestFor(wire.requests, "A")?.payload).toMatchObject({
			resumeFromSequence: 7,
			resumePoint: "saved",
		});
		expect(getOrCreateSessionSlot("A").messages.messages).toMatchObject([
			{ type: "user", text: "saved page" },
		]);
	});
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

	it("shows cached rows immediately and resumes from the held HWM on reconnect", async () => {
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
		// It resumes from the newest sequence delivered, not a replay of it:
		// the server re-sends what the checksum does not cover, like a pending
		// rewind point, on every resume (conduit-test-k7pp).
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
			item: {
				_tag: "part",
				messageId: "u1",
				sortOrder: 0,
				part: { id: "u1-text", type: "text", text: "!" },
			},
			textSuffix: { from: 999, total: 1000 },
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
		pageMock.rpc.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const one = loadOlderTranscript("A");
		const two = loadOlderTranscript("A");
		expect(two).toBe(one);
		expect(pageMock.rpc).toHaveBeenCalledExactlyOnceWith("LoadMoreHistory", {
			sessionId: "A",
			before: "u2",
		});
		finish?.({
			messages: [row("u1", "old"), row("u1", "duplicate"), row("u2", "new")],
			hasMore: false,
		});
		await one;
		expect(
			getOrCreateSessionSlot("A").messages.messages.map(
				(message) => message.uuid,
			),
		).toEqual(["u1/user", "u2/user"]);
		expect(getOrCreateSessionSlot("A").messages.historyHasMore).toBe(false);
	});
});
