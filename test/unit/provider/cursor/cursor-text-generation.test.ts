// Failure modes: wrong account/model/effort, tools or project context leaking,
// transcript writes escaping the scratch root, partial text accepted as success,
// leaked agents on rejection/interruption, acquisition racing cleanup, and
// concurrent calls sharing the process-global Cursor data directory, and title
// generation borrowing the shared login or another account's credential.
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Fiber, Result } from "effect";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { WsRpcError } from "../../../../src/lib/contracts/ws-rpc.js";
import type { CursorAccountResources } from "../../../../src/lib/provider/cursor/cursor-account-resources.js";
import { makeCursorAuth } from "../../../../src/lib/provider/cursor/cursor-auth.js";
import { resolveCursorCredential } from "../../../../src/lib/provider/cursor/cursor-credential.js";
import {
	cursorModelInfo,
	makeCursorRunnerDriver,
} from "../../../../src/lib/provider/cursor/cursor-runner-driver.js";
import type {
	CursorAgent,
	CursorSdkPort,
} from "../../../../src/lib/provider/cursor/sdk-port.js";
import { createTraceCursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-trace-player.js";

const trace = resolve("test/fixtures/cursor-sdk-traces/title-generation.jsonl");
const captured = readFileSync(trace, "utf8")
	.trim()
	.split("\n")
	.map(
		(line) => JSON.parse(line) as { kind?: string; data?: { result?: string } },
	);
const reply = captured.find(({ kind }) => kind === "wait.result")?.data?.result;
const account = {
	driver: "cursor" as const,
	id: AccountIdSchema.make("cursor-title"),
	name: "Cursor titles",
	usageEligible: false,
	env: { CURSOR_API_KEY: "[REDACTED:environment]" },
};
const input = {
	account,
	model: { providerId: "cursor", modelId: "composer-2.5" },
	effort: "",
	instructions: "Return only a short session title. Do not use tools.",
	prompt: "Fix login redirect loop",
};
const roots: string[] = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "cursor-title-replay-"));
	roots.push(root);
	const port = createTraceCursorSdkPort(trace);
	return {
		root,
		port,
		driver: makeCursorRunnerDriver(process.cwd(), port, undefined, root),
	};
}
function observe(
	port: CursorSdkPort,
	change?: (agent: CursorAgent) => CursorAgent,
) {
	const create = port.createAgent.bind(port);
	const sends: MockInstance<CursorAgent["send"]>[] = [];
	const closes: MockInstance<CursorAgent["close"]>[] = [];
	vi.spyOn(port, "createAgent").mockImplementation(async (...args) => {
		expect(readdirSync(args[0].cwd)).toEqual([]);
		const agent = change
			? change(await create(...args))
			: await create(...args);
		sends.push(vi.spyOn(agent, "send"));
		closes.push(vi.spyOn(agent, "close"));
		return agent;
	});
	const remove = vi.spyOn(port, "deleteAgent");
	return { sends, closes, remove };
}
function expectClean(root: string, port: CursorSdkPort) {
	expect(readdirSync(join(root, "text-generation"))).toEqual([]);
	expect(port.deleteAgent).toHaveBeenCalledOnce();
}
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("Cursor ephemeral text generation with captured SDK traffic", () => {
	for (const [loggedIn, ambient] of [
		[true, false],
		[false, false],
		[true, true],
		[false, true],
	]) {
		effectIt.live(
			`${
				loggedIn
					? "uses each requested account's scoped credential for its catalog and title"
					: "fails auth_required when the requested scoped store is empty despite other logins"
			}${ambient ? " with an ambient daemon key" : ""}`,
			() =>
				Effect.gen(function* () {
					vi.stubEnv("NODE_ENV", "test");
					vi.stubEnv("CURSOR_API_KEY", ambient ? "[REDACTED:environment]" : "");
					const { root, port: shared } = setup();
					vi.spyOn(shared, "storedCredential").mockResolvedValue({
						apiKey: "[REDACTED:shared]",
						backendUrl: "https://api2.cursor.sh",
						createdAtMs: 0,
					});
					vi.spyOn(shared, "createAgent");
					vi.spyOn(shared, "modelsList");
					const ports = new Map<string, CursorSdkPort>();
					for (const id of [account.id, "cursor-other"]) {
						const sdk = createTraceCursorSdkPort(trace);
						vi.spyOn(sdk, "storedCredential").mockResolvedValue(
							loggedIn || id !== account.id
								? {
										apiKey: `[REDACTED:${id}]`,
										backendUrl: "https://api2.cursor.sh",
										createdAtMs: 0,
									}
								: undefined,
						);
						observe(sdk);
						vi.spyOn(sdk, "modelsList");
						ports.set(id, sdk);
					}
					const auth = yield* makeCursorAuth(() => Effect.void, {
						port: shared,
						env: {},
					});
					const resources: CursorAccountResources["Service"] = {
						use: (id, work) => {
							const sdk = ports.get(id);
							if (!sdk) throw new Error(`Unexpected account ${id}`);
							return work({
								sdk,
								auth,
								credential: Effect.tryPromise({
									try: () => resolveCursorCredential(sdk, {}),
									catch: () =>
										new WsRpcError({ message: "Credential lookup failed" }),
								}),
							});
						},
					};
					const driver = makeCursorRunnerDriver(
						process.cwd(),
						shared,
						undefined,
						root,
						resources,
					);
					for (const id of loggedIn ? ports.keys() : [account.id]) {
						const sdk = ports.get(id);
						if (!sdk) throw new Error(`Missing account ${id}`);
						const result = yield* Effect.result(
							driver.generateTextEffect({
								...input,
								account: { ...account, id: AccountIdSchema.make(id), env: {} },
							}),
						);
						if (loggedIn) {
							expect(Result.getOrThrow(result)).toBe(reply);
							expect(sdk.modelsList).toHaveBeenCalledWith(
								expect.objectContaining({ apiKey: `[REDACTED:${id}]` }),
							);
							expect(sdk.createAgent).toHaveBeenCalledWith(
								expect.anything(),
								expect.objectContaining({ apiKey: `[REDACTED:${id}]` }),
								expect.anything(),
							);
							expectClean(root, sdk);
						} else {
							expect(Result.isFailure(result)).toBe(true);
							if (Result.isFailure(result))
								expect(result.failure).toMatchObject({ code: "auth_required" });
							for (const other of ports.values()) {
								expect(other.modelsList).not.toHaveBeenCalled();
								expect(other.createAgent).not.toHaveBeenCalled();
							}
						}
					}
					expect(shared.storedCredential).not.toHaveBeenCalled();
					expect(shared.modelsList).not.toHaveBeenCalled();
					expect(shared.createAgent).not.toHaveBeenCalled();
				}),
		);
	}

	it("returns the captured terminal text with no tools/settings and removes all state", async () => {
		const { root, port, driver } = setup();
		const before = process.env["CURSOR_DATA_DIR"];
		const observed = observe(port);
		expect(await Effect.runPromise(driver.generateTextEffect(input))).toBe(
			reply,
		);
		const options = vi.mocked(port.createAgent).mock.calls[0]?.[0];
		expect(options).toMatchObject({
			tools: [],
			customToolNames: [],
			settingSources: [],
			dirs: [],
			sandboxOptions: { enabled: true },
			autoReview: false,
		});
		expect(options?.cwd.startsWith(join(root, "text-generation"))).toBe(true);
		expect(existsSync(options?.cwd ?? "")).toBe(false);
		expect(observed.sends[0]?.mock.calls[0]).toEqual([
			`${input.instructions}\n\n${input.prompt}`,
			{
				model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
				mode: "agent",
			},
			expect.any(Function),
		]);
		expect(observed.closes[0]).toHaveBeenCalledOnce();
		expect(process.env["CURSOR_DATA_DIR"]).toBe(before);
		expectClean(root, port);
	});

	it("uses the cheapest captured parameters for empty effort, even when the default is expensive", async () => {
		const { root, port, driver } = setup();
		const observed = observe(port);
		await Effect.runPromise(
			driver.generateTextEffect({
				...input,
				model: { providerId: "cursor", modelId: "gpt-5.4" },
			}),
		);
		expect(observed.sends[0]?.mock.calls[0]?.[1].model).toEqual({
			id: "gpt-5.4",
			params: [
				{ id: "context", value: "272k" },
				{ id: "reasoning", value: "none" },
				{ id: "fast", value: "false" },
			],
		});
		expectClean(root, port);
	});

	it("preserves an explicitly selected captured variant", async () => {
		const { root, port, driver } = setup();
		const observed = observe(port);
		const models = await port.modelsList({
			source: "environment",
			apiKey: "[REDACTED]",
			fingerprint: "replay",
		});
		const model = models.find(({ id }) => id === "gpt-5.4");
		if (!model) throw new Error("Missing captured GPT model");
		const info = cursorModelInfo(model);
		const selected = info.parameters?.combinations.find(
			({ values }) =>
				values["reasoning"] === "high" && values["fast"] === "false",
		);
		if (!selected) throw new Error("Missing captured high effort variant");
		await Effect.runPromise(
			driver.generateTextEffect({
				...input,
				model: { providerId: "cursor", modelId: model.id },
				effort: selected.variant,
			}),
		);
		expect(observed.sends[0]?.mock.calls[0]?.[1].model.params).toEqual(
			info.variants?.[selected.variant]?.["params"],
		);
		expectClean(root, port);
	});

	for (const stage of ["send", "wait", "close"] as const) {
		it(`cleans up after a ${stage} rejection`, async () => {
			const { root, port, driver } = setup();
			observe(port, (agent) => {
				if (stage === "close")
					return {
						...agent,
						close: async () => {
							await agent.close();
							throw new Error("injected close failure");
						},
					};
				return {
					...agent,
					send: async (...args) => {
						if (stage === "send") throw new Error("injected send failure");
						const run = await agent.send(...args);
						return {
							...run,
							wait: async () => {
								await run.wait();
								throw new Error("injected wait failure");
							},
						};
					},
				};
			});
			const exit = await Effect.runPromiseExit(
				driver.generateTextEffect(input),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expectClean(root, port);
		});
	}

	it("cancels an interrupted run and removes its agent and scratch state", async () => {
		const { root, port, driver } = setup();
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const cancel = vi.fn(async () => {});
		observe(port, (agent) => ({
			...agent,
			send: async (...args) => {
				const run = await agent.send(...args);
				return {
					...run,
					wait: () => {
						started();
						return new Promise<never>(() => {});
					},
					cancel,
				};
			},
		}));
		const fiber = Effect.runFork(driver.generateTextEffect(input));
		await running;
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(cancel).toHaveBeenCalledOnce();
		expectClean(root, port);
	});

	it("registers cleanup before interruption can observe a late-created agent", async () => {
		const { root, port, driver } = setup();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let created: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			created = resolve;
		});
		const create = port.createAgent.bind(port);
		const close = vi.fn(async () => {});
		vi.spyOn(port, "createAgent").mockImplementation(async (...args) => {
			const agent = await create(...args);
			created();
			await gate;
			return {
				...agent,
				close: async () => {
					await agent.close();
					await close();
				},
			};
		});
		vi.spyOn(port, "deleteAgent");
		const fiber = Effect.runFork(driver.generateTextEffect(input));
		await ready;
		const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
		release();
		await interrupted;
		expect(close).toHaveBeenCalledOnce();
		expectClean(root, port);
	});

	it("serializes different drivers' scratch data directories and restores the environment", async () => {
		const first = setup();
		const second = setup();
		vi.stubEnv("CURSOR_DATA_DIR", "/tmp/prior-cursor-title-data");
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let firstDir: string | undefined;
		observe(first.port, (agent) => ({
			...agent,
			send: async (...args) => {
				firstDir = process.env["CURSOR_DATA_DIR"];
				const run = await agent.send(...args);
				return {
					...run,
					wait: async () => {
						started();
						await gate;
						expect(process.env["CURSOR_DATA_DIR"]).toBe(firstDir);
						return run.wait();
					},
				};
			},
		}));
		observe(second.port);
		const a = Effect.runPromise(first.driver.generateTextEffect(input));
		await running;
		const b = Effect.runPromise(second.driver.generateTextEffect(input));
		expect(second.port.createAgent).not.toHaveBeenCalled();
		release();
		expect(await Promise.all([a, b])).toEqual([reply, reply]);
		expect(process.env["CURSOR_DATA_DIR"]).toBe("/tmp/prior-cursor-title-data");
		expectClean(first.root, first.port);
		expectClean(second.root, second.port);
	});

	it.each([
		"model",
		"effort",
		"account",
		"auth",
	] as const)("rejects an unavailable %s without creating an agent", async (kind) => {
		const { port, driver } = setup();
		observe(port);
		const request = {
			...input,
			...(kind === "model"
				? { model: { providerId: "cursor", modelId: "missing" } }
				: {}),
			...(kind === "effort" ? { effort: "missing" } : {}),
			...(kind === "account"
				? {
						account: {
							...account,
							driver: "opencode" as const,
							usageEligible: false as const,
						},
					}
				: {}),
			...(kind === "auth" ? { account: { ...account, env: {} } } : {}),
		};
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(driver.generateTextEffect(request)),
			),
		).toBe(true);
		expect(port.createAgent).not.toHaveBeenCalled();
	});
});
