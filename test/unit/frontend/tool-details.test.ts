// The browser's tool-detail module (conduit-test-y7eo.10): one owner for
// loading and keeping full tool details in memory. The harness spec
// (harness-tool-previews) proves the request counts through a real browser;
// this covers the rules that are impractical to reach there.
//
// Ways it could fail, written before the code:
//  1. A settled tool loaded once is requested again on the next ask.
//  2. A running tool's detail is kept and served as final once it settles,
//     including when the browser already shows the tool as completed (it
//     does for some running tools), so only the server's word may count.
//  3. An ask for a settled tool joins a request sent while it was running, so
//     it gets, and keeps, the pre-settle detail.
//  4. Two asks for the same tool at once send two requests.
//  5. Asks in the same tick for one session go as several requests, or asks
//     for two sessions share one (forks repeat call ids in another session).
//  6. A fork's tool is served from the other session's entry.
//  7. A failed or timed-out request is kept, or stays in flight, so a retry
//     never asks again; a tool missing from the reply never settles.
//  8. The cache grows past about 50 MB, evicts the most recently used, does
//     not count a hit as use, or empties itself for one oversized detail.
//  9. Prefetch: more than one in flight; it asks for running, uncut, cached or
//     in-flight tools; it goes past about 5 MB per session view, or the budget
//     never resets for a new view; a failure surfaces; a wanted set that
//     arrives during a prefetch is lost.
// 10. An expand after a prefetch asks again.
// Review fixes, written before the change:
// 11. An entry is weighed by the asker's preview, not by what came back: a
//     tool asked for while its preview said running, or with no preview at
//     all, is kept at a few bytes however large its detail, so the cache
//     runs far past 50 MB; uncut input fields are never counted.
// 12. A settled detail that arrives after the asker gave up (the 10 s
//     timeout) is thrown away, so the retry downloads it again.
// 13. (ToolFullDetail) Switching from a parent to its fork, where the same
//     call id has the same status, keeps showing the parent's detail; the
//     load asks under whichever session is current when it runs, not the
//     one the tool was shown in.
// Prefetch after 2 s on a turn activity block (conduit-test-y7eo.11), written
// before the change:
// 14. A prefetch starts before the session's initial load completes, or a
//     set wanted during the load is dropped once the load completes.
// 15. A view left before its load completes still prefetches, or holds up
//     prefetch for the next view for good.
// 16. The budget follows the session, not the view: leaving a session and
//     coming back (A to B to A, nothing wanted in B) keeps what A spent.
// 17. A session that is not open is prefetched.
// 18. Prefetch asks for a tool whose only cut is one no card shows (a written
//     file's content), spending budget on a load no expand would make.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PartVersion,
	ToolCallId,
	type ToolDetail,
	Utf8Bytes,
} from "../../../src/lib/contracts/tool-wire.js";
import {
	makeToolDetails,
	type SessionRef,
} from "../../../src/lib/frontend/stores/tool-details.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";

const MB = 1_000_000;
const session: SessionRef = { projectSlug: "p", sessionId: "s1" };
const fork: SessionRef = { projectSlug: "p", sessionId: "s2" };

/** A view of each session whose first load has completed. */
const views = new Map(
	[session, fork].map((ref) => [ref, Promise.resolve(true)]),
);
const opened = (ref: SessionRef) => views.get(ref);

/** A view of `session` that has not loaded yet, settled on demand. */
const loading = () => {
	let settle: (loaded: boolean) => void = () => {};
	const view = new Promise<boolean>((resolve) => {
		settle = resolve;
	});
	return { view, settle };
};

const tool = (
	id: string,
	status: ToolMessage["status"] = "completed",
	resultBytes = 10_000,
): ToolMessage => ({
	type: "tool",
	uuid: id,
	id,
	name: "Bash",
	status,
	preview: { resultBytes: Utf8Bytes.make(resultBytes) },
});

const detail = (
	id: string,
	text = `full ${id}`,
	settled = true,
): ToolDetail => ({
	toolId: ToolCallId.make(id),
	version: PartVersion.make(1),
	settled,
	output: { _tag: "whole", text },
});

/** A server that answers each request on demand, recording what was asked. */
const server = () => {
	const requests: { session: SessionRef; ids: readonly string[] }[] = [];
	const pending: {
		resolve: (tools: readonly ToolDetail[]) => void;
		reject: (error: Error) => void;
		ids: readonly string[];
	}[] = [];
	const fetch = vi.fn(
		(ref: SessionRef, ids: readonly ToolCallId[]) =>
			new Promise<readonly ToolDetail[]>((resolve, reject) => {
				requests.push({ session: ref, ids });
				pending.push({ resolve, reject, ids });
			}),
	);
	return {
		fetch,
		requests,
		/** Answer the oldest open request with each asked tool's detail. */
		answer: async (text?: (id: string) => string, settled = true) => {
			const next = pending.shift();
			next?.resolve(next.ids.map((id) => detail(id, text?.(id), settled)));
			await vi.advanceTimersByTimeAsync(0);
		},
		fail: async () => {
			pending.shift()?.reject(new Error("connection lost"));
			await vi.advanceTimersByTimeAsync(0);
		},
	};
};

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("expand", () => {
	it("keeps a settled tool's detail: the second ask makes no request", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const first = details.get(session, tool("a"));
		await tick();
		await s.answer();
		expect(await first).toEqual(detail("a"));
		expect(await details.get(session, tool("a", "error"))).toEqual(detail("a"));
		expect(s.requests).toHaveLength(1);
	});

	it("never keeps a running tool's detail, and asks again once it settles", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		// The browser already says completed; the server says still running.
		for (const status of ["running", "completed"] as const) {
			const early = details.get(session, tool("a", status));
			await tick();
			await s.answer(() => "partial", false);
			expect((await early)?.output?.text).toBe("partial");
		}
		const settled = details.get(session, tool("a"));
		await tick();
		await s.answer(() => "final");
		expect((await settled)?.output?.text).toBe("final");
		expect((await details.get(session, tool("a")))?.output?.text).toBe("final");
		expect(s.requests).toHaveLength(3);
	});

	it("does not join a request sent while the tool was running", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const running = details.get(session, tool("a", "running"));
		await tick();
		const settled = details.get(session, tool("a"));
		await tick();
		expect(s.requests).toHaveLength(2);
		await s.answer(() => "partial", false);
		await s.answer(() => "final");
		expect((await running)?.output?.text).toBe("partial");
		expect((await settled)?.output?.text).toBe("final");
		expect((await details.get(session, tool("a")))?.output?.text).toBe("final");
		expect(s.requests).toHaveLength(2);
	});

	it("makes one request for two asks of the same tool at once", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const both = Promise.all([
			details.get(session, tool("a")),
			details.get(session, tool("a")),
		]);
		await tick();
		// Still in flight: a third ask joins it too.
		const third = details.get(session, tool("a"));
		await tick();
		await s.answer();
		expect(await both).toEqual([detail("a"), detail("a")]);
		expect(await third).toEqual(detail("a"));
		expect(s.requests).toEqual([{ session, ids: ["a"] }]);
	});

	it("batches asks close together, one request per session", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const asks = [
			details.get(session, tool("a")),
			details.get(session, tool("b")),
			details.get(fork, tool("a")),
		];
		await tick();
		expect(s.requests).toEqual([
			{ session, ids: ["a", "b"] },
			{ session: fork, ids: ["a"] },
		]);
		await s.answer();
		await s.answer((id) => `fork ${id}`);
		expect((await Promise.all(asks)).map((d) => d?.output?.text)).toEqual([
			"full a",
			"full b",
			"fork a",
		]);
		expect((await details.get(fork, tool("a")))?.output?.text).toBe("fork a");
		expect((await details.get(session, tool("a")))?.output?.text).toBe(
			"full a",
		);
		expect(s.requests).toHaveLength(2);
	});

	it("keeps nothing from a failed request, so a retry asks again", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const failed = details.get(session, tool("a")).catch((e: unknown) => e);
		await tick();
		await s.fail();
		expect(await failed).toEqual(new Error("connection lost"));
		const retry = details.get(session, tool("a"));
		await tick();
		await s.answer();
		expect(await retry).toEqual(detail("a"));
		expect(s.requests).toHaveLength(2);
	});

	it("gives up on a request that never answers, so a retry asks again", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const stuck = details.get(session, tool("a"));
		const outcome = stuck.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await outcome).toBeInstanceOf(Error);
		const retry = details.get(session, tool("a"));
		await tick();
		expect(s.requests).toHaveLength(2);
		await s.answer();
		await s.answer();
		expect(await retry).toEqual(detail("a"));
	});

	it("answers undefined for a tool the server does not know", async () => {
		const details = makeToolDetails(async () => [], opened);
		const ask = details.get(session, tool("gone"));
		await tick();
		expect(await ask).toBeUndefined();
	});
});

describe("memory", () => {
	const big = (size: number) => () => "x".repeat(size);

	it("weighs what came back, staying within about 50 MB, least recently used out first", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const { preview: _cut, ...uncut } = tool("a", "running");
		// Each asker's preview says a few KB, or nothing; each reply is 20 MB.
		const load = async (ask: ToolMessage) => {
			const loading = details.get(session, ask);
			await tick();
			await s.answer(big(20 * MB));
			return loading;
		};
		await load(uncut);
		await load(tool("b"));
		// Using "a" makes "b" the least recently used.
		await details.get(session, tool("a"));
		expect(s.requests).toHaveLength(2);
		await load(tool("c"));
		await details.get(session, tool("a"));
		await details.get(session, tool("c"));
		expect(s.requests).toHaveLength(3);
		const b = details.get(session, tool("b"));
		await tick();
		expect(s.requests).toHaveLength(4);
		await s.answer();
		await b;
	});

	it("does not empty itself for a detail bigger than the whole cache", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const small = details.get(session, tool("a"));
		await tick();
		await s.answer();
		await small;
		const huge = details.get(session, tool("huge"));
		await tick();
		await s.answer(big(60 * MB));
		await huge;
		await details.get(session, tool("a"));
		expect(s.requests).toHaveLength(2);
		const again = details.get(session, tool("huge"));
		await tick();
		expect(s.requests).toHaveLength(3);
		await s.answer();
		await again;
	});

	it("keeps a finished detail that arrives after its asker gave up", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const late = details.get(session, tool("a")).catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await late).toBeInstanceOf(Error);
		await s.answer();
		expect(await details.get(session, tool("a"))).toEqual(detail("a"));
		expect(s.requests).toHaveLength(1);
	});
});

describe("wanted soon", () => {
	it("prefetches cut, settled tools in one request, and an expand then asks nothing", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const { preview: _cut, ...uncut } = tool("whole");
		details.wantSoon(session, [
			tool("a"),
			tool("b"),
			tool("live", "running"),
			tool("pending", "pending"),
			uncut,
		]);
		await tick();
		expect(s.requests).toEqual([{ session, ids: ["a", "b"] }]);
		await s.answer();
		expect(await details.get(session, tool("b"))).toEqual(detail("b"));
		expect(s.requests).toHaveLength(1);
	});

	it("skips tools already kept or on their way", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const kept = details.get(session, tool("kept"));
		const coming = details.get(session, tool("coming"));
		await tick();
		await s.answer();
		await Promise.all([kept, coming]);
		const flying = details.get(session, tool("flying"));
		await tick();
		details.wantSoon(session, [tool("kept"), tool("flying"), tool("new")]);
		await tick();
		expect(s.requests.at(-1)).toEqual({ session, ids: ["new"] });
		await s.answer();
		await s.answer();
		await flying;
	});

	it("keeps one prefetch in flight, then runs the newest wanted set", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		details.wantSoon(session, [tool("a")]);
		await tick();
		details.wantSoon(session, [tool("b")]);
		details.wantSoon(session, [tool("c")]);
		await tick();
		expect(s.requests).toHaveLength(1);
		await s.answer();
		await tick();
		expect(s.requests.map(({ ids }) => ids)).toEqual([["a"], ["c"]]);
		await s.answer();
	});

	// Vitest fails the run on an unhandled rejection, so a surfaced failure shows.
	it("is silent on failure and does not retry", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		details.wantSoon(session, [tool("a")]);
		await tick();
		await s.fail();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.requests).toHaveLength(1);
	});

	it("stops after about 5 MB per session view, and a new view starts afresh", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		details.wantSoon(session, [
			tool("a", "completed", 3 * MB),
			tool("too-big", "completed", 3 * MB),
			tool("fits", "completed", 1.5 * MB),
		]);
		await tick();
		expect(s.requests.at(-1)?.ids).toEqual(["a", "fits"]);
		await s.answer();
		details.wantSoon(session, [tool("more", "completed", MB)]);
		await tick();
		expect(s.requests).toHaveLength(1);
		details.wantSoon(fork, [tool("x", "completed", 4 * MB)]);
		await tick();
		expect(s.requests.at(-1)).toEqual({ session: fork, ids: ["x"] });
		await s.answer();
	});
	it("asks only for cuts a card shows: a written file's content is not one", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, opened);
		const cut = (
			id: string,
			name: string,
			input: Record<string, unknown>,
			field: string,
		): ToolMessage => ({
			type: "tool",
			uuid: id,
			id,
			name,
			status: "completed",
			input,
			preview: {
				inputCuts: [{ path: [field], fullBytes: Utf8Bytes.make(MB) }],
			},
		});
		details.wantSoon(session, [
			cut("write", "Write", { filePath: "a.md", content: "…" }, "content"),
			cut("bash", "Bash", { command: "…" }, "command"),
		]);
		await tick();
		expect(s.requests).toEqual([{ session, ids: ["bash"] }]);
		await s.answer();
	});

	it("waits for the session's first load, then runs the newest set wanted meanwhile", async () => {
		const s = server();
		const { view, settle } = loading();
		const details = makeToolDetails(s.fetch, () => view);
		details.wantSoon(session, [tool("a")]);
		details.wantSoon(session, [tool("b")]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.requests).toHaveLength(0);
		settle(true);
		await tick();
		expect(s.requests).toEqual([{ session, ids: ["b"] }]);
		await s.answer();
	});

	it("drops what a view left before loading wanted, and serves the next view", async () => {
		const s = server();
		const left = loading();
		let view = left.view;
		const details = makeToolDetails(s.fetch, () => view);
		details.wantSoon(session, [tool("a")]);
		await tick();
		left.settle(false);
		await tick();
		expect(s.requests).toHaveLength(0);
		view = Promise.resolve(true);
		details.wantSoon(session, [tool("b")]);
		await tick();
		expect(s.requests).toEqual([{ session, ids: ["b"] }]);
		await s.answer();
	});

	it("starts each view of a session afresh, with nothing wanted in between", async () => {
		const s = server();
		let view = Promise.resolve(true);
		const details = makeToolDetails(s.fetch, () => view);
		details.wantSoon(session, [tool("a", "completed", 4 * MB)]);
		await tick();
		await s.answer();
		details.wantSoon(session, [tool("b", "completed", 4 * MB)]);
		await tick();
		expect(s.requests).toHaveLength(1);
		view = Promise.resolve(true);
		details.wantSoon(session, [tool("b", "completed", 4 * MB)]);
		await tick();
		expect(s.requests.map(({ ids }) => ids)).toEqual([["a"], ["b"]]);
		await s.answer();
	});

	it("prefetches nothing for a session that is not open", async () => {
		const s = server();
		const details = makeToolDetails(s.fetch, () => undefined);
		details.wantSoon(session, [tool("a")]);
		await tick();
		expect(s.requests).toHaveLength(0);
	});
});
