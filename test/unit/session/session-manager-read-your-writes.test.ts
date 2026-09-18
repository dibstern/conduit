import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { expect, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

type OperationsOutsideReadModelParity = keyof Pick<
	SessionManagerService,
	| "initialize"
	| "getDefaultSessionId"
	| "getLastKnownSessionCount"
	| "listSessions"
	| "clearPaginationCursor"
	| "seedPaginationCursor"
	| "loadPreRenderedHistory"
	| "recordMessageActivity"
	| "addToParentMap"
	| "getSessionParentMap"
	| "incrementPendingQuestionCount"
	| "decrementPendingQuestionCount"
	| "setPendingQuestionCounts"
	| "sendDualSessionLists"
>;

type ReadModelMutation = Exclude<
	keyof SessionManagerService,
	OperationsOutsideReadModelParity
>;

interface ParityContext {
	readonly api: OpenCodeAPI;
	readonly service: SessionManagerService;
	readonly readQuery: ReadQueryEffect;
	readonly seedSession: (
		sessionId: string,
		title: string,
		opts?: { parentId?: string },
	) => Effect.Effect<void, unknown>;
}

interface ParityCase {
	readonly expectedFailure?: string;
	readonly run: (context: ParityContext) => Effect.Effect<void, unknown>;
}

const createdSession = (
	id: string,
	title: string,
	parentID?: string,
): SessionDetail => ({
	id,
	projectID: "project",
	directory: "/test/project",
	title,
	version: "1",
	time: { created: 1_000, updated: 1_000 },
	...(parentID === undefined ? {} : { parentID }),
});

const READ_MODEL_PARITY_CASES: Record<ReadModelMutation, ParityCase> = {
	establishOpenCodeSession: {
		run: ({ service, readQuery, seedSession }) =>
			Effect.gen(function* () {
				yield* seedSession("established-parent", "Parent");
				const session = createdSession(
					"ses-established",
					"Established through service",
					"established-parent",
				);

				yield* service.establishOpenCodeSession(
					session,
					defaultInstanceIdForDriver("opencode"),
				);

				expect(yield* readQuery.getSession(session.id)).toEqual(
					expect.objectContaining({
						id: session.id,
						title: session.title,
						parent_id: "established-parent",
					}),
				);
			}),
	},
	createSession: {
		run: ({ api, service }) =>
			Effect.gen(function* () {
				const created = createdSession(
					"ses-created",
					"Created through service",
				);
				vi.mocked(api.session.create).mockResolvedValueOnce(created);

				yield* service.createSession(created.title, { providerId: "opencode" });

				expect(yield* service.listSessions()).toEqual([
					expect.objectContaining({ id: created.id, title: created.title }),
				]);
			}),
	},
	deleteSession: {
		run: ({ service, readQuery, seedSession }) =>
			Effect.gen(function* () {
				const sessionId = "ses-deleted";
				yield* seedSession(sessionId, "Delete me");

				yield* service.deleteSession(sessionId);

				expect(yield* readQuery.getSession(sessionId)).toBeUndefined();
			}),
	},
	renameSession: {
		run: ({ service, readQuery, seedSession }) =>
			Effect.gen(function* () {
				const sessionId = "ses-renamed";
				yield* seedSession(sessionId, "Old title");

				yield* service.renameSession(sessionId, "New title");

				expect((yield* readQuery.getSession(sessionId))?.title).toBe(
					"New title",
				);
			}),
	},
	setForkEntry: {
		run: ({ api, service, readQuery, seedSession }) =>
			Effect.gen(function* () {
				const parentId = "ses-parent";
				const forked = createdSession("ses-forked", "Forked session", parentId);
				const forkMessageId = "msg-fork-point";
				vi.mocked(api.session.fork).mockResolvedValueOnce(forked);
				yield* seedSession(parentId, "Parent session");
				yield* seedSession(forked.id, forked.title);

				const providerFork = yield* Effect.promise(() =>
					api.session.fork(parentId, { messageID: forkMessageId }),
				);
				yield* service.setForkEntry(providerFork.id, {
					parentID: parentId,
					forkMessageId,
					forkPointTimestamp: 900,
				});

				expect(yield* readQuery.getSession(forked.id)).toEqual(
					expect.objectContaining({
						parent_id: parentId,
						fork_point_event: forkMessageId,
					}),
				);
			}),
	},
};

describe("SessionManager read-your-writes parity", () => {
	for (const [operation, parityCase] of Object.entries(
		READ_MODEL_PARITY_CASES,
	) as [ReadModelMutation, ParityCase][]) {
		const expectedFailureSuffix = parityCase.expectedFailure
			? ` (expected failure: ${parityCase.expectedFailure})`
			: "";
		it.effect(
			`${operation} is visible through the SQLite read path${expectedFailureSuffix}`,
			() => {
				const dir = mkdtempSync(join(tmpdir(), "conduit-session-parity-"));
				const api = makeMockOpenCodeAPI();
				const persistenceLayer = makePersistenceEffectLayer(
					join(dir, "events.db"),
				);
				const layer = Layer.provideMerge(
					SessionManagerServiceLive,
					Layer.mergeAll(
						makeSessionManagerStateLive(),
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(
							ConfigTag,
							makeMockConfig({ configDir: dir, projectDir: dir }),
						),
						DaemonEventBusLive,
						persistenceLayer,
					),
				);

				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const store = yield* EventStoreEffectTag;
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					const readQuery = yield* ReadQueryEffectTag;
					const service = yield* SessionManagerServiceTag;
					yield* projectionRunner.markRecovered();

					const seedSession: ParityContext["seedSession"] = (
						sessionId,
						title,
						opts,
					) =>
						Effect.gen(function* () {
							const stored = yield* store.append(
								canonicalEvent(
									"session.created",
									sessionId,
									{
										sessionId,
										title,
										provider: "opencode",
										...(opts?.parentId === undefined
											? {}
											: { parentId: opts.parentId }),
									},
									{ provider: "opencode", createdAt: 1_000 },
								),
							);
							yield* projectionRunner
								.projectEvent(stored)
								.pipe(Effect.provideService(SqlClient.SqlClient, sql));
						});

					const context = { api, service, readQuery, seedSession };
					if (parityCase.expectedFailure === undefined) {
						yield* parityCase.run(context);
						return;
					}

					const outcome = yield* Effect.exit(parityCase.run(context));
					expect(Exit.isFailure(outcome)).toBe(true);
					if (Exit.isFailure(outcome)) {
						const errors = [
							...Cause.failures(outcome.cause),
							...Cause.defects(outcome.cause),
						];
						expect(errors).toHaveLength(1);
						expect((errors[0] as Error).name).toBe("AssertionError");
					}
				}).pipe(
					Effect.provide(layer),
					Effect.ensuring(
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
					),
				);
			},
		);
	}
});
