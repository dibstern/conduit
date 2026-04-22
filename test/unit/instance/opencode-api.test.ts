import { describe, expect, it, vi } from "vitest";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";

// Stub SDK client — test that methods delegate correctly
function makeStubSdk() {
	return {
		session: {
			list: vi.fn(async () => ({
				data: [{ id: "s1", title: "test" }],
				error: undefined,
				response: { status: 200 },
			})),
			get: vi.fn(async () => ({
				data: { id: "s1", title: "test" },
				error: undefined,
				response: { status: 200 },
			})),
			create: vi.fn(async () => ({
				data: { id: "s2", title: "new" },
				error: undefined,
				response: { status: 200 },
			})),
			delete: vi.fn(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			update: vi.fn(async () => ({
				data: { id: "s1", title: "updated" },
				error: undefined,
				response: { status: 200 },
			})),
			status: vi.fn(async () => ({
				data: { s1: { type: "idle" } },
				error: undefined,
				response: { status: 200 },
			})),
			messages: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			message: vi.fn(async () => ({
				data: { info: { id: "m1" }, parts: [] },
				error: undefined,
				response: { status: 200 },
			})),
			abort: vi.fn(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			fork: vi.fn(async () => ({
				data: { id: "s3" },
				error: undefined,
				response: { status: 200 },
			})),
			revert: vi.fn(async () => ({
				data: { id: "s1" },
				error: undefined,
				response: { status: 200 },
			})),
			unrevert: vi.fn(async () => ({
				data: { id: "s1" },
				error: undefined,
				response: { status: 200 },
			})),
			share: vi.fn(async () => ({
				data: { id: "s1", share: { url: "https://share.test" } },
				error: undefined,
				response: { status: 200 },
			})),
			summarize: vi.fn(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			diff: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			promptAsync: vi.fn(async () => ({
				data: undefined,
				error: undefined,
				response: { status: 204 },
			})),
			prompt: vi.fn(async () => ({
				data: { info: { id: "m1" }, parts: [] },
				error: undefined,
				response: { status: 200 },
			})),
			children: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
		},
		config: {
			get: vi.fn(async () => ({
				data: {},
				error: undefined,
				response: { status: 200 },
			})),
			update: vi.fn(async () => ({
				data: {},
				error: undefined,
				response: { status: 200 },
			})),
			providers: vi.fn(async () => ({
				data: { providers: [], default: {} },
				error: undefined,
				response: { status: 200 },
			})),
		},
		provider: {
			list: vi.fn(async () => ({
				data: { all: [], default: {}, connected: [] },
				error: undefined,
				response: { status: 200 },
			})),
		},
		pty: {
			list: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			create: vi.fn(async () => ({
				data: { id: "pty1" },
				error: undefined,
				response: { status: 200 },
			})),
			remove: vi.fn(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			update: vi.fn(async () => ({
				data: { id: "pty1" },
				error: undefined,
				response: { status: 200 },
			})),
		},
		file: {
			list: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			read: vi.fn(async () => ({
				data: { content: "hello" },
				error: undefined,
				response: { status: 200 },
			})),
			status: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
		},
		find: {
			text: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			files: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			symbols: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
		},
		path: {
			get: vi.fn(async () => ({
				data: { cwd: "/test" },
				error: undefined,
				response: { status: 200 },
			})),
		},
		vcs: {
			get: vi.fn(async () => ({
				data: { branch: "main" },
				error: undefined,
				response: { status: 200 },
			})),
		},
		app: {
			agents: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
		},
		command: {
			list: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
		},
		project: {
			list: vi.fn(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			current: vi.fn(async () => ({
				data: { id: "proj1", worktree: "/test" },
				error: undefined,
				response: { status: 200 },
			})),
		},
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* () {})(),
			})),
		},
		postSessionIdPermissionsPermissionId: vi.fn(async () => ({
			data: true,
			error: undefined,
			response: { status: 200 },
		})),
		// biome-ignore lint/suspicious/noExplicitAny: test stub for OpencodeClient
	} as any;
}

function makeStubGaps() {
	return {
		listPendingPermissions: vi.fn(async () => []),
		listPendingQuestions: vi.fn(async () => []),
		replyQuestion: vi.fn(async () => {}),
		rejectQuestion: vi.fn(async () => {}),
		listSkills: vi.fn(async () => []),
		getMessagesPage: vi.fn(async () => []),
		// biome-ignore lint/suspicious/noExplicitAny: test stub for GapEndpoints
	} as any;
}

describe("OpenCodeAPI", () => {
	it("session.list() delegates to sdk.session.list()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.list();
		expect(sdk.session.list).toHaveBeenCalled();
		expect(result).toEqual([{ id: "s1", title: "test" }]);
	});

	it("session.get() delegates to sdk.session.get()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.get("s1");
		expect(sdk.session.get).toHaveBeenCalledWith(
			expect.objectContaining({
				path: { id: "s1" },
			}),
		);
		expect(result).toEqual({ id: "s1", title: "test" });
	});

	it("session.create() delegates to sdk.session.create()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.create({ title: "new session" });
		expect(sdk.session.create).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { title: "new session" },
			}),
		);
		expect(result).toEqual({ id: "s2", title: "new" });
	});

	it("session.messages() flattens SDK shape and delegates to sdk.session.messages()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.messages("s1");
		expect(sdk.session.messages).toHaveBeenCalledWith(
			expect.objectContaining({
				path: { id: "s1" },
			}),
		);
		expect(result).toEqual([]);
	});

	it("permission.list() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		gaps.listPendingPermissions.mockResolvedValue([{ id: "p1" }]);
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.permission.list();
		expect(gaps.listPendingPermissions).toHaveBeenCalled();
		expect(result).toEqual([{ id: "p1" }]);
	});

	it("question.reply() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.question.reply("q1", [["yes"]]);
		expect(gaps.replyQuestion).toHaveBeenCalledWith("q1", [["yes"]]);
	});

	it("session.prompt() builds parts array from text", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.session.prompt("s1", { text: "hello" });
		expect(sdk.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					parts: [{ type: "text", text: "hello" }],
				}),
			}),
		);
	});

	it("permission.reply() maps decision and delegates to SDK", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.permission.reply("s1", "perm1", "once");
		expect(sdk.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
			expect.objectContaining({
				path: { id: "s1", permissionID: "perm1" },
				body: { response: "once" },
			}),
		);
	});

	it("provider.list() delegates to sdk.provider.list()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.provider.list();
		expect(sdk.provider.list).toHaveBeenCalled();
		// SDK returns { all, default, connected }; adapter normalizes to { providers, defaults, connected }
		expect(result).toEqual({ providers: [], defaults: {}, connected: [] });
	});

	it("pty.resize() delegates to sdk.pty.update() with size", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.pty.resize("pty1", 24, 80);
		expect(sdk.pty.update).toHaveBeenCalledWith(
			expect.objectContaining({
				path: { id: "pty1" },
				body: { size: { rows: 24, cols: 80 } },
			}),
		);
	});

	it("app.skills() delegates to gapEndpoints.listSkills()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		gaps.listSkills.mockResolvedValue([{ name: "test-skill" }]);
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.app.skills();
		expect(gaps.listSkills).toHaveBeenCalled();
		expect(result).toEqual([{ name: "test-skill" }]);
	});

	it("getBaseUrl() returns configured base URL", () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: { Authorization: "Basic abc" },
		});
		expect(api.getBaseUrl()).toBe("http://localhost:4096");
	});

	it("getAuthHeaders() returns configured auth headers", () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: { Authorization: "Basic abc" },
		});
		expect(api.getAuthHeaders()).toEqual({
			Authorization: "Basic abc",
		});
	});

	it("sdk error result throws OpenCodeApiError", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		sdk.session.get.mockResolvedValue({
			data: undefined,
			error: { name: "NotFoundError", data: { message: "not found" } },
			response: { status: 404, url: "/session/s999" },
		});
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await expect(api.session.get("s999")).rejects.toThrow(/API error.*session/);
	});

	it("sdk network error throws OpenCodeConnectionError", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		sdk.session.list.mockRejectedValue(new TypeError("fetch failed"));
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await expect(api.session.list()).rejects.toThrow(/fetch failed/);
	});

	it("session.messagesPage() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		gaps.getMessagesPage.mockResolvedValue([{ id: "m1" }]);
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.messagesPage("s1", {
			limit: 10,
			before: "m5",
		});
		expect(gaps.getMessagesPage).toHaveBeenCalledWith("s1", {
			limit: 10,
			before: "m5",
		});
		expect(result).toEqual([{ id: "m1" }]);
	});

	it("app.projects() delegates to sdk.project.list()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.app.projects();
		expect(sdk.project.list).toHaveBeenCalled();
		expect(result).toEqual([]);
	});

	it("app.currentProject() delegates to sdk.project.current()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({
			sdk,
			gapEndpoints: gaps,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.app.currentProject();
		expect(sdk.project.current).toHaveBeenCalled();
		expect(result).toEqual({ id: "proj1", worktree: "/test" });
	});
});
