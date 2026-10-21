import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionTitleServiceLive,
	SessionTitleServiceTag,
} from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { ClaudeOneShotQueryFactory } from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	makeClaudeTextGenerationLayer,
	replayClaudeText,
} from "../../helpers/claude-text-generation.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

const SESSION_ID = "claude-title-integration-session";
const FIRST_MESSAGE =
	"Please investigate why OAuth token refresh is failing after expiry.";
const GENERATED_TITLE = "pong";
const DEFAULT_TITLE = "Claude Session";

const makeSignal = () => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
};

const makeGatedTitleQuery = () => {
	const started = makeSignal();
	const release = makeSignal();
	const finished = makeSignal();
	return {
		started: started.promise,
		finished: finished.promise,
		release: release.resolve,
		query: async function* (): AsyncIterable<unknown> {
			started.resolve();
			try {
				await release.promise;
				yield* replayClaudeText();
			} finally {
				finished.resolve();
			}
		},
	};
};

const makeTempDbPath = () => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-claude-title-flow-"));
	return { dir, filename: join(dir, "events.db") };
};

const removeTempDir = (dir: string) =>
	Effect.sync(() => rmSync(dir, { recursive: true, force: true }));

const makeTitleServiceLayer = (input: {
	readonly filename: string;
	readonly queryFactory: ClaudeOneShotQueryFactory;
	readonly accounts?: ReturnType<typeof makeMockAccountDirectory>;
	readonly configDir?: string;
}) =>
	Layer.provideMerge(
		makeSessionTitleServiceLive(),
		Layer.mergeAll(
			Layer.succeed(AccountDirectory)(
				input.accounts ?? makeMockAccountDirectory(),
			),
			makeClaudeTextGenerationLayer(input.queryFactory),
			Layer.succeed(OpenCodeAPITag)(makeMockOpenCodeAPI()),
			Layer.succeed(LoggerTag)(makeMockLogger()),
			Layer.succeed(ConfigTag)(
				makeMockConfig({
					projectDir: process.cwd(),
					...(input.configDir ? { configDir: input.configDir } : {}),
				}),
			),
			Layer.succeed(WebSocketHandlerTag)(makeMockWebSocketHandler()),
			Layer.succeed(SessionManagerServiceTag)(makeMockSessionManagerService()),
			makePersistenceEffectLayer(input.filename, "test-project"),
		),
	);

const seedSessionRow = (input: {
	readonly sessionId: string;
	readonly title: string;
	readonly createdAt: number;
}) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			VALUES (${input.sessionId}, 'claude-sdk', ${input.title}, 'idle', ${input.createdAt}, ${input.createdAt})`;
	});

const appendProjectedSessionCreated = (input: {
	readonly sessionId: string;
	readonly title: string;
	readonly createdAt: number;
}) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const event = yield* store.append(
			canonicalEvent(
				"session.created",
				input.sessionId,
				{
					sessionId: input.sessionId,
					title: input.title,
					provider: "claude-sdk",
				},
				{ provider: "claude-sdk", createdAt: input.createdAt },
			),
		);
		yield* runner.projectEvent(event);
		return event;
	});

const appendProjectedFirstMessage = (input: {
	readonly sessionId: string;
	readonly createdAt: number;
}) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const event = yield* store.append(
			canonicalEvent(
				"message.created",
				input.sessionId,
				{
					messageId: `${input.sessionId}-message-1`,
					role: "user",
					sessionId: input.sessionId,
				},
				{ provider: "claude-sdk", createdAt: input.createdAt },
			),
		);
		yield* runner.projectEvent(event);
		return event;
	});

const appendProjectedManualRename = (input: {
	readonly sessionId: string;
	readonly title: string;
	readonly createdAt: number;
}) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		const event = yield* store.append(
			canonicalEvent(
				"session.renamed",
				input.sessionId,
				{
					sessionId: input.sessionId,
					title: input.title,
				},
				{
					provider: "claude-sdk",
					createdAt: input.createdAt,
					metadata: { source: "relay" },
				},
			),
		);
		yield* runner.projectEvent(event);
		return event;
	});

const getSessionTitle = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		return (yield* readQuery.getSession(sessionId))?.title;
	});

const sleepMillis = (duration: number) =>
	Effect.promise(
		() => new Promise<void>((resolve) => setTimeout(resolve, duration)),
	);

const waitForSessionTitle = (sessionId: string, expected: string) =>
	Effect.gen(function* () {
		let latest: string | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			latest = yield* getSessionTitle(sessionId);
			if (latest === expected) return;
			yield* sleepMillis(10);
		}
		return yield* Effect.fail(
			new Error(
				`Timed out waiting for ${sessionId} title ${expected}; latest was ${latest}`,
			),
		);
	});

const awaitSignal = (name: string, promise: Promise<void>) =>
	Effect.tryPromise({
		try: () =>
			Promise.race([
				promise,
				new Promise<void>((_, reject) =>
					setTimeout(
						() => reject(new Error(`Timed out waiting for ${name}`)),
						2000,
					),
				),
			]),
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});

const getRenameEvents = (sessionId: string) =>
	Effect.gen(function* () {
		const store = yield* EventStoreEffectTag;
		const events = yield* store.readBySession(sessionId);
		return events.flatMap((event) => {
			if (event.type !== "session.renamed") return [];
			return [
				{
					title: event.data.title,
					source: event.metadata.source ?? null,
				},
			];
		});
	});

const waitForQueryFactoryCalls = (
	queryFactory: ReturnType<typeof vi.fn>,
	expectedCalls: number,
) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (queryFactory.mock.calls.length >= expectedCalls) return;
			yield* sleepMillis(10);
		}
		return yield* Effect.fail(
			new Error(
				`Timed out waiting for queryFactory call count ${expectedCalls}; saw ${queryFactory.mock.calls.length}`,
			),
		);
	});

describe("Integration: Claude Session Titles", () => {
	it.effect(
		"uses the saved title account after the title service restarts",
		() => {
			const { dir, filename } = makeTempDbPath();
			const queryFactory = vi.fn(
				(_params: Parameters<ClaudeOneShotQueryFactory>[0]) =>
					replayClaudeText(),
			);
			const accounts = makeMockAccountDirectory([
				{
					driver: "claude",
					id: AccountIdSchema.make("claude-personal"),
					name: "Personal",
					folder: configuredClaudeConfigDir("/integration-personal-login"),
					usageEligible: true,
				},
				{
					driver: "claude",
					id: AccountIdSchema.make("claude-work"),
					name: "Work",
					folder: configuredClaudeConfigDir("/integration-work-login"),
					usageEligible: true,
				},
			]);
			const generateSessionTitle = (sessionId: string) =>
				Effect.gen(function* () {
					yield* (yield* ProjectionRunnerEffectTag).markRecovered();
					yield* seedSessionRow({
						sessionId,
						title: DEFAULT_TITLE,
						createdAt: 1000,
					});
					yield* (yield* SessionTitleServiceTag).titleFromMessage({
						sessionId,
						message: FIRST_MESSAGE,
					});
					yield* waitForSessionTitle(sessionId, GENERATED_TITLE);
				}).pipe(
					Effect.provide(
						makeTitleServiceLayer({
							filename,
							queryFactory,
							accounts,
							configDir: dir,
						}),
					),
				);
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
						dir,
					),
				);
				yield* generateSessionTitle("selected-account-before-restart");
				yield* generateSessionTitle("selected-account-after-restart");
				expect(queryFactory).toHaveBeenCalledTimes(2);
				for (const [params] of queryFactory.mock.calls) {
					expect(params.options).toMatchObject({
						env: { CLAUDE_CONFIG_DIR: "/integration-work-login" },
						model: "sonnet",
						effort: "high",
					});
				}
			}).pipe(Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect(
		"generates with the directory's selected default Claude account",
		() => {
			const { dir, filename } = makeTempDbPath();
			const queryFactory = vi.fn(
				(params: Parameters<ClaudeOneShotQueryFactory>[0]) => {
					expect(params.options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(
						"/integration-work-login",
					);
					return replayClaudeText();
				},
			);
			const layer = makeTitleServiceLayer({
				filename,
				queryFactory,
				accounts: makeMockAccountDirectory([
					{
						driver: "claude",
						id: AccountIdSchema.make("claude-work"),
						name: "Work",
						folder: configuredClaudeConfigDir("/integration-work-login"),
						usageEligible: true,
					},
				]),
			});
			return Effect.gen(function* () {
				yield* (yield* ProjectionRunnerEffectTag).markRecovered();
				yield* seedSessionRow({
					sessionId: SESSION_ID,
					title: DEFAULT_TITLE,
					createdAt: 1000,
				});
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: SESSION_ID,
					message: FIRST_MESSAGE,
				});
				yield* waitForSessionTitle(SESSION_ID, GENERATED_TITLE);
				expect(queryFactory).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(layer), Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect(
		"persists a generated title and keeps it after a duplicate session.created",
		() => {
			const { dir, filename } = makeTempDbPath();
			const queryFactory = vi.fn(() => replayClaudeText());
			const layer = makeTitleServiceLayer({ filename, queryFactory });

			return Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const service = yield* SessionTitleServiceTag;
				yield* runner.markRecovered();

				yield* seedSessionRow({
					sessionId: SESSION_ID,
					title: DEFAULT_TITLE,
					createdAt: 1000,
				});
				yield* appendProjectedSessionCreated({
					sessionId: SESSION_ID,
					title: DEFAULT_TITLE,
					createdAt: 1000,
				});
				const initialSession = yield* readQuery.getSession(SESSION_ID);
				expect(["Claude Session", "Untitled"]).toContain(initialSession?.title);

				yield* appendProjectedFirstMessage({
					sessionId: SESSION_ID,
					createdAt: 2000,
				});
				const messages =
					yield* readQuery.getSessionMessagesWithParts(SESSION_ID);
				expect(messages).toHaveLength(1);
				expect(queryFactory).not.toHaveBeenCalled();

				yield* service.titleFromMessage({
					sessionId: SESSION_ID,
					message: FIRST_MESSAGE,
				});
				yield* waitForSessionTitle(SESSION_ID, GENERATED_TITLE);
				expect(queryFactory).toHaveBeenCalledTimes(1);

				yield* appendProjectedSessionCreated({
					sessionId: SESSION_ID,
					title: DEFAULT_TITLE,
					createdAt: 3000,
				});
				expect(yield* getSessionTitle(SESSION_ID)).toBe(GENERATED_TITLE);
			}).pipe(Effect.provide(layer), Effect.ensuring(removeTempDir(dir)));
		},
	);

	it.effect("preserves a manual title when generation completes later", () => {
		const { dir, filename } = makeTempDbPath();
		const gatedTitle = makeGatedTitleQuery();
		let titleQueryCalls = 0;
		const queryFactory = vi.fn(() =>
			titleQueryCalls++ === 0 ? gatedTitle.query() : replayClaudeText(),
		);
		const layer = makeTitleServiceLayer({ filename, queryFactory });

		return Effect.gen(function* () {
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.markRecovered();

			yield* seedSessionRow({
				sessionId: SESSION_ID,
				title: DEFAULT_TITLE,
				createdAt: 1000,
			});
			yield* appendProjectedSessionCreated({
				sessionId: SESSION_ID,
				title: DEFAULT_TITLE,
				createdAt: 1000,
			});
			yield* appendProjectedFirstMessage({
				sessionId: SESSION_ID,
				createdAt: 1500,
			});
			yield* Effect.gen(function* () {
				const service = yield* SessionTitleServiceTag;
				yield* service.titleFromMessage({
					sessionId: SESSION_ID,
					message: FIRST_MESSAGE,
				});
				yield* awaitSignal("title query start", gatedTitle.started);

				yield* appendProjectedManualRename({
					sessionId: SESSION_ID,
					title: "Manual Title",
					createdAt: 2000,
				});
				expect(yield* getSessionTitle(SESSION_ID)).toBe("Manual Title");

				gatedTitle.release();
				yield* awaitSignal("title query finish", gatedTitle.finished);

				// Starting a second title job proves the first job completed its
				// post-query apply path and removed its in-flight guard.
				yield* Effect.gen(function* () {
					for (let attempt = 0; attempt < 100; attempt++) {
						yield* service.titleFromMessage({
							sessionId: SESSION_ID,
							message: FIRST_MESSAGE,
						});
						if (queryFactory.mock.calls.length >= 2) return;
						yield* sleepMillis(10);
					}
					return yield* Effect.fail(
						new Error("Timed out waiting for title job in-flight cleanup"),
					);
				});
				yield* waitForQueryFactoryCalls(queryFactory, 2);

				expect(yield* getSessionTitle(SESSION_ID)).toBe("Manual Title");
				expect(yield* getRenameEvents(SESSION_ID)).toEqual([
					{ title: "Manual Title", source: "relay" },
				]);
			});
		}).pipe(Effect.provide(layer), Effect.ensuring(removeTempDir(dir)));
	});
});
