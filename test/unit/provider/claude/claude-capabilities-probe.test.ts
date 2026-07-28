import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../../../src/lib/logger.js";
import { probeClaudeCapabilities } from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";

describe("probeClaudeCapabilities", () => {
	const workspaceRoot = "/tmp/claude-workspace";

	function makeFakeQuery(opts: {
		initResult?: {
			models?: Array<{
				value: string;
				displayName: string;
				resolvedModel?: string;
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

	it("preserves resolvedModel when present and preserves its absence", async () => {
		const logger = createTestLogger();
		logger.warn = vi.fn();
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{
						value: "sonnet",
						displayName: "Sonnet",
						resolvedModel: "claude-sonnet-5",
					},
					{ value: "legacy", displayName: "Legacy" },
				],
				commands: [],
				agents: [],
				account: {},
			},
		});

		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
			logger,
		});

		expect(result.models[0]?.resolvedModel).toBe("claude-sonnet-5");
		expect(result.models[1]).not.toHaveProperty("resolvedModel");
		// This fixture's "legacy" id legitimately has no context-window row, so
		// scope the assertion to the drift this test is about.
		expect(logger.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("subset decode"),
		);
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

	it("mirrors the built-in Claude context-window options per model slug", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "claude-fable-5", displayName: "Fable 5" },
					{ value: "claude-opus-5", displayName: "Opus 5" },
					{ value: "claude-opus-4-8", displayName: "Opus 4.8" },
					{ value: "claude-opus-4-7", displayName: "Opus 4.7" },
					{ value: "claude-opus-4-6", displayName: "Opus 4.6" },
					{ value: "claude-opus-4-5", displayName: "Opus 4.5" },
					{ value: "claude-sonnet-5", displayName: "Sonnet 5" },
					{ value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
					{ value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		const optionsFor = (modelId: string) =>
			result.models.find((model) => model.id === modelId)?.contextWindowOptions;
		const default1mOptions = [
			{ value: "200k", label: "200k" },
			{ value: "1m", label: "1M", isDefault: true },
		];
		const default200kOptions = [
			{ value: "200k", label: "200k", isDefault: true },
			{ value: "1m", label: "1M" },
		];

		expect(optionsFor("claude-fable-5")).toEqual(default1mOptions);
		expect(optionsFor("claude-opus-5")).toEqual(default1mOptions);
		expect(optionsFor("claude-opus-4-6")).toEqual(default1mOptions);
		expect(optionsFor("claude-sonnet-5")).toEqual(default200kOptions);
		expect(optionsFor("claude-sonnet-4-6")).toEqual(default200kOptions);
		expect(optionsFor("claude-opus-4-8")).toBeUndefined();
		expect(optionsFor("claude-opus-4-7")).toBeUndefined();
		expect(optionsFor("claude-opus-4-5")).toBeUndefined();
		expect(optionsFor("claude-haiku-4-5")).toBeUndefined();
	});

	it("maps a suffixed catalog value to its context-window options without changing its id", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "opus[1m]", displayName: "Opus (1M context)" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]).toMatchObject({
			id: "opus[1m]",
			contextWindowOptions: [
				{ value: "200k", label: "200k" },
				{ value: "1m", label: "1M", isDefault: true },
			],
		});
	});

	it("drops the context-window qualifier from the name when a selector owns it", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "opus[1m]", displayName: "Opus (1M context)" },
					{ value: "sonnet", displayName: "Sonnet (200k context)" },
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		// The rail must not claim a window the selector beside it contradicts.
		expect(result.models[0]?.name).toBe("Opus");
		expect(result.models[1]?.name).toBe("Sonnet");
	});

	it("keeps a name's qualifier when no selector renders for that model", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "haiku", displayName: "Haiku (200k context)" },
					{ value: "default", displayName: "Default (recommended)" },
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		// Without a control owning the fact, the parenthetical is the user's
		// only signal — stripping it would delete information, not de-duplicate.
		expect(result.models[0]?.name).toBe("Haiku (200k context)");
		expect(result.models[1]?.name).toBe("Default (recommended)");
	});

	it("never renders an empty name if the qualifier is the whole label", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "opus[1m]", displayName: "(1M context)" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.name).toBe("(1M context)");
	});

	it("reads the context limit off the model the SDK actually resolved", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{
						value: "opus[1m]",
						displayName: "Opus (1M context)",
						resolvedModel: "claude-opus-5[1m]",
					},
					{
						// The CLI drops the suffix for models that do not take it,
						// so this entry is NOT running a 1M window despite asking.
						value: "claude-fable-5[1m]",
						displayName: "Fable 5 (1M context)",
						resolvedModel: "claude-fable-5",
					},
					{
						value: "sonnet",
						displayName: "Sonnet",
						resolvedModel: "claude-sonnet-5",
					},
				],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.limit?.context).toBe(1_000_000);
		expect(result.models[1]?.limit?.context).toBe(200_000);
		expect(result.models[2]?.limit?.context).toBe(200_000);
	});

	it("falls back to the requested id for the context limit when resolvedModel is absent", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "opus[1m]", displayName: "Opus (1M context)" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.limit?.context).toBe(1_000_000);
	});

	it("warns when the catalog advertises a model the context-window table has no row for", async () => {
		const logger = createTestLogger();
		logger.warn = vi.fn();
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "claude-opus-9", displayName: "Opus 9" },
					// An explicitly-undefined row is a decision, not a gap.
					{ value: "haiku", displayName: "Haiku" },
				],
			},
		});
		await probeClaudeCapabilities({ queryFactory, workspaceRoot, logger });
		const rowWarnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
			.map(([message]) => String(message))
			.filter((message) => message.includes("context-window row"));
		expect(rowWarnings).toHaveLength(1);
		expect(rowWarnings[0]).toContain("claude-opus-9");
	});

	it("does not expose context-window options for the default catalog value", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "default", displayName: "Default (recommended)" }],
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.contextWindowOptions).toBeUndefined();
	});

	it("flips 1m default for premium subscriptions", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }],
				account: { subscriptionType: "max" },
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.contextWindowOptions).toEqual([
			{ value: "200k", label: "200k" },
			{ value: "1m", label: "1M", isDefault: true },
		]);
	});

	it("keeps 200k default for non-premium subscriptions", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }],
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

	it("keeps 200k default for Claude Pro", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }],
				account: { subscriptionType: "Claude Pro" },
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
		"Claude Max",
		"Claude Enterprise",
	])("recognises %s as premium", async (sub) => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }],
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

	it("exposes 1M-default options for the live Claude Max opus catalog entry", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "opus[1m]", displayName: "Opus (1M context)" }],
				account: { subscriptionType: "Claude Max" },
			},
		});
		const result = await probeClaudeCapabilities({
			queryFactory,
			workspaceRoot,
		});
		expect(result.models[0]?.contextWindowOptions).toEqual([
			{ value: "200k", label: "200k" },
			{ value: "1m", label: "1M", isDefault: true },
		]);
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
