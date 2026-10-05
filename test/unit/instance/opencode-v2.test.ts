import { describe, expect, it, vi } from "vitest";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../../src/lib/instance/sdk-factory.js";

// Boundary failures: lost auth, changed directory scope or paging, malformed
// requests/JSON/data, HTTP/network errors, and swallowed SSE errors or aborts.
function makeApi(
	response: () => Response = () => Response.json([]),
	directory?: string,
) {
	const requests: Request[] = [];
	const transport: typeof fetch = vi.fn(async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push(request);
		return response();
	});
	const factory = createSdkClient({
		baseUrl: "http://opencode.test",
		auth: { username: "opencode", password: "test-password" },
		fetch: transport,
		...(directory === undefined ? {} : { directory }),
	});
	const api = new OpenCodeAPI({
		sdk: factory.client,
		baseUrl: "http://opencode.test",
		authHeaders: factory.authHeaders,
	});
	return { api, requests, factory, transport };
}

describe("OpenCode v2 SDK boundary", () => {
	it("keeps the former gap endpoints and their default directory scope", async () => {
		const { api, requests } = makeApi(undefined, "/configured project");
		await api.permission.list();
		await api.question.list();
		await api.app.skills();
		await api.session.messagesPage("s1", { limit: 10, before: "m 5/+" });
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/permission",
			"/question",
			"/skill",
			"/session/s1/message",
		]);
		for (const request of requests) {
			expect(new URL(request.url).searchParams.has("directory")).toBe(false);
			expect(request.headers.has("x-opencode-directory")).toBe(false);
			expect(request.headers.get("Authorization")).toBe(
				`Basic ${Buffer.from("opencode:test-password").toString("base64")}`,
			);
		}
		const query = new URL(requests[3]?.url ?? "").searchParams;
		expect(query.get("limit")).toBe("10");
		expect(query.get("before")).toBe("m 5/+");
	});

	it.each([
		undefined,
		"/configured project",
	])("sends SDK auth and retains explicit skill directory with default %s", async (directory) => {
		const { api, requests } = makeApi(undefined, directory);
		await api.app.skills("/a project/with + unicode 日本");
		const request = requests[0];
		expect(request?.headers.get("Authorization")).toMatch(/^Basic /);
		const url = new URL(request?.url ?? "");
		expect(url.pathname).toBe("/skill");
		expect(url.searchParams.get("directory")).toBe(
			"/a project/with + unicode 日本",
		);
	});

	it("retains directory, numeric list options, and abort signals on regular SDK calls", async () => {
		const { api, requests } = makeApi(undefined, "/a project/日本");
		const controller = new AbortController();
		await api.session.list({ roots: false, limit: 10 });
		await api.session.messages("s1", { limit: 2, signal: controller.signal });
		const query = new URL(requests[0]?.url ?? "").searchParams;
		expect(query.get("directory")).toBe("/a project/日本");
		expect(query.get("roots")).toBe("false");
		expect(query.get("limit")).toBe("10");
		expect(new URL(requests[1]?.url ?? "").searchParams.get("limit")).toBe("2");
		controller.abort();
		expect(requests[1]?.signal.aborted).toBe(true);
	});

	it("retains the old zero-limit and empty-cursor omission for paging", async () => {
		const { api, requests } = makeApi();
		await api.session.messagesPage("s1", { limit: 0, before: "" });
		expect(new URL(requests[0]?.url ?? "").search).toBe("");
	});

	it.each([
		true,
		{},
		undefined,
	])("validates question action response %s and returns void", async (body) => {
		const { api, requests } = makeApi(
			() =>
				body === undefined
					? new Response(null, { status: 204 })
					: Response.json(body),
			"/configured project",
		);
		expect(await api.question.reply("q1", [["yes"]])).toBeUndefined();
		expect(await api.question.reject("q1")).toBeUndefined();
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/question/q1/reply",
			"/question/q1/reject",
		]);
		for (const request of requests) {
			expect(request.method).toBe("POST");
			expect(request.headers.has("x-opencode-directory")).toBe(false);
			expect(new URL(request.url).search).toBe("");
			expect(request.headers.get("Authorization")).toMatch(/^Basic /);
		}
		expect(await requests[0]?.json()).toEqual({ answers: [["yes"]] });
	});

	it("validates question answers before performing a request", async () => {
		const { api, transport } = makeApi();
		await expect(
			api.question.reply("q1", [[123]] as unknown as string[][]),
		).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/question/q1/reply",
			responseStatus: 400,
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it("retains the session-scoped permission reply endpoint and body", async () => {
		const { api, requests } = makeApi(() => Response.json(true), "/a project");
		await api.permission.reply("s1", "p1", "always");
		const request = requests[0];
		expect(new URL(request?.url ?? "").pathname).toBe(
			"/session/s1/permissions/p1",
		);
		expect(request?.headers.get("x-opencode-directory")).toBe(
			encodeURIComponent("/a project"),
		);
		expect(await request?.json()).toEqual({ response: "always" });
	});

	it("keeps auth on URL/init fetch calls", async () => {
		const { factory, requests } = makeApi();
		await factory.fetch("http://opencode.test/raw", {
			headers: { Accept: "application/json" },
		});
		expect(requests[0]?.headers.get("Authorization")).toBe(
			factory.authHeaders["Authorization"],
		);
		expect(requests[0]?.headers.get("Accept")).toBe("application/json");
	});

	it.each([
		"permissions",
		"questions",
		"skills",
		"messages",
		"reply",
		"reject",
	] as const)("rejects malformed %s data at the boundary", async (operation) => {
		const { api } = makeApi(() => Response.json({ unexpected: true }));
		const result =
			operation === "permissions"
				? api.permission.list()
				: operation === "questions"
					? api.question.list()
					: operation === "skills"
						? api.app.skills()
						: operation === "messages"
							? api.session.messagesPage("s1")
							: operation === "reply"
								? api.question.reply("q1", [["yes"]])
								: api.question.reject("q1");
		await expect(result).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			responseStatus: 200,
		});
	});

	it.each([
		["permissions", "application/json"],
		["reply", "application/json"],
		["permissions", "text/html"],
		["reply", "text/html"],
	] as const)("maps malformed %s %s to an API error", async (operation, contentType) => {
		const { api } = makeApi(
			() =>
				new Response("{not-json", {
					headers: { "Content-Type": contentType },
				}),
		);
		await expect(
			operation === "permissions"
				? api.permission.list()
				: api.question.reply("q1", [["yes"]]),
		).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			responseStatus: 200,
			responseBody: { parseDetails: expect.stringContaining("JSON") },
		});
	});

	it.each([
		[401, "application/json"],
		[503, "application/json"],
		[401, "text/html"],
		[404, "text/html"],
		[503, "text/html"],
	] as const)("preserves HTTP status %s with %s in OpenCodeApiError", async (status, contentType) => {
		const { api } = makeApi(
			() =>
				new Response("failed", {
					status,
					headers: { "Content-Type": contentType },
				}),
		);
		await expect(api.permission.list()).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			responseStatus: status,
		});
	});

	it("maps v2 network failures to OpenCodeConnectionError", async () => {
		const { api } = makeApi(() => {
			throw new TypeError("fetch failed");
		});
		await expect(api.permission.list()).rejects.toMatchObject({
			_tag: "OpenCodeConnectionError",
		});
	});

	it("streams through the v2 SDK with auth, directory, and abort forwarding", async () => {
		const { api, requests } = makeApi(
			() =>
				new Response('data: {"type":"server.connected","properties":{}}\n\n', {
					headers: { "Content-Type": "text/event-stream" },
				}),
			"/a project/日本",
		);
		const controller = new AbortController();
		const onSseError = vi.fn();
		const { stream } = await api.event.subscribe({
			signal: controller.signal,
			sseMaxRetryAttempts: 1,
			onSseError,
		});
		expect((await stream.next()).value).toEqual({
			type: "server.connected",
			properties: {},
		});
		expect(requests[0]?.headers.get("Authorization")).toMatch(/^Basic /);
		expect(new URL(requests[0]?.url ?? "").searchParams.get("directory")).toBe(
			"/a project/日本",
		);
		controller.abort();
		await stream.return();
		expect(onSseError).not.toHaveBeenCalled();
	});

	it("keeps the event stream open past the REST retry timeout", async () => {
		// Regression: the retry fetch's per-attempt timeout aborted the stream,
		// flapping the "Reconnecting to OpenCode" banner every 10s.
		// Like real fetch, an init signal overrides the Request's own.
		const baseFetch: typeof fetch = async (input, init) => {
			const signal = init?.signal ?? (input as Request).signal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const timer = setTimeout(() => {
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"server.connected","properties":{}}\n\n',
							),
						);
					}, 100);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						controller.error(signal.reason);
					});
				},
			});
			return new Response(body, {
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const factory = createSdkClient({
			baseUrl: "http://opencode.test",
			retry: { timeout: 20, retries: 0, baseFetch },
		});
		const api = new OpenCodeAPI({
			sdk: factory.client,
			baseUrl: "http://opencode.test",
			authHeaders: factory.authHeaders,
		});
		const controller = new AbortController();
		const onSseError = vi.fn();
		const { stream } = await api.event.subscribe({
			signal: controller.signal,
			sseMaxRetryAttempts: 1,
			onSseError,
		});
		expect((await stream.next()).value).toEqual({
			type: "server.connected",
			properties: {},
		});
		expect(onSseError).not.toHaveBeenCalled();
		controller.abort();
		await stream.return();
	});

	it("lets conduit own SSE reconnection after one transport failure", async () => {
		const { api, transport } = makeApi(() => {
			throw new TypeError("stream failed");
		});
		const onSseError = vi.fn();
		const { stream } = await api.event.subscribe({
			sseMaxRetryAttempts: 1,
			onSseError,
		});
		expect(await stream.next()).toEqual({ done: true, value: undefined });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(onSseError).toHaveBeenCalledTimes(1);
		expect(onSseError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "stream failed" }),
		);
	});
});
