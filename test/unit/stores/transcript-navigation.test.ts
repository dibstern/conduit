// @vitest-environment jsdom
// Failure cases: partial index publication; crossed windows during a jump;
// stale navigation/session completions; failed replacement losing old content;
// historical context/cache pollution; index restart on every body jump.
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SessionDetailEnvelope,
	type SessionDetailWindow,
	type SessionPromptIndexEnvelope,
	type SessionPromptSummary,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import { makeWsRpcClientsLayer } from "../../../src/lib/frontend/transport/shared-client.js";
import type { HistoryMessage } from "../../../src/lib/frontend/types.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";
import { makeRpcStream, makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

const mocks = vi.hoisted(() => ({
	getRuntime: vi.fn(),
	runTransportEffect: vi.fn(),
	openSavedTranscript: vi.fn(() => Promise.resolve(undefined)),
	saveTranscript: vi.fn(() => Promise.resolve()),
	forgetTranscript: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => mocks);
vi.mock("../../../src/lib/frontend/stores/saved-transcripts.js", () => mocks);
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (text: string) => text,
}));

import {
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	createTranscriptView,
	primaryTranscript,
	type TranscriptView,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";

type DetailFeed = Effect.Success<
	ReturnType<typeof makeRpcStream<SessionDetailEnvelope, WsRpcError>>
>;
type IndexFeed = Effect.Success<
	ReturnType<typeof makeRpcStream<SessionPromptIndexEnvelope, WsRpcError>>
>;
let details: DetailFeed[];
let indexes: IndexFeed[];
let wire: ReturnType<typeof makeRpcWire>;
let runtime: ManagedRuntime.ManagedRuntime<
	import("../../../src/lib/frontend/transport/shared-client.js").WsRpcClients,
	never
>;
let view: TranscriptView;
const wait = async (predicate: () => boolean) =>
	vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000 });
const emit = async (feed: DetailFeed, ...values: SessionDetailEnvelope[]) =>
	Effect.runPromise(feed.emit(...values));
const indexEmit = async (
	feed: IndexFeed,
	...values: SessionPromptIndexEnvelope[]
) => Effect.runPromise(feed.emit(...values));
const prompt = (n: number): SessionPromptSummary => ({
	id: `u${n}`,
	createdAt: n,
	preview: `Prompt ${n}`,
	isInherited: false,
});
const row = (n: number): HistoryMessage => ({
	id: `u${n}`,
	role: "user",
	time: { created: n },
	parts: [{ id: `p${n}`, type: "text", text: `Prompt ${n}` }],
});
const snapshot = (
	numbers: number[],
	kind: SessionDetailWindow["kind"] = "latest",
	sequence = 1,
): SessionDetailEnvelope => ({
	_tag: "snapshot",
	sequence,
	hasMore: numbers[0] !== 1,
	rows: [
		...numbers.flatMap((n) => detailRowsOf(row(n))),
		{
			_tag: "window",
			window: {
				kind,
				firstMessageId: `u${numbers[0]}`,
				lastMessageId: `u${numbers.at(-1)}`,
				hasEarlier: numbers[0] !== 1,
				hasLater: kind === "historical",
			},
		},
	],
});
const requests = (tag: string) =>
	wire.requests.filter((request) => request.tag === tag);

beforeEach(() => {
	details = [];
	indexes = [];
	const table: StubTable = {
		SubscribeSessionDetail: () =>
			Stream.unwrap(
				makeRpcStream<SessionDetailEnvelope, WsRpcError>().pipe(
					Effect.map((feed) => {
						details.push(feed);
						return feed.stream;
					}),
				),
			),
		SubscribeSessionPromptIndex: () =>
			Stream.unwrap(
				makeRpcStream<SessionPromptIndexEnvelope, WsRpcError>().pipe(
					Effect.map((feed) => {
						indexes.push(feed);
						return feed.stream;
					}),
				),
			),
	};
	wire = makeRpcWire(table);
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	mocks.getRuntime.mockResolvedValue(runtime);
	mocks.runTransportEffect.mockImplementation((effect) =>
		runtime.runPromise(effect),
	);
	openSessionForSetup("A", "project");
	view = createTranscriptView();
});
afterEach(async () => {
	view.dispose();
	primaryTranscript.dispose();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await runtime.dispose();
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
	vi.clearAllMocks();
});

async function open() {
	view.view("project", "A");
	await wait(() => details.length === 1 && indexes.length === 1);
	const detail = details[0];
	const index = indexes[0];
	if (!detail || !index) throw new Error("missing initial feeds");
	await emit(detail, snapshot([118, 119, 120]), { _tag: "synchronized" });
	await indexEmit(
		index,
		{
			_tag: "snapshot",
			sequence: 1,
			rows: Array.from({ length: 120 }, (_, n) => prompt(n + 1)),
		},
		{ _tag: "synchronized" },
	);
	await wait(
		() =>
			view.prompts.length === 120 &&
			view.chat.transcript?.status._tag === "live",
	);
	return { detail, index };
}

describe("full-session transcript navigation owner", () => {
	it.each([
		"before",
		"after",
	] as const)("keeps the current window when the %s adjacent page is empty", async (direction) => {
		await open();
		view.navigate("u20");
		await wait(() => details.length === 2);
		const historical = details[1];
		if (!historical) throw new Error("missing historical feed");
		await emit(historical, snapshot([20, 21], "historical"), {
			_tag: "synchronized",
		});
		await wait(() => view.window.kind === "historical");
		const page = direction === "before" ? view.loadOlder() : view.loadNewer();
		await wait(() => details.length === 3);
		const empty = details[2];
		if (!empty) throw new Error("missing adjacent feed");
		await emit(
			empty,
			{
				_tag: "snapshot",
				sequence: 2,
				rows: [
					{
						_tag: "window",
						window: {
							kind: "historical",
							hasEarlier: direction !== "before",
							hasLater: direction !== "after",
						},
					},
				],
			},
			{ _tag: "synchronized" },
		);
		await page;
		expect(view.chat.transcript?.rows.map((row) => row.id)).toEqual([
			"u20",
			"u21",
		]);
		expect(
			direction === "before" ? view.window.hasEarlier : view.window.hasLater,
		).toBe(false);
		expect(view.navigation).toBeNull();
	});
	it("coalesces scrub moves arriving in separate browser tasks", async () => {
		await open();
		view.navigate("u10");
		await new Promise((resolve) => setTimeout(resolve, 0));
		view.navigate("u20");
		await new Promise((resolve) => setTimeout(resolve, 0));
		view.navigate("u30");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(requests("SubscribeSessionDetail")).toHaveLength(2);
		expect(requests("SubscribeSessionDetail")[1]?.payload).toMatchObject({
			window: { anchorMessageId: "u30", direction: "from" },
		});
	});
	it("publishes the complete prompt index atomically while bodies remain paginated", async () => {
		view.view("project", "A");
		await wait(() => details.length === 1 && indexes.length === 1);
		const detail = details[0];
		const index = indexes[0];
		if (!detail || !index) throw new Error("missing feeds");
		await emit(detail, snapshot([118, 119, 120]), { _tag: "synchronized" });
		await indexEmit(index, {
			_tag: "snapshot",
			sequence: 1,
			rows: Array.from({ length: 60 }, (_, n) => prompt(n + 1)),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(view.prompts).toEqual([]);
		await indexEmit(
			index,
			{
				_tag: "snapshotChunk",
				sequence: 1,
				rows: Array.from({ length: 60 }, (_, n) => prompt(n + 61)),
			},
			{ _tag: "synchronized" },
		);
		await wait(() => view.prompts.length === 120);
		expect(view.chat.transcript?.rows.map((row) => row.id)).toEqual([
			"u118",
			"u119",
			"u120",
		]);
		await indexEmit(
			index,
			{ _tag: "remove", id: "u4", sequence: 2 },
			{ _tag: "upsert", item: prompt(121), sequence: 3 },
		);
		await wait(() => view.prompts.at(-1)?.id === "u121");
		expect(view.prompts.some((item) => item.id === "u4")).toBe(false);
	});

	it("coalesces scrub targets and stages the requested window until synchronized", async () => {
		await open();
		view.navigate("u10");
		view.navigate("u20");
		await wait(() => details.length === 2);
		expect(requests("SubscribeSessionDetail")[1]?.payload).toMatchObject({
			window: { anchorMessageId: "u20", direction: "from" },
		});
		expect(view.navigation).toMatchObject({
			target: { messageId: "u20" },
			phase: "loading",
		});
		const replacement = details[1];
		if (!replacement) throw new Error("missing replacement");
		await emit(replacement, snapshot([20, 21, 22], "historical"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(view.chat.transcript?.rows[0]?.id).toBe("u118");
		await emit(replacement, { _tag: "synchronized" });
		await wait(() => view.navigation?.phase === "placing");
		expect(view.chat.transcript?.rows[0]?.id).toBe("u20");
		expect(view.window.kind).toBe("historical");
		expect(view.transition?.kind).toBe("replace");
		expect(requests("SubscribeSessionPromptIndex")).toHaveLength(1);
		const placed = view.navigation?.id;
		if (placed === undefined) throw new Error("missing placement id");
		view.acknowledgePlacement(placed - 1);
		expect(view.navigation).not.toBeNull();
		view.acknowledgePlacement(placed);
		expect(view.navigation).toBeNull();
		view.navigate("u21");
		expect(view.navigation).toMatchObject({
			target: { messageId: "u21" },
			phase: "placing",
		});
		expect(requests("SubscribeSessionDetail")).toHaveLength(2);
		const missing = view.navigation?.id;
		if (missing === undefined) throw new Error("missing loaded placement");
		view.acknowledgePlacement(missing, false);
		expect(view.navigation).toBeNull();
		expect(view.pageError).toBeInstanceOf(Error);
	});

	it("ignores a superseded jump and keeps the last committed window on failure", async () => {
		await open();
		view.navigate("u20");
		await wait(() => details.length === 2);
		view.navigate("u40");
		await wait(() => details.length === 3);
		const stale = details[1];
		const chosen = details[2];
		if (!stale || !chosen) throw new Error("missing jumps");
		await emit(stale, snapshot([20, 21], "historical"), {
			_tag: "synchronized",
		});
		await emit(chosen, snapshot([40, 41], "historical"), {
			_tag: "synchronized",
		});
		await wait(() => view.chat.transcript?.rows[0]?.id === "u40");
		view.navigate("u60");
		await wait(() => details.length === 4);
		const failed = details[3];
		if (!failed) throw new Error("missing failed jump");
		await Effect.runPromise(
			failed.fail(new WsRpcError({ message: "Unknown turn" })),
		);
		await wait(() => view.pageError !== null);
		expect(view.chat.transcript?.rows[0]?.id).toBe("u40");
		expect(view.navigation).toBeNull();
	});

	it("returns to latest and does not save or restore session context from an old window", async () => {
		view.dispose();
		view = primaryTranscript;
		await open();
		const main = sessionMessages.get("A");
		if (!main) throw new Error("missing primary slot");
		main.contextPercent = 77;
		const initialSaves = mocks.saveTranscript.mock.calls.length;
		view.navigate("u20");
		await wait(() => details.length === 2);
		const old = details[1];
		if (!old) throw new Error("missing old window");
		await emit(old, snapshot([20, 21], "historical"), { _tag: "synchronized" });
		await wait(() => view.window.kind === "historical");
		expect(main.contextPercent).toBe(77);
		expect(mocks.saveTranscript).toHaveBeenCalledTimes(initialSaves);
		view.latest();
		await wait(() => details.length === 3);
		expect(requests("SubscribeSessionDetail")[2]?.payload).not.toHaveProperty(
			"window",
		);
		const latest = details[2];
		if (!latest) throw new Error("missing latest window");
		await emit(latest, snapshot([119, 120, 121]), { _tag: "synchronized" });
		await wait(() => view.navigation?.phase === "placing");
		expect(view.navigation?.target).toBe("latest");
		expect(view.window.kind).toBe("latest");
		expect(view.prompts).toHaveLength(120);
	});

	it("rejects old session completion and preserves monotonic placement ids", async () => {
		await open();
		view.navigate("u20");
		const previousId = view.navigation?.id ?? -1;
		await wait(() => details.length === 2);
		const stale = details[1];
		if (!stale) throw new Error("missing stale request");
		view.view("project", "B");
		await wait(() => details.length === 3 && indexes.length === 2);
		const current = details[2];
		if (!current) throw new Error("missing new session");
		await emit(stale, snapshot([20], "historical"), { _tag: "synchronized" });
		await emit(current, snapshot([1]), { _tag: "synchronized" });
		await wait(() => view.chat.transcript?.rows[0]?.id === "u1");
		expect(view.prompts).toEqual([]);
		view.navigate("u1");
		expect(view.navigation?.id).toBeGreaterThan(previousId);
	});
});
