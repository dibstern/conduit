import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { daemonSessionGitCache } from "../../../src/lib/git/session-git.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { settleIdleSessions } from "../../../src/lib/session/auto-settle-sweep.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";
import type { SessionGit } from "../../../src/lib/shared-types.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

describe("relay automatic settlement sweep", () => {
	it.effect("waits for fresh git before settling recent merged work", () => {
		const projectDir = "/auto-settle-git";
		const directories = new Map([
			["merged", `${projectDir}/merged`],
			["unmerged", `${projectDir}/unmerged`],
		]);
		const cached = new Map<string, SessionGit>([
			[`${projectDir}/merged`, { merged: false }],
			[`${projectDir}/unmerged`, { merged: true, mergedHead: "stale-head" }],
		]);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(daemonSessionGitCache, "isStale").mockReturnValue(true);
		vi.spyOn(daemonSessionGitCache, "peek").mockImplementation((directory) =>
			cached.get(directory),
		);
		const refresh = vi
			.spyOn(daemonSessionGitCache, "refresh")
			.mockImplementation(async (directory) => {
				await held;
				const git =
					directory === directories.get("merged")
						? { merged: true, mergedHead: "fresh-head" }
						: { merged: false };
				cached.set(directory, git);
				return git;
			});
		const setSettled = vi.fn((_id: string, _head?: string) =>
			Effect.succeed(true),
		);
		return Effect.scoped(
			Effect.gen(function* () {
				const now = Date.now();
				const sql = yield* SqlClient.SqlClient;
				for (const [id, directory] of directories)
					yield* sql`INSERT INTO sessions (id, provider, title, status, workspace, last_message_at, created_at, updated_at)
						VALUES (${id}, 'claude', ${id}, 'idle', ${JSON.stringify({ cause: "user", origin: "existing", worktrees: { [projectDir]: directory } })}, ${now}, ${now}, ${now})`;
				const settling = yield* Effect.fork(
					settleIdleSessions(
						{
							projectDir,
							hasViewer: () => false,
							hasLiveBackgroundWork: () => false,
							setSettled,
						},
						3 * DAY,
						now,
					),
				);
				yield* Effect.tryPromise(() =>
					vi.waitFor(() => expect(refresh).toHaveBeenCalled()),
				);
				expect(setSettled).not.toHaveBeenCalled();
				release();
				expect(yield* Fiber.join(settling)).toBe(1);
				expect(setSettled.mock.calls).toEqual([["merged", "fresh-head"]]);
				expect(refresh.mock.calls.map(([directory]) => directory)).toContain(
					directories.get("unmerged"),
				);
			}),
		).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			Effect.ensuring(Effect.sync(release)),
		);
	});

	it.effect(
		"settles only eligible rows once and clears the automatic marker on un-settle",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-auto-settle-"));
			const configLayer = Layer.succeed(
				ConfigTag,
				makeMockConfig({ configDir: dir, projectDir: dir }),
			);
			const loggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
			const openCodeApi = makeMockOpenCodeAPI();
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
					makeSessionManagerStateLive(),
					Layer.succeed(OpenCodeAPITag, openCodeApi),
					loggerLayer,
					configLayer,
					Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
					Layer.succeed(BackgroundLivenessTag, () => undefined),
					RelayStatusSnapshotLive,
					makeOverridesStateLive(),
					Layer.succeed(
						OpenCodeInstancesTag,
						makeOpenCodeInstancesStub({ opencode: openCodeApi }),
					),
					DaemonEventBusLive,
					makePersistenceEffectLayer(join(dir, "events.db"), "test-project"),
					Layer.succeed(
						OrchestrationEngineTag,
						new OrchestrationEngine({ registry: new ProviderRegistry() }),
					),
				),
			);
			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const read = yield* ReadQueryEffectTag;
				const service = yield* SessionManagerServiceTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();
				const now = Date.now();
				const old = now - 4 * DAY;
				const seed = (id: string) =>
					Effect.gen(function* () {
						for (const event of [
							canonicalEvent(
								"session.created",
								id,
								{ sessionId: id, title: id, provider: "opencode" },
								{ createdAt: old - 1 },
							),
							canonicalEvent(
								"message.created",
								id,
								{ sessionId: id, messageId: `${id}-m1`, role: "assistant" },
								{ createdAt: old },
							),
						])
							yield* runner.projectEvent(yield* store.append(event));
					});
				for (const id of ["eligible", "viewed", "background", "woken"])
					yield* seed(id);
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent(
							"session.snoozed",
							"woken",
							{ sessionId: "woken", until: old + 3 },
							{ createdAt: old + 2 },
						),
					),
				);
				const viewers = new Set(["viewed"]);
				const background = makeSessionBackgroundLiveness();
				background.record({
					sessionId: "background",
					kind: "snapshot",
					tasks: [{ id: "task1", type: "local_agent", description: "Audit" }],
				});
				const ports = {
					hasViewer: (id: string) => viewers.has(id),
					hasLiveBackgroundWork: background.hasLiveWork,
					setSettled: (id: string) =>
						service.setSessionSettled(id, { settled: true, automatic: true }),
				};
				expect(yield* settleIdleSessions(ports, 3 * DAY, now)).toBe(2);
				expect(
					(yield* read.getSession("eligible"))?.settled_automatically,
				).toBe(1);
				expect((yield* read.getSession("viewed"))?.settled_at).toBeNull();
				expect((yield* read.getSession("background"))?.settled_at).toBeNull();
				const events = yield* store.readAllBySession("eligible");
				expect(
					events
						.filter((event) => event.type === "session.settled")
						.map((event) => event.data),
				).toEqual([{ sessionId: "eligible", automatic: true }]);
				expect(
					(yield* store.readAllBySession("woken"))
						.filter((event) => event.type.startsWith("session."))
						.map((event) => event.type),
				).toEqual(["session.created", "session.snoozed", "session.settled"]);
				expect(yield* settleIdleSessions(ports, 3 * DAY, now)).toBe(0);
				yield* service.setSessionSettled("eligible", { settled: false });
				expect(
					(yield* read.getSession("eligible"))?.settled_automatically,
				).toBe(0);
				background.record({
					sessionId: "background",
					kind: "snapshot",
					tasks: [],
				});
				viewers.clear();
				expect(yield* settleIdleSessions(ports, 3 * DAY, now)).toBe(2);
				const settledRows = yield* sql<{
					id: string;
				}>`SELECT id FROM sessions WHERE settled_at IS NOT NULL`;
				expect(settledRows.map((row) => row.id).sort()).toEqual([
					"background",
					"viewed",
					"woken",
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
