import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { expect, vi } from "vitest";
import {
	ConfigTag,
	LoggerTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	type ClaudeTitleQueryFactory,
	formatClaudeTitleFallback,
	isDefaultSessionTitle,
	makeSessionTitleServiceLive,
	SessionTitleServiceTag,
	sanitizeGeneratedTitle,
} from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockSessionManagerService,
} from "../../helpers/mock-factories.js";

function makeWebSocketHandler() {
	const broadcast = vi.fn<(message: RelayMessage) => void>();
	const handler: WebSocketHandlerShape = {
		broadcast,
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		attach: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
	};
	return { handler, broadcast };
}

async function* makeQuery(
	messages: readonly unknown[],
): AsyncIterable<unknown> {
	for (const message of messages) {
		yield message;
	}
}

const assistantMessage = (text: string) => ({
	type: "assistant",
	message: {
		content: [{ type: "text", text }],
	},
});

const streamTextDelta = (text: string) => ({
	type: "stream_event",
	event: {
		type: "content_block_delta",
		delta: { type: "text_delta", text },
	},
});

const resultMessage = (text: string) => ({
	type: "result",
	result: text,
});

function makeTestLayer(input: {
	readonly queryFactory: ClaudeTitleQueryFactory;
	readonly sessionManager?: SessionManagerService;
	readonly now?: () => Date;
	readonly wsHandler?: WebSocketHandlerShape;
	readonly config?: ReturnType<typeof makeMockConfig>;
	readonly logger?: ReturnType<typeof makeMockLogger>;
}) {
	const ws = input.wsHandler ?? makeWebSocketHandler().handler;
	const deps = Layer.mergeAll(
		Layer.succeed(LoggerTag, input.logger ?? makeMockLogger()),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(
			SessionManagerServiceTag,
			input.sessionManager ?? makeMockSessionManagerService(),
		),
		Layer.succeed(
			ConfigTag,
			input.config ?? makeMockConfig({ projectDir: process.cwd() }),
		),
		makePersistenceEffectLayer(":memory:"),
	);
	return Layer.provideMerge(
		makeSessionTitleServiceLive({
			queryFactory: input.queryFactory,
			...(input.now ? { now: input.now } : {}),
		}),
		deps,
	);
}

function makePersistenceTestLayer(input: {
	readonly queryFactory: ClaudeTitleQueryFactory;
	readonly sessionManager?: SessionManagerService;
	readonly now?: () => Date;
	readonly wsHandler?: WebSocketHandlerShape;
	readonly persistenceDbPath: string;
	readonly config?: ReturnType<typeof makeMockConfig>;
	readonly logger?: ReturnType<typeof makeMockLogger>;
}) {
	const ws = input.wsHandler ?? makeWebSocketHandler().handler;
	const deps = Layer.mergeAll(
		Layer.succeed(LoggerTag, input.logger ?? makeMockLogger()),
		Layer.succeed(WebSocketHandlerTag, ws),
		Layer.succeed(
			SessionManagerServiceTag,
			input.sessionManager ?? makeMockSessionManagerService(),
		),
		Layer.succeed(
			ConfigTag,
			input.config ?? makeMockConfig({ projectDir: process.cwd() }),
		),
		makePersistenceEffectLayer(input.persistenceDbPath),
	);
	return Layer.provideMerge(
		makeSessionTitleServiceLive({
			queryFactory: input.queryFactory,
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
						SELECT last_applied_seq
						FROM projector_cursors
						WHERE projector_name = 'session'
					) AS cursor_sequence`);
					const latest = Number(rows[0]?.latest_sequence ?? 0);
					const cursor = Number(rows[0]?.cursor_sequence ?? 0);
					if (latest > 0 && cursor >= latest) return latest;
					throw new Error("Timed out waiting for session projector cursor");
				},
				{ timeout: 1_000 },
			),
		);
	});

const makeManualRenameRaceLayer = (input: {
	readonly queryFactory: ClaudeTitleQueryFactory;
	readonly sessionManager?: SessionManagerService;
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
								Effect.catchAll((error) =>
									Effect.dieMessage(
										`Failed to append manual rename race event: ${String(error)}`,
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
			Layer.succeed(LoggerTag, input.logger ?? makeMockLogger()),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(ConfigTag, makeMockConfig({ projectDir: process.cwd() })),
			Layer.succeed(
				SessionManagerServiceTag,
				input.sessionManager ?? makeMockSessionManagerService(),
			),
			Layer.succeed(ReadQueryEffectTag, raceReadQuery),
			Layer.succeed(EventStoreEffectTag, eventStore),
			Layer.succeed(ProjectionRunnerEffectTag, projectionRunner),
			Layer.succeed(SqlClient.SqlClient, sql),
		);

		return {
			layer: Layer.provideMerge(
				makeSessionTitleServiceLive({
					queryFactory: input.queryFactory,
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
		expect(isDefaultSessionTitle("Claude Session")).toBe(true);
		expect(isDefaultSessionTitle("Untitled")).toBe(true);
		expect(isDefaultSessionTitle("New session")).toBe(true);
		expect(isDefaultSessionTitle("New session 3")).toBe(true);
		expect(sanitizeGeneratedTitle("Claude Session")).toBeUndefined();
		expect(sanitizeGeneratedTitle("Untitled")).toBeUndefined();
		expect(sanitizeGeneratedTitle("New session")).toBeUndefined();
	});

	it("formats Claude fallback titles with local date and minute precision", () => {
		expect(formatClaudeTitleFallback(new Date(2026, 4, 17, 10, 11, 59))).toBe(
			"Claude Session 2026-05-17 10:11",
		);
	});
});

describe("SessionTitleService", () => {
	it.effect("passes constrained Opus query options to the SDK query", () => {
		return Effect.gen(function* () {
			const queryCalled = yield* Deferred.make<void>();
			const projectDir = join(tmpdir(), "conduit-title-project");
			let captured: Parameters<ClaudeTitleQueryFactory>[0] | undefined;
			const queryFactory = vi.fn(
				(params: Parameters<ClaudeTitleQueryFactory>[0]) => {
					captured = params;
					Effect.runSync(Deferred.succeed(queryCalled, undefined));
					return makeQuery([resultMessage("Fix OAuth Callback Loop")]);
				},
			);
			const layer = makeTestLayer({
				queryFactory,
				config: makeMockConfig({ projectDir }),
			});
			yield* Effect.gen(function* () {
				const service = yield* SessionTitleServiceTag;
				const firstMessage = "Please fix the OAuth callback loop.";
				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage,
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
					'Do not use "Claude Session", "Untitled", or "New session".',
				);
				expect(params.prompt).toContain(
					`<message>\n${firstMessage}\n</message>`,
				);

				const options = params.options;
				expect(options).toBeDefined();
				if (!options) throw new Error("query options were not provided");

				expect(options.cwd).toBe(projectDir);
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
				expect(options.abortController).toBeInstanceOf(AbortController);
				expect(options.env).toMatchObject({
					CLAUDE_AGENT_SDK_CLIENT_APP: "conduit",
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				});
				expect(options.thinking).toEqual({ type: "disabled" });
			}).pipe(Effect.provide(layer));
		});
	});

	it.effect("truncates overlong Opus output and applies it", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-apply-");
		return Effect.gen(function* () {
			const listsSent = yield* Deferred.make<void>();
			const pushViewerFamilies = vi.fn(() =>
				Deferred.succeed(listsSent, undefined),
			);
			const sessionManager = makeMockSessionManagerService({
				pushViewerFamilies,
			});
			const ws = makeWebSocketHandler();
			const layer = makePersistenceTestLayer({
				queryFactory: () =>
					makeQuery([
						assistantMessage(
							"Investigate OAuth Callback Loop In Production Immediately",
						),
					]),
				sessionManager,
				wsHandler: ws.handler,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage: "OAuth keeps redirecting after callback.",
				});
				yield* Deferred.await(listsSent);

				expect(yield* getSessionTitle()).toBe(
					"Investigate OAuth Callback Loop In Production",
				);
				expect(pushViewerFamilies).toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect("prefers result text over partial stream text", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-result-wins-");
		return Effect.gen(function* () {
			const listsSent = yield* Deferred.make<void>();
			const sessionManager = makeMockSessionManagerService({
				pushViewerFamilies: vi.fn(() => Deferred.succeed(listsSent, undefined)),
			});
			const layer = makePersistenceTestLayer({
				queryFactory: () =>
					makeQuery([
						streamTextDelta("Partial Stream Title"),
						resultMessage("Final Result Title"),
					]),
				sessionManager,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage: "Fix OAuth callback loop.",
				});
				yield* Deferred.await(listsSent);

				expect(yield* getSessionTitle()).toBe("Final Result Title");
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect(
		"sends fresh session lists when updated_at changes after title projection",
		() => {
			const { dir, filename } = makeTempDbPath("conduit-title-updated-at-");
			return Effect.gen(function* () {
				const pushViewerFamilies = vi.fn(() => Effect.void);
				const sessionManager = makeMockSessionManagerService({
					pushViewerFamilies,
				});
				const layer = makePersistenceTestLayer({
					queryFactory: () =>
						makeQuery([assistantMessage("Fix OAuth Callback Loop")]),
					sessionManager,
					persistenceDbPath: filename,
				});
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						CREATE TRIGGER bump_updated_at_after_title_update
						AFTER UPDATE OF title ON sessions
						BEGIN
							UPDATE sessions SET updated_at = NEW.updated_at + 1 WHERE id = NEW.id;
						END`;
					const service = yield* SessionTitleServiceTag;
					yield* service.startForFirstClaudeMessage({
						sessionId: "session-1",
						firstMessage: "Fix OAuth callback loop.",
					});
					yield* Effect.promise(() =>
						vi.waitFor(async () => {
							const rows = await Effect.runPromise(sql<{ title: string }>`
							SELECT title FROM sessions WHERE id = 'session-1'`);
							expect(rows[0]?.title).toBe("Fix OAuth Callback Loop");
							expect(pushViewerFamilies).toHaveBeenCalled();
						}),
					);

					expect(yield* getSessionTitle()).toBe("Fix OAuth Callback Loop");
					expect(pushViewerFamilies).toHaveBeenCalled();
				}).pipe(Effect.provide(layer));
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect("falls back when the Opus query fails", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-fallback-");
		return Effect.gen(function* () {
			const listsSent = yield* Deferred.make<void>();
			const sessionManager = makeMockSessionManagerService({
				pushViewerFamilies: vi.fn(() => Deferred.succeed(listsSent, undefined)),
			});
			const ws = makeWebSocketHandler();
			const log = makeMockLogger();
			const fallbackNow = new Date(2026, 4, 17, 10, 11, 0);
			const layer = makePersistenceTestLayer({
				queryFactory: () => {
					throw new Error("SDK unavailable");
				},
				sessionManager,
				wsHandler: ws.handler,
				logger: log,
				now: () => fallbackNow,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage: "Create OAuth callback tests.",
				});
				yield* Deferred.await(listsSent);

				const fallbackTitle = "Claude Session 2026-05-17 10:11";
				expect(yield* getSessionTitle()).toBe(fallbackTitle);
				// A background-task failure (fork 3.2): logged, never broadcast.
				expect(log.warn).toHaveBeenCalledWith(
					"SESSION_TITLE_GENERATION_FAILED sessionId=session-1 reason=SDK unavailable",
				);
				expect(ws.broadcast).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.ensuring(removeTempDir(dir)));
	});

	it.effect("deduplicates in-flight title jobs for the same session", () => {
		const { dir, filename } = makeTempDbPath("conduit-title-dedupe-");
		return Effect.gen(function* () {
			let releaseQuery: (() => void) | undefined;
			const queryGate = new Promise<void>((resolve) => {
				releaseQuery = resolve;
			});
			const queryStarted = yield* Deferred.make<void>();
			const listsSent = yield* Deferred.make<void>();
			const queryFactory = vi.fn(() =>
				(async function* () {
					Effect.runSync(Deferred.succeed(queryStarted, undefined));
					await queryGate;
					yield assistantMessage("Fix OAuth Callback Loop");
				})(),
			);
			const sessionManager = makeMockSessionManagerService({
				pushViewerFamilies: vi.fn(() => Deferred.succeed(listsSent, undefined)),
			});
			const layer = makePersistenceTestLayer({
				queryFactory,
				sessionManager,
				persistenceDbPath: filename,
			});
			yield* Effect.gen(function* () {
				yield* seedSessionRow();
				const service = yield* SessionTitleServiceTag;
				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage: "Fix OAuth callback loop.",
				});
				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage: "Fix OAuth callback loop again.",
				});
				yield* Deferred.await(queryStarted);
				expect(queryFactory).toHaveBeenCalledTimes(1);

				releaseQuery?.();
				yield* Deferred.await(listsSent);
				expect(queryFactory).toHaveBeenCalledTimes(1);
				expect(yield* getSessionTitle()).toBe("Fix OAuth Callback Loop");
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
					(params: Parameters<ClaudeTitleQueryFactory>[0]) => {
						abortSignal = params.options?.abortController?.signal;
						return (async function* () {
							try {
								Effect.runSync(Deferred.succeed(queryStarted, undefined));
								await new Promise<void>((resolve) => {
									abortSignal?.addEventListener("abort", () => resolve(), {
										once: true,
									});
								});
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

				yield* service.startForFirstClaudeMessage({
					sessionId: "session-1",
					firstMessage: "Fix OAuth callback loop.",
				});
				yield* Deferred.await(queryStarted);

				yield* Scope.close(scope, Exit.void);

				expect(abortSignal?.aborted).toBe(true);
				yield* Deferred.await(queryFinalized).pipe(
					Effect.timeoutFail({
						duration: "1 second",
						onTimeout: () =>
							new Error("Title query generator was not finalized"),
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
				const pushViewerFamilies = vi.fn(() => Effect.void);
				const sessionManager = makeMockSessionManagerService({
					pushViewerFamilies,
				});
				const ws = makeWebSocketHandler();
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					yield* projectionRunner.markRecovered();
					const race = yield* makeManualRenameRaceLayer({
						queryFactory: () =>
							makeQuery([assistantMessage("Generated OAuth Callback Title")]),
						sessionManager,
						wsHandler: ws.handler,
					});
					yield* Effect.gen(function* () {
						const service = yield* SessionTitleServiceTag;
						yield* service.startForFirstClaudeMessage({
							sessionId: "session-1",
							firstMessage: "Fix OAuth callback loop.",
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
								title: "Generated OAuth Callback Title",
								source: "auto-title",
							},
						]);
						expect(yield* getSessionTitle()).toBe("Claude Session");
						expect(pushViewerFamilies).not.toHaveBeenCalled();

						yield* projectionRunner.projectEvent(manualRename);
						expect(yield* getSessionTitle()).toBe("Manual OAuth Title");
					}).pipe(Effect.provide(race.layer));
				}).pipe(Effect.provide(makePersistenceEffectLayer(filename)));
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
				const pushViewerFamilies = vi.fn(() => Effect.void);
				const sessionManager = makeMockSessionManagerService({
					pushViewerFamilies,
				});
				const ws = makeWebSocketHandler();
				yield* Effect.gen(function* () {
					yield* seedSessionRow();
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					yield* projectionRunner.markRecovered();
					const race = yield* makeManualRenameRaceLayer({
						queryFactory: () => {
							throw new Error("SDK unavailable");
						},
						sessionManager,
						wsHandler: ws.handler,
						logger: log,
						now: () => new Date(2026, 4, 17, 10, 11, 0),
					});
					yield* Effect.gen(function* () {
						const service = yield* SessionTitleServiceTag;
						yield* service.startForFirstClaudeMessage({
							sessionId: "session-1",
							firstMessage: "Fix OAuth callback loop.",
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
								title: "Claude Session 2026-05-17 10:11",
								source: "auto-title",
							},
						]);
						expect(yield* getSessionTitle()).toBe("Claude Session");
						expect(pushViewerFamilies).not.toHaveBeenCalled();
						expect(log.warn).not.toHaveBeenCalled();

						yield* projectionRunner.projectEvent(manualRename);
						expect(yield* getSessionTitle()).toBe("Manual OAuth Title");
					}).pipe(Effect.provide(race.layer));
				}).pipe(Effect.provide(makePersistenceEffectLayer(filename)));
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect(
		"auto-title projection does not apply after an unprojected manual rename event",
		() => {
			const { dir, filename } = makeTempDbPath("conduit-title-projector-race-");
			return Effect.gen(function* () {
				const layer = makePersistenceEffectLayer(filename);
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
