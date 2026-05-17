import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	type ClaudeTitleQueryFactory,
	makeSessionTitleServiceLive,
	SessionTitleServiceTag,
} from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeMockLogger,
	makeMockSessionManagerService,
} from "../../helpers/mock-factories.js";

const SESSION_ID = "claude-title-integration-session";
const FIRST_MESSAGE =
	"Please investigate why OAuth token refresh is failing after expiry.";
const GENERATED_TITLE = "OAuth Token Refresh Bug Investigation";
const DEFAULT_TITLE = "Claude Session";

async function* makeTitleQuery(title: string): AsyncIterable<unknown> {
	yield {
		type: "assistant",
		message: {
			content: [{ type: "text", text: title }],
		},
	};
}

const makeSignal = () => {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
};

const makeGatedTitleQuery = (title: string) => {
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
				yield {
					type: "assistant",
					message: {
						content: [{ type: "text", text: title }],
					},
				};
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
	readonly queryFactory: ClaudeTitleQueryFactory;
}) =>
	Layer.provideMerge(
		makeSessionTitleServiceLive({ queryFactory: input.queryFactory }),
		Layer.mergeAll(
			Layer.succeed(LoggerTag, makeMockLogger()),
			Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
			makePersistenceEffectLayer(input.filename),
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
		"persists a generated title and keeps it after a duplicate session.created",
		() => {
			const { dir, filename } = makeTempDbPath();
			const queryFactory = vi.fn(() => makeTitleQuery(GENERATED_TITLE));
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

				yield* service.startForFirstClaudeMessage({
					sessionId: SESSION_ID,
					firstMessage: FIRST_MESSAGE,
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
		const gatedTitle = makeGatedTitleQuery(GENERATED_TITLE);
		let titleQueryCalls = 0;
		const queryFactory = vi.fn(() =>
			titleQueryCalls++ === 0
				? gatedTitle.query()
				: makeTitleQuery("Second Generated Title"),
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
				yield* service.startForFirstClaudeMessage({
					sessionId: SESSION_ID,
					firstMessage: FIRST_MESSAGE,
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
						yield* service.startForFirstClaudeMessage({
							sessionId: SESSION_ID,
							firstMessage: FIRST_MESSAGE,
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
