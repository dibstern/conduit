import { describe, expect, it } from "vitest";
import { OpenCodeApiError } from "../../../src/lib/errors.js";
import {
	GapEndpointHttpError,
	GapEndpoints,
} from "../../../src/lib/instance/gap-endpoints.js";

describe("GapEndpoints", () => {
	function makeGap(
		responses: Array<{ status: number; body: unknown }>,
	): GapEndpoints {
		let idx = 0;
		const mockFetch = async () => {
			const r = responses[idx++];
			if (!r) throw new Error("No more mock responses");
			return new Response(JSON.stringify(r.body), {
				status: r.status,
				headers: { "Content-Type": "application/json" },
			});
		};
		return new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: mockFetch as typeof fetch,
		});
	}

	function makeGapWithTextResponse(options: {
		status: number;
		body: string;
		contentType?: string;
	}): GapEndpoints {
		return new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: (async () =>
				new Response(options.body, {
					status: options.status,
					headers: {
						"Content-Type": options.contentType ?? "application/json",
					},
				})) as typeof fetch,
		});
	}

	it("listPendingPermissions returns array from GET /permission", async () => {
		const gap = makeGap([
			{
				status: 200,
				body: [
					{
						id: "per_1",
						sessionID: "ses_1",
						permission: "bash",
						patterns: ["npm test"],
						metadata: { command: "npm test" },
						always: ["npm test"],
					},
				],
			},
		]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([
			{
				id: "per_1",
				sessionID: "ses_1",
				permission: "bash",
				patterns: ["npm test"],
				metadata: { command: "npm test" },
				always: ["npm test"],
			},
		]);
	});

	it("listPendingPermissions rejects malformed non-array responses", async () => {
		const gap = makeGap([{ status: 200, body: {} }]);
		const rejected = gap.listPendingPermissions();

		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/permission",
			responseStatus: 200,
			context: expect.objectContaining({
				method: "GET",
				path: "/permission",
			}),
		});
		await expect(rejected).rejects.toBeInstanceOf(OpenCodeApiError);
	});

	it("listPendingPermissions rejects malformed successful JSON as an OpenCode API error", async () => {
		const gap = makeGapWithTextResponse({
			status: 200,
			body: "{not-json",
		});
		const rejected = gap.listPendingPermissions();

		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/permission",
			responseStatus: 200,
			responseBody: {
				parseDetails: expect.stringContaining("JSON"),
			},
			context: expect.objectContaining({
				method: "GET",
				path: "/permission",
				parseDetails: expect.stringContaining("JSON"),
			}),
		});
		await expect(rejected).rejects.toBeInstanceOf(OpenCodeApiError);
	});

	it("listPendingQuestions returns array", async () => {
		const gap = makeGap([
			{
				status: 200,
				body: [
					{
						id: "que_1",
						sessionID: "ses_1",
						questions: [
							{
								question: "Pick an option",
								header: "Choice",
								options: [{ label: "Yes", description: "Continue" }],
							},
						],
					},
				],
			},
		]);
		const result = await gap.listPendingQuestions();
		expect(result).toEqual([
			{
				id: "que_1",
				sessionID: "ses_1",
				questions: [
					{
						question: "Pick an option",
						header: "Choice",
						options: [{ label: "Yes", description: "Continue" }],
					},
				],
			},
		]);
	});

	it("listPendingQuestions rejects missing required response fields", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "que_1" }] }]);
		const rejected = gap.listPendingQuestions();

		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/question",
			responseStatus: 200,
			context: expect.objectContaining({
				method: "GET",
				path: "/question",
			}),
		});
		await expect(rejected).rejects.toBeInstanceOf(OpenCodeApiError);
	});

	it("replyQuestion sends POST /question/{id}/reply", async () => {
		let capturedUrl = "";
		let capturedBody: unknown;
		let fetchCalls = 0;
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				fetchCalls += 1;
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				capturedBody = await req.json();
				return new Response(null, { status: 204 });
			},
		});
		await gap.replyQuestion("q1", [["yes"]]);
		expect(fetchCalls).toBe(1);
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reply");
		expect(capturedBody).toEqual({ answers: [["yes"]] });
	});

	it("replyQuestion rejects malformed request envelopes before fetch", async () => {
		let fetchCalls = 0;
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async () => {
				fetchCalls += 1;
				return new Response(null, { status: 204 });
			},
		});

		await expect(
			gap.replyQuestion("q1", [["yes"], [123]] as unknown as string[][]),
		).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/question/q1/reply",
			context: expect.objectContaining({
				method: "POST",
				path: "/question/q1/reply",
			}),
		});
		expect(fetchCalls).toBe(0);
	});

	it("replyQuestion rejects malformed successful JSON as an OpenCode API error", async () => {
		const gap = makeGapWithTextResponse({
			status: 200,
			body: "{not-json",
		});
		const rejected = gap.replyQuestion("q1", [["yes"]]);

		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/question/q1/reply",
			responseStatus: 200,
			responseBody: {
				parseDetails: expect.stringContaining("JSON"),
			},
			context: expect.objectContaining({
				method: "POST",
				path: "/question/q1/reply",
				parseDetails: expect.stringContaining("JSON"),
			}),
		});
		await expect(rejected).rejects.toBeInstanceOf(OpenCodeApiError);
	});

	it("rejectQuestion sends POST /question/{id}/reject", async () => {
		let capturedUrl = "";
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				return new Response(null, { status: 204 });
			},
		});
		await gap.rejectQuestion("q1");
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reject");
	});

	it("listSkills returns array", async () => {
		const gap = makeGap([{ status: 200, body: [{ name: "s1" }] }]);
		const result = await gap.listSkills();
		expect(result).toEqual([{ name: "s1" }]);
	});

	it("getMessagesPage passes limit and before params", async () => {
		let capturedUrl = "";
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				return new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		await gap.getMessagesPage("s1", { limit: 10, before: "m5" });
		expect(capturedUrl).toContain("/session/s1/message");
		expect(capturedUrl).toContain("limit=10");
		expect(capturedUrl).toContain("before=m5");
	});

	it("getMessagesPage rejects malformed response data as an OpenCode API error", async () => {
		const gap = makeGap([{ status: 200, body: {} }]);
		const rejected = gap.getMessagesPage("s1");

		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/session/s1/message",
			responseStatus: 200,
			context: expect.objectContaining({
				method: "GET",
				path: "/session/s1/message",
			}),
		});
		await expect(rejected).rejects.toBeInstanceOf(OpenCodeApiError);
	});

	it("rejects GET failures with a tagged gap endpoint error", async () => {
		const gap = makeGap([{ status: 503, body: { error: "down" } }]);
		const rejected = gap.listPendingPermissions();

		await expect(rejected).rejects.toMatchObject({
			_tag: "GapEndpointHttpError",
			method: "GET",
			path: "/permission",
			status: 503,
			message: "GET /permission failed: 503",
		});
		await expect(rejected).rejects.toBeInstanceOf(GapEndpointHttpError);
	});

	it("rejects POST failures with a tagged gap endpoint error", async () => {
		const gap = makeGap([{ status: 400, body: { error: "bad" } }]);
		const rejected = gap.replyQuestion("q1", [["yes"]]);

		await expect(rejected).rejects.toMatchObject({
			_tag: "GapEndpointHttpError",
			method: "POST",
			path: "/question/q1/reply",
			status: 400,
			message: "POST /question/q1/reply failed: 400",
		});
		await expect(rejected).rejects.toBeInstanceOf(GapEndpointHttpError);
	});
});
