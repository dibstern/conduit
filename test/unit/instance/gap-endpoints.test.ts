import { describe, expect, it } from "vitest";
import { GapEndpoints } from "../../../src/lib/instance/gap-endpoints.js";

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

	it("listPendingPermissions returns array from GET /permission", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "p1", type: "bash" }] }]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([{ id: "p1", type: "bash" }]);
	});

	it("listPendingPermissions returns empty array on non-array", async () => {
		const gap = makeGap([{ status: 200, body: {} }]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([]);
	});

	it("listPendingQuestions returns array", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "q1" }] }]);
		const result = await gap.listPendingQuestions();
		expect(result).toEqual([{ id: "q1" }]);
	});

	it("replyQuestion sends POST /question/{id}/reply", async () => {
		let capturedUrl = "";
		let capturedBody: unknown;
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				capturedBody = await req.json();
				return new Response(null, { status: 204 });
			},
		});
		await gap.replyQuestion("q1", [["yes"]]);
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reply");
		expect(capturedBody).toEqual({ answers: [["yes"]] });
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
});
