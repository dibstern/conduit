import { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import {
	AccountIdSchema,
	type OpenCodeAccount,
} from "../../../src/lib/contracts/account.js";
import { isPlaceholderTitle } from "../../../src/lib/contracts/session-title.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ProjectSettingsLive,
	publishProjectSetting,
} from "../../../src/lib/domain/relay/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	formatTitleFallback,
	makeSessionTitleServiceLive,
	SessionTitleServiceTag,
	sanitizeGeneratedTitle,
} from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { ClaudeOneShotQueryFactory } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { CursorAccountResources } from "../../../src/lib/provider/cursor/cursor-account-resources.js";
import { makeCursorProviderRuntime } from "../../../src/lib/provider/cursor/cursor-provider-runtime.js";
import { createCursorSdkPort } from "../../../src/lib/provider/cursor/cursor-sdk.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import * as openCodeTextServer from "../../../src/lib/provider/opencode-text-server.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	makeClaudeTextGenerationLayer,
	replayClaudeText,
} from "../../helpers/claude-text-generation.js";
import { cursorAccountResourcesFixture } from "../../helpers/cursor-account-resources-fixture.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";
import { replayOpenCodeText } from "../../helpers/opencode-text-generation.js";

function makeWebSocketHandler() {
	const handler: WebSocketHandlerShape = {
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		registerSessionViewer: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
	};
	return { handler };
}

function makeTestLayer(input: {
	readonly queryFactory: ClaudeOneShotQueryFactory;
	readonly now?: () => Date;
	readonly wsHandler?: WebSocketHandlerShape;
	readonly config?: ReturnType<typeof makeMockConfig>;
	readonly logger?: ReturnType<typeof makeMockLogger>;
	readonly accounts?: ReturnType<typeof makeMockAccountDirectory>;
	readonly adapterConfigDir?: string;
	readonly providerLayer?: Layer.Layer<
		ProviderRegistryTag,
		never,
		ReadQueryEffectTag | ProviderStateEffectTag
	>;
}) {
	const ws = input.wsHandler ?? makeWebSocketHandler().handler;
	const deps = Layer.mergeAll(
		Layer.succeed(AccountDirectory)(
			input.accounts ?? makeMockAccountDirectory(),
		),
		input.providerLayer ??
			makeClaudeTextGenerationLayer(input.queryFactory, input.adapterConfigDir),
		Layer.succeed(OpenCodeAPITag)(makeMockOpenCodeAPI()),
		Layer.succeed(LoggerTag)(input.logger ?? makeMockLogger()),
		Layer.succeed(WebSocketHandlerTag)(ws),
		Layer.succeed(ConfigTag)(
			input.config ?? makeMockConfig({ projectDir: process.cwd() }),
		),
		ProjectSettingsLive,
	).pipe(
		Layer.provideMerge(makePersistenceEffectLayer(":memory:", "test-project")),
	);
	return Layer.provideMerge(
		makeSessionTitleServiceLive({
			...(input.now ? { now: input.now } : {}),
		}),
		deps,
	);
}

function makePersistenceTestLayer(input: {
	readonly queryFactory: ClaudeOneShotQueryFactory;
	readonly now?: () => Date;
	readonly wsHandler?: WebSocketHandlerShape;
	readonly persistenceDbPath: string;
	readonly config?: ReturnType<typeof makeMockConfig>;
	readonly logger?: ReturnType<typeof makeMockLogger>;
}) {
	const ws = input.wsHandler ?? makeWebSocketHandler().handler;
	const deps = Layer.mergeAll(
		Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
		makeClaudeTextGenerationLayer(input.queryFactory),
		Layer.succeed(OpenCodeAPITag)(makeMockOpenCodeAPI()),
		Layer.succeed(LoggerTag)(input.logger ?? makeMockLogger()),
		Layer.succeed(WebSocketHandlerTag)(ws),
		Layer.succeed(ConfigTag)(
			input.config ?? makeMockConfig({ projectDir: process.cwd() }),
		),
		makePersistenceEffectLayer(input.persistenceDbPath, "test-project"),
	);
	return Layer.provideMerge(
		makeSessionTitleServiceLive({
			...(input.now ? { now: input.now } : {}),
		}),
		deps,
	);
}

const makeTempDbPath = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, filename: join(dir, "events.db") };
};

const removeTempDir = (dir: string) =>
	Effect.sync(() => rmSync(dir, { recursive: true, force: true }));

const seedSessionRow = (sessionId = "session-1") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			VALUES (${sessionId}, 'claude', 'Claude Session', 'idle', 1000, 1000)`;
	});

const getSessionTitle = (sessionId = "session-1") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ title: string }>`
			SELECT title FROM sessions WHERE id = ${sessionId}`;
		return rows[0]?.title;
	});

const getRenameEvents = (sessionId = "session-1") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql<{
			sequence: number;
			title: string;
			source: string | null;
		}>`
			SELECT
				sequence,
				json_extract(data, '$.title') AS title,
				json_extract(metadata, '$.source') AS source
			FROM events
			WHERE session_id = ${sessionId} AND type = 'session.renamed'
			ORDER BY sequence ASC`;
	});

const waitForSessionProjectorToReachLatestRename = (sessionId = "session-1") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* Effect.promise(() =>
			vi.waitFor(
				async () => {
					const rows = await Effect.runPromise(sql<{
						latest_sequence: number | null;
						cursor_sequence: number | null;
					}>`
				SELECT
					(
						SELECT MAX(sequence)
						FROM events
						WHERE session_id = ${sessionId} AND type = 'session.renamed'
					) AS latest_sequence,
					(
						SELECT MAX(last_applied_seq)
						FROM projector_cursors
						WHERE projector_name = 'session'
							OR (
								projector_name LIKE '@batch:%'
								AND instr(
									',' || substr(projector_name, length('@batch:') + 1) || ',',
									',session,'
								) > 0
							)
					) AS cursor_sequence`);
					const latest = Number(rows[0]?.latest_sequence ?? 0);
					const cursor = Number(rows[0]?.cursor_sequence ?? 0);
					if (latest > 0 && cursor >= latest) return latest;
					throw new Error("Timed out waiting for session projector cursor");
				},
				// Covers a whole replayed generation plus projection, which is slow under load.
				{ timeout: 10_000 },
			),
		);
	});

const makeManualRenameRaceLayer = (input: {
	readonly queryFactory: ClaudeOneShotQueryFactory;
	readonly now?: () => Date;
	readonly wsHandler?: WebSocketHandlerShape;
	readonly logger?: ReturnType<typeof makeMockLogger>;
	readonly manualTitle?: string;
}) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const manualRenameInserted = yield* Deferred.make<StoredEvent>();
		const manualTitle = input.manualTitle ?? "Manual OAuth Title";
		let inserted = false;

		const raceReadQuery: ReadQueryEffect = {
			...readQuery,
			getSession: (sessionId: string) =>
				Effect.gen(function* () {
					const row = yield* readQuery.getSession(sessionId);
					if (!inserted) {
						inserted = true;
						const manualRename = yield* eventStore
							.append(
								canonicalEvent(
									"session.renamed",
									sessionId,
									{
										sessionId,
										title: manualTitle,
									},
									{
										provider: "claude",
										createdAt: 1500,
										metadata: { source: "relay" },
									},
								),
							)
							.pipe(
								Effect.catch((error) =>
									Effect.die(
										new Error(
											`Failed to append manual rename race event: ${String(error)}`,
										),
									),
								),
							);
						yield* Deferred.succeed(manualRenameInserted, manualRename);
					}
					return row;
				}),
		};
		const ws = input.wsHandler ?? makeWebSocketHandler().handler;
		const deps = Layer.mergeAll(
			Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
			makeClaudeTextGenerationLayer(input.queryFactory),
			Layer.succeed(OpenCodeAPITag)(makeMockOpenCodeAPI()),
			Layer.succeed(LoggerTag)(input.logger ?? makeMockLogger()),
			Layer.succeed(WebSocketHandlerTag)(ws),
			Layer.succeed(ConfigTag)(makeMockConfig({ projectDir: process.cwd() })),
			Layer.succeed(ReadQueryEffectTag)(raceReadQuery),
			Layer.succeed(EventStoreEffectTag)(eventStore),
			Layer.succeed(ProjectionRunnerEffectTag)(projectionRunner),
			Layer.succeed(SqlClient.SqlClient)(sql),
		);

		return {
			layer: Layer.provideMerge(
				makeSessionTitleServiceLive({
					...(input.now ? { now: input.now } : {}),
				}),
				deps,
			),
			manualRenameInserted,
		};
	});

describe("session title helpers", () => {
	it("truncates generated titles to six words", () => {
		expect(
			sanitizeGeneratedTitle(
				"Fix OAuth Callback Loop In Production Immediately",
			),
		).toBe("Fix OAuth Callback Loop In Production");
	});

	it("collapses newlines and control characters to spaces", () => {
		expect(sanitizeGeneratedTitle("Fix\nOAuth\u0007Callback\tLoop")).toBe(
			"Fix OAuth Callback Loop",
		);
	});

	it("trims surrounding quotes and backticks", () => {
		expect(sanitizeGeneratedTitle('"`Fix OAuth Callback Loop`"')).toBe(
			"Fix OAuth Callback Loop",
		);
	});

	it("strips trailing periods", () => {
		expect(sanitizeGeneratedTitle("Fix OAuth Callback Loop.")).toBe(
			"Fix OAuth Callback Loop",
		);
	});

	it("strips periods after truncating to six words", () => {
		expect(
			sanitizeGeneratedTitle(
				"Fix OAuth Callback Loop In Production. Immediately",
			),
		).toBe("Fix OAuth Callback Loop In Production");
	});

	it("rejects default-equivalent titles", () => {
		expect(isPlaceholderTitle("Claude Session")).toBe(true);
		expect(isPlaceholderTitle("Untitled")).toBe(true);
		expect(isPlaceholderTitle("New session")).toBe(true);
		expect(isPlaceholderTitle("New session 3")).toBe(true);
		expect(sanitizeGeneratedTitle("Claude Session")).toBeUndefined();
		expect(sanitizeGeneratedTitle("Untitled")).toBeUndefined();
		expect(sanitizeGeneratedTitle("New session")).toBeUndefined();
	});

	it("formats fallback titles with local date and minute precision", () => {
		expect(formatTitleFallback(new Date(2026, 4, 17, 10, 11, 59))).toBe(
			"Session 2026-05-17 10:11",
		);
	});
});

describe("SessionTitleService", () => {
	for (const scenario of [
		{
			name: "uses the built-in default when the saved account was removed",
			accountPresent: false,
			catalogAvailable: false,
			problem: "Title generation account does not exist",
		},
		{
			name: "uses the built-in default when the saved model left its catalog",
			accountPresent: true,
			catalogAvailable: true,
			problem:
				"ModelNotInCatalog: model claude/sonnet is not in the claude catalog",
		},
		{
			name: "uses the saved account, model and effort while its catalog is unverified",
			accountPresent: true,
			catalogAvailable: false,
			problem: undefined,
		},
	]) {
		it.effect(scenario.name, () => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-title-stale-"));
			const queryFactory = vi.fn(
				(_params: Parameters<ClaudeOneShotQueryFactory>[0]) =>
					replayClaudeText(),
			);
			const log = makeMockLogger();
			const layer = makeTestLayer({
				queryFactory,
				logger: log,
				config: makeMockConfig({ configDir }),
				accounts: makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-personal"),
						name: "Personal",
						folder: configuredClaudeConfigDir("/title-personal-login"),
						usageEligible: true,
					},
					...(scenario.accountPresent
						? [
								{
									driver: "claude" as const,
									id: AccountIdSchema.make("claude-work"),
									name: "Work",
									folder: configuredClaudeConfigDir("/title-work-login"),
									usageEligible: true,
								},
							]
						: []),
				]),
			});
			return Effect.gen(function* () {
				yield* Effect.sync(() =>
					saveRelaySettings(
						{
							titleGeneration: {
								account: { _tag: "Id", id: "claude-work" },
								providerId: "claude",
								modelId: "sonnet",
								effort: "high",
							},
						},
						configDir,
					),
				);
				if (scenario.catalogAvailable) {
					yield* publishProjectSetting({
						_tag: "providerModels",
						accountId: "claude-work",
						providers: [
							{
								id: "claude",
								name: "Claude",
								configured: true,
								models: [{ id: "opus", name: "Opus", provider: "claude" }],
							},
						],
					});
				}
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "Fix auth",
				});
				yield* waitForSessionProjectorToReachLatestRename();
				expect(yield* getSessionTitle()).toBe("pong");
				expect(queryFactory).toHaveBeenCalledTimes(1);
				if (scenario.problem) {
					expect(queryFactory.mock.calls[0]?.[0].options).toMatchObject({
						env: { CLAUDE_CONFIG_DIR: "/title-personal-login" },
						model: "opus",
						thinking: { type: "disabled" },
					});
					expect(log.warn).toHaveBeenCalledTimes(1);
					expect(log.warn).toHaveBeenCalledWith(
						expect.stringContaining(
							`SESSION_TITLE_GENERATION_FALLBACK sessionId=session-1 harness=claude account=claude-work model=claude/sonnet reason=${scenario.problem}`,
						),
					);
				} else {
					expect(queryFactory.mock.calls[0]?.[0].options).toMatchObject({
						env: { CLAUDE_CONFIG_DIR: "/title-work-login" },
						model: "sonnet",
						effort: "high",
					});
					expect(log.warn).not.toHaveBeenCalled();
				}
			}).pipe(Effect.provide(layer), Effect.ensuring(removeTempDir(configDir)));
		});
	}

	it.effect(
		"generates with the saved OpenCode account without importing its scratch session",
		() => {
			const configDir = mkdtempSync("/tmp/conduit-opencode-title-service-");
			const replay = replayOpenCodeText();
			const account = {
				driver: "opencode",
				id: AccountIdSchema.make("opencode-titles"),
				name: "OpenCode titles",
				usageEligible: false,
			} as const;
			const accounts = makeMockAccountDirectory([account]);
			const route = vi.fn((selected: OpenCodeAccount, directory?: string) => {
				expect(selected).toEqual(account);
				expect(directory).toBeUndefined();
				return Effect.succeed(replay.client(directory ?? ""));
			});
			let scratch = "";
			const server = vi
				.spyOn(openCodeTextServer, "openCodeTextServerEffect")
				.mockImplementation(() =>
					Effect.gen(function* () {
						const root = yield* Effect.acquireRelease(
							Effect.sync(() =>
								mkdtempSync(join(tmpdir(), "conduit-title-service-")),
							),
							removeTempDir,
						);
						scratch = root;
						return {
							client: replay.client(root),
							cwd: root,
							root,
							process: new ChildProcess(),
							pid: 123456,
						};
					}),
				);
			const provider = new OpenCodeProviderInstance({
				clientForSession: () => Effect.succeed(replay.client("/project")),
				configDir,
				clientForAccount: route,
			});
			saveRelaySettings(
				{
					titleGeneration: {
						account: { _tag: "Id", id: account.id },
						providerId: replay.model.providerId,
						modelId: replay.model.modelId,
						effort: "",
					},
				},
				configDir,
			);
			const queryFactory = vi.fn(() => replayClaudeText());
			return Effect.gen(function* () {
				const service = yield* SessionTitleServiceTag;
				yield* seedSessionRow("opencode-title");
				yield* service.titleFromMessage({
					sessionId: "opencode-title",
					message: "Fix login redirect loop",
				});
				yield* waitForSessionProjectorToReachLatestRename("opencode-title");
				expect(yield* getSessionTitle("opencode-title")).toBe(
					sanitizeGeneratedTitle(replay.reply),
				);
				expect(yield* getRenameEvents("opencode-title")).toHaveLength(1);
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT id FROM sessions`).toEqual([
					{ id: "opencode-title" },
				]);
				expect(
					yield* sql`SELECT sequence FROM events WHERE session_id = ${replay.sessionId}`,
				).toEqual([]);
				expect(queryFactory).not.toHaveBeenCalled();
				expect(route).toHaveBeenCalledOnce();
				expect(server).toHaveBeenCalledOnce();
				expect(existsSync(scratch)).toBe(false);
			}).pipe(
				Effect.provide(
					makeTestLayer({
						queryFactory,
						accounts,
						config: makeMockConfig({ configDir }),
						providerLayer: Layer.succeed(ProviderRegistryTag)(
							new ProviderRegistry([provider]),
						),
					}),
				),
				Effect.ensuring(removeTempDir(configDir)),
				Effect.ensuring(Effect.sync(() => server.mockRestore())),
			);
		},
	);

	it.effect(
		"generates the title with the selected Cursor account by replaying captured SDK traffic",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-cursor-title-service-"),
			);
			const accounts = makeMockAccountDirectory([
				{
					driver: "cursor",
					id: AccountIdSchema.make("cursor-titles"),
					name: "Cursor titles",
					usageEligible: false,
					env: { CURSOR_API_KEY: "[REDACTED:environment]" },
				},
			]);
			vi.stubEnv(
				"CONDUIT_CURSOR_SDK_TRACE",
				join(
					import.meta.dirname,
					"../../fixtures/cursor-sdk-traces/title-generation.jsonl",
				),
			);
			saveRelaySettings(
				{
					titleGeneration: {
						account: { _tag: "Id", id: "cursor-titles" },
						providerId: "cursor",
						modelId: "composer-2.5",
						effort: "",
					},
				},
				configDir,
			);
			const queryFactory = vi.fn(() => replayClaudeText());
			const layer = makeTestLayer({
				queryFactory,
				config: makeMockConfig({ configDir }),
				accounts,
				providerLayer: Layer.effect(
					ProviderRegistryTag,
					Effect.gen(function* () {
						const read = yield* ReadQueryEffectTag;
						const state = yield* ProviderStateEffectTag;
						const provider = yield* makeCursorProviderRuntime(
							{
								daemonConfigDir: configDir,
								accounts: accounts.snapshot,
							},
							{ read, state },
						).pipe(
							Effect.provideService(
								CursorAccountResources,
								cursorAccountResourcesFixture(createCursorSdkPort()),
							),
						);
						return new ProviderRegistry([provider]);
					}),
				),
			});
			return Effect.gen(function* () {
				const service = yield* SessionTitleServiceTag;
				yield* seedSessionRow("cursor-title");
				yield* service.titleFromMessage({
					sessionId: "cursor-title",
					message: "Fix login redirect loop",
				});
				yield* waitForSessionProjectorToReachLatestRename("cursor-title");
				expect(yield* getSessionTitle("cursor-title")).toBe(
					"Fix login redirect loop",
				);
				expect(yield* getRenameEvents("cursor-title")).toHaveLength(1);
				expect(queryFactory).not.toHaveBeenCalled();
				expect(readdirSync(join(configDir, "text-generation"))).toEqual([]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => {
						vi.unstubAllEnvs();
						rmSync(configDir, { recursive: true, force: true });
					}),
				),
			);
		},
	);

	it.effect(
		"reads account, model and effort again for the next title without restarting",
		() => {
			const configDir = mkdtempSync(join(tmpdir(), "conduit-title-setting-"));
			const queryFactory = vi.fn(
				(_params: Parameters<ClaudeOneShotQueryFactory>[0]) =>
					replayClaudeText(),
			);
			const layer = makeTestLayer({
				queryFactory,
				config: makeMockConfig({ configDir }),
				accounts: makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-personal"),
						name: "Personal",
						folder: configuredClaudeConfigDir("/title-personal-login"),
						usageEligible: true,
					},
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-work"),
						name: "Work",
						folder: configuredClaudeConfigDir("/title-work-login"),
						usageEligible: true,
					},
				]),
			});
			return Effect.gen(function* () {
				const service = yield* SessionTitleServiceTag;
				yield* seedSessionRow("before-setting");
				yield* service.titleFromMessage({
					sessionId: "before-setting",
					message: "Fix auth",
				});
				yield* waitForSessionProjectorToReachLatestRename("before-setting");
				expect(yield* getSessionTitle("before-setting")).toBe("pong");
				expect(queryFactory.mock.calls[0]?.[0].options).toMatchObject({
					env: { CLAUDE_CONFIG_DIR: "/title-personal-login" },
					model: "opus",
					thinking: { type: "disabled" },
				});

				yield* Effect.sync(() =>
					saveRelaySettings(
						{
							titleGeneration: {
								account: { _tag: "Id", id: "claude-work" },
								providerId: "claude",
								modelId: "sonnet",
								effort: "high",
							},
						},
						configDir,
					),
				);
				yield* seedSessionRow("after-setting");
				yield* service.titleFromMessage({
					sessionId: "after-setting",
					message: "Fix auth",
				});
				yield* waitForSessionProjectorToReachLatestRename("after-setting");
				expect(yield* getSessionTitle("after-setting")).toBe("pong");
				expect(queryFactory.mock.calls[1]?.[0].options).toMatchObject({
					env: { CLAUDE_CONFIG_DIR: "/title-work-login" },
					model: "sonnet",
					effort: "high",
				});

				yield* Effect.sync(() =>
					saveRelaySettings({ titleGeneration: null }, configDir),
				);
				yield* seedSessionRow("after-reset");
				yield* service.titleFromMessage({
					sessionId: "after-reset",
					message: "Fix auth",
				});
				yield* waitForSessionProjectorToReachLatestRename("after-reset");
				expect(yield* getSessionTitle("after-reset")).toBe("pong");
				expect(queryFactory.mock.calls[2]?.[0].options).toMatchObject({
					env: { CLAUDE_CONFIG_DIR: "/title-personal-login" },
					model: "opus",
					thinking: { type: "disabled" },
				});
				expect(queryFactory).toHaveBeenCalledTimes(3);
			}).pipe(Effect.provide(layer), Effect.ensuring(removeTempDir(configDir)));
		},
	);

	it.effect(
		"uses the directory's default account and removes the scratch directory",
		() => {
			const projectDir = "/title-project-root";
			let scratchDir: string | undefined;
			const queryFactory = vi.fn(
				(params: Parameters<ClaudeOneShotQueryFactory>[0]) => {
					scratchDir = params.options?.cwd;
					expect(params.options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(
						"/account-base/.claude-work",
					);
					expect(params.options?.env?.["TITLE_ACCOUNT_MARKER"]).toBe("work");
					return replayClaudeText();
				},
			);
			const layer = makeTestLayer({
				queryFactory,
				accounts: makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-work"),
						name: "Work",
						configuredFolder: ".claude-work",
						folder: configuredClaudeConfigDir("/account-base/.claude-work"),
						env: { TITLE_ACCOUNT_MARKER: "work" },
						usageEligible: true,
					},
				]),
				// Deliberately not a daemon config path. The job must use the directory.
				config: makeMockConfig({
					projectDir,
					configDir: "/not-a-daemon-config",
				}),
			});
			return Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "Fix auth",
				});
				yield* waitForSessionProjectorToReachLatestRename();
				expect(yield* getSessionTitle()).toBe("pong");
				expect(scratchDir).toBeDefined();
				expect(existsSync(scratchDir ?? "")).toBe(false);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("passes constrained Opus query options to the SDK query", () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-title-isolation-"));
		return Effect.gen(function* () {
			const queryCalled = yield* Deferred.make<void>();
			const projectDir = join(tmpdir(), "conduit-title-project");
			let captured: Parameters<ClaudeOneShotQueryFactory>[0] | undefined;
			const queryFactory = vi.fn(
				(params: Parameters<ClaudeOneShotQueryFactory>[0]) => {
					captured = params;
					expect(params.options?.cwd?.startsWith(`${configDir}/`)).toBe(true);
					expect(readdirSync(params.options?.cwd ?? "")).toEqual([]);
					Effect.runSync(Deferred.succeed(queryCalled, undefined));
					return replayClaudeText();
				},
			);
			const layer = makeTestLayer({
				queryFactory,
				config: makeMockConfig({ projectDir }),
				adapterConfigDir: configDir,
			});
			yield* Effect.gen(function* () {
				const service = yield* SessionTitleServiceTag;
				const firstMessage = "Please fix the OAuth callback loop.";
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: firstMessage,
				});
				yield* Deferred.await(queryCalled);

				const params = captured;
				expect(params).toBeDefined();
				if (!params) throw new Error("queryFactory was not called");

				expect(params.prompt).toContain(
					"Create a concise sidebar title for this coding-assistant session.",
				);
				expect(params.prompt).toContain("Return only the title.");
				expect(params.prompt).toContain("Use at most six words.");
				expect(params.prompt).toContain("Do not include quotes.");
				expect(params.prompt).toContain(
					'Do not return a placeholder title such as "Untitled" or "New session".',
				);
				expect(params.prompt).toContain(
					`<message>\n${firstMessage}\n</message>`,
				);

				const options = params.options;
				expect(options).toBeDefined();
				if (!options) throw new Error("query options were not provided");

				expect(options.cwd).not.toBe(projectDir);
				expect(options.model).toBe("opus");
				expect(options.persistSession).toBe(false);
				expect(options.maxTurns).toBe(1);
				expect(options.allowedTools).toEqual([]);
				expect(options.tools).toEqual([]);
				// User hooks, CLAUDE.md files and output styles must not reach the title prompt.
				expect(typeof options.systemPrompt).toBe("string");
				expect(options.settings).toEqual({
					disableAllHooks: true,
					outputStyle: "default",
					claudeMdExcludes: ["**"],
				});
				expect(options.settingSources).toEqual(["user"]);
				expect(options.mcpServers).toEqual({});
				expect(options.strictMcpConfig).toBe(true);
				expect(options.abortController).toBeInstanceOf(AbortController);
				expect(options.env).toMatchObject({
					CLAUDE_AGENT_SDK_CLIENT_APP: "conduit",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				});
				expect(options.thinking).toEqual({ type: "disabled" });
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(configDir)));
	});

	it.effect("truncates overlong Opus output and applies it", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-apply-");
		return Effect.gen(function* () {
			const ws = makeWebSocketHandler();
			const layer = makePersistenceTestLayer({
				queryFactory: () => replayClaudeText("enter-worktree-turn"),
				wsHandler: ws.handler,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "OAuth keeps redirecting after callback.",
				});
				yield* waitForSessionProjectorToReachLatestRename();

				expect(yield* getSessionTitle()).toBe(
					"I created the worktree `contract` on",
				);
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect("applies the title to an OpenCode session", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-opencode-");
		return Effect.gen(function* () {
			const layer = makePersistenceTestLayer({
				queryFactory: () => replayClaudeText(),
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES ('session-1', 'opencode', 'Untitled', 'idle', 1000, 1000)`;
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "The instance header selector is broken.",
				});
				yield* waitForSessionProjectorToReachLatestRename();

				expect(yield* getSessionTitle()).toBe("pong");
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect(
		"collects captured partials, assistant text and result without duplication",
		() => {
			const { dir, filename } = makeTempDbPath("conduit-title-result-wins-");
			return Effect.gen(function* () {
				const layer = makePersistenceTestLayer({
					queryFactory: () => replayClaudeText(),
					persistenceDbPath: filename,
				});
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const service = yield* SessionTitleServiceTag;
					yield* service.titleFromMessage({
						sessionId: "session-1",
						message: "Fix OAuth callback loop.",
					});
					yield* waitForSessionProjectorToReachLatestRename();

					expect(yield* getSessionTitle()).toBe("pong");
				}).pipe(Effect.provide(layer));
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect("falls back when the Opus query fails", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-fallback-");
		return Effect.gen(function* () {
			const ws = makeWebSocketHandler();
			const log = makeMockLogger();
			const fallbackNow = new Date(2026, 4, 17, 10, 11, 0);
			const layer = makePersistenceTestLayer({
				queryFactory: () => replayClaudeText("subagent-task-error-turn"),
				wsHandler: ws.handler,
				logger: log,
				now: () => fallbackNow,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "Create OAuth callback tests.",
				});
				yield* waitForSessionProjectorToReachLatestRename();

				const fallbackTitle = "Session 2026-05-17 10:11";
				expect(yield* getSessionTitle()).toBe(fallbackTitle);
				// A background-task failure (fork 3.2): logged, never broadcast.
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining(
						"SESSION_TITLE_GENERATION_FAILED sessionId=session-1 harness=claude account=claude model=claude/opus reason=",
					),
				);
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("API Error: 529 overloaded"),
				);
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect(
		"times out after 30 seconds, aborts the query and applies the timestamp title",
		() => {
			return Effect.gen(function* () {
				const started = yield* Deferred.make<void>();
				let scratchDir: string | undefined;
				let signal: AbortSignal | undefined;
				const log = makeMockLogger();
				const layer = makeTestLayer({
					queryFactory: (params) =>
						(async function* () {
							signal = params.options?.abortController?.signal;
							scratchDir = params.options?.cwd;
							Effect.runSync(Deferred.succeed(started, undefined));
							await new Promise<void>((resolve) => {
								signal?.addEventListener("abort", () => resolve(), {
									once: true,
								});
							});
							yield* replayClaudeText();
						})(),
					logger: log,
					now: () => new Date(2026, 4, 17, 10, 11),
				});
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const service = yield* SessionTitleServiceTag;
					yield* service.titleFromMessage({
						sessionId: "session-1",
						message: "Fix auth",
					});
					yield* Deferred.await(started);
					yield* TestClock.adjust("30 seconds");
					yield* waitForSessionProjectorToReachLatestRename();
					expect(yield* getSessionTitle()).toBe("Session 2026-05-17 10:11");
					expect(signal?.aborted).toBe(true);
					expect(scratchDir).toBeDefined();
					expect(existsSync(scratchDir ?? "")).toBe(false);
					expect(log.warn).toHaveBeenCalledWith(
						expect.stringContaining("Timed out waiting for title generation"),
					);
				}).pipe(Effect.provide(layer));
			});
		},
	);

	it.effect("deduplicates in-flight title jobs for the same session", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-dedupe-");
		return Effect.gen(function* () {
			let releaseQuery: (() => void) | undefined;
			const queryGate = new Promise<void>((resolve) => {
				releaseQuery = resolve;
			});
			const queryStarted = yield* Deferred.make<void>();
			const queryFactory = vi.fn(() =>
				(async function* () {
					Effect.runSync(Deferred.succeed(queryStarted, undefined));
					await queryGate;
					yield* replayClaudeText();
				})(),
			);
			const layer = makePersistenceTestLayer({
				queryFactory,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "Fix OAuth callback loop.",
				});
				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "Fix OAuth callback loop again.",
				});
				yield* Deferred.await(queryStarted);
				expect(queryFactory).toHaveBeenCalledTimes(1);

				releaseQuery?.();
				yield* waitForSessionProjectorToReachLatestRename();
				expect(queryFactory).toHaveBeenCalledTimes(1);
				expect(yield* getSessionTitle()).toBe("pong");
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect(
		"interrupts in-flight title jobs when the service scope closes",
		() => {
			return Effect.gen(function* () {
				const queryStarted = yield* Deferred.make<void>();
				const queryFinalized = yield* Deferred.make<void>();
				let abortSignal: AbortSignal | undefined;
				const queryFactory = vi.fn(
					(params: Parameters<ClaudeOneShotQueryFactory>[0]) => {
						abortSignal = params.options?.abortController?.signal;
						return (async function* () {
							try {
								Effect.runSync(Deferred.succeed(queryStarted, undefined));
								await new Promise<void>((resolve) => {
									abortSignal?.addEventListener("abort", () => resolve(), {});
								});
								yield* replayClaudeText();
							} finally {
								Effect.runSync(Deferred.succeed(queryFinalized, undefined));
							}
						})();
					},
				);
				const layer = makeTestLayer({ queryFactory });
				const scope = yield* Scope.make();
				const context = yield* Layer.buildWithScope(Layer.fresh(layer), scope);
				const service = Context.get(context, SessionTitleServiceTag);

				yield* service.titleFromMessage({
					sessionId: "session-1",
					message: "Fix OAuth callback loop.",
				});
				yield* Deferred.await(queryStarted);

				yield* Scope.close(scope, Exit.void);

				expect(abortSignal?.aborted).toBe(true);
				yield* Deferred.await(queryFinalized).pipe(
					Effect.timeoutOrElse({
						duration: "1 second",
						orElse: () =>
							Effect.fail(
								(() => new Error("Title query generator was not finalized"))(),
							),
					}),
				);
			});
		},
	);

	it.effect(
		"does not overwrite a manual rename event that lands after the stale eligibility read",
		() => {
			const { dir, filename } = makeTempDbPath("conduit-title-manual-race-");
			return Effect.gen(function* () {
				const ws = makeWebSocketHandler();
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					yield* projectionRunner.markRecovered();
					const race = yield* makeManualRenameRaceLayer({
						queryFactory: () => replayClaudeText(),
						wsHandler: ws.handler,
					});
					yield* Effect.gen(function* () {
						const service = yield* SessionTitleServiceTag;
						yield* service.titleFromMessage({
							sessionId: "session-1",
							message: "Fix OAuth callback loop.",
						});

						const manualRename = yield* Deferred.await(
							race.manualRenameInserted,
						);
						yield* waitForSessionProjectorToReachLatestRename();

						expect(
							(yield* getRenameEvents()).map((event) => ({
								title: event.title,
								source: event.source,
							})),
						).toEqual([
							{ title: "Manual OAuth Title", source: "relay" },
							{
								title: "pong",
								source: "auto-title",
							},
						]);
						expect(yield* getSessionTitle()).toBe("Claude Session");

						yield* projectionRunner.projectEvent(manualRename);
						expect(yield* getSessionTitle()).toBe("Manual OAuth Title");
					}).pipe(Effect.provide(race.layer));
				}).pipe(
					Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
				);
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect(
		"does not broadcast fallback failure when a manual rename event wins the apply race",
		() => {
			const { dir, filename } = makeTempDbPath(
				"conduit-title-fallback-manual-race-",
			);
			return Effect.gen(function* () {
				const log = makeMockLogger();
				const ws = makeWebSocketHandler();
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					yield* projectionRunner.markRecovered();
					const race = yield* makeManualRenameRaceLayer({
						queryFactory: () => {
							throw new Error("SDK unavailable");
						},
						wsHandler: ws.handler,
						logger: log,
						now: () => new Date(2026, 4, 17, 10, 11, 0),
					});
					yield* Effect.gen(function* () {
						const service = yield* SessionTitleServiceTag;
						yield* service.titleFromMessage({
							sessionId: "session-1",
							message: "Fix OAuth callback loop.",
						});

						const manualRename = yield* Deferred.await(
							race.manualRenameInserted,
						);
						yield* waitForSessionProjectorToReachLatestRename();

						expect(
							(yield* getRenameEvents()).map((event) => ({
								title: event.title,
								source: event.source,
							})),
						).toEqual([
							{ title: "Manual OAuth Title", source: "relay" },
							{
								title: "Session 2026-05-17 10:11",
								source: "auto-title",
							},
						]);
						expect(yield* getSessionTitle()).toBe("Claude Session");
						expect(log.warn).not.toHaveBeenCalled();

						yield* projectionRunner.projectEvent(manualRename);
						expect(yield* getSessionTitle()).toBe("Manual OAuth Title");
					}).pipe(Effect.provide(race.layer));
				}).pipe(
					Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
				);
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect(
		"auto-title projection does not apply after an unprojected manual rename event",
		() => {
			const { dir, filename } = makeTempDbPath("conduit-title-projector-race-");
			return Effect.gen(function* () {
				const layer = makePersistenceEffectLayer(filename, "test-project");
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const eventStore = yield* EventStoreEffectTag;
					const projectionRunner = yield* ProjectionRunnerEffectTag;

					yield* projectionRunner.markRecovered();

					const manualRename = yield* eventStore.append(
						canonicalEvent(
							"session.renamed",
							"session-1",
							{
								sessionId: "session-1",
								title: "Manual OAuth Title",
							},
							{
								provider: "claude",
								createdAt: 1500,
								metadata: { source: "relay" },
							},
						),
					);
					const autoTitle = yield* eventStore.append(
						canonicalEvent(
							"session.renamed",
							"session-1",
							{
								sessionId: "session-1",
								title: "Generated OAuth Callback Title",
							},
							{
								provider: "claude",
								createdAt: 2000,
								metadata: { source: "auto-title" },
							},
						),
					);

					yield* projectionRunner.projectEvent(autoTitle);
					expect(yield* getSessionTitle()).toBe("Claude Session");

					yield* projectionRunner.projectEvent(manualRename);
					expect(yield* getSessionTitle()).toBe("Manual OAuth Title");
				}).pipe(Effect.provide(layer));
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);
});
