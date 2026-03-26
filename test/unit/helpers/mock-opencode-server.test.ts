import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenCodeRecording } from "../../e2e/fixtures/recorded/types.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";

const FIXTURE: OpenCodeRecording = {
	name: "test-fixture",
	recordedAt: new Date().toISOString(),
	opencodeVersion: "1.2.6",
	interactions: [
		{
			kind: "rest",
			method: "GET",
			path: "/path",
			status: 200,
			responseBody: { cwd: "/tmp" },
		},
		{
			kind: "rest",
			method: "GET",
			path: "/session",
			status: 200,
			responseBody: [{ id: "ses_1" }],
		},
		{
			kind: "rest",
			method: "GET",
			path: "/agent",
			status: 200,
			responseBody: [{ id: "coder", name: "Coder" }],
		},
		{
			kind: "rest",
			method: "POST",
			path: "/session",
			status: 200,
			responseBody: { id: "ses_2", title: "New" },
		},
		{
			kind: "rest",
			method: "GET",
			path: "/session",
			status: 200,
			responseBody: [{ id: "ses_1" }, { id: "ses_2" }],
		},
		{
			kind: "rest",
			method: "DELETE",
			path: "/session/ses_2",
			status: 204,
			responseBody: null,
		},
		{
			kind: "rest",
			method: "GET",
			path: "/session",
			status: 200,
			responseBody: [{ id: "ses_1" }],
		},
		// prompt_async triggers SSE batch
		{
			kind: "rest",
			method: "POST",
			path: "/session/ses_1/prompt_async",
			status: 200,
			responseBody: {},
		},
		{
			kind: "sse",
			type: "session.status",
			properties: { sessionID: "ses_1", status: { type: "busy" } },
			delayMs: 0,
		},
		{
			kind: "sse",
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				partID: "p1",
				field: "text",
				delta: "hello",
			},
			delayMs: 5,
		},
		{
			kind: "sse",
			type: "session.status",
			properties: { sessionID: "ses_1", status: { type: "idle" } },
			delayMs: 5,
		},
		// Permission reply also triggers SSE batch
		{
			kind: "rest",
			method: "POST",
			path: "/permission/perm_1/reply",
			status: 200,
			responseBody: {},
		},
		{
			kind: "sse",
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				partID: "p2",
				field: "text",
				delta: "world",
			},
			delayMs: 0,
		},
		{
			kind: "sse",
			type: "session.status",
			properties: { sessionID: "ses_1", status: { type: "idle" } },
			delayMs: 5,
		},
	],
};

/** Collect SSE events from a streaming fetch response. Returns an abort-safe promise. */
function collectSseEvents(
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
	events: Array<{ type: string }>,
): Promise<void> {
	if (!reader) return Promise.resolve();
	const decoder = new TextDecoder();
	let buffer = "";

	return (async () => {
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						events.push(JSON.parse(line.slice(6)));
					}
				}
			}
		} catch {
			// AbortError is expected when controller.abort() is called
		}
	})();
}

describe("MockOpenCodeServer", () => {
	let mock: MockOpenCodeServer;

	beforeAll(async () => {
		mock = new MockOpenCodeServer(FIXTURE);
		await mock.start();
	});

	afterAll(async () => {
		await mock.stop();
	});

	beforeEach(() => {
		mock.reset();
	});

	it("serves REST responses from queued recording", async () => {
		const r1 = await fetch(`${mock.url}/path`);
		expect(r1.status).toBe(200);
		expect(r1.headers.get("content-type")).toContain("application/json");
		expect(await r1.json()).toEqual({ cwd: "/tmp" });

		const r2 = await fetch(`${mock.url}/session`);
		expect(r2.status).toBe(200);
		expect(await r2.json()).toEqual([{ id: "ses_1" }]);
	});

	it("dequeues successive responses for same endpoint", async () => {
		// Drain first GET /session
		await fetch(`${mock.url}/session`);

		// GET /agent (only one in queue)
		const r1 = await fetch(`${mock.url}/agent`);
		expect(await r1.json()).toEqual([{ id: "coder", name: "Coder" }]);

		// POST /session
		const r2 = await fetch(`${mock.url}/session`, {
			method: "POST",
			body: "{}",
		});
		expect(await r2.json()).toEqual({ id: "ses_2", title: "New" });

		// Second GET /session (different response than first)
		const r3 = await fetch(`${mock.url}/session`);
		expect(await r3.json()).toEqual([{ id: "ses_1" }, { id: "ses_2" }]);

		// DELETE /session/ses_2
		const r4 = await fetch(`${mock.url}/session/ses_2`, { method: "DELETE" });
		expect(r4.status).toBe(204);
		expect(r4.headers.get("content-type")).toBeNull();

		// Third GET /session (back to just ses_1)
		const r5 = await fetch(`${mock.url}/session`);
		expect(await r5.json()).toEqual([{ id: "ses_1" }]);
	});

	it("returns last queued response when queue is exhausted", async () => {
		// Drain the only GET /path response
		await fetch(`${mock.url}/path`);
		// Ask again — should get last response
		const res = await fetch(`${mock.url}/path`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ cwd: "/tmp" });
	});

	it("matches path parameters (e.g. /session/:id)", async () => {
		// DELETE with a DIFFERENT session ID but same pattern
		// First drain the queued GET /session responses so we can get to DELETE
		await fetch(`${mock.url}/session`); // first
		await fetch(`${mock.url}/agent`);
		await fetch(`${mock.url}/session`, { method: "POST", body: "{}" });
		await fetch(`${mock.url}/session`); // second

		const res = await fetch(`${mock.url}/session/ses_xyz`, {
			method: "DELETE",
		});
		expect(res.status).toBe(204);
	});

	it("streams SSE events after prompt_async", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		expect(sseRes.status).toBe(200);

		const events: Array<{ type: string }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		await fetch(`${mock.url}/session/ses_1/prompt_async`, {
			method: "POST",
			body: "{}",
		});

		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		expect(events.length).toBe(5);
		expect(events[0]).toMatchObject({ type: "session.status" });
		expect(events[1]).toMatchObject({ type: "message.part.delta" });
		expect(events[2]).toMatchObject({ type: "session.status" });
		expect(events[3]).toMatchObject({ type: "message.part.delta" });
		expect(events[4]).toMatchObject({ type: "session.status" });
	});

	it("emits all post-prompt SSE events when prompt fires (including permission-adjacent)", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});

		const events: Array<{ type: string }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		await fetch(`${mock.url}/session/ses_1/prompt_async`, {
			method: "POST",
			body: "{}",
		});
		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		expect(events.length).toBe(5);
		expect(events[0]).toMatchObject({ type: "session.status" });
		expect(events[1]).toMatchObject({ type: "message.part.delta" });
		expect(events[2]).toMatchObject({ type: "session.status" });
		expect(events[3]).toMatchObject({ type: "message.part.delta" });
		expect(events[4]).toMatchObject({ type: "session.status" });
	});

	it("emits post-prompt SSE events independently of REST consumption", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});

		const events: Array<{ type: string }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		await fetch(`${mock.url}/session/ses_1/prompt_async`, {
			method: "POST",
			body: "{}",
		});

		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		// The FIXTURE has 5 SSE events after prompt_async — 3 before
		// the permission reply REST entry + 2 after it — all in segment 1
		// since permission reply is NOT a prompt boundary
		expect(events.length).toBe(5);
		expect(events[0]).toMatchObject({ type: "session.status" });
		expect(events[1]).toMatchObject({ type: "message.part.delta" });
		expect(events[2]).toMatchObject({ type: "session.status" });
		expect(events[3]).toMatchObject({ type: "message.part.delta" });
		expect(events[4]).toMatchObject({ type: "session.status" });
	});

	it("segments SSE events by prompt boundary for multi-turn", async () => {
		const multiFixture: OpenCodeRecording = {
			name: "multi-turn",
			recordedAt: new Date().toISOString(),
			opencodeVersion: "1.2.6",
			interactions: [
				{
					kind: "rest",
					method: "GET",
					path: "/path",
					status: 200,
					responseBody: { cwd: "/tmp" },
				},
				{
					kind: "rest",
					method: "GET",
					path: "/session",
					status: 200,
					responseBody: [{ id: "ses_1" }],
				},
				{ kind: "sse", type: "session.created", properties: {}, delayMs: 0 },
				{
					kind: "rest",
					method: "POST",
					path: "/session/ses_1/prompt_async",
					status: 200,
					responseBody: {},
				},
				{
					kind: "sse",
					type: "message.part.delta",
					properties: { delta: "turn1" },
					delayMs: 0,
				},
				{ kind: "sse", type: "session.idle", properties: {}, delayMs: 0 },
				{
					kind: "rest",
					method: "POST",
					path: "/session/ses_1/prompt_async",
					status: 200,
					responseBody: {},
				},
				{
					kind: "sse",
					type: "message.part.delta",
					properties: { delta: "turn2" },
					delayMs: 0,
				},
				{ kind: "sse", type: "session.idle", properties: {}, delayMs: 0 },
			],
		};

		const multiMock = new MockOpenCodeServer(multiFixture);
		await multiMock.start();

		try {
			const controller = new AbortController();
			const sseRes = await fetch(`${multiMock.url}/event`, {
				signal: controller.signal,
				headers: { Accept: "text/event-stream" },
			});
			const events: Array<{
				type: string;
				properties?: Record<string, unknown>;
			}> = [];
			const collecting = collectSseEvents(sseRes.body?.getReader(), events);

			await fetch(`${multiMock.url}/session/ses_1/prompt_async`, {
				method: "POST",
				body: "{}",
			});
			await new Promise((r) => setTimeout(r, 100));

			expect(events).toHaveLength(3);
			expect(events[0]).toMatchObject({ type: "session.created" });
			expect(events[1]).toMatchObject({ type: "message.part.delta" });
			expect(events[2]).toMatchObject({ type: "session.idle" });

			await fetch(`${multiMock.url}/session/ses_1/prompt_async`, {
				method: "POST",
				body: "{}",
			});
			await new Promise((r) => setTimeout(r, 100));
			controller.abort();
			await collecting;

			expect(events).toHaveLength(5);
			expect(events[3]).toMatchObject({ type: "message.part.delta" });
			expect(events[4]).toMatchObject({ type: "session.idle" });
		} finally {
			await multiMock.stop();
		}
	});

	it("flushPendingSse emits all segments without requiring prompt_async", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		const events: Array<{ type: string }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		mock.flushPendingSse();
		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		expect(events.length).toBe(5);
	});

	it("reset() re-initializes all queues", async () => {
		// Drain some responses
		await fetch(`${mock.url}/path`);
		await fetch(`${mock.url}/session`);

		// Reset
		mock.reset();

		// Should get first response again
		const res = await fetch(`${mock.url}/path`);
		expect(await res.json()).toEqual({ cwd: "/tmp" });

		const res2 = await fetch(`${mock.url}/session`);
		expect(await res2.json()).toEqual([{ id: "ses_1" }]);
	});
});
