// Failure modes: wrong account/directory/model/effort, inherited instructions or
// plugins/MCP, tools reaching the model, rejected/empty replies, cancellation
// while prompting or acquiring, and failed cleanup leaking temporary sessions.
import * as childProcess from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	type OpenCodeAccount,
} from "../../../src/lib/contracts/account.js";
import * as managedProcess from "../../../src/lib/instance/managed-opencode-process.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import { replayOpenCodeText } from "../../helpers/opencode-text-generation.js";

const account = {
	driver: "opencode",
	id: AccountIdSchema.make("titles"),
	name: "Titles",
	usageEligible: false,
} as const;
function setup() {
	const replay = replayOpenCodeText();
	const spawn = vi
		.spyOn(managedProcess, "spawnManagedOpenCode")
		.mockResolvedValue({
			pid: 123456,
			process: new childProcess.ChildProcess(),
			processIdentity: {
				supervisorPid: 123455,
				controlPort: 12344,
				token: "test-token",
			},
		});
	vi.spyOn(managedProcess, "commitManagedOpenCodeSpawn").mockResolvedValue();
	vi.spyOn(managedProcess, "probeOpenCodeHealth").mockResolvedValue({});
	vi.spyOn(managedProcess, "stopManagedOpenCode").mockResolvedValue(true);
	vi.spyOn(managedProcess, "availableOpenCodePort").mockResolvedValue(12345);
	vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
		replay.transport.fetch(input, init),
	);
	const clientForAccount = vi.fn(
		(selected: OpenCodeAccount, directory?: string) => {
			expect(selected).toEqual(account);
			return Effect.succeed(replay.client(directory ?? ""));
		},
	);
	const instance = new OpenCodeProviderInstance({
		client: replay.client("/project"),
		clientForAccount,
	});
	const input = {
		account,
		model: replay.model,
		effort: "",
		instructions: replay.instructions,
		prompt: replay.prompt,
	};
	return {
		...replay,
		spawn,
		clientForAccount,
		instance,
		input,
		cwd: () => String(spawn.mock.calls[0]?.[4]?.cwd ?? ""),
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("OpenCode ephemeral text generation from captured traffic", () => {
	it("replays a synchronous tool-free prompt on the selected account and removes the session and scratch", async () => {
		const run = setup();
		expect(
			await Effect.runPromise(run.instance.generateTextEffect(run.input)),
		).toBe(run.reply);
		expect(run.clientForAccount).toHaveBeenCalledOnce();
		expect(run.cwd()).toContain(join(tmpdir(), "conduit-title-"));
		expect(existsSync(run.cwd())).toBe(false);
		const prompt = run.requests.find(
			(request) =>
				request.method === "POST" &&
				new URL(request.url).pathname.endsWith("/message"),
		);
		expect(await prompt?.json()).toMatchObject({
			model: { providerID: run.model.providerId, modelID: run.model.modelId },
			tools: { "*": false },
			variant: "",
			system: run.instructions,
		});
		expect(
			run.requests.filter((request) => request.method === "DELETE"),
		).toHaveLength(1);
		expect(
			run.requests.some((request) =>
				new URL(request.url).pathname.endsWith("/abort"),
			),
		).toBe(true);
	});

	it("deletes the session when the prompt transport fails", async () => {
		const run = setup();
		const replayFetch = run.transport.fetch;
		vi.spyOn(run.transport, "fetch").mockImplementation((input, init) => {
			if (new URL(new Request(input, init).url).pathname.endsWith("/message"))
				return Promise.reject(new Error("transport failed"));
			return replayFetch(input, init);
		});
		const exit = await Effect.runPromiseExit(
			run.instance.generateTextEffect(run.input),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(
			run.requests.filter((request) => request.method === "DELETE"),
		).toHaveLength(1);
		expect(existsSync(run.cwd())).toBe(false);
	});

	it("cleans up its reserved id even when the create response is lost", async () => {
		const run = setup();
		const replayFetch = run.transport.fetch;
		vi.spyOn(run.transport, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(
				input instanceof Request ? input.clone() : input,
				init,
			);
			const response = await replayFetch(input, init);
			if (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/session"
			)
				throw new Error("create response lost");
			return response;
		});
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(run.instance.generateTextEffect(run.input)),
			),
		).toBe(true);
		const created = run.requests.find(
			(request) => new URL(request.url).pathname === "/api/session",
		);
		const id = ((await created?.json()) as { id: string }).id;
		expect(
			run.requests.some(
				(request) =>
					request.method === "DELETE" &&
					new URL(request.url).pathname === `/session/${id}`,
			),
		).toBe(true);
		expect(existsSync(run.cwd())).toBe(false);
	});

	it("waits for in-flight creation before interrupt cleanup", async () => {
		const run = setup();
		let started!: () => void;
		let finish!: () => void;
		const creating = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const replayFetch = run.transport.fetch;
		vi.spyOn(run.transport, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(
				input instanceof Request ? input.clone() : input,
				init,
			);
			const response = await replayFetch(input, init);
			if (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/session"
			) {
				started();
				await gate;
			}
			return response;
		});
		const fiber = Effect.runFork(run.instance.generateTextEffect(run.input));
		await creating;
		const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const deletedBeforeCreateSettled = run.requests.filter(
			(request) => request.method === "DELETE",
		).length;
		finish();
		await interrupted;
		expect(deletedBeforeCreateSettled).toBe(0);
		expect(
			run.requests.filter((request) => request.method === "DELETE"),
		).toHaveLength(1);
		expect(existsSync(run.cwd())).toBe(false);
	});

	it("still deletes when abort fails, and reports cleanup failure", async () => {
		const run = setup();
		const replayFetch = run.transport.fetch;
		vi.spyOn(run.transport, "fetch").mockImplementation((input, init) => {
			if (
				new URL(
					new Request(input instanceof Request ? input.clone() : input, init)
						.url,
				).pathname.endsWith("/abort")
			)
				return Promise.reject(new Error("abort unavailable"));
			return replayFetch(input, init);
		});
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(run.instance.generateTextEffect(run.input)),
			),
		).toBe(true);
		expect(
			run.requests.filter((request) => request.method === "DELETE"),
		).toHaveLength(1);
		expect(existsSync(run.cwd())).toBe(false);
	});

	it("interrupts an in-flight prompt and still aborts and deletes the session", async () => {
		const run = setup();
		let started!: () => void;
		const prompting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let signal: AbortSignal | undefined;
		const replayFetch = run.transport.fetch;
		vi.spyOn(run.transport, "fetch").mockImplementation((input, init) => {
			const request = new Request(
				input instanceof Request ? input.clone() : input,
				init,
			);
			if (
				request.method !== "POST" ||
				!new URL(request.url).pathname.endsWith("/message")
			)
				return replayFetch(input, init);
			signal = request.signal;
			started();
			return new Promise((_, reject) =>
				signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				}),
			);
		});
		const fiber = Effect.runFork(run.instance.generateTextEffect(run.input));
		await prompting;
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(signal?.aborted).toBe(true);
		expect(
			run.requests.filter((request) => request.method === "DELETE"),
		).toHaveLength(1);
		expect(existsSync(run.cwd())).toBe(false);
	});

	it("spawns with an empty config and cwd, replacing inherited config with provider selection only", async () => {
		const run = setup();
		vi.stubEnv("OPENCODE_CONFIG", "/hostile/opencode.json");
		vi.stubEnv("OPENCODE_CONFIG_DIR", "/hostile/config");
		vi.stubEnv("OPENCODE_CONFIG_CONTENT", '{"plugin":["worktree-plugin"]}');
		vi.stubEnv("OPENCODE_AUTH_CONTENT", '{"test":"stale-auth"}');
		const config = {
			provider: { custom: { options: { apiKey: "test-secret" } } },
			enabled_providers: ["custom"],
			disabled_providers: ["other"],
			plugin: ["worktree-plugin"],
			instructions: ["AGENTS.md"],
			agent: { injected: {} },
			mcp: { injected: {} },
		};
		run.clientForAccount.mockImplementation(() => {
			const client = run.client("");
			vi.spyOn(client.config, "get").mockResolvedValue(config);
			return Effect.succeed(client);
		});
		run.spawn.mockImplementationOnce(
			async (_id, _port, env, _root, options) => {
				expect(readdirSync(String(env["XDG_CONFIG_HOME"]))).toEqual([]);
				expect(readdirSync(String(options?.cwd))).toEqual([]);
				expect(env).not.toHaveProperty("OPENCODE_CONFIG");
				expect(env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
				expect(env).not.toHaveProperty("OPENCODE_AUTH_CONTENT");
				expect(options?.inheritEnv).toBe(false);
				expect(env["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
				expect(env["OPENCODE_DISABLE_CLAUDE_CODE"]).toBe("1");
				expect(env["OPENCODE_DISABLE_EXTERNAL_SKILLS"]).toBe("1");
				expect(env["OPENCODE_PURE"]).toBe("1");
				expect(JSON.parse(String(env["OPENCODE_CONFIG_CONTENT"]))).toEqual({
					provider: config.provider,
					enabled_providers: config.enabled_providers,
					disabled_providers: config.disabled_providers,
				});
				return {
					pid: 123456,
					process: new childProcess.ChildProcess(),
					processIdentity: {
						supervisorPid: 123455,
						controlPort: 12344,
						token: "test-token",
					},
				};
			},
		);
		await Effect.runPromise(run.instance.generateTextEffect(run.input));
		expect(run.spawn).toHaveBeenCalledOnce();
		expect(existsSync(run.cwd())).toBe(false);
	});

	it("rejects the wrong harness before resolving a client", async () => {
		const run = setup();
		const exit = await Effect.runPromiseExit(
			run.instance.generateTextEffect({
				...run.input,
				account: { ...account, driver: "cursor" },
			}),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(run.clientForAccount).not.toHaveBeenCalled();
	});
});
