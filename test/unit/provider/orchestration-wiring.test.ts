// test/unit/provider/orchestration-wiring.test.ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	AccountDirectory,
	AccountDirectoryStateLive,
	makeAccountDirectory,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	OpenCodeDriver,
	OpenCodeProviderInstance,
} from "../../../src/lib/provider/opencode-provider-instance.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	getOrchestrationLayer,
	type OrchestrationRuntimeLayerOptions,
} from "../../../src/lib/provider/orchestration-wiring.js";
import * as shellEnvironment from "../../../src/lib/provider/project-shell-env.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { makeOpenCodeInstancesStub } from "../../helpers/mock-factories.js";
import { makeTestOrchestrationRuntimeLayer as makeOrchestrationRuntimeLayer } from "../../helpers/provider-adapters.js";

let configDir: string;
const Resolver = shellEnvironment.ProjectShellEnvResolver;
const resolvers: shellEnvironment.ProjectShellEnvResolver[] = [];
beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "82tn9-wiring-"));
	// The fallback still owns a real cache and watchers, but captures no user shell.
	vi.spyOn(shellEnvironment, "ProjectShellEnvResolver").mockImplementation(
		class extends Resolver {
			constructor() {
				super({ env: { HOME: configDir, PATH: "" }, shell: "/usr/bin/false" });
				resolvers.push(this);
			}
		},
	);
	onTestFinished(() => {
		for (const resolver of resolvers.splice(0)) resolver.close();
		vi.restoreAllMocks();
		rmSync(configDir, { recursive: true, force: true });
	});
});

function orchestrationDeps(
	persistence: ReturnType<typeof makePersistenceEffectLayer>,
	client: OpenCodeAPI,
) {
	return Layer.mergeAll(
		Layer.succeed(AccountDirectory)(
			makeAccountDirectory(
				Effect.succeed(
					accountsStateFromInstances(
						[
							{ id: "opencode", name: "OpenCode", driver: "opencode" },
							{ id: "claude", name: "Claude", driver: "claude" },
						],
						configuredClaudeConfigDir("/tmp/g4zp-test-claude"),
					),
				),
			),
		),
		Layer.succeed(OpenCodeAPITag)(client),
		Layer.succeed(SessionWorkspaceTag)({
			get: () => Effect.die("Unexpected workspace lookup"),
			withLaunch: (effect) => effect,
			preview: () => Effect.die("Unexpected workspace preview"),
			renameBranch: () => Effect.die("Unexpected workspace rename"),
			move: () => Effect.die("Unexpected workspace move"),
			inherit: () => Effect.die("Unexpected workspace inheritance"),
			resolve: () => Effect.die("Unexpected workspace resolution"),
			record: () => Effect.die("Unexpected workspace recording"),
			claudeWorktreeState: () =>
				Effect.die("Unexpected Claude workspace lookup"),
		}),
		persistence,
		Layer.succeed(OpenCodeInstancesTag)(
			makeOpenCodeInstancesStub({ opencode: client }),
		),
		makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
	);
}

function makeStubClient(): OpenCodeAPI {
	return {
		session: {
			get: vi.fn(async () => ({ permission: [] })),
			update: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			prompt: vi.fn(async () => {}),
		},
		permission: { reply: vi.fn(async () => {}), list: vi.fn(async () => []) },
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
		provider: {
			list: vi.fn(async () => ({
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						models: [
							{
								id: "claude-sonnet",
								name: "Claude Sonnet",
								limit: { context: 200000, output: 8192 },
							},
						],
					},
				],
				defaults: {},
				connected: ["anthropic"],
			})),
		},
		app: {
			agents: vi.fn(async () => []),
			commands: vi.fn(async () => []),
			skills: vi.fn(async () => []),
		},
	} as unknown as OpenCodeAPI;
}

function seedProjectedSessionBinding(sessionId: string, providerId: string) {
	const now = 1_735_689_600_000;
	return Effect.flatMap(SqlClient.SqlClient, (sql) =>
		Effect.all([
			sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (${sessionId}, ${providerId}, ${"Persisted session"}, ${"idle"}, ${now}, ${now})`,
			sql`INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (${`${sessionId}:initial`}, ${sessionId}, ${providerId}, 'active', ${now})`,
		]),
	);
}

/**
 * Mirrors relay-stack: the same persistence layer reference is provided to
 * orchestration and merged into the outer runtime. An in-memory SQLite
 * database is private to its connection, so a row seeded through the outer
 * SqlClient is visible to orchestration only when both share one connection.
 */
function makeSharedPersistenceRuntime(
	outerPersistence: (
		persistence: ReturnType<typeof makePersistenceEffectLayer>,
	) => ReturnType<typeof makePersistenceEffectLayer>,
) {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return ManagedRuntime.make(
		Layer.merge(
			makeOrchestrationRuntimeLayer({ configDir }).pipe(
				Layer.provide(orchestrationDeps(persistence, makeStubClient())),
			),
			outerPersistence(persistence),
		),
	);
}

async function makeScopedOrchestrationView(
	options: OrchestrationRuntimeLayerOptions & { client: OpenCodeAPI },
) {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	const runtime = ManagedRuntime.make(
		makeOrchestrationRuntimeLayer({ configDir, ...options }).pipe(
			Layer.provide(orchestrationDeps(persistence, options.client)),
		),
	);
	onTestFinished(() => runtime.dispose());
	return runtime.runPromise(getOrchestrationLayer);
}

describe("Orchestration wiring", () => {
	it.each([
		false,
		true,
	])("retires a deleted fallback worktree after refresh (prepare=%s)", async (prepareShellEnv) => {
		const project = join(configDir, "project");
		const worktree = join(configDir, "worktree");
		mkdirSync(project);
		mkdirSync(worktree);
		const layer = await makeScopedOrchestrationView({
			client: makeStubClient(),
			workspaceRoot: project,
		});
		await Effect.runPromise(
			layer.engine.resolveCallContextEffect({
				sessionId: "",
				workspaceRoot: worktree,
				prepareShellEnv,
			}),
		);
		const resolver = resolvers.at(-1);
		if (!resolver) throw new Error("Missing fallback resolver");
		expect(resolver.directories()).toContain(worktree);
		rmSync(worktree, { recursive: true });
		await resolver.refresh(worktree, "test-project");
		expect(resolver.directories()).not.toContain(worktree);
		expect(resolver.registrations()).toEqual([
			{ directory: project, projectId: "test-project" },
		]);
	});

	for (const requireRoutableAccount of [false, true])
		it.each([
			"removed",
			"wrong driver",
		])(`resolves a carried account (%s, strict=${requireRoutableAccount})`, async (reason) => {
			const accounts = await Effect.runPromise(
				AccountDirectory.pipe(
					Effect.provide(
						AccountDirectoryStateLive(
							accountsStateFromInstances(
								[
									{ id: "warm-account", name: "Warm", driver: "claude" },
									{
										id: "fallback-account",
										name: "Fallback",
										driver: "claude",
										env: { ANTHROPIC_API_KEY: "synthetic-fallback-key" },
									},
								],
								configuredClaudeConfigDir(join(configDir, "claude")),
								5,
								{ defaultAccountIds: { claude: "warm-account" } },
							),
						),
					),
				),
			);
			const account = await Effect.runPromise(
				accounts.resolve({ _tag: "Id", id: "warm-account" }),
			);
			const persistence = makePersistenceEffectLayer(
				":memory:",
				"test-project",
			);
			const client = makeStubClient();
			const runtime = ManagedRuntime.make(
				makeOrchestrationRuntimeLayer({
					configDir,
					workspaceRoot: configDir,
				}).pipe(
					Layer.provide(
						Layer.merge(
							orchestrationDeps(persistence, client),
							Layer.succeed(AccountDirectory)(accounts),
						),
					),
				),
			);
			onTestFinished(() => runtime.dispose());
			const { engine } = await runtime.runPromise(getOrchestrationLayer);
			if (reason === "removed") {
				await Effect.runPromise(
					accounts.apply({ _tag: "Remove", id: account.id }),
				);
				expect(
					(
						await Effect.runPromise(
							accounts.resolve({ _tag: "Id", id: account.id }),
						)
					).id,
				).toBe("fallback-account");
			}
			const carried =
				reason === "wrong driver"
					? { ...account, driver: "cursor" as const }
					: account;
			const outcome = Effect.runPromise(
				engine.resolveCallContextEffect({
					sessionId: "",
					account: carried,
					requireRoutableAccount,
					prepareShellEnv: true,
				}),
			);
			if (requireRoutableAccount)
				await expect(outcome).rejects.toMatchObject({
					_tag: "ProviderInstanceFailure",
					message: expect.stringContaining(account.id),
				});
			else
				await expect(outcome).resolves.toMatchObject({
					account: { ...carried, env: undefined },
				});
		});
	it("scoped orchestration view returns engine, registry, and OpenCode instance", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({ client });

		expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
		expect(layer.registry).toBeInstanceOf(ProviderRegistry);
		expect(layer.openCodeInstance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	it("registry has opencode provider instance registered", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({ client });

		expect(layer.registry.hasInstance("opencode")).toBe(true);
	});

	it("exposes orchestration services through the scoped runtime layer", async () => {
		const client = makeStubClient();
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const runtime = ManagedRuntime.make(
			makeOrchestrationRuntimeLayer({ configDir }).pipe(
				Layer.provide(orchestrationDeps(persistence, client)),
			),
		);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);

			expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
			expect(layer.registry).toBeInstanceOf(ProviderRegistry);
			expect(layer.registry.hasInstance("opencode")).toBe(true);
			expect(layer.registry.hasInstance("claude")).toBe(true);
		} finally {
			await runtime.dispose();
		}
	});

	it("shares the relay's single SqlClient connection with orchestration", async () => {
		const runtime = makeSharedPersistenceRuntime((persistence) => persistence);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			await runtime.runPromise(
				seedProjectedSessionBinding("persisted-session", "claude"),
			);

			expect(
				await runtime.runPromise(
					layer.engine.getProviderForSessionEffect("persisted-session"),
				),
			).toBe("claude");
		} finally {
			await runtime.dispose();
		}
	});

	it("detects a second connection (control for the shared-connection proof)", async () => {
		const runtime = makeSharedPersistenceRuntime(Layer.fresh);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			await runtime.runPromise(
				seedProjectedSessionBinding("persisted-session", "claude"),
			);

			expect(
				await runtime.runPromise(
					layer.engine.getProviderForSessionEffect("persisted-session"),
				),
			).toBeUndefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("exposes a reactor drain quiescence seam through the wired runtime layer", async () => {
		const runtime = makeSharedPersistenceRuntime((persistence) => persistence);

		try {
			const layer = await runtime.runPromise(getOrchestrationLayer);
			// No committed side effects: the reactor reaches quiescence deterministically
			// (no sleeps), proving the drain seam is wired through the production path.
			await Effect.runPromise(layer.drainSideEffects());
		} finally {
			await runtime.dispose();
		}
	});

	it("creates provider instances through plain drivers", async () => {
		const client = makeStubClient();
		const instance = await Effect.runPromise(
			OpenCodeDriver.create({
				clientForAccount: () => Effect.succeed(client),
				clientForSession: () => Effect.succeed(client),
			}).pipe(Effect.scoped),
		);

		expect(OpenCodeDriver.providerId).toBe("opencode");
		expect(instance).toBeInstanceOf(OpenCodeProviderInstance);
	});

	it("engine can discover opencode capabilities", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({ client });

		const caps = await Effect.runPromise(
			layer.engine.dispatchEffect({
				type: "discover",
				providerId: "opencode",
			}),
		);

		expect(caps).toMatchObject({ supportsTools: true });
	});

	it("shutdown cleans up all components", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({ client });

		// Should not throw
		await Effect.runPromise(layer.engine.shutdownEffect());
	});

	it("accepts optional workspace root", async () => {
		const client = makeStubClient();
		const layer = await makeScopedOrchestrationView({
			client,
			workspaceRoot: tmpdir(),
		});

		expect(layer.openCodeInstance).toBeInstanceOf(OpenCodeProviderInstance);
	});
});
