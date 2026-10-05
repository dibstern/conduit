import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeApiError } from "../../../src/lib/errors.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";

function makeSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "s1",
		projectID: "proj1",
		directory: "/test",
		title: "test",
		version: "1.0.0",
		time: { created: 1, updated: 1 },
		...overrides,
	};
}

function makeAgent(overrides: Record<string, unknown> = {}) {
	return {
		name: "build",
		description: "Build agent",
		mode: "primary",
		builtIn: true,
		permission: { edit: "ask", bash: {} },
		tools: {},
		options: {},
		...overrides,
	};
}

function makeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: "proj1",
		worktree: "/test",
		time: { created: 1 },
		...overrides,
	};
}

function makePty(overrides: Record<string, unknown> = {}) {
	return {
		id: "pty1",
		title: "Terminal",
		command: "zsh",
		args: [],
		cwd: "/test",
		status: "running",
		pid: 1234,
		...overrides,
	};
}

function makeProvider(overrides: Record<string, unknown> = {}) {
	return {
		id: "anthropic",
		name: "Anthropic",
		env: ["ANTHROPIC_API_KEY"],
		models: {
			"claude-sonnet-4": {
				id: "claude-sonnet-4",
				name: "Claude Sonnet 4",
				release_date: "2026-01-01",
				attachment: true,
				reasoning: true,
				temperature: true,
				tool_call: true,
				limit: { context: 200000, output: 64000 },
				options: {},
				variants: { "1m": { limit: { context: 1000000 } } },
			},
		},
		...overrides,
	};
}

function makeProviderWithCurrentModelShape() {
	return makeProvider({
		id: "helicone",
		name: "Helicone",
		env: ["HELICONE_API_KEY"],
		models: {
			"claude-opus-4-1-20250805": {
				id: "claude-opus-4-1-20250805",
				providerID: "helicone",
				api: {
					id: "claude-opus-4-1-20250805",
					url: "https://ai-gateway.helicone.ai/v1",
					npm: "@ai-sdk/openai-compatible",
				},
				name: "Anthropic: Claude Opus 4.1 (20250805)",
				family: "claude-opus",
				capabilities: {
					temperature: true,
					reasoning: true,
					attachment: false,
					toolcall: true,
					input: {
						text: true,
						audio: false,
						image: true,
						video: false,
						pdf: false,
					},
					output: {
						text: true,
						audio: false,
						image: false,
						video: false,
						pdf: false,
					},
					interleaved: { field: "reasoning_content" },
				},
				cost: {
					input: 15,
					output: 75,
					cache: {
						read: 1.5,
						write: 18.75,
					},
				},
				limit: { context: 200000, output: 32000 },
				status: "active",
				options: {},
				headers: {},
				release_date: "2025-08-05",
				variants: {
					low: { reasoningEffort: "low" },
					medium: { reasoningEffort: "medium" },
					high: { reasoningEffort: "high" },
				},
			},
		},
	});
}

type SdkResponse = {
	data: unknown;
	error: unknown;
	response: { status: number; url?: string };
};

// Stub SDK client — test that methods delegate correctly
function makeStubSdk() {
	const sdk = {
		session: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [makeSession()],
				error: undefined,
				response: { status: 200 },
			})),
			get: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeSession(),
				error: undefined,
				response: { status: 200 },
			})),
			create: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeSession({ id: "s2", title: "new" }),
				error: undefined,
				response: { status: 200 },
			})),
			delete: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			update: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeSession({ title: "updated" }),
				error: undefined,
				response: { status: 200 },
			})),
			status: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { s1: { type: "idle" } },
				error: undefined,
				response: { status: 200 },
			})),
			messages: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			message: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { info: { id: "m1" }, parts: [] },
				error: undefined,
				response: { status: 200 },
			})),
			abort: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			fork: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeSession({ id: "s3" }),
				error: undefined,
				response: { status: 200 },
			})),
			revert: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeSession({ revert: { messageID: "m1" } }),
				error: undefined,
				response: { status: 200 },
			})),
			unrevert: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeSession(),
				error: undefined,
				response: { status: 200 },
			})),
			share: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { url: "https://share.test" },
				error: undefined,
				response: { status: 200 },
			})),
			summarize: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			diff: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { diffs: [] },
				error: undefined,
				response: { status: 200 },
			})),
			promptAsync: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: undefined,
				error: undefined,
				response: { status: 204 },
			})),
			prompt: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { info: { id: "m1" }, parts: [] },
				error: undefined,
				response: { status: 200 },
			})),
			children: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
		},
		config: {
			get: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: {},
				error: undefined,
				response: { status: 200 },
			})),
			update: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: {},
				error: undefined,
				response: { status: 200 },
			})),
			providers: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { providers: [], default: {} },
				error: undefined,
				response: { status: 200 },
			})),
		},
		provider: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { all: [], default: {}, connected: [] },
				error: undefined,
				response: { status: 200 },
			})),
		},
		pty: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [makePty()],
				error: undefined,
				response: { status: 200 },
			})),
			create: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makePty(),
				error: undefined,
				response: { status: 200 },
			})),
			remove: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			update: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makePty(),
				error: undefined,
				response: { status: 200 },
			})),
		},
		file: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [
					{
						name: "app.ts",
						path: "src/app.ts",
						absolute: "/test/src/app.ts",
						type: "file",
						ignored: false,
					},
				],
				error: undefined,
				response: { status: 200 },
			})),
			read: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { type: "text", content: "hello" },
				error: undefined,
				response: { status: 200 },
			})),
			status: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [
					{
						path: "src/app.ts",
						added: 2,
						removed: 1,
						status: "modified",
					},
				],
				error: undefined,
				response: { status: 200 },
			})),
		},
		find: {
			text: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [
					{
						path: { text: "src/app.ts" },
						lines: { text: "const app = true;" },
						line_number: 1,
						absolute_offset: 0,
						submatches: [{ match: { text: "app" }, start: 6, end: 9 }],
					},
				],
				error: undefined,
				response: { status: 200 },
			})),
			files: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: ["src/app.ts"],
				error: undefined,
				response: { status: 200 },
			})),
			symbols: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [
					{
						name: "main",
						kind: 12,
						location: {
							uri: "file:///test/src/app.ts",
							range: {
								start: { line: 1, character: 0 },
								end: { line: 1, character: 4 },
							},
						},
					},
				],
				error: undefined,
				response: { status: 200 },
			})),
		},
		path: {
			get: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: {
					state: "/state",
					config: "/config",
					worktree: "/test",
					directory: "/test",
				},
				error: undefined,
				response: { status: 200 },
			})),
		},
		vcs: {
			get: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: { branch: "main" },
				error: undefined,
				response: { status: 200 },
			})),
		},
		app: {
			skills: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			agents: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [makeAgent()],
				error: undefined,
				response: { status: 200 },
			})),
		},
		command: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [
					{
						name: "fix",
						description: "Fix issue",
						template: "Fix {{args}}",
					},
				],
				error: undefined,
				response: { status: 200 },
			})),
		},
		project: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [makeProject()],
				error: undefined,
				response: { status: 200 },
			})),
			current: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: makeProject(),
				error: undefined,
				response: { status: 200 },
			})),
		},
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* () {})(),
			})),
		},
		permission: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			respond: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
		},
		question: {
			list: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: [],
				error: undefined,
				response: { status: 200 },
			})),
			reply: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
			reject: vi.fn<() => Promise<SdkResponse>>(async () => ({
				data: true,
				error: undefined,
				response: { status: 200 },
			})),
		},
	};
	// Expose mocks while standing in for the generated client in adapter tests.
	return sdk as typeof sdk & OpencodeClient;
}

describe("OpenCodeAPI", () => {
	it("session.list() delegates to sdk.session.list()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.list();
		expect(sdk.session.list).toHaveBeenCalled();
		expect(result).toEqual([
			expect.objectContaining({ id: "s1", title: "test" }),
		]);
	});

	it("event.subscribe() forwards SSE retry-ownership options to the SDK", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const controller = new AbortController();
		const onSseError = vi.fn();
		await api.event.subscribe({
			signal: controller.signal,
			sseMaxRetryAttempts: 1,
			onSseError,
		});
		// If the wrapper stops forwarding these, the SDK silently retries
		// forever again and transport errors never surface (bd n2x).
		expect(sdk.event.subscribe).toHaveBeenCalledWith(undefined, {
			signal: controller.signal,
			sseMaxRetryAttempts: 1,
			onSseError,
		});
	});

	it("session.get() delegates to sdk.session.get()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.get("s1");
		expect(sdk.session.get).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionID: "s1",
			}),
		);
		expect(result).toEqual(
			expect.objectContaining({ id: "s1", title: "test" }),
		);
	});

	it("session.create() delegates to sdk.session.create()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.create({ title: "new session" });
		expect(sdk.session.create).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "new session",
			}),
		);
		expect(result).toEqual(expect.objectContaining({ id: "s2", title: "new" }));
	});

	it("session.messages() flattens SDK shape and delegates to sdk.session.messages()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.messages("s1");
		expect(sdk.session.messages).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionID: "s1",
			}),
			undefined,
		);
		expect(result).toEqual([]);
	});

	it("permission.list() delegates to sdk.permission.list()", async () => {
		const sdk = makeStubSdk();
		sdk.permission.list.mockResolvedValue({
			data: [{ id: "p1", sessionID: "s1", permission: "bash" }],
			error: undefined,
			response: { status: 200 },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.permission.list();
		expect(sdk.permission.list).toHaveBeenCalled();
		expect(result).toEqual([{ id: "p1", sessionID: "s1", permission: "bash" }]);
	});

	it("question.reply() delegates to sdk.question.reply()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.question.reply("q1", [["yes"]]);
		expect(sdk.question.reply).toHaveBeenCalledWith(
			{ requestID: "q1", answers: [["yes"]] },
			expect.any(Object),
		);
	});

	it("session.prompt() builds parts array from text", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.session.prompt("s1", { text: "hello" });
		expect(sdk.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				parts: [{ type: "text", text: "hello" }],
			}),
		);
	});

	it("permission.reply() maps decision and delegates to SDK", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.permission.reply("s1", "perm1", "once");
		expect(sdk.permission.respond).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionID: "s1",
				permissionID: "perm1",
				response: "once",
			}),
		);
	});

	it("provider.list() delegates to sdk.provider.list()", async () => {
		const sdk = makeStubSdk();
		sdk.provider.list.mockResolvedValue({
			data: {
				all: [makeProvider()],
				default: { anthropic: "claude-sonnet-4" },
				connected: ["anthropic"],
			},
			error: undefined,
			response: { status: 200 },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.provider.list();
		expect(sdk.provider.list).toHaveBeenCalled();
		// SDK returns { all, default, connected }; adapter normalizes to { providers, defaults, connected }
		expect(result).toEqual({
			providers: [
				expect.objectContaining({
					id: "anthropic",
					name: "Anthropic",
					models: [
						expect.objectContaining({
							id: "claude-sonnet-4",
							name: "Claude Sonnet 4",
							variants: { "1m": { limit: { context: 1000000 } } },
						}),
					],
				}),
			],
			defaults: { anthropic: "claude-sonnet-4" },
			connected: ["anthropic"],
		});
	});

	it("provider.list() accepts the current nested model capabilities shape", async () => {
		const sdk = makeStubSdk();
		sdk.provider.list.mockResolvedValue({
			data: {
				all: [makeProviderWithCurrentModelShape()],
				default: { helicone: "claude-opus-4-1-20250805" },
				connected: ["helicone"],
			},
			error: undefined,
			response: { status: 200 },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		const result = await api.provider.list();

		expect(result.providers).toHaveLength(1);
		const provider = result.providers[0];
		if (!provider) throw new Error("expected one provider");
		const models = provider.models ?? [];
		expect(models).toHaveLength(1);
		const model = models[0];
		expect(model).toEqual(
			expect.objectContaining({
				id: "claude-opus-4-1-20250805",
				name: "Anthropic: Claude Opus 4.1 (20250805)",
				limit: { context: 200000, output: 32000 },
				variants: {
					low: { reasoningEffort: "low" },
					medium: { reasoningEffort: "medium" },
					high: { reasoningEffort: "high" },
				},
			}),
		);
	});

	it("provider.list() rejects provider entries missing SDK-required fields", async () => {
		const sdk = makeStubSdk();
		sdk.provider.list.mockResolvedValue({
			data: {
				all: [{ name: "Anthropic", models: {} }],
				default: {},
				connected: [],
			},
			error: undefined,
			response: { status: 200, url: "/provider" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.provider.list()).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/provider",
			context: expect.objectContaining({ label: "provider.list" }),
		});
	});

	it("file.status() decodes SDK file status arrays", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.file.status()).resolves.toEqual([
			{
				path: "src/app.ts",
				added: 2,
				removed: 1,
				status: "modified",
			},
		]);
	});

	it("file.status() rejects non-array status responses", async () => {
		const sdk = makeStubSdk();
		sdk.file.status.mockResolvedValue({
			data: {},
			error: undefined,
			response: { status: 200, url: "/file/status" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.file.status()).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/file/status",
			context: expect.objectContaining({ label: "file.status" }),
		});
	});

	it("session.prompt() rejects malformed non-void promptAsync responses", async () => {
		const sdk = makeStubSdk();
		sdk.session.promptAsync.mockResolvedValue({
			data: { accepted: true },
			error: undefined,
			response: { status: 204, url: "/session/s1/prompt" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(
			api.session.prompt("s1", { text: "hello" }),
		).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/session/s1/prompt",
			context: expect.objectContaining({ label: "session.prompt" }),
		});
	});

	it("session.delete() rejects malformed non-boolean responses", async () => {
		const sdk = makeStubSdk();
		sdk.session.delete.mockResolvedValue({
			data: { deleted: true },
			error: undefined,
			response: { status: 200, url: "/session/s1" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.session.delete("s1")).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/session/s1",
			context: expect.objectContaining({ label: "session.delete" }),
		});
	});

	it("pty.delete() rejects malformed non-boolean responses", async () => {
		const sdk = makeStubSdk();
		sdk.pty.remove.mockResolvedValue({
			data: { deleted: true },
			error: undefined,
			response: { status: 200, url: "/pty/pty1" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.pty.delete("pty1")).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/pty/pty1",
			context: expect.objectContaining({ label: "pty.delete" }),
		});
	});

	it("file.list() accepts the name/type envelope Conduit reads", async () => {
		const sdk = makeStubSdk();
		sdk.file.list.mockResolvedValue({
			data: [{ name: "app.ts", type: "file" }],
			error: undefined,
			response: { status: 200, url: "/file" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.file.list("src")).resolves.toEqual([
			{ name: "app.ts", type: "file" },
		]);
	});

	it("file.read() rejects legacy content-only responses", async () => {
		const sdk = makeStubSdk();
		sdk.file.read.mockResolvedValue({
			data: { content: "hello" },
			error: undefined,
			response: { status: 200, url: "/file/content" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.file.read("src/app.ts")).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/file/content",
			context: expect.objectContaining({ label: "file.read" }),
		});
	});

	it("find.text() rejects malformed match entries", async () => {
		const sdk = makeStubSdk();
		sdk.find.text.mockResolvedValue({
			data: [{ path: "src/app.ts" }],
			error: undefined,
			response: { status: 200, url: "/find" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.find.text("app")).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/find",
			context: expect.objectContaining({ label: "find.text" }),
		});
	});

	it("find.files() rejects non-string file entries", async () => {
		const sdk = makeStubSdk();
		sdk.find.files.mockResolvedValue({
			data: [123],
			error: undefined,
			response: { status: 200, url: "/find/file" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.find.files("app")).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/find/file",
			context: expect.objectContaining({ label: "find.files" }),
		});
	});

	it("app.agents() decodes SDK agents without id and normalizes public agent ids from names", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.agents()).resolves.toEqual([
			{
				id: "build",
				name: "build",
				description: "Build agent",
				mode: "primary",
			},
		]);
	});

	it("app.agents() accepts provider-owned permission shapes", async () => {
		const sdk = makeStubSdk();
		sdk.app.agents.mockResolvedValue({
			data: [
				makeAgent({
					builtIn: undefined,
					native: true,
					permission: [{ permission: "*", action: "allow", pattern: "*" }],
					tools: undefined,
				}),
			],
			error: undefined,
			response: { status: 200, url: "/app/agents" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.agents()).resolves.toEqual([
			{
				id: "build",
				name: "build",
				description: "Build agent",
				mode: "primary",
			},
		]);
	});

	it("app.agents() accepts nullable OpenCode agent config fields", async () => {
		const sdk = makeStubSdk();
		sdk.app.agents.mockResolvedValue({
			data: [
				makeAgent({
					topP: null,
					temperature: null,
					color: null,
					variant: null,
					steps: 12,
				}),
			],
			error: undefined,
			response: { status: 200, url: "/agent" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.agents()).resolves.toEqual([
			{
				id: "build",
				name: "build",
				description: "Build agent",
				mode: "primary",
			},
		]);
	});

	it("app.commands() decodes SDK commands with required templates", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.commands()).resolves.toEqual([
			{
				name: "fix",
				description: "Fix issue",
				template: "Fix {{args}}",
			},
		]);
	});

	it("app.commands() rejects commands missing SDK-required templates", async () => {
		const sdk = makeStubSdk();
		sdk.command.list.mockResolvedValue({
			data: [{ name: "fix" }],
			error: undefined,
			response: { status: 200, url: "/command" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.commands()).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/command",
			context: expect.objectContaining({ label: "app.commands" }),
		});
	});

	it("app.path() decodes SDK path responses and normalizes to cwd", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.path()).resolves.toEqual({ cwd: "/test" });
	});

	it("app.path() rejects legacy cwd-only responses before normalization", async () => {
		const sdk = makeStubSdk();
		sdk.path.get.mockResolvedValue({
			data: { cwd: "/test" },
			error: undefined,
			response: { status: 200, url: "/path" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});

		await expect(api.app.path()).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/path",
			context: expect.objectContaining({ label: "app.path" }),
		});
	});

	it("pty.resize() delegates to sdk.pty.update() with size", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await api.pty.resize("pty1", 24, 80);
		expect(sdk.pty.update).toHaveBeenCalledWith(
			expect.objectContaining({
				ptyID: "pty1",
				size: { rows: 24, cols: 80 },
			}),
		);
	});

	it("app.skills() delegates to sdk.app.skills()", async () => {
		const sdk = makeStubSdk();
		sdk.app.skills.mockResolvedValue({
			data: [{ name: "test-skill" }],
			error: undefined,
			response: { status: 200 },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.app.skills();
		expect(sdk.app.skills).toHaveBeenCalled();
		expect(result).toEqual([{ name: "test-skill" }]);
	});

	it("getBaseUrl() returns configured base URL", () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: { Authorization: "Basic abc" },
		});
		expect(api.getBaseUrl()).toBe("http://localhost:4096");
	});

	it("getAuthHeaders() returns configured auth headers", () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: { Authorization: "Basic abc" },
		});
		expect(api.getAuthHeaders()).toEqual({
			Authorization: "Basic abc",
		});
	});

	it("sdk error result throws OpenCodeApiError", async () => {
		const sdk = makeStubSdk();
		sdk.session.get.mockResolvedValue({
			data: undefined,
			error: { name: "NotFoundError", data: { message: "not found" } },
			response: { status: 404, url: "/session/s999" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await expect(api.session.get("s999")).rejects.toThrow(/API error.*session/);
	});

	it("sdk network error throws OpenCodeConnectionError", async () => {
		const sdk = makeStubSdk();
		sdk.session.list.mockRejectedValue(new TypeError("fetch failed"));
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		await expect(api.session.list()).rejects.toThrow(/fetch failed/);
	});

	it("session.get() rejects malformed SDK data as an OpenCode API error", async () => {
		const sdk = makeStubSdk();
		sdk.session.get.mockResolvedValue({
			data: { id: "s1", title: "missing required fields" },
			error: undefined,
			response: { status: 200, url: "/session/s1" },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const rejected = api.session.get("s1");

		await expect(rejected).rejects.toMatchObject({
			_tag: "OpenCodeApiError",
			endpoint: "/session/s1",
			responseStatus: 200,
			context: expect.objectContaining({
				label: "session.get",
			}),
		});
		await expect(rejected).rejects.toBeInstanceOf(OpenCodeApiError);
	});

	it("session.messagesPage() delegates to sdk.session.messages()", async () => {
		const sdk = makeStubSdk();
		sdk.session.messages.mockResolvedValue({
			data: [
				{
					info: {
						id: "m1",
						sessionID: "s1",
						role: "assistant",
						time: { created: 1, completed: 2 },
						parentID: "m0",
						modelID: "claude-sonnet-4",
						providerID: "anthropic",
						mode: "build",
						path: { cwd: "/test", root: "/test" },
						cost: 0,
						tokens: {
							input: 1,
							output: 2,
							reasoning: 0,
							cache: { read: 0, write: 0 },
						},
					},
					parts: [{ id: "part-1", type: "text", text: "hello" }],
				},
			],
			error: undefined,
			response: { status: 200 },
		});
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.session.messagesPage("s1", {
			limit: 10,
			before: "m5",
		});
		expect(sdk.session.messages).toHaveBeenCalledWith(
			{ sessionID: "s1", limit: 10, before: "m5" },
			expect.any(Object),
		);
		expect(result).toEqual([
			expect.objectContaining({
				id: "m1",
				role: "assistant",
				parts: [{ id: "part-1", type: "text", text: "hello" }],
			}),
		]);
	});

	it("app.projects() delegates to sdk.project.list()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.app.projects();
		expect(sdk.project.list).toHaveBeenCalled();
		expect(result).toEqual([makeProject()]);
	});

	it("app.currentProject() delegates to sdk.project.current()", async () => {
		const sdk = makeStubSdk();
		const api = new OpenCodeAPI({
			sdk,
			baseUrl: "http://localhost:4096",
			authHeaders: {},
		});
		const result = await api.app.currentProject();
		expect(sdk.project.current).toHaveBeenCalled();
		expect(result).toEqual(makeProject());
	});
});
