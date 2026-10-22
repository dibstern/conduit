// Failure modes: wrong account/directory/model/effort, inherited instructions or
// plugins/MCP, tools reaching the model, rejected/empty replies, cancellation
// while prompting or acquiring, and failed cleanup leaking temporary sessions.
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AccountIdSchema,
	type OpenCodeAccount,
} from "../../../src/lib/contracts/account.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import { replayOpenCodeText } from "../../helpers/opencode-text-generation.js";

const roots: string[] = [];
const account = {
	driver: "opencode",
	id: AccountIdSchema.make("titles"),
	name: "Titles",
	usageEligible: false,
} as const;
function setup() {
	const configDir = mkdtempSync("/tmp/opencode-title-replay-");
	roots.push(configDir);
	const replay = replayOpenCodeText();
	const clients: ReturnType<typeof replay.client>[] = [];
	let cwd = "";
	const clientForAccount = vi.fn(
		(selected: OpenCodeAccount, directory?: string) => {
			expect(selected).toEqual(account);
			cwd = directory ?? "";
			expect(readdirSync(cwd)).toEqual([]);
			const client = replay.client(cwd);
			clients.push(client);
			return Effect.succeed(client);
		},
	);
	const instance = new OpenCodeProviderInstance({
		clientForSession: () => Effect.succeed(replay.client("/project")),
		configDir,
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
		configDir,
		clients,
		clientForAccount,
		instance,
		input,
		cwd: () => cwd,
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("OpenCode ephemeral text generation from captured traffic", () => {
	it("replays a synchronous tool-free prompt on the selected account and removes the session and scratch", async () => {
		const run = setup();
		expect(
			await Effect.runPromise(run.instance.generateTextEffect(run.input)),
		).toBe(run.reply);
		expect(run.clientForAccount).toHaveBeenCalledOnce();
		expect(run.cwd()).toContain(join(run.configDir, "text-generation", "run-"));
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
		run.clientForAccount.mockImplementation((_, directory) => {
			const client = run.client(directory ?? "");
			vi.spyOn(client.session, "promptText").mockRejectedValue(
				new Error("transport failed"),
			);
			return Effect.succeed(client);
		});
		const exit = await Effect.runPromiseExit(
			run.instance.generateTextEffect(run.input),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(
			run.requests.filter((request) => request.method === "DELETE"),
		).toHaveLength(1);
		expect(readdirSync(join(run.configDir, "text-generation"))).toEqual([]);
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
		expect(readdirSync(join(run.configDir, "text-generation"))).toEqual([]);
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
		expect(readdirSync(join(run.configDir, "text-generation"))).toEqual([]);
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
		expect(readdirSync(join(run.configDir, "text-generation"))).toEqual([]);
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
		expect(readdirSync(join(run.configDir, "text-generation"))).toEqual([]);
	});

	it("rejects inherited AGENTS.md before creating a temporary session", async () => {
		const run = setup();
		writeFileSync(
			join(run.configDir, "AGENTS.md"),
			"Do not send this to a title model.",
		);
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(run.instance.generateTextEffect(run.input)),
			),
		).toBe(true);
		expect(run.requests.some((request) => request.method === "POST")).toBe(
			false,
		);
		expect(readdirSync(join(run.configDir, "text-generation"))).toEqual([]);
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
