import { describe, expect, it, vi } from "vitest";
import { probeClaudeCapabilities } from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { createTestLogger } from "../../../../src/lib/logger.js";

describe("probeClaudeCapabilities", () => {
	const workspaceRoot = "/tmp/claude-workspace";

	function makeFakeQuery(opts: {
		initResult?: {
			models?: Array<{
				value: string;
				displayName: string;
				supportedEffortLevels?: string[];
			}>;
			account?: { subscriptionType?: string };
			commands?: Array<{
				name: string;
				description?: string;
				argumentHint?: string;
			}>;
			agents?: Array<{
				name: string;
				description?: string;
				model?: string;
			}>;
		};
		throwOnInit?: Error;
	}) {
		return vi.fn().mockReturnValue({
			initializationResult: vi.fn().mockImplementation(async () => {
				if (opts.throwOnInit) throw opts.throwOnInit;
				return opts.initResult ?? { models: [] };
			}),
		});
	}

	it("returns models mapped to conduit ModelInfo on success", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
					{ value: "claude-sonnet-4-7", displayName: "Claude Sonnet 4.7" },
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models).toHaveLength(2);
		expect(result.models[0]).toMatchObject({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			providerId: "claude",
		});
		expect(result.models[0]?.limit).toEqual({
			context: 200_000,
			output: 32_000,
		});
		expect(result.models[1]?.limit).toEqual({
			context: 200_000,
			output: 64_000,
		});
	});

	it("maps SDK supportedEffortLevels into ModelInfo.variants", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{
						value: "claude-opus-4-7",
						displayName: "Claude Opus 4.7",
						supportedEffortLevels: ["low", "medium", "high", "max"],
					},
					{
						value: "claude-haiku-4-7",
						displayName: "Claude Haiku 4.7",
						supportedEffortLevels: [],
					},
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.variants).toEqual({
			low: {},
			medium: {},
			high: {},
			max: {},
		});
		expect(result.models[1]?.variants).toBeUndefined();
	});

	it("omits variants when SDK omits supportedEffortLevels", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-opus-4-7", displayName: "Opus 4.7" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.variants).toBeUndefined();
	});

	it("captures subscriptionType from init.account", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
				account: { subscriptionType: "Max" },
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.subscriptionType).toBe("Max");
	});

	it("captures slash commands from init", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [],
				commands: [
					{
						name: "init",
						description: "Init Claude",
						argumentHint: "[path]",
					},
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.commands).toEqual([
			{
				name: "init",
				description: "Init Claude",
				args: "[path]",
				source: "claude-sdk",
			},
		]);
	});

	it("captures agents from init", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [],
				agents: [
					{ name: "code-reviewer", description: "Reviews code", model: "opus" },
					{ name: "test-runner", description: "Runs tests" },
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.agents).toEqual([
			{
				id: "code-reviewer",
				name: "code-reviewer",
				description: "Reviews code",
				model: "opus",
			},
			{ id: "test-runner", name: "test-runner", description: "Runs tests" },
		]);
	});

	it("returns empty commands and agents when init omits them", async () => {
		const queryFactory = makeFakeQuery({ initResult: { models: [] } });
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.commands).toEqual([]);
		expect(result.agents).toEqual([]);
	});

	it("leaves subscriptionType undefined when account is absent", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.subscriptionType).toBeUndefined();
	});

	it("adds contextWindowOptions for Sonnet family", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" },
					{ value: "claude-opus-4-7", displayName: "Opus 4.7" },
					{ value: "claude-haiku-4-7", displayName: "Haiku 4.7" },
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		const sonnet = result.models.find((m) => m.id === "claude-sonnet-4-7");
		const opus = result.models.find((m) => m.id === "claude-opus-4-7");
		const haiku = result.models.find((m) => m.id === "claude-haiku-4-7");
		expect(sonnet?.contextWindowOptions).toEqual([
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		]);
		expect(opus?.contextWindowOptions).toBeUndefined();
		expect(haiku?.contextWindowOptions).toBeUndefined();
	});

	it("flips 1m default for premium subscriptions", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
				account: { subscriptionType: "max" },
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.contextWindowOptions).toEqual([
			{ value: "200k", label: "200K" },
			{ value: "1m", label: "1M (beta)", isDefault: true },
		]);
	});

	it("keeps 200k default for non-premium subscriptions", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
				account: { subscriptionType: "Pro" },
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.contextWindowOptions?.[0]).toMatchObject({
			value: "200k",
			isDefault: true,
		});
		expect(result.models[0]?.contextWindowOptions?.[1]).toMatchObject({
			value: "1m",
		});
		expect(
			result.models[0]?.contextWindowOptions?.[1]?.isDefault,
		).toBeUndefined();
	});

	it.each([
		"max",
		"maxplan",
		"max5",
		"max20",
		"enterprise",
		"team",
		"MAX",
		"Max Plan",
	])("recognises %s as premium", async (sub) => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
				account: { subscriptionType: sub },
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		const onem = result.models[0]?.contextWindowOptions?.find(
			(o) => o.value === "1m",
		);
		expect(onem?.isDefault).toBe(true);
	});

	it("calls query() with runtime-equivalent workspace discovery options", async () => {
		const queryFactory = makeFakeQuery({ initResult: { models: [] } });
		await probeClaudeCapabilities({ queryFactory, workspaceRoot });
		expect(queryFactory).toHaveBeenCalledTimes(1);
		const callArg = queryFactory.mock.calls[0]?.[0] as {
			options: Record<string, unknown>;
		};
		expect(callArg.options["persistSession"]).toBe(false);
		expect(callArg.options["maxTurns"]).toBe(0);
		expect(callArg.options["cwd"]).toBe(workspaceRoot);
		expect(callArg.options["settingSources"]).toEqual([
			"user",
			"project",
			"local",
		]);
		expect(callArg.options["abortController"]).toBeInstanceOf(AbortController);
	});

	it("aborts the controller in finally on success", async () => {
		let capturedController: AbortController | undefined;
		const queryFactory = vi
			.fn()
			.mockImplementation(
				(arg: { options?: { abortController?: AbortController } }) => {
					capturedController = arg.options?.abortController;
					return {
						initializationResult: async () => ({ models: [] }),
					};
				},
			);
		await probeClaudeCapabilities({ queryFactory, workspaceRoot });
		expect(capturedController?.signal.aborted).toBe(true);
	});

	it("aborts the controller in finally on initializationResult() error", async () => {
		let capturedController: AbortController | undefined;
		const queryFactory = vi
			.fn()
			.mockImplementation(
				(arg: { options?: { abortController?: AbortController } }) => {
					capturedController = arg.options?.abortController;
					return {
						initializationResult: async () => {
							throw new Error("boom");
						},
					};
				},
			);
		await expect(
			probeClaudeCapabilities({ queryFactory, workspaceRoot }),
		).rejects.toThrow("boom");
		expect(capturedController?.signal.aborted).toBe(true);
	});

	it("returns empty models when init returns no models field", async () => {
		const queryFactory = makeFakeQuery({ initResult: {} });
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models).toEqual([]);
	});

	it("infers limits for known Haiku family", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-haiku-4-7", displayName: "Haiku 4.7" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.limit).toEqual({
			context: 200_000,
			output: 8_192,
		});
	});

	it("omits limit when model id matches no known family", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "mystery-model", displayName: "Mystery" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.limit).toBeUndefined();
	});

	describe("initializationResult decode-with-warn (observability)", () => {
		function loggerSpy() {
			const logger = createTestLogger();
			logger.warn = vi.fn();
			return logger;
		}

		it("does not warn when init matches the consumed SDK shape", async () => {
			const logger = loggerSpy();
			const queryFactory = makeFakeQuery({
				initResult: {
					models: [{ value: "claude-opus-4-8", displayName: "Opus 4.8" }],
					commands: [{ name: "init", description: "d", argumentHint: "h" }],
					agents: [{ name: "reviewer", description: "reviews" }],
					account: { subscriptionType: "Max" },
				},
			});
			const result = await probeClaudeCapabilities({
				queryFactory,
				workspaceRoot,
				logger,
			});
			expect(result.models).toHaveLength(1);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it("warns but still returns catalogs when init drifts — never fail-closes", async () => {
			const logger = loggerSpy();
			// commands/agents/account absent → drift from the SDK's required shape
			const queryFactory = makeFakeQuery({ initResult: { models: [] } });
			const result = await probeClaudeCapabilities({
				queryFactory,
				workspaceRoot,
				logger,
			});
			expect(result.commands).toEqual([]);
			expect(result.agents).toEqual([]);
			expect(logger.warn).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain(
				"failed subset decode",
			);
		});
	});
});
